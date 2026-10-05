/**
 * cross-cluster/positioned-sweep.ts
 *
 * Continuous positioned-portfolio sweep for markets created by the
 * v21-funding-scale program (engine 3b02ff24 / wrapper eae0cce7). Pure: no RPC,
 * so the decoder, the bound/coverage math, the pace and the transaction plan are
 * tested against hand-built byte buffers.
 *
 * Why the keeper changes (engine fix/v21-funding-scale):
 *
 *   Old engine: with funding > 0 every accrual re-stales EVERY positioned
 *   portfolio, and a risk-increasing order reverts Custom(121) EngineLossStale
 *   unless every stale portfolio is refreshed in the order's own slot. The keeper
 *   therefore sent "accrue, then refresh every positioned portfolio" in one tx
 *   (plus follow-up txs under a push hold) every cycle.
 *
 *   New engine (`asset_hidden_kf_loss_is_insurance_covered`): an order is admitted
 *   while other portfolios are stale iff, per side, the hidden-loss BOUND of the
 *   side's stale legs is covered by the available insurance of the domain that
 *   absorbs that side's bankruptcies (the OPPOSITE side's domain). The bound
 *   only shrinks as stale portfolios are refreshed, and the drift generation
 *   rotates once every positioned portfolio has been refreshed at least once
 *   since it began (laggards drop to 0, `drift_prior` stops counting). So the
 *   keeper must keep sweeping every positioned portfolio, but it no longer has
 *   to finish the sweep inside one slot or one transaction.
 *
 * Sweep transaction shape: `[LP observation crank (accrues, dt -> 0), refresh x k]`.
 * A refresh (no-observation PermissionlessCrank) is only accepted in a slot
 * where the asset is already accrued, and a refresh of a non-stale portfolio
 * returns Custom(22) and reverts the whole transaction, so the cranker
 * simulate-prunes as before. Sweep transactions never carry a user order.
 *
 * Layout detection: the drift state is appended to every engine asset slot
 * (2 x 80 bytes), so the per-asset stride is 2485 bytes instead of 2325. A
 * market account is `1350 + max_market_slots * stride` bytes. Anything that is
 * not exactly the new length is NOT decoded here and the cranker keeps its
 * previous behaviour (accrue + refresh everything each cycle).
 */
import { PublicKey } from "@solana/web3.js";

import { ACCRUE_CRANK_CU, CATCHUP_CRANK_CU, LIQUIDATE_CRANK_CU, MAX_TX_CU, REPAIR_CU, buildObservationCrankIx, buildRefreshCrankIx, catchupAllowsRefresh } from "./positioned-refresh.ts";
import type { CrankPlan, PlannedCrank, PositionedPortfolio } from "./positioned-refresh.ts";
import { buildLivenessRepairIx } from "./liveness-repair.ts";
import type { LivenessRepair } from "./liveness-repair.ts";

// ── Market account layout (absolute byte offsets, little-endian) ─────────────

/** HEADER_LEN (16) + WRAPPER_CONFIG_LEN (576). */
export const MARKET_GROUP_OFF = 592;
/** MarketGroupV16HeaderAccount is 758 bytes: asset slots start at 592 + 758. */
export const ASSET_SLOTS_OFF = 1350;
/** u32: V16ConfigAccount.max_market_slots (group +34). */
export const HDR_MAX_MARKET_SLOTS = 626;
/** u128: header.insurance. */
export const HDR_INSURANCE = 893;
/** u128: header.source_insurance_credit_reserved_total_atoms. */
export const HDR_SOURCE_INSURANCE_RESERVED_TOTAL = 1037;
/** u64: header.current_slot. */
export const HDR_CURRENT_SLOT = 1205;
/** Wrapper oracle block in front of every engine asset slot. */
export const ASSET_WRAPPER_LEN = 1024;
/** Per-asset stride before / after the drift state was appended. */
export const LEGACY_SLOT_STRIDE = 2325;
export const DRIFT_SLOT_STRIDE = 2485;

// EngineAssetSlotV16Account field offsets (relative to the engine slot base E).
const E_LIFECYCLE = 16;
const E_EFFECTIVE_PRICE = 25;
const E_SLOT_LAST = 41;
const E_KF_EPOCH_LONG = 145;
const E_KF_EPOCH_SHORT = 153;
const E_STALE_LONG = 337;
const E_STALE_SHORT = 345;
const E_PENDING_OBL_LONG = 353;
const E_PENDING_OBL_SHORT = 361;
const E_MODE_LONG = 513;
const E_MODE_SHORT = 514;
const E_INS_BUDGET_LONG = 515;
const E_INS_BUDGET_SHORT = 531;
const E_INS_SPENT_LONG = 547;
const E_INS_SPENT_SHORT = 563;
const E_BARRIER_LONG = 579;
const E_BARRIER_SHORT = 587;
/** InsuranceCreditReservationV16Account; first field insurance_credit_reserved_num u128. */
const E_INS_RESERVATION_LONG = 1157;
const E_INS_RESERVATION_SHORT = 1229;
const E_KF_DRIFT_LONG = 1301;
const E_KF_DRIFT_SHORT = 1381;
/** KfDriftSideV16Account: gen_epoch u64, laggard_count u64, drift_gen, drift_prior, stale_weight, laggard_weight (u128). */
export const KF_DRIFT_LEN = 80;
const D_GEN_EPOCH = 0;
const D_LAGGARD_COUNT = 8;
const D_DRIFT_GEN = 16;
const D_DRIFT_PRIOR = 32;
const D_STALE_WEIGHT = 48;
const D_LAGGARD_WEIGHT = 64;

export const LIFECYCLE_ACTIVE = 2;
export const SIDE_MODE_NORMAL = 0;

export const SOCIAL_WEIGHT_SCALE = 1_000_000_000_000_000n;
export const POS_SCALE = 1_000_000n;
export const BOUND_SCALE = 1_000_000_000_000n;

export type MarketLayout = "drift" | "legacy" | "unknown";

function u32(d: Uint8Array, off: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(off, true);
}
function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}
function u128(d: Uint8Array, off: number): bigint {
  return u64(d, off) | (u64(d, off + 8) << 64n);
}

/**
 * Which slot layout a market account uses, from its length and
 * `max_market_slots`: `1350 + n * 2485` = drift (new program), `1350 + n * 2325`
 * = legacy. Anything else is "unknown" and is never decoded as drift.
 */
export function detectMarketLayout(data: Uint8Array): MarketLayout {
  if (data.length < HDR_MAX_MARKET_SLOTS + 4) return "unknown";
  const n = u32(data, HDR_MAX_MARKET_SLOTS);
  if (n === 0) return "unknown";
  if (data.length === ASSET_SLOTS_OFF + n * DRIFT_SLOT_STRIDE) return "drift";
  if (data.length === ASSET_SLOTS_OFF + n * LEGACY_SLOT_STRIDE) return "legacy";
  return "unknown";
}

/** Engine slot base E of `assetIndex` in a drift-layout market. */
export function driftEngineSlotBase(assetIndex = 0): number {
  return ASSET_SLOTS_OFF + assetIndex * DRIFT_SLOT_STRIDE + ASSET_WRAPPER_LEN;
}

export interface KfDriftSide {
  genEpoch: bigint;
  laggardCount: bigint;
  driftGen: bigint;
  driftPrior: bigint;
  staleWeight: bigint;
  laggardWeight: bigint;
}

export interface SweepMarketState {
  maxMarketSlots: number;
  currentSlot: bigint;
  insurance: bigint;
  sourceInsuranceReservedTotal: bigint;
  lifecycle: number;
  effectivePrice: bigint;
  slotLast: bigint;
  kfEpochLong: bigint;
  kfEpochShort: bigint;
  staleLong: bigint;
  staleShort: bigint;
  pendingObligationLong: bigint;
  pendingObligationShort: bigint;
  modeLong: number;
  modeShort: number;
  insuranceBudgetLong: bigint;
  insuranceBudgetShort: bigint;
  insuranceSpentLong: bigint;
  insuranceSpentShort: bigint;
  pendingBarrierLong: bigint;
  pendingBarrierShort: bigint;
  /** insurance_reservation_<side>.insurance_credit_reserved_num (BOUND_SCALE units). */
  insuranceReservedNumLong: bigint;
  insuranceReservedNumShort: bigint;
  driftLong: KfDriftSide;
  driftShort: KfDriftSide;
}

function decodeDrift(d: Uint8Array, off: number): KfDriftSide {
  return {
    genEpoch: u64(d, off + D_GEN_EPOCH),
    laggardCount: u64(d, off + D_LAGGARD_COUNT),
    driftGen: u128(d, off + D_DRIFT_GEN),
    driftPrior: u128(d, off + D_DRIFT_PRIOR),
    staleWeight: u128(d, off + D_STALE_WEIGHT),
    laggardWeight: u128(d, off + D_LAGGARD_WEIGHT),
  };
}

/** Decode the sweep/coverage inputs. null when the account is not drift layout (old program: fall back). */
export function decodeSweepMarketState(data: Uint8Array, assetIndex = 0): SweepMarketState | null {
  if (detectMarketLayout(data) !== "drift") return null;
  const maxMarketSlots = u32(data, HDR_MAX_MARKET_SLOTS);
  if (assetIndex < 0 || assetIndex >= maxMarketSlots) return null;
  const e = driftEngineSlotBase(assetIndex);
  return {
    maxMarketSlots,
    currentSlot: u64(data, HDR_CURRENT_SLOT),
    insurance: u128(data, HDR_INSURANCE),
    sourceInsuranceReservedTotal: u128(data, HDR_SOURCE_INSURANCE_RESERVED_TOTAL),
    lifecycle: data[e + E_LIFECYCLE],
    effectivePrice: u64(data, e + E_EFFECTIVE_PRICE),
    slotLast: u64(data, e + E_SLOT_LAST),
    kfEpochLong: u64(data, e + E_KF_EPOCH_LONG),
    kfEpochShort: u64(data, e + E_KF_EPOCH_SHORT),
    staleLong: u64(data, e + E_STALE_LONG),
    staleShort: u64(data, e + E_STALE_SHORT),
    pendingObligationLong: u64(data, e + E_PENDING_OBL_LONG),
    pendingObligationShort: u64(data, e + E_PENDING_OBL_SHORT),
    modeLong: data[e + E_MODE_LONG],
    modeShort: data[e + E_MODE_SHORT],
    insuranceBudgetLong: u128(data, e + E_INS_BUDGET_LONG),
    insuranceBudgetShort: u128(data, e + E_INS_BUDGET_SHORT),
    insuranceSpentLong: u128(data, e + E_INS_SPENT_LONG),
    insuranceSpentShort: u128(data, e + E_INS_SPENT_SHORT),
    pendingBarrierLong: u64(data, e + E_BARRIER_LONG),
    pendingBarrierShort: u64(data, e + E_BARRIER_SHORT),
    insuranceReservedNumLong: u128(data, e + E_INS_RESERVATION_LONG),
    insuranceReservedNumShort: u128(data, e + E_INS_RESERVATION_SHORT),
    driftLong: decodeDrift(data, e + E_KF_DRIFT_LONG),
    driftShort: decodeDrift(data, e + E_KF_DRIFT_SHORT),
  };
}

/** Absolute offsets tests patch (asset 0 unless given). */
export function sweepFieldOffsets(assetIndex = 0) {
  const e = driftEngineSlotBase(assetIndex);
  return {
    maxMarketSlots: HDR_MAX_MARKET_SLOTS,
    currentSlot: HDR_CURRENT_SLOT,
    insurance: HDR_INSURANCE,
    sourceInsuranceReservedTotal: HDR_SOURCE_INSURANCE_RESERVED_TOTAL,
    lifecycle: e + E_LIFECYCLE,
    effectivePrice: e + E_EFFECTIVE_PRICE,
    slotLast: e + E_SLOT_LAST,
    kfEpochLong: e + E_KF_EPOCH_LONG,
    kfEpochShort: e + E_KF_EPOCH_SHORT,
    staleLong: e + E_STALE_LONG,
    staleShort: e + E_STALE_SHORT,
    pendingObligationLong: e + E_PENDING_OBL_LONG,
    pendingObligationShort: e + E_PENDING_OBL_SHORT,
    modeLong: e + E_MODE_LONG,
    modeShort: e + E_MODE_SHORT,
    insuranceBudgetLong: e + E_INS_BUDGET_LONG,
    insuranceBudgetShort: e + E_INS_BUDGET_SHORT,
    insuranceSpentLong: e + E_INS_SPENT_LONG,
    insuranceSpentShort: e + E_INS_SPENT_SHORT,
    pendingBarrierLong: e + E_BARRIER_LONG,
    pendingBarrierShort: e + E_BARRIER_SHORT,
    insuranceReservedNumLong: e + E_INS_RESERVATION_LONG,
    insuranceReservedNumShort: e + E_INS_RESERVATION_SHORT,
    driftLong: e + E_KF_DRIFT_LONG,
    driftShort: e + E_KF_DRIFT_SHORT,
  };
}

// ── Bound / coverage math (mirrors engine 3b02ff24, exact BigInt) ────────────

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}
function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

/**
 * `kernel_kf_hidden_loss_bound` (engine 89403177): 0 with no stale legs, else
 * `ceil(stale_weight*drift_gen/(SWS*POS)) + (laggards ? ceil(laggard_weight*drift_prior/(SWS*POS)) : 0) + 2*stale`.
 *
 * null = no bound (the engine returns None, i.e. uncovered). Security review S1:
 * every stale leg carries `loss_weight >= 1`, so `stale_weight < stale` means the
 * tracker does not describe the cohort (e.g. a zeroed drift tail under a live
 * cohort); the engine fails closed instead of collapsing to `2 * stale`.
 */
export function hiddenLossBound(stale: bigint, d: KfDriftSide): bigint | null {
  if (stale === 0n) return 0n;
  if (d.staleWeight < stale) return null;
  const den = SOCIAL_WEIGHT_SCALE * POS_SCALE;
  const gen = ceilDiv(d.staleWeight * d.driftGen, den);
  const prior = d.laggardCount === 0n ? 0n : ceilDiv(d.laggardWeight * d.driftPrior, den);
  return gen + prior + 2n * stale;
}

/**
 * `available_domain_insurance(domain of side)`:
 * `min(insurance - source_reserved_total, budget - spent - ceil(reserved_num / BOUND_SCALE))`, each floored at 0.
 */
export function availableDomainInsurance(s: SweepMarketState, side: "long" | "short"): bigint {
  const globalAvailable = satSub(s.insurance, s.sourceInsuranceReservedTotal);
  const budget = side === "long" ? s.insuranceBudgetLong : s.insuranceBudgetShort;
  const spent = side === "long" ? s.insuranceSpentLong : s.insuranceSpentShort;
  const reservedNum = side === "long" ? s.insuranceReservedNumLong : s.insuranceReservedNumShort;
  const remaining = satSub(satSub(budget, spent), ceilDiv(reservedNum, BOUND_SCALE));
  return globalAvailable < remaining ? globalAvailable : remaining;
}

export interface SweepCoverage {
  /** Hidden-loss bound of the long side's stale legs (absorbed by the SHORT domain); null = no bound (uncovered, S1). */
  boundLong: bigint | null;
  /** ... of the short side's stale legs (absorbed by the LONG domain). */
  boundShort: bigint | null;
  /**
   * The drift tracker fails `validate_kf_drift_shape` (engine 89403177, S1): laggards
   * above the stale count, a generation after the KF epoch, or (on a Normal side) a
   * stale / laggard weight below its count. The engine never admits then.
   */
  trackerMalformed: boolean;
  availableLongDomain: bigint;
  availableShortDomain: bigint;
  /** Tracker well-formed, both bounds defined, boundLong <= availableShortDomain && boundShort <= availableLongDomain. */
  covered: boolean;
  /** max(bound/available) over both sides; 0 with no stale legs, Infinity when a bound faces 0 insurance. */
  ratio: number;
  /**
   * The engine's other preconditions for the relaxed path: single-asset market,
   * asset Active, both sides Normal, no pending obligations or domain-loss
   * barriers, asset accrued to the market clock. When false, the old rule
   * applies (every stale portfolio must be refreshed before an open).
   */
  relaxedEligible: boolean;
  ineligibleReason: string | null;
  staleLong: bigint;
  staleShort: bigint;
  laggardLong: bigint;
  laggardShort: bigint;
  /**
   * True when a risk-increasing order would be refused EngineLossStale: some
   * portfolio is stale (or the asset is not accrued) and the relaxed path does
   * not admit it.
   */
  blocksRiskIncrease: boolean;
}

/** bound/available as a float; exact enough for pacing (BigInt ratio in parts per million). null bound = Infinity. */
export function boundRatio(bound: bigint | null, available: bigint): number {
  if (bound === null) return Number.POSITIVE_INFINITY;
  if (bound === 0n) return 0;
  if (available === 0n) return Number.POSITIVE_INFINITY;
  const ppm = (bound * 1_000_000n) / available;
  return ppm > 1_000_000_000_000n ? Number.POSITIVE_INFINITY : Number(ppm) / 1_000_000;
}

function relaxedIneligibility(s: SweepMarketState): string | null {
  if (s.maxMarketSlots !== 1) return `max_market_slots=${s.maxMarketSlots}`;
  if (s.lifecycle !== LIFECYCLE_ACTIVE) return `lifecycle=${s.lifecycle}`;
  if (s.modeLong !== SIDE_MODE_NORMAL || s.modeShort !== SIDE_MODE_NORMAL) return `mode=${s.modeLong}/${s.modeShort}`;
  if (s.pendingObligationLong !== 0n || s.pendingObligationShort !== 0n) return "pending-obligations";
  if (s.pendingBarrierLong !== 0n || s.pendingBarrierShort !== 0n) return "domain-loss-barrier";
  if (s.slotLast < s.currentSlot) return "not-accrued";
  return null;
}

/**
 * Mirror of the engine's `validate_kf_drift_shape` (89403177): laggards are a
 * subset of the stale cohort, a generation never starts after the side's KF
 * epoch, and on a Normal side every stale leg / laggard carries loss_weight >= 1.
 */
export function driftTrackerWellFormed(s: SweepMarketState): boolean {
  const side = (stale: bigint, kfEpoch: bigint, mode: number, d: KfDriftSide): boolean =>
    d.laggardCount <= stale &&
    d.genEpoch <= kfEpoch &&
    !(mode === SIDE_MODE_NORMAL && (d.staleWeight < stale || d.laggardWeight < d.laggardCount));
  return (
    side(s.staleLong, s.kfEpochLong, s.modeLong, s.driftLong) &&
    side(s.staleShort, s.kfEpochShort, s.modeShort, s.driftShort)
  );
}

export function evaluateCoverage(s: SweepMarketState): SweepCoverage {
  const boundLong = hiddenLossBound(s.staleLong, s.driftLong);
  const boundShort = hiddenLossBound(s.staleShort, s.driftShort);
  const availableLongDomain = availableDomainInsurance(s, "long");
  const availableShortDomain = availableDomainInsurance(s, "short");
  const trackerMalformed = !driftTrackerWellFormed(s);
  const covered =
    !trackerMalformed &&
    boundLong !== null &&
    boundShort !== null &&
    boundLong <= availableShortDomain &&
    boundShort <= availableLongDomain;
  const ratio = Math.max(boundRatio(boundLong, availableShortDomain), boundRatio(boundShort, availableLongDomain));
  const ineligibleReason = relaxedIneligibility(s);
  const relaxedEligible = ineligibleReason === null;
  const stale = s.staleLong !== 0n || s.staleShort !== 0n || s.slotLast < s.currentSlot;
  return {
    boundLong,
    boundShort,
    trackerMalformed,
    availableLongDomain,
    availableShortDomain,
    covered,
    ratio,
    relaxedEligible,
    ineligibleReason,
    staleLong: s.staleLong,
    staleShort: s.staleShort,
    laggardLong: s.driftLong.laggardCount,
    laggardShort: s.driftShort.laggardCount,
    blocksRiskIncrease: stale && !(relaxedEligible && covered),
  };
}

// ── Configuration / transaction sizing ───────────────────────────────────────

export interface SweepConfig {
  /** Base refreshes per sweep transaction (default 10). */
  k: number;
  /** Per-refresh CU estimate on the new engine (default 114k). */
  refreshCu: number;
  /** Observation (accrual) crank CU estimate (default ACCRUE_CRANK_CU). */
  accrueCu: number;
  /** Extra CU on every sweep transaction on top of the sum of estimates. */
  headroomCu: number;
  /** Most sweep transactions one market sends in one cranker cycle. */
  maxTxsPerCycle: number;
}

export const DEFAULT_SWEEP_K = 10;
export const DEFAULT_SWEEP_REFRESH_CU = 114_000;
export const DEFAULT_SWEEP_HEADROOM_CU = 60_000;
export const DEFAULT_SWEEP_MAX_TXS_PER_CYCLE = 8;

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  k: DEFAULT_SWEEP_K,
  refreshCu: DEFAULT_SWEEP_REFRESH_CU,
  accrueCu: ACCRUE_CRANK_CU,
  headroomCu: DEFAULT_SWEEP_HEADROOM_CU,
  maxTxsPerCycle: DEFAULT_SWEEP_MAX_TXS_PER_CYCLE,
};

function envInt(env: Readonly<Record<string, string | undefined>>, key: string, def: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : def;
}

/**
 * KEEPER_SWEEP_K, KEEPER_SWEEP_REFRESH_CU, KEEPER_SWEEP_ACCRUE_CU,
 * KEEPER_SWEEP_HEADROOM_CU, KEEPER_SWEEP_MAX_TXS_PER_CYCLE. Invalid values fall
 * back to the default.
 */
export function sweepConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): SweepConfig {
  return {
    k: envInt(env, "KEEPER_SWEEP_K", DEFAULT_SWEEP_K, 1),
    refreshCu: envInt(env, "KEEPER_SWEEP_REFRESH_CU", DEFAULT_SWEEP_REFRESH_CU, 1_000),
    accrueCu: envInt(env, "KEEPER_SWEEP_ACCRUE_CU", ACCRUE_CRANK_CU, 1_000),
    headroomCu: envInt(env, "KEEPER_SWEEP_HEADROOM_CU", DEFAULT_SWEEP_HEADROOM_CU, 0),
    maxTxsPerCycle: envInt(env, "KEEPER_SWEEP_MAX_TXS_PER_CYCLE", DEFAULT_SWEEP_MAX_TXS_PER_CYCLE, 1),
  };
}

/** KEEPER_SWEEP_ENABLED=false keeps the legacy refresh-everything cycle even on drift-layout markets. */
export function sweepEnabledFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.KEEPER_SWEEP_ENABLED !== "false";
}

/** Refreshes that fit one sweep tx beside the accrual (and `extraCu` of other cranks) under MAX_TX_CU. */
export function maxRefreshesPerSweepTx(cfg: SweepConfig, extraCu = 0, withAccrue = true): number {
  const room = MAX_TX_CU - cfg.headroomCu - extraCu - (withAccrue ? cfg.accrueCu : 0);
  return room <= 0 ? 0 : Math.floor(room / cfg.refreshCu);
}

// ── Adaptive pace ─────────────────────────────────────────────────────────────

export type SweepPaceLevel = "idle" | "relaxed" | "steady" | "elevated" | "urgent";

export interface SweepPace {
  level: SweepPaceLevel;
  /** Refreshes per sweep transaction. */
  k: number;
  /** Sweep transactions this cycle (the cycle's accrual transaction is the first). */
  txs: number;
}

/** bound/available at or above which the sweep goes flat out. */
export const SWEEP_URGENT_RATIO = 0.8;
export const SWEEP_ELEVATED_RATIO = 0.5;
export const SWEEP_STEADY_RATIO = 0.25;

/**
 * How hard to sweep this cycle. The first transaction is always the cycle's
 * accrual; more transactions and a bigger k (up to the CU cap) as the bound
 * approaches the insurance that covers it:
 *   - idle      no positioned portfolio: accrual only (k 0, 1 tx)
 *   - relaxed   no stale legs, or ratio < 0.25: base k, 1 tx
 *   - steady    ratio in [0.25, 0.5): base k, 2 txs
 *   - elevated  ratio in [0.5, 0.8): k at the CU cap, half a full sweep
 *   - urgent    ratio >= 0.8, not covered, or the relaxed path unavailable
 *               while stale: k at the cap, a full sweep (capped by maxTxsPerCycle)
 */
export function planSweepPace(cov: SweepCoverage | null, positioned: number, cfg: SweepConfig): SweepPace {
  const kCap = Math.max(1, maxRefreshesPerSweepTx(cfg));
  const kBase = Math.max(1, Math.min(cfg.k, kCap));
  if (positioned <= 0) return { level: "idle", k: 0, txs: 1 };
  const full = (k: number) => Math.max(1, Math.ceil(positioned / k));
  const cap = (n: number) => Math.max(1, Math.min(cfg.maxTxsPerCycle, n));
  if (!cov) return { level: "urgent", k: kCap, txs: cap(full(kCap)) };
  const stale = cov.staleLong !== 0n || cov.staleShort !== 0n;
  if (stale && (!cov.covered || !cov.relaxedEligible || cov.ratio >= SWEEP_URGENT_RATIO)) {
    return { level: "urgent", k: kCap, txs: cap(full(kCap)) };
  }
  if (!stale || cov.ratio < SWEEP_STEADY_RATIO) return { level: "relaxed", k: kBase, txs: 1 };
  if (cov.ratio < SWEEP_ELEVATED_RATIO) return { level: "steady", k: kBase, txs: cap(Math.min(2, full(kBase))) };
  return { level: "elevated", k: kCap, txs: cap(Math.ceil(full(kCap) / 2)) };
}

// ── Sweep order: heaviest stale first, every portfolio once per round ─────────

/**
 * Sweep cursor (per market). `visits`: base58 -> sequence number of the last
 * visit. `roundStart`: a portfolio is DUE in the current round while its last
 * visit is below it. A round ends when nothing is due; the next one starts at
 * the next sequence number, making every positioned portfolio due again.
 */
export interface SweepCursor {
  visits: Map<string, number>;
  roundStart: number;
  /** Sequence number of the last recorded visit batch. */
  seq: number;
  /**
   * Set when a batch was topped up across a round boundary: the next recorded
   * visit closes the old round, and the new round starts AFTER it, so every
   * member of that batch (old-round tail and topped-up) is due again in the new
   * round. Without this the old round's tail would silently count as visited in
   * the new round too, and the lightest portfolio (always the tail) would be
   * reached only every other round.
   */
  roundPending: boolean;
}

export function freshSweepCursor(): SweepCursor {
  return { visits: new Map(), roundStart: 0, seq: 0, roundPending: false };
}

/** Market KF epochs at the read: a leg with `kf_epoch_snap` below its side's epoch is stale. */
export interface SideEpochs {
  long: bigint;
  short: bigint;
}

/**
 * True when the portfolio holds a stale leg at the read (`kf_epoch_snap <
 * kf_epoch_<side>`). Unknown (no epochs, no snaps) counts as stale.
 */
export function isStaleAtRead(p: PositionedPortfolio, epochs: SideEpochs | null): boolean {
  if (!epochs) return true;
  const hasSnap = p.kfEpochSnapLong !== undefined || p.kfEpochSnapShort !== undefined;
  if (!hasSnap) return true;
  return (
    (p.kfEpochSnapLong != null && p.kfEpochSnapLong < epochs.long) ||
    (p.kfEpochSnapShort != null && p.kfEpochSnapShort < epochs.short)
  );
}

/**
 * Next batch of up to `k` portfolios (security review I2 of #277).
 *
 * The hidden-loss bound is weight-proportional (`stale_weight * drift / (SWS*POS)`),
 * so refreshing the heaviest stale legs first shrinks it fastest. A pure weight
 * order would starve light portfolios, and the generation only rotates once every
 * positioned portfolio has been refreshed since it began. So the order is by
 * ROUND: only portfolios not yet visited this round are eligible, and among them
 *   1. stale at the read (`kf_epoch_snap < kf_epoch_<side>`) before not stale,
 *   2. loss_weight descending,
 *   3. least recently visited first, then pubkey (deterministic).
 * Every portfolio is visited once per round, and a round is about ceil(n/k)
 * batches, so no portfolio waits more than about two rounds (the starvation test
 * pins 2*ceil(n/k) - 1). When fewer than k are due, the next round starts (mutates
 * `cursor.roundStart`) and the batch is topped up from it. `exclude` holds what
 * this cycle already took.
 * Within the batch non-LP portfolios go first and the LP last (the order
 * measured on devnet: the LP is re-staled by its own accrual).
 */
export function selectSweepBatch(
  positioned: ReadonlyArray<PositionedPortfolio>,
  cursor: SweepCursor,
  k: number,
  exclude: ReadonlySet<string> = new Set(),
  epochs: SideEpochs | null = null,
): PositionedPortfolio[] {
  if (k <= 0) return [];
  const candidates = positioned
    .map((p) => ({ p, key: p.pubkey.toBase58() }))
    .filter((x) => !exclude.has(x.key));
  if (candidates.length === 0) return [];
  const last = (key: string) => cursor.visits.get(key) ?? -1;
  const rank = (xs: typeof candidates) =>
    xs
      .map((x) => ({ ...x, stale: isStaleAtRead(x.p, epochs), w: x.p.lossWeight ?? 0n }))
      .sort((a, b) => {
        if (a.stale !== b.stale) return a.stale ? -1 : 1;
        if (a.w !== b.w) return a.w > b.w ? -1 : 1;
        const va = last(a.key);
        const vb = last(b.key);
        if (va !== vb) return va - vb;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
  let due = candidates.filter((x) => last(x.key) < cursor.roundStart);
  if (due.length === 0) {
    // Round complete: the next one starts with this batch.
    cursor.roundStart = cursor.seq + 1;
    cursor.roundPending = false;
    due = candidates;
  }
  const picked = rank(due).slice(0, k);
  if (picked.length < k) {
    // The round is (or is about to be) complete: top the batch up from the next round's
    // order, so a tx never goes out half-empty at a round boundary. The new round starts
    // once this batch is recorded (see `roundPending`).
    const inBatch = new Set(picked.map((x) => x.key));
    const next = rank(candidates.filter((x) => !inBatch.has(x.key))).slice(0, k - picked.length);
    if (next.length > 0) cursor.roundPending = true;
    picked.push(...next);
  }
  return picked.map((x) => x.p).sort((a, b) => Number(a.isLp) - Number(b.isLp));
}

/**
 * Record one batch of visits (refreshes that landed, or portfolios the
 * simulation showed not stale). Closes a pending round boundary.
 */
export function markVisited(cursor: SweepCursor, pubkeys: ReadonlyArray<PublicKey>): void {
  if (pubkeys.length === 0) return;
  const seq = ++cursor.seq;
  for (const pk of pubkeys) cursor.visits.set(pk.toBase58(), seq);
  if (cursor.roundPending) {
    cursor.roundStart = seq + 1;
    cursor.roundPending = false;
  }
}

/** Forget portfolios that are no longer positioned. */
export function pruneVisits(cursor: SweepCursor, positioned: ReadonlyArray<PositionedPortfolio>): void {
  const live = new Set(positioned.map((p) => p.pubkey.toBase58()));
  for (const k of [...cursor.visits.keys()]) if (!live.has(k)) cursor.visits.delete(k);
}

/**
 * Replace cached positioned entries with the weights / epoch snaps of fresh
 * portfolio bytes (a simulation's post-state). Entries without data, or whose
 * data no longer shows a position, are left as they are.
 */
export function refreshPositionedFrom(
  positioned: PositionedPortfolio[],
  fresh: ReadonlyArray<PositionedPortfolio>,
): void {
  const byKey = new Map(fresh.map((p) => [p.pubkey.toBase58(), p]));
  for (let i = 0; i < positioned.length; i++) {
    const f = byKey.get(positioned[i].pubkey.toBase58());
    if (f) positioned[i] = f;
  }
}

// ── Sweep transaction plan ────────────────────────────────────────────────────

export interface SweepPlan extends CrankPlan {
  /** Targets that did not fit under the CU cap (stay unvisited; the next tx picks them up). */
  deferred: PositionedPortfolio[];
}

/**
 * One sweep transaction:
 *   [liveness repairs] [catch-up x n] [observation crank on the LP, if `accrue`] [refresh (+liquidate) x <= k]
 *
 * `accrue: false` is the refresh-only shape, used only when a simulation shows
 * the asset is already accrued in the current slot (an earlier sweep tx landed
 * in it), where a second observation crank would return Custom(22). The
 * compute-budget limit is the sum of the estimates plus `cfg.headroomCu`,
 * capped at MAX_TX_CU. Targets that do not fit are returned in `deferred`.
 */
export function planSweepTx(params: {
  owner: PublicKey;
  market: PublicKey;
  lpPortfolio: PublicKey;
  targets: ReadonlyArray<PositionedPortfolio>;
  cfg: SweepConfig;
  accrue?: boolean;
  catchup?: number;
  repairs?: ReadonlyArray<LivenessRepair>;
  liquidateTargets?: ReadonlyArray<PublicKey>;
}): SweepPlan {
  const { owner, market, lpPortfolio, targets, cfg } = params;
  const accrue = params.accrue ?? true;
  const catchup = accrue ? params.catchup ?? 0 : 0;
  const repairs = params.repairs ?? [];
  const liq = params.liquidateTargets ?? [];
  const cranks: PlannedCrank[] = repairs.map((r) => ({
    kind: "repair" as const,
    portfolio: market,
    ix: buildLivenessRepairIx(market, r),
    repair: r,
  }));
  let cu = repairs.length * REPAIR_CU;
  for (let i = 0; i < catchup; i++) {
    cranks.push({ kind: "catchup", portfolio: lpPortfolio, ix: buildObservationCrankIx(owner, market, lpPortfolio) });
  }
  cu += catchup * CATCHUP_CRANK_CU;
  if (accrue && !catchupAllowsRefresh(catchup)) {
    return { cranks, overflow: [], deferred: [...targets], computeUnits: Math.min(MAX_TX_CU, cu + cfg.headroomCu) };
  }
  if (accrue) {
    cranks.push({ kind: "accrue", portfolio: lpPortfolio, ix: buildObservationCrankIx(owner, market, lpPortfolio) });
    cu += cfg.accrueCu;
  }
  const packCap = MAX_TX_CU - cfg.headroomCu;
  const deferred: PositionedPortfolio[] = [];
  for (const p of targets) {
    if (cu + cfg.refreshCu > packCap) {
      deferred.push(p);
      continue;
    }
    cranks.push({ kind: "refresh", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
    cu += cfg.refreshCu;
    if (!p.isLp && liq.some((t) => t.equals(p.pubkey)) && cu + LIQUIDATE_CRANK_CU <= packCap) {
      cranks.push({ kind: "liquidate", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
      cu += LIQUIDATE_CRANK_CU;
    }
  }
  return {
    cranks,
    overflow: [],
    deferred,
    computeUnits: cranks.length === 0 ? 0 : Math.min(MAX_TX_CU, cu + cfg.headroomCu),
  };
}

// ── Health ────────────────────────────────────────────────────────────────────

/** JSON-safe sweep health for /health and the `[health]` line. */
export interface SweepHealth {
  layout: "drift";
  /** max(bound/available); null when infinite (a bound faces zero insurance). */
  coverageRatio: number | null;
  covered: boolean;
  /** Drift tracker fails the engine's shape check (S1): never admits. */
  trackerMalformed: boolean;
  relaxedEligible: boolean;
  ineligibleReason: string | null;
  blocksRiskIncrease: boolean;
  /** Decimal atoms, or "uncovered" when the engine has no bound (S1). */
  boundLong: string;
  boundShort: string;
  availableLongDomain: string;
  availableShortDomain: string;
  staleLong: number;
  staleShort: number;
  laggardLong: number;
  laggardShort: number;
  pace: SweepPaceLevel;
  k: number;
  txsPlanned: number;
  txsSent: number;
  refreshed: number;
  pruned: number;
  positioned: number;
  /** Positioned portfolios not visited by the sweep yet since they became positioned (or since boot). */
  neverVisited: number;
}

export function sweepHealth(
  cov: SweepCoverage,
  pace: SweepPace,
  run: { txsSent: number; refreshed: number; pruned: number; positioned: number; neverVisited: number },
): SweepHealth {
  return {
    layout: "drift",
    coverageRatio: Number.isFinite(cov.ratio) ? Number(cov.ratio.toFixed(6)) : null,
    covered: cov.covered,
    trackerMalformed: cov.trackerMalformed,
    relaxedEligible: cov.relaxedEligible,
    ineligibleReason: cov.ineligibleReason,
    blocksRiskIncrease: cov.blocksRiskIncrease,
    boundLong: cov.boundLong === null ? "uncovered" : cov.boundLong.toString(),
    boundShort: cov.boundShort === null ? "uncovered" : cov.boundShort.toString(),
    availableLongDomain: cov.availableLongDomain.toString(),
    availableShortDomain: cov.availableShortDomain.toString(),
    staleLong: Number(cov.staleLong),
    staleShort: Number(cov.staleShort),
    laggardLong: Number(cov.laggardLong),
    laggardShort: Number(cov.laggardShort),
    pace: pace.level,
    k: pace.k,
    txsPlanned: pace.txs,
    txsSent: run.txsSent,
    refreshed: run.refreshed,
    pruned: run.pruned,
    positioned: run.positioned,
    neverVisited: run.neverVisited,
  };
}
