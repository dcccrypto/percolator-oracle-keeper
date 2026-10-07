/**
 * cross-cluster/v22/sweep.ts
 *
 * The positioned-refresh sweep for v2.2 markets (KEEPER_V22_SWEEP). A round is planned by settle-pairing.ts
 * (`planSettleRound`): txs shaped [accrue crank, refresh xN], heaviest stale weight first, budgeted by LEG WEIGHT
 * (a refresh weighs 3 + legs), the LP's settle paired with its counterparties (SETTLE_PAIRING).
 *
 * WHAT "PAIRED" MEANS HERE (security review of #148, items 1-9): the round tracks which counterparties ACTUALLY
 * settled (landed refresh, or the engine said "already current" = Custom(22)). The LP tx goes only if
 *   - every positioned counterparty settled in this round, or
 *   - `prefer` and the only misses are portfolios the program REFUSED (band 104/111/112/113, hard refusal): those
 *     cannot be settled by any keeper action, so waiting would freeze the LP; the miss is counted in
 *     `unpairedLpSettles`. `strict` holds the LP instead.
 * A counterparty tx that did not LAND (any reason) is never a reason to settle the LP alone: the LP waits (no
 * "force after N skipped rounds" exists any more). The one exception is a PROTECTIVE round (the LP itself is near
 * liquidation or a senior draw is pending): the LP then goes in the legacy full recovery shape, last in a tx with
 * the counterparties that fit, never alone.
 *
 * Execution of a tx: simulate first; a refresh refused at a known index is PRUNED (Custom(22) = current, band
 * code = expected state, anything else = hard refusal), the rest re-simulated and sent (bounded); hard and band
 * refusals put the portfolio on a cool-down (`quarantine`) ONLY when the refusal carries a program Custom code; an error with
 * no code (compute exhaustion, account in use, blockhash, RPC) shrinks the tx instead and counts as an unsettled
 * counterparty that holds the LP in BOTH modes. Rent (tag 106) is sent AFTER the LP tx, sequentially, for portfolios the
 * plain refresh already settled (106 forces the Refresh action and write-locks the LP). A landed tx that
 * failed with Custom(22) on its accrue crank (a parallel tx accrued the same slot) is treated as "already
 * accrued" and re-sent refresh-only.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildObservationCrankIx, buildRefreshCrankIx } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { holdPushes as realHold, releasePushes as realRelease } from "../refresh-coordination.ts";
import { BAND_EXPECTED_CODES } from "./errors.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import { DEFAULT_MAX_GAP_SLOTS, DEFAULT_MAX_TXS_PER_ROUND, DEFAULT_WEIGHT_BUDGET, planSettleRound } from "./settle-pairing.ts";
import type { PlannedTx, RoundPlan } from "./settle-pairing.ts";
import type { PairingMode } from "./flags.ts";

const NON_PROGRESS = 22;
export const SWEEP_TX_UNITS = 1_400_000;
export const SWEEP_MAX_PRUNES = 8;
/**
 * Cool-down ladder (slots) after a PROGRAM refusal (a Custom code) of a refresh: the first is short; a longer one applies
 * only when the SAME portfolio repeats the SAME code. At most MAX_QUARANTINES_PER_ROUND portfolios are quarantined per
 * round unless each carries a distinct code (one bad code must not quarantine a whole book).
 */
export const QUARANTINE_LADDER: readonly number[] = [150, 450, 1_500];
export const MAX_QUARANTINES_PER_ROUND = 2;
export const QUARANTINE_FIRST_SLOTS = QUARANTINE_LADDER[0];
/** Rounds skipped after a gap-exceeded round: 1, then 2 (capped: the engine clock must not go unaccrued for long). */
export const MAX_GAP_BACKOFF_ROUNDS = 2;

export interface SweepRoundConfig {
  pairing: PairingMode;
  weightBudget: number;
  maxTxsPerRound: number;
  maxGapSlots: number;
  /** How long the market's pushes are held during a multi-tx round. */
  holdMs: number;
}

export const DEFAULT_SWEEP_ROUND_CONFIG: SweepRoundConfig = {
  pairing: "prefer",
  weightBudget: DEFAULT_WEIGHT_BUDGET,
  maxTxsPerRound: DEFAULT_MAX_TXS_PER_ROUND,
  maxGapSlots: DEFAULT_MAX_GAP_SLOTS,
  holdMs: 12_000,
};

export interface SweepDeps {
  exec: ExecContext;
  getSlot: () => Promise<number>;
  hold?: (market: string, ms: number) => void;
  release?: (market: string) => void;
}

/** Pairing health, process-lifetime, exported through /health (health.ts). */
export interface PairingStats {
  rounds: number;
  singleTxRounds: number;
  multiTxRounds: number;
  pairedLpSettles: number;
  /** LP settled while counterparties were unvisited / refused (prefer's counted degradation, and mode off's legacy shape). */
  unpairedLpSettles: number;
  lpDeferredStrict: number;
  /** LP held because a counterparty tx did not land (never forced). */
  lpHeldPhase1Unlanded: number;
  /** LP held (strict) because a counterparty was refused. */
  lpHeldCounterpartyMiss: number;
  gapExceeded: number;
  gapBackoffRounds: number;
  consecutiveGapExceeded: number;
  lastGapSlots: number | null;
  maxGapSlots: number;
  bandExpected: number;
  prunedCurrent: number;
  hardRefusals: number;
  quarantinedNow: number;
  anchorAccrues: number;
  /** The anchor accrue was refused by the program: that tx fell back to the counterparty form. */
  anchorFallbacks: number;
  /** Quarantines skipped because the per-round cap was reached. */
  quarantineCapped: number;
  /** Accrue went through a counterparty because the market had no keeper-owned flat anchor. */
  counterpartyAccrues: number;
  accrueAlreadyDone: number;
  protectiveRounds: number;
  rentSettlesInRound: number;
  /** A compute / runtime error (no program code) shrank a tx: nobody was blamed or quarantined. */
  shrinkDeferrals: number;
  feeAfterRound: number;
  feeUnpairedLpSettles: number;
}

const zeroStats = (): PairingStats => ({
  rounds: 0, singleTxRounds: 0, multiTxRounds: 0, pairedLpSettles: 0, unpairedLpSettles: 0, lpDeferredStrict: 0,
  lpHeldPhase1Unlanded: 0, lpHeldCounterpartyMiss: 0, gapExceeded: 0, gapBackoffRounds: 0, consecutiveGapExceeded: 0,
  lastGapSlots: null, maxGapSlots: 0, bandExpected: 0, prunedCurrent: 0, hardRefusals: 0, quarantinedNow: 0,
  anchorAccrues: 0, anchorFallbacks: 0, quarantineCapped: 0, counterpartyAccrues: 0, accrueAlreadyDone: 0, protectiveRounds: 0, rentSettlesInRound: 0, shrinkDeferrals: 0,
  feeAfterRound: 0, feeUnpairedLpSettles: 0,
});

export const pairingStats: PairingStats = zeroStats();

export function resetPairingStats(): void {
  Object.assign(pairingStats, zeroStats());
}

/** Per-market gap backoff state (a round abandoned for a gap > maxGapSlots). */
export interface GapBackoff {
  level: number;
  skipRounds: number;
}
export const freshGapBackoff = (): GapBackoff => ({ level: 0, skipRounds: 0 });

/**
 * Rent settles (tag 106) are NOT substituted for a refresh (106 forces the Refresh action, so a liquidatable counterparty
 * would not be liquidated, and every 106 write-locks the LP, which would serialise the parallel phase-1 txs). They run
 * AFTER the LP tx of a round, sequentially, one tx per portfolio, only for portfolios the round already refreshed with
 * the plain crank, and only when the LP settled.
 */
export interface RentPlanInput {
  /** base58 portfolio keys whose rent is due this round. */
  due: ReadonlySet<string>;
  build: (p: PositionedPortfolio) => TransactionInstruction;
  /** Most rent settles per round (default 4). */
  max?: number;
}

export interface RoundInput {
  lp: PublicKey;
  lpWeight?: number;
  counterparties: ReadonlyArray<PositionedPortfolio>;
  /** The keeper's OWN flat portfolio (accrue-only target). */
  anchor?: PublicKey | null;
  /** Oracle leg accounts for the observation crank (Hybrid); [] for AUTH_MARK. */
  oracleAccounts?: ReadonlyArray<PublicKey>;
  /** base58 -> slot until which a refused portfolio is not retried. */
  quarantine?: Map<string, bigint>;
  /** base58 -> last program code + ladder level (a longer cool-down only on a repeat of the same code). */
  quarantineHistory?: Map<string, { code: number; level: number }>;
  nowSlot?: number;
  gapBackoff?: GapBackoff;
  rent?: RentPlanInput;
  /** The LP itself needs a crank now: legacy full recovery shape, never alone, no gap / phase-1 hold. */
  protective?: boolean;
}

/** current = Custom 22 (already settled); band = expected band state; hard = any other PROGRAM code; deferred = no program code (compute / runtime). */
export type PruneReason = "current" | "band" | "hard" | "deferred";

export interface RoundResult {
  plan: RoundPlan;
  txsSent: number;
  /** Counterparties that settled (landed or already current). */
  settled: string[];
  /** Counterparties not settled this round, with why. */
  missing: Array<{ key: string; why: "quarantined" | PruneReason | "unlanded" | "unplanned" }>;
  rentSettled: string[];
  /** The round was skipped for a gap backoff: nothing ran (the delegate must decline so the legacy accrual crank runs). */
  backedOff: boolean;
  /** The program refused an anchor accrue this round (the caller drops the anchor for a while). */
  anchorRefused: boolean;
  pruned: number;
  lpSettled: boolean;
  gapSlots: number | null;
  abandoned: string | null;
  outcomes: ExecOutcome[];
}

export interface BuildTxArgs {
  accrue: PlannedTx["accrue"];
  accrueTarget: PublicKey | null;
  refresh: ReadonlyArray<PositionedPortfolio>;
  oracleAccounts?: ReadonlyArray<PublicKey>;
  tail?: ReadonlyArray<TransactionInstruction>;
}

/** The instruction list of one planned tx (accrue crank first, then the refreshes, then a tail). */
export function buildSweepTxIxs(owner: PublicKey, market: PublicKey, tx: BuildTxArgs): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (tx.accrue !== "none" && tx.accrueTarget) ixs.push(buildObservationCrankIx(owner, market, tx.accrueTarget, tx.oracleAccounts ?? []));
  for (const p of tx.refresh) ixs.push(buildRefreshCrankIx(owner, market, p.pubkey));
  for (const t of tx.tail ?? []) ixs.push(t);
  return ixs;
}

interface TxRun {
  outcome: ExecOutcome;
  /** counterparties settled by this tx (empty unless it landed / dry-ran). */
  settled: string[];
  pruned: Array<{ key: string; reason: PruneReason; code: number | null }>;
  /** refreshes of this tx that did not settle because the tx did not land. */
  unlanded: string[];
  droppedAccrue: boolean;
  anchorRefused: boolean;
}

export interface RunTxOptions {
  oracleAccounts?: ReadonlyArray<PublicKey>;
  tail?: ReadonlyArray<TransactionInstruction>;
  /** Codes at the tail instruction that are expected (e.g. 38 for tag 78). */
  tailExpected?: ReadonlySet<number>;
  job?: string;
  /** Extra expected codes for this tx (the tail's, e.g. 38 for tag 78). */
  expected?: ReadonlySet<number>;
  /** LP tx gate: given the keys pruned for a reason other than "current" so far, a reason to hold the send. */
  lpGate?: (prunedNotSettled: Array<{ key: string; reason: PruneReason }>) => string | null;
}

/** Run one planned tx with simulate-prune-isolate. Exported for the tag-78 job. */
export async function runPlannedTx(deps: SweepDeps, ctx: { market: PublicKey; label: string }, t: PlannedTx, o: RunTxOptions = {}): Promise<TxRun> {
  const owner = deps.exec.keeper.publicKey;
  let accrue: PlannedTx["accrue"] = t.accrue;
  let target = t.accrueTarget;
  let refresh = [...t.refresh];
  const pruned: TxRun["pruned"] = [];
  let droppedAccrue = false;
  let anchorRefused = false;
  let shrinks = 0;
  const budget = SWEEP_MAX_PRUNES + 3;
  const settledKeys = (): string[] => {
    // the first counterparty is settled by its own accrue crank when the accrue went through it
    const ks = refresh.map((p) => p.pubkey.toBase58());
    if (accrue === "counterparty" && target) ks.unshift(target.toBase58());
    return ks;
  };
  const fail = (outcome: ExecOutcome): TxRun => ({ outcome, settled: [], pruned, unlanded: settledKeys(), droppedAccrue, anchorRefused });
  for (let attempt = 0; attempt <= budget; attempt++) {
    const hasAccrue = accrue !== "none" && target !== null;
    const ixs = buildSweepTxIxs(owner, ctx.market, { accrue, accrueTarget: target, refresh, oracleAccounts: o.oracleAccounts, tail: o.tail });
    if (ixs.length === 0) return { outcome: { kind: "dry-run", unitsConsumed: null, logs: [], ixCount: 0 }, settled: [], pruned, unlanded: [], droppedAccrue, anchorRefused };
    const outcome = await simulateAndSend(deps.exec, ixs, {
      job: o.job ?? "sweep",
      label: ctx.label,
      units: SWEEP_TX_UNITS,
      expected: o.expected ? new Set([...BAND_EXPECTED_CODES, ...o.expected]) : BAND_EXPECTED_CODES,
      beforeSend: () => (t.settlesLp && o.lpGate ? o.lpGate(pruned.filter((p) => p.reason !== "current")) : null),
    });
    const landed = outcome.kind === "sent" && outcome.landed === "landed";
    if (landed || outcome.kind === "dry-run") return { outcome, settled: settledKeys(), pruned, unlanded: [], droppedAccrue, anchorRefused };
    // A landed tx that failed on its accrue crank with Custom(22): another tx accrued this slot. Continue refresh-only.
    if (outcome.kind === "sent" && outcome.landed === "failed" && outcome.failCode === NON_PROGRESS && hasAccrue && !droppedAccrue) {
      pairingStats.accrueAlreadyDone++;
      ({ accrue, target, refresh } = dropAccrue(t, accrue, target, refresh));
      droppedAccrue = true;
      continue;
    }
    if (outcome.kind === "sent" || outcome.kind === "held" || outcome.kind === "failed") return fail(outcome);
    // refused in simulation
    const refused = outcome as Extract<ExecOutcome, { kind: "refused" }>;
    // NOT a program refusal (no Custom code): compute exhaustion, account in use, blockhash, RPC. Nobody is blamed and nothing
    // is quarantined: shrink the tx (cut the TAIL), the cut refreshes are "deferred" = unsettled, which holds the LP in both modes.
    if (refused.code === null) {
      if (refresh.length > 1 && shrinks < 3) {
        shrinks++;
        pairingStats.shrinkDeferrals++;
        const cut = Math.max(1, Math.ceil(refresh.length / 4));
        for (const p of refresh.slice(-cut)) pruned.push({ key: p.pubkey.toBase58(), reason: "deferred", code: null });
        refresh = refresh.slice(0, -cut);
        continue;
      }
      return fail(outcome);
    }
    const idx = refused.index;
    if (idx === null) return fail(outcome);
    if (hasAccrue && idx === 0) {
      if (refused.code === NON_PROGRESS && !droppedAccrue) {
        pairingStats.accrueAlreadyDone++;
        ({ accrue, target, refresh } = dropAccrue(t, accrue, target, refresh));
        droppedAccrue = true;
        continue;
      }
      // The program refused the ANCHOR accrue (closed, filled, wrong): fall back to the counterparty form for this tx.
      if (accrue === "anchor" && refresh.length > 0 && refused.code !== NON_PROGRESS) {
        anchorRefused = true;
        pairingStats.anchorFallbacks++;
        accrue = "counterparty";
        target = refresh[0].pubkey;
        refresh = refresh.slice(1);
        continue;
      }
      // Accrue through a COUNTERPARTY the program refuses: isolate THAT portfolio and accrue through the next one.
      if (accrue === "counterparty" && target && refresh.length > 0) {
        const reason: PruneReason = refused.expected ? "band" : "hard";
        if (reason === "band") pairingStats.bandExpected++;
        else pairingStats.hardRefusals++;
        pruned.push({ key: target.toBase58(), reason, code: refused.code });
        target = refresh[0].pubkey;
        refresh = refresh.slice(1);
        continue;
      }
      return fail(outcome);
    }
    const refreshIdx = hasAccrue ? idx - 1 : idx;
    const victim = refresh[refreshIdx];
    if (!victim) return fail(outcome); // a refusal on the tail instruction (e.g. 78): the caller classifies it
    const reason: PruneReason = refused.code === NON_PROGRESS ? "current" : refused.expected ? "band" : "hard";
    if (reason === "current") pairingStats.prunedCurrent++;
    else if (reason === "band") pairingStats.bandExpected++;
    else pairingStats.hardRefusals++;
    pruned.push({ key: victim.pubkey.toBase58(), reason, code: refused.code });
    refresh = refresh.filter((_, i) => i !== refreshIdx);
  }
  return fail({ kind: "failed", error: "prune budget exhausted" });
}

function dropAccrue(t: PlannedTx, accrue: PlannedTx["accrue"], target: PublicKey | null, refresh: PositionedPortfolio[]) {
  // refresh-only: the accrue target that was also a SETTLE (LP, counterparty) becomes a plain refresh
  let r = refresh;
  if (target && (accrue === "lp" || accrue === "counterparty")) r = [{ pubkey: target, longLegs: 0, shortLegs: 0, isLp: accrue === "lp" }, ...refresh];
  void t;
  return { accrue: "none" as PlannedTx["accrue"], target: null as PublicKey | null, refresh: r };
}

/**
 * Plan and execute one round for one market. `counterparties` excludes the LP. Never throws.
 */
export async function runSettleRound(
  deps: SweepDeps,
  ctx: { market: PublicKey; label: string },
  input: RoundInput,
  cfg: SweepRoundConfig = DEFAULT_SWEEP_ROUND_CONFIG,
): Promise<RoundResult> {
  const hold = deps.hold ?? realHold;
  const release = deps.release ?? realRelease;
  const nowSlot = BigInt(input.nowSlot ?? 0);
  const quarantine = input.quarantine ?? new Map<string, bigint>();
  const history = input.quarantineHistory ?? new Map<string, { code: number; level: number }>();
  const backoff = input.gapBackoff;
  const protective = input.protective === true;
  const emptyRes = (plan: RoundPlan, abandoned: string | null, backedOff: boolean): RoundResult => ({ plan, txsSent: 0, settled: [], missing: [], rentSettled: [], backedOff, anchorRefused: false, pruned: 0, lpSettled: false, gapSlots: null, abandoned, outcomes: [] });

  // Gap backoff: after a round abandoned for a gap > maxGapSlots, skip a few rounds instead of re-sending phase 1 every tick.
  if (backoff && backoff.skipRounds > 0 && !protective) {
    backoff.skipRounds--;
    pairingStats.gapBackoffRounds++;
    return emptyRes(planSettleRound({ mode: cfg.pairing, lp: input.lp, counterparties: [] }), `gap backoff: ${backoff.skipRounds} more round(s) skipped`, true);
  }

  // Quarantined counterparties are not planned but are MISSING for the pairing decision.
  const missing: RoundResult["missing"] = [];
  const planned: PositionedPortfolio[] = [];
  for (const c of input.counterparties) {
    const k = c.pubkey.toBase58();
    const until = quarantine.get(k);
    if (until !== undefined && until > nowSlot) missing.push({ key: k, why: "quarantined" });
    else {
      if (until !== undefined) quarantine.delete(k);
      planned.push(c);
    }
  }
  pairingStats.quarantinedNow = [...quarantine.values()].filter((u) => u > nowSlot).length;

  const plan = planSettleRound({ mode: cfg.pairing, lp: input.lp, lpWeight: input.lpWeight, counterparties: planned, anchor: input.anchor ?? null, weightBudget: cfg.weightBudget, maxTxsPerRound: cfg.maxTxsPerRound });
  const res: RoundResult = { plan, txsSent: 0, settled: [], missing, rentSettled: [], backedOff: false, anchorRefused: false, pruned: 0, lpSettled: false, gapSlots: null, abandoned: null, outcomes: [] };
  pairingStats.rounds++;
  if (protective) pairingStats.protectiveRounds++;
  if (plan.txs.length <= 1) pairingStats.singleTxRounds++;
  else pairingStats.multiTxRounds++;
  if (plan.lpDeferred) pairingStats.lpDeferredStrict++;
  for (const t of plan.txs) {
    if (t.accrue === "anchor") pairingStats.anchorAccrues++;
    if (t.accrue === "counterparty") pairingStats.counterpartyAccrues++;
  }
  for (const u of plan.unvisited) res.missing.push({ key: u.pubkey.toBase58(), why: "unplanned" });

  const marketKey = ctx.market.toBase58();
  const holding = plan.needsPushHold && cfg.pairing !== "off";
  if (holding) hold(marketKey, cfg.holdMs);
  // Quarantine a program-refused portfolio: ladder by REPEAT of the same code; capped per round unless each code is distinct.
  const quarantinedThisRound = new Set<number>();
  let quarantinedCount = 0;
  const q = (key: string, code: number | null) => {
    if (code === null) return;
    if (quarantinedCount >= MAX_QUARANTINES_PER_ROUND && quarantinedThisRound.has(code)) {
      pairingStats.quarantineCapped++;
      return;
    }
    quarantinedCount++;
    quarantinedThisRound.add(code);
    const h = history.get(key);
    const level = h && h.code === code ? Math.min(h.level + 1, QUARANTINE_LADDER.length - 1) : 0;
    history.set(key, { code, level });
    quarantine.set(key, nowSlot + BigInt(QUARANTINE_LADDER[level]));
  };
  try {
    const [phase1, phase2] = plan.phases.length > 1 ? [plan.phases[0], plan.phases[1]] : [plan.phases[0] ?? [], [] as number[]];
    const runOpts = (isLp: boolean): RunTxOptions => ({
      oracleAccounts: input.oracleAccounts,
      lpGate: isLp ? (prunedNotSettled) => lpHold(prunedNotSettled.map((p) => p.reason === "deferred" ? "deferred" : p.key)) : undefined,
    });
    /**
     * Reason to hold the LP tx now, or null. A counterparty that did NOT land or was DEFERRED (no program code: compute /
     * runtime) always holds the LP. Only a REAL program refusal (band / hard) may be waived, by `prefer`, with the miss counted.
     */
    const lpHold = (extra: string[]): string | null => {
      if (protective) return null;
      const unlanded = res.missing.some((m) => m.why === "unlanded" || m.why === "deferred") || extra.includes("deferred");
      if (unlanded) return "a counterparty tx did not land or was deferred (no program refusal): the LP is not settled alone";
      const miss = res.missing.filter((m) => m.why !== "current").map((m) => m.key).concat(extra);
      if (miss.length > 0 && cfg.pairing === "strict") return `strict: ${miss.length} counterparties were refused or skipped; the LP waits`;
      return null;
    };
    const record = (r: TxRun) => {
      res.outcomes.push(r.outcome);
      res.pruned += r.pruned.length;
      if (r.outcome.kind === "sent") res.txsSent++;
      if (r.anchorRefused) res.anchorRefused = true;
      res.settled.push(...r.settled);
      for (const p of r.pruned) {
        if (p.reason === "current") res.settled.push(p.key);
        else {
          res.missing.push({ key: p.key, why: p.reason });
          if (p.reason === "band" || p.reason === "hard") q(p.key, p.code);
        }
      }
      for (const k of r.unlanded) res.missing.push({ key: k, why: "unlanded" });
    };
    const lpIsInPhase1 = plan.lpTxIndex !== null && phase1.includes(plan.lpTxIndex);
    const run = (i: number) => runPlannedTx(deps, ctx, plan.txs[i], runOpts(plan.txs[i].settlesLp));

    const p1 = await Promise.all(phase1.map(run));
    p1.forEach(record);
    const okRun = (r: TxRun) => (r.outcome.kind === "sent" && r.outcome.landed === "landed") || r.outcome.kind === "dry-run";
    const lastLanded = Math.max(0, ...p1.map((r) => (r.outcome.kind === "sent" ? r.outcome.landedSlot ?? 0 : 0)));
    const noteLp = (landedOk: boolean) => {
      res.lpSettled = landedOk;
      if (!landedOk) return;
      const misses = res.missing.filter((m) => m.why !== "current");
      if (plan.paired && misses.length === 0) pairingStats.pairedLpSettles++;
      else pairingStats.unpairedLpSettles++;
    };

    if (lpIsInPhase1) {
      const lpRun = p1[phase1.indexOf(plan.lpTxIndex as number)];
      noteLp(okRun(lpRun));
      if (lpRun.outcome.kind === "held") {
        if (lpRun.outcome.reason.startsWith("strict")) pairingStats.lpHeldCounterpartyMiss++;
        else pairingStats.lpHeldPhase1Unlanded++;
        res.abandoned = lpRun.outcome.reason;
      }
    }

    if (phase2.length > 0) {
      const hold1 = lpHold([]);
      if (hold1) {
        if (hold1.startsWith("a counterparty")) pairingStats.lpHeldPhase1Unlanded++;
        else pairingStats.lpHeldCounterpartyMiss++;
        res.abandoned = hold1;
        return res;
      }
      if (!protective && lastLanded > 0) {
        const now = await deps.getSlot();
        const gap = now - lastLanded;
        res.gapSlots = gap;
        pairingStats.lastGapSlots = gap;
        pairingStats.maxGapSlots = Math.max(pairingStats.maxGapSlots, gap);
        if (gap > cfg.maxGapSlots) {
          pairingStats.gapExceeded++;
          pairingStats.consecutiveGapExceeded++;
          if (backoff) {
            backoff.level = Math.min(backoff.level + 1, MAX_GAP_BACKOFF_ROUNDS);
            backoff.skipRounds = backoff.level;
          }
          res.abandoned = `slot gap ${gap} > ${cfg.maxGapSlots} between the counterparty txs and the LP tx; backing off ${backoff?.skipRounds ?? 0} round(s)`;
          return res;
        }
      }
      const lpRun = await runPlannedTx(deps, ctx, plan.txs[phase2[0]], runOpts(true));
      record(lpRun);
      noteLp(okRun(lpRun));
      if (lpRun.outcome.kind === "held") {
        if (lpRun.outcome.reason.startsWith("strict")) pairingStats.lpHeldCounterpartyMiss++;
        else pairingStats.lpHeldPhase1Unlanded++;
        res.abandoned = lpRun.outcome.reason;
      }
      if (res.lpSettled) {
        pairingStats.consecutiveGapExceeded = 0;
        if (backoff) backoff.level = 0;
        if (lpRun.outcome.kind === "sent" && lpRun.outcome.landedSlot !== null && lastLanded > 0) {
          res.gapSlots = lpRun.outcome.landedSlot - lastLanded;
          pairingStats.lastGapSlots = res.gapSlots;
          pairingStats.maxGapSlots = Math.max(pairingStats.maxGapSlots, res.gapSlots);
        }
      }
    } else if (res.lpSettled && backoff) {
      backoff.level = 0;
    }

    // Phase 3: rent. Only after the LP settled, only for portfolios this round already refreshed with the PLAIN crank
    // (so a liquidatable / B-stale counterparty was handled by the engine's own action choice), one tx each, sequentially
    // (tag 106 write-locks the LP, so these must not run in parallel with anything else).
    if (res.lpSettled && input.rent && input.rent.due.size > 0) {
      const settled = new Set(res.settled);
      let n = 0;
      for (const c of input.counterparties) {
        const k = c.pubkey.toBase58();
        if (n >= (input.rent.max ?? 4)) break;
        if (!input.rent.due.has(k) || !settled.has(k)) continue;
        n++;
        const out = await simulateAndSend(deps.exec, [input.rent.build(c)], { job: "rent-106", label: ctx.label, units: 600_000, expected: BAND_EXPECTED_CODES });
        res.outcomes.push(out);
        if ((out.kind === "sent" && out.landed === "landed") || out.kind === "dry-run") {
          res.rentSettled.push(k);
          pairingStats.rentSettlesInRound++;
        }
      }
    }
    return res;
  } catch (err) {
    res.abandoned = `round failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160);
    return res;
  } finally {
    if (holding) release(marketKey);
  }
}
