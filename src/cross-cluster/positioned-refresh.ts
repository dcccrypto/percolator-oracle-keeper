/**
 * cross-cluster/positioned-refresh.ts
 *
 * Pure helpers for the recovery cranker's "accrue, then refresh every
 * positioned portfolio" transaction. Kept free of RPC so the decoding and the
 * transaction plan can be tested against real devnet account bytes.
 *
 * Why the cranker needs this (measured on devnet 2026-09-28, engine c141d47f,
 * predicate unchanged at 35ddd692):
 *
 *   The loss-stale predicate is `asset_is_loss_stale_at_slot` (v16.rs ~7558):
 *
 *     stale_account_count_long != 0
 *       || stale_account_count_short != 0
 *       || (asset has exposure && asset.slot_last < header.current_slot)
 *
 *   Every accrual that moves K or F for a side runs
 *   `kernel_mark_kf_stale_cohorts`, which sets
 *   `stale_account_count_<side> = stored_pos_count_<side>`. The count only goes
 *   back down as each positioned portfolio is refreshed. The keeper's
 *   observation crank accrues the market through the LP portfolio, so after it
 *   lands every other positioned portfolio (and the LP itself) is stale, the
 *   market reads `loss_stale_active = 1`, and risk-increasing trades revert
 *   `Custom(21)` (EngineLockActive) until someone refreshes all of them.
 *
 *   A refresh is a PermissionlessCrank with NO observation. The engine's
 *   planner (`select_auto_crank_plan`, v16.rs ~2269) picks `RefreshAccount`
 *   for a stale account and uses the committed price. The wrapper only accepts
 *   that when nothing is pending for the asset:
 *   `reject_incomplete_asset_health_observation_view` returns
 *   `EngineNonProgress` (Custom(22)) if `dt != 0` and the mark or funding would
 *   still move. So the refreshes have to run in the same transaction as the
 *   accrual, after it, where `dt == 0`. A no-observation crank on an account
 *   that is not stale selects `NoAction` and also returns Custom(22), which
 *   would revert the whole transaction; the cranker prunes such refreshes by
 *   simulating first.
 *
 *   The observation crank is capped at `max_accrual_dt_slots` per call. If the
 *   gap is larger, the wrapper commits a partial accrual and returns early
 *   (`bounded_market_catchup_only`) without refreshing anything, and a
 *   refresh after it fails. So when the market is behind, the plan puts
 *   `floor(gap / max_accrual_dt_slots)` bounded catch-up cranks first.
 */
import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  encodePermissionlessCrank,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_PORTFOLIO_ACCOUNT_LEN,
  parsePortfolioV17,
} from "@percolatorct/sdk";

import { buildLivenessRepairIx } from "./liveness-repair.ts";
import type { LivenessRepair } from "./liveness-repair.ts";

import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

/** The asset every registry market trades (single-asset markets). */
export const REFRESH_ASSET_INDEX = 0;

// ── Market account offsets ────────────────────────────────────────────────
// Group header (MarketGroupV16HeaderAccount) starts at V17_MARKET_GROUP_OFF:
//   +0   market_group_id [32]
//   +32  V16ConfigAccount: max_portfolio_assets u16, max_market_slots u32,
//        min_nonzero_mm_req u128, min_nonzero_im_req u128, h_min, h_max,
//        maintenance_margin_bps, initial_margin_bps, max_trading_fee_bps,
//        liquidation_fee_bps (u64 x6), liquidation_fee_cap u128,
//        min_liquidation_abs u128, max_accrual_dt_slots u64  => +150
// current_slot (+613) and loss_stale_active (+623) were cross-checked against
// live devnet reads: current_slot equals asset.slot_last right after a crank,
// and loss_stale_active tracks the predicate above.
const G = V17_MARKET_GROUP_OFF;
const HDR_MAX_ACCRUAL_DT_SLOTS = G + 150;
const HDR_CURRENT_SLOT = G + 613;
const HDR_LOSS_STALE_ACTIVE = G + 623;

// Asset slot i = [wrapper oracle block 1024][AssetStateV16Account ...].
const ASSET_SLOT_BASE = G + V17_MARKET_GROUP_LEN;
const ASSET_SLOT_LEN = 2325;
const ASSET_WRAPPER_LEN = 1024;
// AssetStateV16Account field offsets (repr(C), all Pod byte arrays, no padding).
const AS_LIFECYCLE = 16;
const AS_SLOT_LAST = 41;
const AS_KF_EPOCH_LONG = 145;
const AS_KF_EPOCH_SHORT = 153;
const AS_OI_EFF_LONG = 289;
const AS_OI_EFF_SHORT = 305;
const AS_STORED_POS_LONG = 321;
const AS_STORED_POS_SHORT = 329;
const AS_STALE_LONG = 337;
const AS_STALE_SHORT = 345;
const AS_PENDING_OBL_LONG = 353;
const AS_PENDING_OBL_SHORT = 361;
const AS_LOSS_WEIGHT_LONG = 369;
const AS_LOSS_WEIGHT_SHORT = 385;

const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;

export interface MarketRefreshState {
  maxAccrualDtSlots: bigint;
  currentSlot: bigint;
  lossStaleActive: boolean;
  lifecycle: number;
  slotLast: bigint;
  kfEpochLong: bigint;
  kfEpochShort: bigint;
  storedPosLong: bigint;
  storedPosShort: bigint;
  staleLong: bigint;
  staleShort: bigint;
  /** asset_contributes_to_loss_stale_summary (v16.rs ~7542). */
  contributesToLossStale: boolean;
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}
function u128(d: Uint8Array, off: number): bigint {
  return u64(d, off) | (u64(d, off + 8) << 64n);
}

export function decodeMarketRefreshState(
  data: Uint8Array,
  assetIndex = REFRESH_ASSET_INDEX,
): MarketRefreshState {
  const a = ASSET_SLOT_BASE + assetIndex * ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
  if (data.length < a + AS_LOSS_WEIGHT_SHORT + 16) {
    throw new Error(`decodeMarketRefreshState: market account too short (${data.length} bytes)`);
  }
  const lifecycle = data[a + AS_LIFECYCLE];
  const storedPosLong = u64(data, a + AS_STORED_POS_LONG);
  const storedPosShort = u64(data, a + AS_STORED_POS_SHORT);
  const staleLong = u64(data, a + AS_STALE_LONG);
  const staleShort = u64(data, a + AS_STALE_SHORT);
  const contributesToLossStale =
    (lifecycle === LIFECYCLE_ACTIVE || lifecycle === LIFECYCLE_DRAIN_ONLY) &&
    (u128(data, a + AS_OI_EFF_LONG) !== 0n ||
      u128(data, a + AS_OI_EFF_SHORT) !== 0n ||
      storedPosLong !== 0n ||
      storedPosShort !== 0n ||
      staleLong !== 0n ||
      staleShort !== 0n ||
      u64(data, a + AS_PENDING_OBL_LONG) !== 0n ||
      u64(data, a + AS_PENDING_OBL_SHORT) !== 0n ||
      u128(data, a + AS_LOSS_WEIGHT_LONG) !== 0n ||
      u128(data, a + AS_LOSS_WEIGHT_SHORT) !== 0n);
  return {
    maxAccrualDtSlots: u64(data, HDR_MAX_ACCRUAL_DT_SLOTS),
    currentSlot: u64(data, HDR_CURRENT_SLOT),
    lossStaleActive: data[HDR_LOSS_STALE_ACTIVE] !== 0,
    lifecycle,
    slotLast: u64(data, a + AS_SLOT_LAST),
    kfEpochLong: u64(data, a + AS_KF_EPOCH_LONG),
    kfEpochShort: u64(data, a + AS_KF_EPOCH_SHORT),
    storedPosLong,
    storedPosShort,
    staleLong,
    staleShort,
    contributesToLossStale,
  };
}

/** Absolute byte offsets of stale_account_count_long/short for `assetIndex` (tests patch these). */
export function staleCountOffsets(assetIndex = REFRESH_ASSET_INDEX): { long: number; short: number } {
  const a = ASSET_SLOT_BASE + assetIndex * ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
  return { long: a + AS_STALE_LONG, short: a + AS_STALE_SHORT };
}

/** Mirror of `asset_is_loss_stale_at_slot(asset, header.current_slot)`. */
export function isAssetLossStale(s: MarketRefreshState): boolean {
  return (
    s.staleLong !== 0n ||
    s.staleShort !== 0n ||
    (s.contributesToLossStale && s.slotLast < s.currentSlot)
  );
}

/** True when the market has any stored position, i.e. an accrual can re-stale someone. */
export function marketHasPositions(s: MarketRefreshState): boolean {
  return s.storedPosLong !== 0n || s.storedPosShort !== 0n;
}

export interface PositionedPortfolio {
  pubkey: PublicKey;
  longLegs: number;
  shortLegs: number;
  isLp: boolean;
}

/**
 * Portfolios of this market that hold an active leg on `assetIndex`. Accounts
 * that are not full-size portfolios, or do not decode, are skipped. A leg is
 * counted by its side (0 = long, 1 = short), which is how
 * `stored_pos_count_<side>` counts it.
 */
export function selectPositionedPortfolios(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  assetIndex = REFRESH_ASSET_INDEX,
): PositionedPortfolio[] {
  const out: PositionedPortfolio[] = [];
  for (const { pubkey, data } of accounts) {
    if (data.length !== V17_PORTFOLIO_ACCOUNT_LEN) continue;
    let parsed;
    try {
      parsed = parsePortfolioV17(data);
    } catch {
      continue;
    }
    let longLegs = 0;
    let shortLegs = 0;
    for (const leg of parsed.legs) {
      if (!leg.active || leg.assetIndex !== assetIndex) continue;
      if (leg.side === 0) longLegs++;
      else shortLegs++;
    }
    if (longLegs + shortLegs === 0) continue;
    out.push({ pubkey, longLegs, shortLegs, isLp: parsed.matcherEnabled === true });
  }
  return out;
}

/**
 * True when the cached positioned set accounts for exactly the market's
 * stored positions. A mismatch means someone opened or closed a position
 * since discovery, so the set must be re-read before it is used.
 */
export function positionedSetMatchesMarket(
  set: ReadonlyArray<PositionedPortfolio>,
  s: MarketRefreshState,
): boolean {
  let longs = 0n;
  let shorts = 0n;
  for (const p of set) {
    longs += BigInt(p.longLegs);
    shorts += BigInt(p.shortLegs);
  }
  return longs === s.storedPosLong && shorts === s.storedPosShort;
}

/** Observation crank (accrues asset 0 from the committed AUTH_MARK mark). */
export function buildObservationCrankIx(
  owner: PublicKey,
  market: PublicKey,
  portfolio: PublicKey,
): TransactionInstruction {
  return buildPermissionlessCrankIx(owner, market, portfolio, true);
}

/** No-observation crank: refreshes a stale portfolio from committed state. */
export function buildRefreshCrankIx(
  owner: PublicKey,
  market: PublicKey,
  portfolio: PublicKey,
): TransactionInstruction {
  return buildPermissionlessCrankIx(owner, market, portfolio, false);
}

function buildPermissionlessCrankIx(
  owner: PublicKey,
  market: PublicKey,
  portfolio: PublicKey,
  withObservation: boolean,
): TransactionInstruction {
  const keys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, { owner, market, portfolio });
  const data = encodePermissionlessCrank({
    nowSlot: 0n, // wrapper authenticates against Clock::get()
    observations: withObservation ? [{ assetIndex: REFRESH_ASSET_INDEX, oracleAccounts: 0 }] : [],
  });
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys,
    data: data as unknown as Buffer,
  });
}

// ── Transaction plan ──────────────────────────────────────────────────────

/**
 * Per-crank CU estimates used to size the accrual transaction.
 *
 * Re-measured on devnet 2026-10-04 (wrapper 7c906e45 / engine 35ddd692), from
 * landed keeper cranks: catch-up ~27.5k; full accrual ~61k when the mark has
 * not moved, but 120k-162.6k right after a mark move (OTC 157k on every
 * up-tick, Jimothy 162.6k, backpack 152.4k); refresh 92k-153k (OTC trader
 * Haf5hMma 108k-151k). The old accrual estimate (150k) was BELOW the
 * post-move peak, so an accrual-only plan exhausted its budget and reverted
 * ProgramFailedToComplete (OTC streaks, 2026-10-03/04). See
 * ACCRUAL_TX_CU_HEADROOM for the per-transaction margin on top.
 *
 * REFRESH_CRANK_CU 130k -> 145k (wrapper #523 / engine #275, the #175 Earn-drain
 * fix "E1"): a refresh that fully nets a leg's loss now books the netted support
 * into the loss domain (one extra backing add + recompute), measured on the
 * swordcat/backpack live replays at up to +10.9k per refresh. Worst refresh is
 * then ~153k + 11k = 164k. At 130k x 8 the packed plan's limit (1.34M) is below
 * the worst 8-refresh cycle (163k + 8 x 164k = 1.475M, above even the 1.4M
 * re-sim), so the last refresh is pruned; at 145k x 7 the planned limit
 * (200k + 7 x 145k + 100k = 1.315M) covers the worst 7-refresh cycle
 * (163k + 7 x 164k = 1.311M) with no boost. Capacity: 7 refreshes beside the
 * accrual (an 8th positioned portfolio goes to a follow-up tx).
 */
export const CATCHUP_CRANK_CU = 30_000;
export const ACCRUE_CRANK_CU = 200_000;
export const REFRESH_CRANK_CU = 145_000;
export const MAX_TX_CU = 1_400_000;
/**
 * Extra CU on every accrual transaction, reserved before packing refreshes.
 * Refresh estimates are averages (an LP refresh ~92-110k, a trader refresh
 * up to ~153k): a plan with few refreshes has no averaging slack, so a
 * 2-refresh OTC plan sized at exactly the sum of estimates (410k) ran out at
 * 162k + 151k + 110k = 423k. The headroom absorbs that per-transaction
 * variance and the sim-to-land race (an accrual simulated before a push
 * lands at ~61k but executes after it at ~157k). It costs at most one
 * refresh of capacity: 7 refreshes fit beside the accrual (REFRESH_CRANK_CU 145k).
 */
export const ACCRUAL_TX_CU_HEADROOM = 100_000;
/** ExpireBackingBucket / FinalizeResetSide: one market-only state transition each (well under 40k CU). */
export const REPAIR_CU = 40_000;
/** Measured on devnet (ANSEM, 2026-09-29): liquidating a bankrupt leg ~200k CU. */
export const LIQUIDATE_CRANK_CU = 250_000;

/**
 * True when a (post-refresh) portfolio holds an active leg and its equity
 * `capital + pnl` is not positive — bankrupt. The refresh crank alone only
 * re-certifies such an account; the keeper's next accrual re-stales it, so
 * without a second crank in the SAME transaction the engine never reaches its
 * Liquidate step and the loss keeps growing against the counterparty backing
 * (ANSEM `DcVGSEfZ`, 2026-09-29: capital 0, PnL -88M -> -223M in ~2h while
 * the Earn vault's backing was consumed).
 */
export function isBankruptPortfolio(data: Uint8Array): boolean {
  try {
    const p = parsePortfolioV17(data);
    return p.activeBitmap !== 0n && !p.matcherEnabled && p.capital + p.pnl <= 0n;
  } catch {
    return false;
  }
}
/**
 * Most catch-up cranks that still leave room for the accrual + refreshes.
 * A market further behind gets a catch-up-only transaction this cycle: a
 * refresh cannot clear loss-stale while `slot_last < current_slot` anyway.
 */
export const MAX_CATCHUP_WITH_REFRESH = 10;
/** Catch-up-only transaction size (40 x ~19 bytes + ~270 fixed fits 1232 bytes; 40 x 30k CU fits 1.4M). */
export const MAX_CATCHUP_CRANKS = 40;

export type PlannedCrankKind = "repair" | "catchup" | "accrue" | "refresh" | "liquidate";

export interface PlannedCrank {
  kind: PlannedCrankKind;
  /** The crank's target portfolio; for a "repair" (market-only instruction) the market itself. */
  portfolio: PublicKey;
  ix: TransactionInstruction;
  /** Set on "repair" entries: which liveness repair this is. */
  repair?: LivenessRepair;
}

export interface CrankPlan {
  cranks: PlannedCrank[];
  /**
   * Refreshes that did not fit this transaction's CU budget. The cranker sends
   * them as follow-up transactions (`planOverflowRefreshTxs`) in the same price
   * window, so every positioned portfolio is refreshed each cohort.
   */
  overflow: PositionedPortfolio[];
  computeUnits: number;
}

/**
 * Number of bounded catch-up cranks to put before the full accrual. Each one
 * advances `slot_last` by exactly `maxDt` and returns early; the crank after
 * them sees a gap below `maxDt`, accrues to `now`, and runs the engine
 * dispatch, so the refreshes behind it see `dt == 0`. The count is computed
 * from the slot the market was read at; if the chain crosses another
 * multiple of `maxDt` before the transaction lands, the pre-simulation or the
 * landing fails cleanly and the next cycle recomputes it.
 */
export function catchupCrankCount(gap: bigint, maxDt: bigint): number {
  if (maxDt <= 0n || gap <= 0n) return 0;
  const n = gap / maxDt;
  return Number(n > BigInt(MAX_CATCHUP_CRANKS) ? BigInt(MAX_CATCHUP_CRANKS) : n);
}

/** True when this cycle's catch-up leaves room to accrue and refresh in the same transaction. */
export function catchupAllowsRefresh(catchup: number): boolean {
  return catchup <= MAX_CATCHUP_WITH_REFRESH;
}

/**
 * Build the per-market crank sequence:
 *   [catch-up x n] -> accrue(LP, observation) -> refresh(p) for each positioned p
 * Non-LP portfolios are refreshed first and the LP last: the LP is re-staled by
 * its own accrual, and this is the order measured end-to-end on devnet.
 * `refreshTargets` should already exclude portfolios pruned by simulation.
 */
export function planCrankTx(params: {
  owner: PublicKey;
  market: PublicKey;
  lpPortfolio: PublicKey;
  catchup: number;
  refreshTargets: ReadonlyArray<PositionedPortfolio>;
  /** Liveness repairs (liveness-repair.ts) to land BEFORE any crank this cycle. */
  repairs?: ReadonlyArray<LivenessRepair>;
  /**
   * Positioned portfolios found bankrupt after their refresh (see
   * `isBankruptPortfolio`): each gets a SECOND no-observation crank right after
   * its refresh, which the engine's auto-crank planner resolves to
   * `AutoCrankPlanV16::Liquidate` once the account is current.
   */
  liquidateTargets?: ReadonlyArray<PublicKey>;
}): CrankPlan {
  const { owner, market, lpPortfolio, catchup, refreshTargets } = params;
  const repairs = params.repairs ?? [];
  const cranks: PlannedCrank[] = repairs.map((r) => ({
    kind: "repair" as const,
    portfolio: market,
    ix: buildLivenessRepairIx(market, r),
    repair: r,
  }));
  const repairCu = repairs.length * REPAIR_CU;
  for (let i = 0; i < catchup; i++) {
    cranks.push({ kind: "catchup", portfolio: lpPortfolio, ix: buildObservationCrankIx(owner, market, lpPortfolio) });
  }
  if (!catchupAllowsRefresh(catchup)) {
    // Too far behind to finish this cycle: catch-up cranks only.
    return {
      cranks,
      overflow: [],
      computeUnits: Math.min(MAX_TX_CU, repairCu + catchup * CATCHUP_CRANK_CU + ACCRUAL_TX_CU_HEADROOM),
    };
  }
  cranks.push({ kind: "accrue", portfolio: lpPortfolio, ix: buildObservationCrankIx(owner, market, lpPortfolio) });
  let cu = repairCu + catchup * CATCHUP_CRANK_CU + ACCRUE_CRANK_CU;
  /** Packing ceiling: the headroom is reserved, never spent on another refresh. */
  const packCap = MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM;

  const ordered = [...refreshTargets].sort((x, y) => Number(x.isLp) - Number(y.isLp));
  const overflow: PositionedPortfolio[] = [];
  for (const p of ordered) {
    if (cu + REFRESH_CRANK_CU > packCap) {
      overflow.push(p);
      continue;
    }
    cranks.push({ kind: "refresh", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
    cu += REFRESH_CRANK_CU;
    if (!p.isLp && (params.liquidateTargets ?? []).some((t) => t.equals(p.pubkey)) && cu + LIQUIDATE_CRANK_CU <= packCap) {
      cranks.push({ kind: "liquidate", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
      cu += LIQUIDATE_CRANK_CU;
    }
  }
  return { cranks, overflow, computeUnits: Math.min(MAX_TX_CU, cu + ACCRUAL_TX_CU_HEADROOM) };
}

// ── Overflow refreshes (follow-up transactions) ──────────────────────────

/**
 * Refresh-only transaction for `targets`: one no-observation crank per target,
 * plus a second (liquidate) crank right after each non-LP target listed in
 * `liquidateTargets`. Used for the refreshes that did not fit the accrual
 * transaction. It must land after the accrual and before the market's next
 * price push (see refresh-coordination.ts): a no-observation crank is only
 * accepted while the committed mark has not moved since the accrual.
 * The caller sizes `targets` with `chunkOverflowTargets`, so this fits MAX_TX_CU.
 */
export function planRefreshTx(params: {
  owner: PublicKey;
  market: PublicKey;
  targets: ReadonlyArray<PositionedPortfolio>;
  liquidateTargets?: ReadonlyArray<PublicKey>;
}): CrankPlan {
  const { owner, market, targets } = params;
  const liq = params.liquidateTargets ?? [];
  const cranks: PlannedCrank[] = [];
  let cu = 0;
  for (const p of targets) {
    cranks.push({ kind: "refresh", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
    cu += REFRESH_CRANK_CU;
    if (!p.isLp && liq.some((t) => t.equals(p.pubkey)) && cu + LIQUIDATE_CRANK_CU <= MAX_TX_CU) {
      cranks.push({ kind: "liquidate", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
      cu += LIQUIDATE_CRANK_CU;
    }
  }
  // The accrual tx's 1.4M budget absorbs per-refresh variance across 7 refreshes;
  // a short follow-up has no such slack (live 2026-10-02: a lone LP refresh hit
  // ComputationalBudgetExceeded at 130k), so it gets explicit headroom.
  return { cranks, overflow: [], computeUnits: cranks.length === 0 ? 0 : Math.min(MAX_TX_CU, cu + FOLLOWUP_CU_HEADROOM) };
}

/** Extra CU on every follow-up refresh tx (see planRefreshTx). */
export const FOLLOWUP_CU_HEADROOM = 200_000;

/** Refreshes per follow-up transaction: the CU cap, leaving room for one liquidation. */
export const REFRESHES_PER_OVERFLOW_TX = Math.floor((MAX_TX_CU - LIQUIDATE_CRANK_CU) / REFRESH_CRANK_CU);

/**
 * Split the overflow into follow-up transaction groups, in order. Every target
 * appears in exactly one group; each group fits MAX_TX_CU even with one
 * liquidation added (more liquidations than that are skipped by
 * `planRefreshTx`'s CU check and caught by the next cycle).
 */
export function chunkOverflowTargets(
  overflow: ReadonlyArray<PositionedPortfolio>,
  perTx: number = REFRESHES_PER_OVERFLOW_TX,
): PositionedPortfolio[][] {
  const n = Math.max(1, Math.floor(perTx));
  const out: PositionedPortfolio[][] = [];
  for (let i = 0; i < overflow.length; i += n) out.push(overflow.slice(i, i + n));
  return out;
}

/**
 * True when a simulation/transaction failed because an instruction ran out of
 * compute: the runtime reports a BPF program that hits its CU meter as
 * `ProgramFailedToComplete` (log: "exceeded CUs meter at BPF instruction"),
 * and older runtimes as `ComputationalBudgetExceeded`. Neither is an engine
 * verdict on the instruction, so the cranker must not treat it as "the engine
 * rejected this refresh". `ProgramFailedToComplete` without logs is treated
 * as exhaustion too: the only response is one re-simulation at a larger
 * budget, which a genuine panic simply fails again.
 */
export function isComputeExhaustion(err: unknown, logs?: ReadonlyArray<string> | null): boolean {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return false;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(ie)) return false;
  if (ie[1] === "ComputationalBudgetExceeded") return true;
  if (ie[1] !== "ProgramFailedToComplete") return false;
  if (!logs || logs.length === 0) return true;
  return logs.some((l) => /exceeded CUs meter|exceeded maximum compute|computational budget exceeded/i.test(l));
}

/**
 * Parse `{"InstructionError":[idx,{"Custom":n}]}` from a simulation error.
 * Returns the instruction index (in the full transaction, compute-budget ix
 * included) and the custom code, if present.
 */
export function parseInstructionError(err: unknown): { index: number; custom: number | null } | null {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return null;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(ie) || typeof ie[0] !== "number") return null;
  const detail = ie[1];
  let custom: number | null = null;
  if (detail && typeof detail === "object" && "Custom" in detail) {
    const c = (detail as { Custom: unknown }).Custom;
    if (typeof c === "number") custom = c;
  }
  return { index: ie[0], custom };
}
