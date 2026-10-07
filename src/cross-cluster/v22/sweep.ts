/**
 * cross-cluster/v22/sweep.ts
 *
 * The positioned-refresh sweep for v2.2 markets (KEEPER_V22_SWEEP). A round is planned by settle-pairing.ts
 * (`planSettleRound`): txs shaped [accrue crank, refresh xN], heaviest stale weight first, budgeted by LEG WEIGHT
 * (a refresh weighs 3 + legs), the LP's settle paired with its counterparties (SETTLE_PAIRING).
 *
 * Execution of a round:
 *   - every tx is simulated first; a refresh the engine says is not stale (Custom(22) at that refresh) is pruned and
 *     the tx re-simulated; an accrue crank that answers Custom(22) (an earlier tx of the round already accrued this
 *     slot) is dropped, leaving the refresh-only form. Band-market expected refusals (104/111/112/113) drop the
 *     portfolio and are COUNTED as states, never as failures.
 *   - phase 1 (counterparty txs) goes out in parallel; the LP tx goes out only after phase 1 landed and only inside
 *     `maxGapSlots` of the last phase-1 landing; pushes of the market are held for the round.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildObservationCrankIx, buildRefreshCrankIx } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { holdPushes as realHold, releasePushes as realRelease } from "../refresh-coordination.ts";
import { BAND_EXPECTED_CODES } from "./errors.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import { DEFAULT_MAX_GAP_SLOTS, DEFAULT_MAX_TXS_PER_ROUND, DEFAULT_WEIGHT_BUDGET, planSettleRound, portfolioWeight } from "./settle-pairing.ts";
import type { PlannedTx, RoundPlan } from "./settle-pairing.ts";
import type { PairingMode } from "./flags.ts";

const NON_PROGRESS = 22;
export const SWEEP_TX_UNITS = 1_400_000;
export const SWEEP_MAX_PRUNES = 6;

export interface SweepRoundConfig {
  pairing: PairingMode;
  weightBudget: number;
  maxTxsPerRound: number;
  maxGapSlots: number;
  /** Rounds in which the LP was skipped for a failed phase 1 before `prefer` settles it anyway. */
  lpSkipLimit: number;
  /** How long the market's pushes are held during a multi-tx round. */
  holdMs: number;
}

export const DEFAULT_SWEEP_ROUND_CONFIG: SweepRoundConfig = {
  pairing: "prefer",
  weightBudget: DEFAULT_WEIGHT_BUDGET,
  maxTxsPerRound: DEFAULT_MAX_TXS_PER_ROUND,
  maxGapSlots: DEFAULT_MAX_GAP_SLOTS,
  lpSkipLimit: 3,
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
  /** LP settled while counterparties were unvisited (prefer's counted degradation, and mode off's legacy shape). */
  unpairedLpSettles: number;
  lpDeferredStrict: number;
  lpSkippedPhase1Failed: number;
  gapExceeded: number;
  lastGapSlots: number | null;
  maxGapSlots: number;
  bandExpected: number;
  prunedRefreshes: number;
}

export const pairingStats: PairingStats = {
  rounds: 0,
  singleTxRounds: 0,
  multiTxRounds: 0,
  pairedLpSettles: 0,
  unpairedLpSettles: 0,
  lpDeferredStrict: 0,
  lpSkippedPhase1Failed: 0,
  gapExceeded: 0,
  lastGapSlots: null,
  maxGapSlots: 0,
  bandExpected: 0,
  prunedRefreshes: 0,
};

export function resetPairingStats(): void {
  Object.assign(pairingStats, {
    rounds: 0,
    singleTxRounds: 0,
    multiTxRounds: 0,
    pairedLpSettles: 0,
    unpairedLpSettles: 0,
    lpDeferredStrict: 0,
    lpSkippedPhase1Failed: 0,
    gapExceeded: 0,
    lastGapSlots: null,
    maxGapSlots: 0,
    bandExpected: 0,
    prunedRefreshes: 0,
  });
}

export interface RoundResult {
  plan: RoundPlan;
  txsSent: number;
  refreshed: number;
  pruned: number;
  lpSettled: boolean;
  /** Slots between the last phase-1 landing and the LP tx landing (multi-tx rounds). */
  gapSlots: number | null;
  abandoned: string | null;
  outcomes: ExecOutcome[];
}

/** The instruction list of one planned tx (accrue crank first, then the refreshes). */
export function buildSweepTxIxs(owner: PublicKey, market: PublicKey, tx: { accrue: PlannedTx["accrue"]; accrueTarget: PublicKey | null; refresh: ReadonlyArray<PositionedPortfolio> }): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (tx.accrue !== "none" && tx.accrueTarget) ixs.push(buildObservationCrankIx(owner, market, tx.accrueTarget));
  for (const p of tx.refresh) ixs.push(buildRefreshCrankIx(owner, market, p.pubkey));
  return ixs;
}

interface TxRun {
  outcome: ExecOutcome;
  pruned: PositionedPortfolio[];
  refreshed: number;
  droppedAccrue: boolean;
}

/** Run one planned tx with simulate-prune. */
async function runPlannedTx(deps: SweepDeps, ctx: { market: PublicKey; label: string }, t: PlannedTx, lpKey: PublicKey | null): Promise<TxRun> {
  const owner = deps.exec.keeper.publicKey;
  let accrue: PlannedTx["accrue"] = t.accrue;
  let target = t.accrueTarget;
  let refresh = [...t.refresh];
  const pruned: PositionedPortfolio[] = [];
  let droppedAccrue = false;
  for (let attempt = 0; ; attempt++) {
    const ixs = buildSweepTxIxs(owner, ctx.market, { accrue, accrueTarget: target, refresh });
    if (ixs.length === 0) return { outcome: { kind: "dry-run", unitsConsumed: null, logs: [], ixCount: 0 }, pruned, refreshed: 0, droppedAccrue };
    const outcome = await simulateAndSend(deps.exec, ixs, { job: "sweep", label: ctx.label, units: SWEEP_TX_UNITS, expected: BAND_EXPECTED_CODES });
    if (outcome.kind !== "refused" || attempt >= SWEEP_MAX_PRUNES || outcome.index === null) {
      const landed = outcome.kind === "sent" && outcome.landed === "landed";
      return { outcome, pruned, refreshed: landed || outcome.kind === "dry-run" ? refresh.length + (accrue !== "none" && target && t.accrue === "counterparty" ? 1 : 0) : 0, droppedAccrue };
    }
    const hasAccrue = accrue !== "none" && target !== null;
    const refreshIdx = hasAccrue ? outcome.index - 1 : outcome.index;
    if (hasAccrue && outcome.index === 0) {
      if (outcome.code === NON_PROGRESS) {
        // an earlier tx of the round accrued this slot: refresh-only. The LP settle then rides as a refresh of the LP.
        if (t.accrue === "lp" && target) refresh = [{ pubkey: target, longLegs: 0, shortLegs: 0, isLp: true }, ...refresh];
        if (t.accrue === "counterparty" && target) refresh = [{ pubkey: target, longLegs: 0, shortLegs: 0, isLp: false }, ...refresh];
        accrue = "none";
        target = null;
        droppedAccrue = true;
        continue;
      }
      return { outcome, pruned, refreshed: 0, droppedAccrue };
    }
    const victim = refresh[refreshIdx];
    if (!victim || (outcome.code !== NON_PROGRESS && !outcome.expected)) return { outcome, pruned, refreshed: 0, droppedAccrue };
    if (outcome.expected) pairingStats.bandExpected++;
    else pairingStats.prunedRefreshes++;
    pruned.push(victim);
    refresh = refresh.filter((_, i) => i !== refreshIdx);
    void lpKey;
  }
}

/**
 * Plan and execute one round for one market. `counterparties` excludes the LP. Never throws.
 */
export async function runSettleRound(
  deps: SweepDeps,
  ctx: { market: PublicKey; label: string },
  input: { lp: PublicKey; lpWeight?: number; counterparties: ReadonlyArray<PositionedPortfolio>; anchor?: PublicKey | null; lpSkips?: { count: number } },
  cfg: SweepRoundConfig = DEFAULT_SWEEP_ROUND_CONFIG,
): Promise<RoundResult> {
  const hold = deps.hold ?? realHold;
  const release = deps.release ?? realRelease;
  const plan = planSettleRound({ mode: cfg.pairing, lp: input.lp, lpWeight: input.lpWeight, counterparties: input.counterparties, anchor: input.anchor, weightBudget: cfg.weightBudget, maxTxsPerRound: cfg.maxTxsPerRound });
  const res: RoundResult = { plan, txsSent: 0, refreshed: 0, pruned: 0, lpSettled: false, gapSlots: null, abandoned: null, outcomes: [] };
  pairingStats.rounds++;
  if (plan.txs.length <= 1) pairingStats.singleTxRounds++;
  else pairingStats.multiTxRounds++;
  if (plan.lpDeferred) pairingStats.lpDeferredStrict++;

  const marketKey = ctx.market.toBase58();
  const holding = plan.needsPushHold && cfg.pairing !== "off";
  if (holding) hold(marketKey, cfg.holdMs);
  try {
    const [phase1, phase2] = plan.phases.length > 1 ? [plan.phases[0], plan.phases[1]] : [plan.phases[0] ?? [], [] as number[]];
    const record = (r: TxRun) => {
      res.outcomes.push(r.outcome);
      res.pruned += r.pruned.length;
      res.refreshed += r.refreshed;
      if (r.outcome.kind === "sent") res.txsSent++;
    };
    const run = (i: number) => runPlannedTx(deps, ctx, plan.txs[i], input.lp);

    const p1 = await Promise.all(phase1.map(run));
    p1.forEach(record);
    const ok = (r: TxRun) => (r.outcome.kind === "sent" && r.outcome.landed === "landed") || r.outcome.kind === "dry-run";
    const phase1Ok = p1.every(ok);
    const lastLanded = Math.max(0, ...p1.map((r) => (r.outcome.kind === "sent" ? r.outcome.landedSlot ?? 0 : 0)));

    // The LP tx rides in phase 1 when the plan has one phase (single tx / mode off).
    const lpInPhase1 = plan.lpTxIndex !== null && phase1.includes(plan.lpTxIndex);
    if (lpInPhase1) {
      const lpRun = p1[phase1.indexOf(plan.lpTxIndex as number)];
      res.lpSettled = ok(lpRun);
      if (res.lpSettled) {
        if (plan.paired) pairingStats.pairedLpSettles++;
        else if (plan.unpairedLpSettle) pairingStats.unpairedLpSettles++;
      }
    }

    if (phase2.length > 0) {
      const skips = input.lpSkips ?? { count: 0 };
      if (!phase1Ok) {
        skips.count++;
        const force = cfg.pairing === "prefer" && skips.count > cfg.lpSkipLimit;
        if (!force) {
          pairingStats.lpSkippedPhase1Failed++;
          res.abandoned = `phase 1 did not fully land; the LP is not settled alone (skip ${skips.count}${cfg.pairing === "prefer" ? `/${cfg.lpSkipLimit}` : ""})`;
          return res;
        }
        res.abandoned = null;
        pairingStats.unpairedLpSettles++;
      }
      if (phase1Ok && lastLanded > 0) {
        const now = await deps.getSlot();
        const gap = now - lastLanded;
        res.gapSlots = gap;
        pairingStats.lastGapSlots = gap;
        pairingStats.maxGapSlots = Math.max(pairingStats.maxGapSlots, gap);
        if (gap > cfg.maxGapSlots) {
          pairingStats.gapExceeded++;
          res.abandoned = `slot gap ${gap} > ${cfg.maxGapSlots} between the counterparty txs and the LP tx; round re-planned next tick`;
          return res;
        }
      }
      const lpRun = await run(phase2[0]);
      record(lpRun);
      res.lpSettled = ok(lpRun);
      if (res.lpSettled) {
        skips.count = 0;
        if (plan.paired && phase1Ok) pairingStats.pairedLpSettles++;
        else pairingStats.unpairedLpSettles++;
        if (lpRun.outcome.kind === "sent" && lpRun.outcome.landedSlot !== null && lastLanded > 0) {
          res.gapSlots = lpRun.outcome.landedSlot - lastLanded;
          pairingStats.lastGapSlots = res.gapSlots;
          pairingStats.maxGapSlots = Math.max(pairingStats.maxGapSlots, res.gapSlots);
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

export { portfolioWeight };
