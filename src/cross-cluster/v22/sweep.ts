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
 * refusals put the portfolio on a cool-down (`quarantine`). A tag-106 refresh replaces a plain refresh for a
 * portfolio whose rent is due, so rent settles ride the round (never a lone counterparty settle). A landed tx that
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
import { DEFAULT_MAX_GAP_SLOTS, DEFAULT_MAX_TXS_PER_ROUND, DEFAULT_WEIGHT_BUDGET, RENT_EXTRA_WEIGHT, planSettleRound } from "./settle-pairing.ts";
import type { PlannedTx, RoundPlan } from "./settle-pairing.ts";
import type { PairingMode } from "./flags.ts";

const NON_PROGRESS = 22;
export const SWEEP_TX_UNITS = 1_400_000;
export const SWEEP_MAX_PRUNES = 8;
/** Cool-downs (slots) after a refused refresh. */
export const QUARANTINE_BAND_SLOTS = 150;
export const QUARANTINE_HARD_SLOTS = 1_500;
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
  /** Accrue went through a counterparty because the market had no keeper-owned flat anchor. */
  counterpartyAccrues: number;
  accrueAlreadyDone: number;
  protectiveRounds: number;
  rentSettlesInRound: number;
  feeAfterRound: number;
  feeUnpairedLpSettles: number;
}

const zeroStats = (): PairingStats => ({
  rounds: 0, singleTxRounds: 0, multiTxRounds: 0, pairedLpSettles: 0, unpairedLpSettles: 0, lpDeferredStrict: 0,
  lpHeldPhase1Unlanded: 0, lpHeldCounterpartyMiss: 0, gapExceeded: 0, gapBackoffRounds: 0, consecutiveGapExceeded: 0,
  lastGapSlots: null, maxGapSlots: 0, bandExpected: 0, prunedCurrent: 0, hardRefusals: 0, quarantinedNow: 0,
  anchorAccrues: 0, counterpartyAccrues: 0, accrueAlreadyDone: 0, protectiveRounds: 0, rentSettlesInRound: 0,
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

export interface RentPlanInput {
  /** base58 portfolio keys whose rent is due this round. */
  due: ReadonlySet<string>;
  build: (p: PositionedPortfolio) => TransactionInstruction;
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
  nowSlot?: number;
  gapBackoff?: GapBackoff;
  rent?: RentPlanInput;
  /** The LP itself needs a crank now: legacy full recovery shape, never alone, no gap / phase-1 hold. */
  protective?: boolean;
}

export type PruneReason = "current" | "band" | "hard" | "deferred";

export interface RoundResult {
  plan: RoundPlan;
  txsSent: number;
  /** Counterparties that settled (landed or already current). */
  settled: string[];
  /** Counterparties not settled this round, with why. */
  missing: Array<{ key: string; why: "quarantined" | PruneReason | "unlanded" | "unplanned" }>;
  rentSettled: string[];
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
  rent?: RentPlanInput;
  /** keys whose rent settle is replaced by a plain refresh (the 106 was refused). */
  noRent?: ReadonlySet<string>;
  tail?: ReadonlyArray<TransactionInstruction>;
}

/** The instruction list of one planned tx (accrue crank first, then the refreshes / rent settles, then a tail). */
export function buildSweepTxIxs(owner: PublicKey, market: PublicKey, tx: BuildTxArgs): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (tx.accrue !== "none" && tx.accrueTarget) ixs.push(buildObservationCrankIx(owner, market, tx.accrueTarget, tx.oracleAccounts ?? []));
  for (const p of tx.refresh) {
    const k = p.pubkey.toBase58();
    if (tx.rent && tx.rent.due.has(k) && !tx.noRent?.has(k)) ixs.push(tx.rent.build(p));
    else ixs.push(buildRefreshCrankIx(owner, market, p.pubkey));
  }
  for (const t of tx.tail ?? []) ixs.push(t);
  return ixs;
}

interface TxRun {
  outcome: ExecOutcome;
  /** counterparties settled by this tx (empty unless it landed / dry-ran). */
  settled: string[];
  pruned: Array<{ key: string; reason: PruneReason }>;
  /** refreshes of this tx that did not settle because the tx did not land. */
  unlanded: string[];
  rentKeys: string[];
  droppedAccrue: boolean;
}

export interface RunTxOptions {
  oracleAccounts?: ReadonlyArray<PublicKey>;
  rent?: RentPlanInput;
  tail?: ReadonlyArray<TransactionInstruction>;
  /** Codes at the tail instruction that are expected (e.g. 38 for tag 78). */
  tailExpected?: ReadonlySet<number>;
  job?: string;
  /** Extra expected codes for this tx (the tail's, e.g. 38 for tag 78). */
  expected?: ReadonlySet<number>;
  /** LP tx gate: given the keys pruned for a reason other than "current" so far, a reason to hold the send. */
  lpGate?: (prunedNotSettled: string[]) => string | null;
}

/** Run one planned tx with simulate-prune-isolate. Exported for the tag-78 job. */
export async function runPlannedTx(deps: SweepDeps, ctx: { market: PublicKey; label: string }, t: PlannedTx, o: RunTxOptions = {}): Promise<TxRun> {
  const owner = deps.exec.keeper.publicKey;
  let accrue: PlannedTx["accrue"] = t.accrue;
  let target = t.accrueTarget;
  let refresh = [...t.refresh];
  const pruned: TxRun["pruned"] = [];
  const noRent = new Set<string>();
  let droppedAccrue = false;
  let shrinks = 0;
  const budget = SWEEP_MAX_PRUNES + 3;
  const settledKeys = (): string[] => {
    // the first counterparty is settled by its own accrue crank when the accrue went through it
    const ks = refresh.map((p) => p.pubkey.toBase58());
    if (accrue === "counterparty" && target) ks.unshift(target.toBase58());
    return ks;
  };
  const rentKeysNow = (): string[] => (o.rent ? refresh.map((p) => p.pubkey.toBase58()).filter((k) => o.rent!.due.has(k) && !noRent.has(k)) : []);
  for (let attempt = 0; attempt <= budget; attempt++) {
    const hasAccrue = accrue !== "none" && target !== null;
    const ixs = buildSweepTxIxs(owner, ctx.market, { accrue, accrueTarget: target, refresh, oracleAccounts: o.oracleAccounts, rent: o.rent, noRent, tail: o.tail });
    if (ixs.length === 0) return { outcome: { kind: "dry-run", unitsConsumed: null, logs: [], ixCount: 0 }, settled: [], pruned, unlanded: [], rentKeys: [], droppedAccrue };
    const outcome = await simulateAndSend(deps.exec, ixs, {
      job: o.job ?? "sweep",
      label: ctx.label,
      units: SWEEP_TX_UNITS,
      expected: o.expected ? new Set([...BAND_EXPECTED_CODES, ...o.expected]) : BAND_EXPECTED_CODES,
      beforeSend: () => (t.settlesLp && o.lpGate ? o.lpGate(pruned.filter((p) => p.reason !== "current").map((p) => p.key)) : null),
    });
    const landed = outcome.kind === "sent" && outcome.landed === "landed";
    if (landed || outcome.kind === "dry-run") {
      return { outcome, settled: settledKeys(), pruned, unlanded: [], rentKeys: rentKeysNow(), droppedAccrue };
    }
    // A landed tx that failed on its accrue crank with Custom(22): another tx accrued this slot. Continue refresh-only.
    if (outcome.kind === "sent" && outcome.landed === "failed" && outcome.failCode === NON_PROGRESS && hasAccrue && !droppedAccrue) {
      pairingStats.accrueAlreadyDone++;
      ({ accrue, target, refresh } = dropAccrue(t, accrue, target, refresh));
      droppedAccrue = true;
      continue;
    }
    if (outcome.kind === "sent" || outcome.kind === "held" || outcome.kind === "failed") {
      return { outcome, settled: [], pruned, unlanded: settledKeys(), rentKeys: [], droppedAccrue };
    }
    // refused in simulation
    const refused = outcome as Extract<ExecOutcome, { kind: "refused" }>;
    if (refused.index === null) {
      // compute exhaustion or an error with no instruction index: shrink the tx (the cut refreshes are NOT settled).
      if (refresh.length > 1 && shrinks < 3) {
        shrinks++;
        const cut = Math.max(1, Math.ceil(refresh.length / 4));
        for (const p of refresh.slice(-cut)) pruned.push({ key: p.pubkey.toBase58(), reason: "deferred" });
        refresh = refresh.slice(0, -cut);
        continue;
      }
      return { outcome, settled: [], pruned, unlanded: settledKeys(), rentKeys: [], droppedAccrue };
    }
    const idx = refused.index;
    if (hasAccrue && idx === 0) {
      if (refused.code === NON_PROGRESS && !droppedAccrue) {
        pairingStats.accrueAlreadyDone++;
        ({ accrue, target, refresh } = dropAccrue(t, accrue, target, refresh));
        droppedAccrue = true;
        continue;
      }
      // Accrue through a COUNTERPARTY that the program refuses: isolate THAT portfolio (prune it) and accrue through the
      // next one. An LP / anchor accrue target that is refused cannot be isolated: the tx is refused.
      if (accrue === "counterparty" && target && refresh.length > 0) {
        const reason: PruneReason = refused.expected ? "band" : "hard";
        if (reason === "band") pairingStats.bandExpected++;
        else pairingStats.hardRefusals++;
        pruned.push({ key: target.toBase58(), reason });
        target = refresh[0].pubkey;
        refresh = refresh.slice(1);
        continue;
      }
      return { outcome, settled: [], pruned, unlanded: settledKeys(), rentKeys: [], droppedAccrue };
    }
    const refreshIdx = hasAccrue ? idx - 1 : idx;
    const victim = refresh[refreshIdx];
    if (!victim) {
      // a refusal on the tail instruction (e.g. 78): the caller classifies it
      return { outcome, settled: [], pruned, unlanded: settledKeys(), rentKeys: [], droppedAccrue };
    }
    const vk = victim.pubkey.toBase58();
    const isRent = !!o.rent && o.rent.due.has(vk) && !noRent.has(vk);
    if (isRent && refused.code !== NON_PROGRESS) {
      // the tag-106 settle was refused: fall back to the plain refresh for this portfolio (rent waits)
      noRent.add(vk);
      continue;
    }
    const reason: PruneReason = refused.code === NON_PROGRESS ? "current" : refused.expected ? "band" : "hard";
    if (reason === "current") pairingStats.prunedCurrent++;
    else if (reason === "band") pairingStats.bandExpected++;
    else pairingStats.hardRefusals++;
    pruned.push({ key: vk, reason });
    refresh = refresh.filter((_, i) => i !== refreshIdx);
  }
  return { outcome: { kind: "failed", error: "prune budget exhausted" }, settled: [], pruned, unlanded: settledKeys(), rentKeys: [], droppedAccrue };
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
  const backoff = input.gapBackoff;
  const protective = input.protective === true;
  const empty = (plan: RoundPlan, abandoned: string | null): RoundResult => ({ plan, txsSent: 0, settled: [], missing: [], rentSettled: [], pruned: 0, lpSettled: false, gapSlots: null, abandoned, outcomes: [] });

  // Gap backoff: after a round abandoned for a gap > maxGapSlots, skip a few rounds instead of re-sending phase 1 every tick.
  if (backoff && backoff.skipRounds > 0 && !protective) {
    backoff.skipRounds--;
    pairingStats.gapBackoffRounds++;
    return empty(planSettleRound({ mode: cfg.pairing, lp: input.lp, counterparties: [] }), `gap backoff: ${backoff.skipRounds} more round(s) skipped`);
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
      const due = input.rent?.due.has(k) === true;
      planned.push(due ? ({ ...c, extraWeight: RENT_EXTRA_WEIGHT } as PositionedPortfolio) : c);
    }
  }
  pairingStats.quarantinedNow = [...quarantine.values()].filter((u) => u > nowSlot).length;

  const plan = planSettleRound({ mode: cfg.pairing, lp: input.lp, lpWeight: input.lpWeight, counterparties: planned, anchor: input.anchor ?? null, weightBudget: cfg.weightBudget, maxTxsPerRound: cfg.maxTxsPerRound });
  const res: RoundResult = { plan, txsSent: 0, settled: [], missing, rentSettled: [], pruned: 0, lpSettled: false, gapSlots: null, abandoned: null, outcomes: [] };
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
  const q = (key: string, reason: PruneReason) => {
    quarantine.set(key, nowSlot + BigInt(reason === "band" ? QUARANTINE_BAND_SLOTS : QUARANTINE_HARD_SLOTS));
  };
  try {
    const [phase1, phase2] = plan.phases.length > 1 ? [plan.phases[0], plan.phases[1]] : [plan.phases[0] ?? [], [] as number[]];
    const runOpts = (isLp: boolean): RunTxOptions => ({
      oracleAccounts: input.oracleAccounts,
      rent: input.rent,
      lpGate: isLp ? (prunedNotSettled) => lpHold(prunedNotSettled) : undefined,
    });
    /** Reason to hold the LP tx now, or null. `extra` = keys the LP tx itself pruned. */
    const lpHold = (extra: string[]): string | null => {
      if (protective) return null;
      const miss = res.missing.filter((m) => m.why !== "current").map((m) => m.key).concat(extra);
      const unlanded = res.missing.some((m) => m.why === "unlanded");
      if (unlanded) return "a counterparty tx did not land: the LP is not settled alone";
      if (miss.length > 0 && cfg.pairing === "strict") return `strict: ${miss.length} counterparties were refused or skipped; the LP waits`;
      return null;
    };
    const record = (r: TxRun) => {
      res.outcomes.push(r.outcome);
      res.pruned += r.pruned.length;
      if (r.outcome.kind === "sent") res.txsSent++;
      res.settled.push(...r.settled);
      res.rentSettled.push(...r.rentKeys);
      for (const p of r.pruned) {
        if (p.reason === "current") res.settled.push(p.key);
        else {
          res.missing.push({ key: p.key, why: p.reason });
          if (p.reason === "band" || p.reason === "hard") q(p.key, p.reason);
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
        res.abandoned = lpRun.outcome.reason;
      }
    }

    if (phase2.length > 0) {
      const hold1 = lpHold([]);
      if (hold1) {
        if (hold1.startsWith("a counterparty tx")) pairingStats.lpHeldPhase1Unlanded++;
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
    return res;
  } catch (err) {
    res.abandoned = `round failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160);
    return res;
  } finally {
    if (holding) release(marketKey);
  }
}
