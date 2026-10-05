/**
 * Continuous positioned-portfolio sweep (drift-layout markets, engine 3b02ff24 /
 * wrapper eae0cce7): decoder, hidden-loss bound and coverage math against
 * hand-built market buffers, the old-layout fallback, the sweep transaction
 * planner (shape, k cap, CU limit, tx size), round-robin coverage of every
 * positioned portfolio, the adaptive pace, the follow-up runner and the health
 * fields.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/positioned-sweep.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { IX_TAG } from "@percolatorct/sdk";
import {
  ASSET_SLOTS_OFF,
  BOUND_SCALE,
  DEFAULT_SWEEP_CONFIG,
  DRIFT_SLOT_STRIDE,
  LEGACY_SLOT_STRIDE,
  POS_SCALE,
  SOCIAL_WEIGHT_SCALE,
  availableDomainInsurance,
  decodeSweepMarketState,
  detectMarketLayout,
  driftEngineSlotBase,
  driftTrackerWellFormed,
  evaluateCoverage,
  freshSweepCursor,
  isStaleAtRead,
  hiddenLossBound,
  markVisited,
  maxRefreshesPerSweepTx,
  planSweepPace,
  planSweepTx,
  pruneVisits,
  selectSweepBatch,
  sweepConfigFromEnv,
  sweepEnabledFromEnv,
  sweepFieldOffsets,
  sweepHealth,
} from "./positioned-sweep.ts";
import type { KfDriftSide, SweepConfig, SweepCoverage, SweepCursor, SweepPlan } from "./positioned-sweep.ts";
import { ACCRUE_CRANK_CU, MAX_TX_CU } from "./positioned-refresh.ts";
import type { CrankPlan, PositionedPortfolio } from "./positioned-refresh.ts";
import { runSweepFollowups, sweepContextFor } from "./recovery-cranker.ts";
import type { SimOutcome, SweepFollowupDeps } from "./recovery-cranker.ts";
import { crankHealthFields } from "./keeper-loop.ts";
import { crankHealthRecord } from "./alerting.ts";
import type { CrankRefreshHealth } from "./refresh-coordination.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const SCALE = SOCIAL_WEIGHT_SCALE * POS_SCALE; // 1e21

// ── Hand-built drift-layout market ────────────────────────────────────────────

interface MarketSpec {
  slots?: number;
  currentSlot?: bigint;
  slotLast?: bigint;
  insurance?: bigint;
  sourceReserved?: bigint;
  lifecycle?: number;
  effectivePrice?: bigint;
  kfEpochLong?: bigint;
  kfEpochShort?: bigint;
  staleLong?: bigint;
  staleShort?: bigint;
  pendingOblLong?: bigint;
  pendingOblShort?: bigint;
  modeLong?: number;
  modeShort?: number;
  budgetLong?: bigint;
  budgetShort?: bigint;
  spentLong?: bigint;
  spentShort?: bigint;
  barrierLong?: bigint;
  barrierShort?: bigint;
  reservedNumLong?: bigint;
  reservedNumShort?: bigint;
  driftLong?: Partial<KfDriftSide>;
  driftShort?: Partial<KfDriftSide>;
}

function putU64(b: Buffer, off: number, v: bigint): void {
  b.writeBigUInt64LE(v, off);
}
function putU128(b: Buffer, off: number, v: bigint): void {
  b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
  b.writeBigUInt64LE(v >> 64n, off + 8);
}
function putDrift(b: Buffer, off: number, d: Partial<KfDriftSide>): void {
  putU64(b, off, d.genEpoch ?? 0n);
  putU64(b, off + 8, d.laggardCount ?? 0n);
  putU128(b, off + 16, d.driftGen ?? 0n);
  putU128(b, off + 32, d.driftPrior ?? 0n);
  putU128(b, off + 48, d.staleWeight ?? 0n);
  putU128(b, off + 64, d.laggardWeight ?? 0n);
}

/** A drift-layout market account: 1350 + slots * 2485 bytes, asset 0 filled from `s`. */
function driftMarket(s: MarketSpec = {}): Buffer {
  const slots = s.slots ?? 1;
  const b = Buffer.alloc(ASSET_SLOTS_OFF + slots * DRIFT_SLOT_STRIDE);
  const o = sweepFieldOffsets(0);
  b.writeUInt32LE(slots, o.maxMarketSlots);
  putU64(b, o.currentSlot, s.currentSlot ?? 1_000n);
  putU64(b, o.slotLast, s.slotLast ?? s.currentSlot ?? 1_000n);
  putU128(b, o.insurance, s.insurance ?? 1_000_000_000n);
  putU128(b, o.sourceInsuranceReservedTotal, s.sourceReserved ?? 0n);
  b[o.lifecycle] = s.lifecycle ?? 2;
  putU64(b, o.effectivePrice, s.effectivePrice ?? 150_000_000n);
  putU64(b, o.kfEpochLong, s.kfEpochLong ?? 0n);
  putU64(b, o.kfEpochShort, s.kfEpochShort ?? 0n);
  putU64(b, o.staleLong, s.staleLong ?? 0n);
  putU64(b, o.staleShort, s.staleShort ?? 0n);
  putU64(b, o.pendingObligationLong, s.pendingOblLong ?? 0n);
  putU64(b, o.pendingObligationShort, s.pendingOblShort ?? 0n);
  b[o.modeLong] = s.modeLong ?? 0;
  b[o.modeShort] = s.modeShort ?? 0;
  putU128(b, o.insuranceBudgetLong, s.budgetLong ?? 1_000_000_000n);
  putU128(b, o.insuranceBudgetShort, s.budgetShort ?? 1_000_000_000n);
  putU128(b, o.insuranceSpentLong, s.spentLong ?? 0n);
  putU128(b, o.insuranceSpentShort, s.spentShort ?? 0n);
  putU64(b, o.pendingBarrierLong, s.barrierLong ?? 0n);
  putU64(b, o.pendingBarrierShort, s.barrierShort ?? 0n);
  putU128(b, o.insuranceReservedNumLong, s.reservedNumLong ?? 0n);
  putU128(b, o.insuranceReservedNumShort, s.reservedNumShort ?? 0n);
  putDrift(b, o.driftLong, s.driftLong ?? {});
  putDrift(b, o.driftShort, s.driftShort ?? {});
  return b;
}

const decode = (s: MarketSpec = {}) => {
  const d = decodeSweepMarketState(driftMarket(s));
  assert.ok(d, "drift market must decode");
  return d;
};

// ── Layout / decoder ──────────────────────────────────────────────────────────

describe("drift-layout decoder", () => {
  it("absolute asset-0 offsets match the wrapper eae0cce7 / engine 3b02ff24 layout", () => {
    const o = sweepFieldOffsets(0);
    assert.equal(driftEngineSlotBase(0), 2374);
    assert.deepEqual(
      [o.maxMarketSlots, o.currentSlot, o.insurance, o.sourceInsuranceReservedTotal],
      [626, 1205, 893, 1037],
    );
    const E = 2374;
    assert.deepEqual(
      [o.lifecycle, o.effectivePrice, o.slotLast, o.kfEpochLong, o.kfEpochShort, o.staleLong, o.staleShort],
      [E + 16, E + 25, E + 41, E + 145, E + 153, E + 337, E + 345],
    );
    assert.deepEqual([o.pendingObligationLong, o.pendingObligationShort, o.modeLong, o.modeShort], [E + 353, E + 361, E + 513, E + 514]);
    assert.deepEqual(
      [o.insuranceBudgetLong, o.insuranceBudgetShort, o.insuranceSpentLong, o.insuranceSpentShort, o.pendingBarrierLong, o.pendingBarrierShort],
      [E + 515, E + 531, E + 547, E + 563, E + 579, E + 587],
    );
    assert.deepEqual([o.insuranceReservedNumLong, o.insuranceReservedNumShort, o.driftLong, o.driftShort], [E + 1157, E + 1229, E + 1301, E + 1381]);
    // the short drift block ends exactly at the end of the 2485-byte slot
    assert.equal(o.driftShort + 80, ASSET_SLOTS_OFF + DRIFT_SLOT_STRIDE);
    // asset k > 0
    assert.equal(driftEngineSlotBase(2), 1350 + 2 * 2485 + 1024);
  });

  it("detects the layout from the account length and max_market_slots", () => {
    assert.equal(detectMarketLayout(driftMarket({ slots: 1 })), "drift");
    assert.equal(detectMarketLayout(driftMarket({ slots: 3 })), "drift");
    const legacy = Buffer.alloc(ASSET_SLOTS_OFF + 2 * LEGACY_SLOT_STRIDE);
    legacy.writeUInt32LE(2, 626);
    assert.equal(detectMarketLayout(legacy), "legacy");
    const odd = Buffer.alloc(ASSET_SLOTS_OFF + DRIFT_SLOT_STRIDE + 8);
    odd.writeUInt32LE(1, 626);
    assert.equal(detectMarketLayout(odd), "unknown");
    assert.equal(detectMarketLayout(Buffer.alloc(100)), "unknown");
    const zeroSlots = driftMarket({ slots: 1 });
    zeroSlots.writeUInt32LE(0, 626);
    assert.equal(detectMarketLayout(zeroSlots), "unknown");
  });

  it("real devnet v18 markets (old 2325-byte stride) are legacy and are not decoded", () => {
    for (const name of ["cate-market-v18", "jup-market-v18", "percolator-market-v18-relaunch"]) {
      const d = fixture(name);
      assert.equal(detectMarketLayout(d), "legacy", name);
      assert.equal(decodeSweepMarketState(d), null, name);
    }
  });

  it("decodes every field from its own offset", () => {
    const s = decode({
      currentSlot: 777n,
      slotLast: 776n,
      insurance: (1n << 100n) + 5n,
      sourceReserved: 9n,
      lifecycle: 2,
      effectivePrice: 123_456n,
      kfEpochLong: 11n,
      kfEpochShort: 12n,
      staleLong: 3n,
      staleShort: 4n,
      pendingOblLong: 5n,
      pendingOblShort: 6n,
      modeLong: 1,
      modeShort: 2,
      budgetLong: 101n,
      budgetShort: 102n,
      spentLong: 103n,
      spentShort: 104n,
      barrierLong: 7n,
      barrierShort: 8n,
      reservedNumLong: 105n,
      reservedNumShort: 106n,
      driftLong: { genEpoch: 21n, laggardCount: 22n, driftGen: 23n, driftPrior: 24n, staleWeight: 25n, laggardWeight: 26n },
      driftShort: { genEpoch: 31n, laggardCount: 32n, driftGen: 33n, driftPrior: 34n, staleWeight: 35n, laggardWeight: (1n << 127n) + 1n },
    });
    assert.equal(s.maxMarketSlots, 1);
    assert.equal(s.currentSlot, 777n);
    assert.equal(s.slotLast, 776n);
    assert.equal(s.insurance, (1n << 100n) + 5n);
    assert.equal(s.sourceInsuranceReservedTotal, 9n);
    assert.equal(s.effectivePrice, 123_456n);
    assert.deepEqual([s.kfEpochLong, s.kfEpochShort, s.staleLong, s.staleShort], [11n, 12n, 3n, 4n]);
    assert.deepEqual([s.pendingObligationLong, s.pendingObligationShort, s.modeLong, s.modeShort], [5n, 6n, 1, 2]);
    assert.deepEqual(
      [s.insuranceBudgetLong, s.insuranceBudgetShort, s.insuranceSpentLong, s.insuranceSpentShort],
      [101n, 102n, 103n, 104n],
    );
    assert.deepEqual([s.pendingBarrierLong, s.pendingBarrierShort, s.insuranceReservedNumLong, s.insuranceReservedNumShort], [7n, 8n, 105n, 106n]);
    assert.deepEqual(s.driftLong, { genEpoch: 21n, laggardCount: 22n, driftGen: 23n, driftPrior: 24n, staleWeight: 25n, laggardWeight: 26n });
    assert.equal(s.driftShort.laggardWeight, (1n << 127n) + 1n);
    assert.equal(s.driftShort.genEpoch, 31n);
  });
});

// ── Bound / available / coverage ─────────────────────────────────────────────

describe("hidden-loss bound", () => {
  it("is 0 with no stale legs, whatever the drift says", () => {
    assert.equal(hiddenLossBound(0n, { genEpoch: 0n, laggardCount: 5n, driftGen: SCALE, driftPrior: SCALE, staleWeight: SCALE, laggardWeight: SCALE }), 0n);
  });

  it("generation term only (no laggards): ceil(stale_weight*drift_gen/(SWS*POS)) + 2*stale, ceil is exact", () => {
    // stale_weight * drift_gen = 12 * SCALE exactly -> 12; + 2*4
    assert.equal(hiddenLossBound(4n, { genEpoch: 0n, laggardCount: 0n, driftGen: 3n * SCALE, driftPrior: 999n * SCALE, staleWeight: 4n, laggardWeight: 999n }), 12n + 8n);
    // one atom above 3 * SCALE rounds up to 4
    assert.equal(hiddenLossBound(1n, { genEpoch: 0n, laggardCount: 0n, driftGen: 3n * SCALE + 1n, driftPrior: 0n, staleWeight: 1n, laggardWeight: 0n }), 4n + 2n);
    // a product below one SCALE still rounds up to 1
    assert.equal(hiddenLossBound(1n, { genEpoch: 0n, laggardCount: 0n, driftGen: 1n, driftPrior: 0n, staleWeight: 1n, laggardWeight: 0n }), 1n + 2n);
  });

  it("laggard case adds ceil(laggard_weight*drift_prior/(SWS*POS)) only while laggards exist", () => {
    const d: KfDriftSide = {
      genEpoch: 7n,
      laggardCount: 2n,
      driftGen: 10n * SCALE,
      driftPrior: 5n * SCALE + 1n,
      staleWeight: 5n,
      laggardWeight: 2n,
    };
    // gen: 5*10 = 50; prior: ceil(2*(5*SCALE+1)/SCALE) = 11; + 2*5
    assert.equal(hiddenLossBound(5n, d), 50n + 11n + 10n);
    assert.equal(hiddenLossBound(5n, { ...d, laggardCount: 0n }), 50n + 10n);
  });

  it("does not overflow on u128-sized inputs (BigInt)", () => {
    const big = (1n << 128n) - 1n;
    const b = hiddenLossBound(1n, { genEpoch: 0n, laggardCount: 1n, driftGen: big, driftPrior: big, staleWeight: big, laggardWeight: big });
    assert.ok(b !== null && b > big);
  });

  it("S1 (engine 89403177): stale_weight < stale has NO bound (fail closed), not 2*stale", () => {
    const d: KfDriftSide = { genEpoch: 0n, laggardCount: 0n, driftGen: 0n, driftPrior: 0n, staleWeight: 2n, laggardWeight: 0n };
    assert.equal(hiddenLossBound(3n, d), null);
    assert.equal(hiddenLossBound(2n, d), 4n); // weight == count: defined
    assert.equal(hiddenLossBound(3n, { ...d, staleWeight: 0n }), null); // zeroed drift tail under a live cohort
  });
});

describe("available domain insurance", () => {
  it("min(insurance - source reserved, budget - spent - ceil(reserved_num / BOUND_SCALE))", () => {
    const s = decode({ insurance: 1_000n, sourceReserved: 100n, budgetLong: 800n, spentLong: 100n, reservedNumLong: 50n * BOUND_SCALE + 1n });
    // global 900; budget remaining 800 - 100 - 51 = 649
    assert.equal(availableDomainInsurance(s, "long"), 649n);
    const t = decode({ insurance: 300n, sourceReserved: 100n, budgetShort: 800n });
    assert.equal(availableDomainInsurance(t, "short"), 200n);
  });

  it("floors each part at 0", () => {
    assert.equal(availableDomainInsurance(decode({ insurance: 10n, sourceReserved: 50n }), "long"), 0n);
    assert.equal(availableDomainInsurance(decode({ budgetShort: 10n, spentShort: 20n }), "short"), 0n);
    assert.equal(availableDomainInsurance(decode({ budgetShort: 10n, reservedNumShort: 11n * BOUND_SCALE }), "short"), 0n);
  });
});

describe("coverage (long bound vs SHORT domain, short bound vs LONG domain)", () => {
  // bound long = 100 + 2*1 = 102, bound short = 40 + 2*2 = 44
  const stale = {
    staleLong: 1n,
    staleShort: 2n,
    driftLong: { driftGen: 100n * SCALE, staleWeight: 1n },
    driftShort: { driftGen: 20n * SCALE, staleWeight: 2n },
  };

  it("covered: both bounds within the opposite domain's available insurance", () => {
    const c = evaluateCoverage(decode({ ...stale, budgetLong: 88n, budgetShort: 204n }));
    assert.equal(c.boundLong, 102n);
    assert.equal(c.boundShort, 44n);
    assert.equal(c.availableShortDomain, 204n);
    assert.equal(c.availableLongDomain, 88n);
    assert.equal(c.covered, true);
    assert.equal(c.ratio, 0.5); // max(102/204, 44/88)
    assert.equal(c.relaxedEligible, true);
    assert.equal(c.blocksRiskIncrease, false);
  });

  it("not covered: the long bound exceeds the SHORT domain (a huge LONG domain does not help)", () => {
    const c = evaluateCoverage(decode({ ...stale, budgetLong: 10n ** 12n, budgetShort: 101n }));
    assert.equal(c.covered, false);
    assert.ok(c.ratio > 1);
    assert.equal(c.blocksRiskIncrease, true);
  });

  it("bound exactly equal to available is covered (<=)", () => {
    const c = evaluateCoverage(decode({ ...stale, budgetLong: 44n, budgetShort: 102n }));
    assert.equal(c.covered, true);
    assert.equal(c.ratio, 1);
  });

  it("laggard case: drift_prior on the laggard weight tips a covered market to not covered", () => {
    const base = { ...stale, budgetLong: 100n, budgetShort: 150n };
    assert.equal(evaluateCoverage(decode(base)).covered, true);
    const withLaggards = evaluateCoverage(
      decode({ ...base, driftLong: { ...stale.driftLong, laggardCount: 1n, laggardWeight: 1n, driftPrior: 60n * SCALE } }),
    );
    assert.equal(withLaggards.boundLong, 162n);
    assert.equal(withLaggards.laggardLong, 1n);
    assert.equal(withLaggards.covered, false);
  });

  it("zero insurance against a non-zero bound: ratio is Infinity, not covered", () => {
    const c = evaluateCoverage(decode({ ...stale, insurance: 0n }));
    assert.equal(c.ratio, Number.POSITIVE_INFINITY);
    assert.equal(c.covered, false);
  });

  it("S1: a zeroed drift tail under a live cohort is uncovered even with unlimited insurance", () => {
    const c = evaluateCoverage(decode({ staleLong: 3n, budgetLong: 10n ** 18n, budgetShort: 10n ** 18n, insurance: 10n ** 18n }));
    assert.equal(c.boundLong, null);
    assert.equal(c.covered, false);
    assert.equal(c.trackerMalformed, true);
    assert.equal(c.ratio, Number.POSITIVE_INFINITY);
    assert.equal(c.blocksRiskIncrease, true);
    const h = sweepHealth(c, { level: "urgent", k: 10, txs: 1 }, { txsSent: 0, refreshed: 0, pruned: 0, positioned: 3, neverVisited: 3 });
    assert.equal(h.boundLong, "uncovered");
    assert.equal(h.coverageRatio, null);
    assert.equal(h.trackerMalformed, true);
  });

  it("S1 tracker shape check (validate_kf_drift_shape): each violation fails closed", () => {
    const ok: MarketSpec = { ...stale, budgetLong: 10_000n, budgetShort: 10_000n, kfEpochLong: 9n, kfEpochShort: 9n };
    assert.equal(driftTrackerWellFormed(decode(ok)), true);
    assert.equal(evaluateCoverage(decode(ok)).covered, true);
    const bad: Array<[string, MarketSpec]> = [
      ["laggards above the stale count", { ...ok, driftLong: { ...stale.driftLong, laggardCount: 2n, laggardWeight: 2n } }],
      ["generation after the KF epoch", { ...ok, driftShort: { ...stale.driftShort, genEpoch: 10n } }],
      ["laggard weight below laggard count", { ...ok, driftLong: { ...stale.driftLong, laggardCount: 1n, laggardWeight: 0n } }],
      ["stale weight below stale count", { ...ok, driftShort: { ...stale.driftShort, staleWeight: 1n } }],
    ];
    for (const [why, spec] of bad) {
      const c = evaluateCoverage(decode(spec));
      assert.equal(c.trackerMalformed, true, why);
      assert.equal(c.covered, false, why);
      assert.equal(c.blocksRiskIncrease, true, why);
    }
    // the weight check only applies on a Normal side (weights are inexact otherwise; the
    // relaxed path is unavailable there anyway)
    const drained = evaluateCoverage(decode({ ...ok, modeLong: 1, driftLong: { ...stale.driftLong, laggardCount: 1n, laggardWeight: 0n } }));
    assert.equal(drained.trackerMalformed, false);
    assert.equal(drained.relaxedEligible, false);
  });

  it("no stale legs: bound 0, ratio 0, covered, nothing blocked", () => {
    const c = evaluateCoverage(decode({ insurance: 0n }));
    assert.deepEqual([c.boundLong, c.boundShort, c.ratio, c.covered, c.blocksRiskIncrease], [0n, 0n, 0, true, false]);
  });

  it("the engine's other preconditions make the relaxed path unavailable (stale -> blocked even if covered)", () => {
    const ok = { ...stale, budgetLong: 10_000n, budgetShort: 10_000n };
    const cases: Array<[MarketSpec, string]> = [
      [{ slots: 2 }, "max_market_slots=2"],
      [{ lifecycle: 3 }, "lifecycle=3"],
      [{ modeLong: 1 }, "mode=1/0"],
      [{ pendingOblShort: 1n }, "pending-obligations"],
      [{ barrierLong: 1n }, "domain-loss-barrier"],
      [{ currentSlot: 10n, slotLast: 9n }, "not-accrued"],
    ];
    for (const [patch, reason] of cases) {
      const c = evaluateCoverage(decode({ ...ok, ...patch }));
      assert.equal(c.covered, true, reason);
      assert.equal(c.relaxedEligible, false, reason);
      assert.equal(c.ineligibleReason, reason);
      assert.equal(c.blocksRiskIncrease, true, reason);
    }
  });
});

// ── Old-layout fallback ───────────────────────────────────────────────────────

const pk = (i: number): PublicKey => {
  const b = new Uint8Array(32);
  b[0] = 1;
  b[30] = Math.floor(i / 256);
  b[31] = i % 256;
  return new PublicKey(b);
};
const portfolios = (n: number, lpIndex = 0): PositionedPortfolio[] =>
  Array.from({ length: n }, (_, i) => ({ pubkey: pk(i + 1), longLegs: i % 2 === 0 ? 1 : 0, shortLegs: i % 2 === 0 ? 0 : 1, isLp: i === lpIndex }));

describe("sweepContextFor (old-layout fallback)", () => {
  it("legacy markets get no sweep context: the cranker keeps refresh-everything", () => {
    const st = { sweepCursor: freshSweepCursor() };
    assert.equal(sweepContextFor(fixture("cate-market-v18"), portfolios(3), st, DEFAULT_SWEEP_CONFIG, true), null);
    assert.equal(sweepContextFor(fixture("percolator-market-v18-relaunch"), portfolios(12), st, DEFAULT_SWEEP_CONFIG, true), null);
  });

  it("KEEPER_SWEEP_ENABLED=false disables it on drift markets too", () => {
    const st = { sweepCursor: freshSweepCursor() };
    assert.equal(sweepContextFor(driftMarket(), portfolios(3), st, DEFAULT_SWEEP_CONFIG, false), null);
    assert.equal(sweepEnabledFromEnv({ KEEPER_SWEEP_ENABLED: "false" }), false);
    assert.equal(sweepEnabledFromEnv({}), true);
  });

  it("drift markets get coverage, pace and the first round-robin batch", () => {
    const st = { sweepCursor: freshSweepCursor() };
    const ctx = sweepContextFor(
      driftMarket({ staleLong: 1n, staleShort: 1n, driftLong: { staleWeight: 1n }, driftShort: { staleWeight: 1n } }),
      portfolios(25), st, DEFAULT_SWEEP_CONFIG, true,
    );
    assert.ok(ctx);
    assert.equal(ctx.positioned.length, 25);
    assert.equal(ctx.firstBatch.length, ctx.pace.k);
    assert.equal(ctx.coverage.staleLong, 1n);
  });
});

// ── Transaction planner ───────────────────────────────────────────────────────

const OWNER = Keypair.generate();
const MARKET = pk(900);
const LP = pk(1);

function crankKind(data: Uint8Array): "obs" | "noobs" {
  assert.equal(data[0], IX_TAG.PermissionlessCrank);
  return data[9] === 0 ? "noobs" : "obs";
}

function txBytes(plan: CrankPlan): number {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits }));
  for (const c of plan.cranks) tx.add(c.ix);
  tx.recentBlockhash = pk(999).toBase58();
  tx.feePayer = OWNER.publicKey;
  tx.sign(OWNER);
  return tx.serialize().length;
}

describe("planSweepTx", () => {
  it("default k=10 fits beside the accrual: [observation crank, refresh x 10], CU <= 1.4M, tx <= 1232 bytes", () => {
    assert.equal(maxRefreshesPerSweepTx(DEFAULT_SWEEP_CONFIG), 10);
    const targets = portfolios(10, 9);
    const plan = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets, cfg: DEFAULT_SWEEP_CONFIG });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue", ...Array(10).fill("refresh")]);
    assert.equal(crankKind(plan.cranks[0].ix.data), "obs");
    for (const c of plan.cranks.slice(1)) assert.equal(crankKind(c.ix.data), "noobs");
    assert.equal(plan.cranks[0].portfolio.toBase58(), LP.toBase58());
    assert.equal(plan.computeUnits, ACCRUE_CRANK_CU + 10 * 114_000 + 60_000);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
    assert.deepEqual(plan.deferred, []);
    assert.deepEqual(plan.overflow, []);
    assert.ok(txBytes(plan) <= 1232, `tx is ${txBytes(plan)} bytes`);
  });

  it("caps refreshes at the CU limit; the rest are deferred (not visited, next tx)", () => {
    const plan = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: portfolios(13), cfg: DEFAULT_SWEEP_CONFIG });
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 10);
    assert.equal(plan.deferred.length, 3);
    // a heavier refresh estimate packs fewer
    const heavy: SweepConfig = { ...DEFAULT_SWEEP_CONFIG, refreshCu: 145_000, headroomCu: 100_000 };
    assert.equal(maxRefreshesPerSweepTx(heavy), 7);
    const p2 = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: portfolios(10), cfg: heavy });
    assert.equal(p2.cranks.filter((c) => c.kind === "refresh").length, 7);
    assert.ok(p2.computeUnits <= MAX_TX_CU);
  });

  it("refresh-only shape (asset already accrued this slot): no observation crank", () => {
    const plan = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: portfolios(4), cfg: DEFAULT_SWEEP_CONFIG, accrue: false, catchup: 3 });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["refresh", "refresh", "refresh", "refresh"]);
    for (const c of plan.cranks) assert.equal(crankKind(c.ix.data), "noobs");
    assert.equal(plan.computeUnits, 4 * 114_000 + 60_000);
  });

  it("catch-up cranks go before the accrual and take CU from the refreshes", () => {
    const plan = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: portfolios(10), cfg: DEFAULT_SWEEP_CONFIG, catchup: 2 });
    assert.deepEqual(plan.cranks.slice(0, 3).map((c) => c.kind), ["catchup", "catchup", "accrue"]);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 9);
    // too far behind: catch-up only, every target deferred
    const far = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: portfolios(3), cfg: DEFAULT_SWEEP_CONFIG, catchup: 11 });
    assert.equal(far.cranks.every((c) => c.kind === "catchup"), true);
    assert.equal(far.deferred.length, 3);
  });

  it("a bankrupt target gets its liquidate crank right after its refresh when it fits", () => {
    const targets = portfolios(3);
    const plan = planSweepTx({
      owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets, cfg: DEFAULT_SWEEP_CONFIG, liquidateTargets: [targets[1].pubkey],
    });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue", "refresh", "refresh", "liquidate", "refresh"]);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
  });

  it("never contains anything but repairs and PermissionlessCranks (never a user order)", () => {
    const plan = planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: portfolios(10), cfg: DEFAULT_SWEEP_CONFIG });
    for (const c of plan.cranks) assert.equal(c.ix.data[0], IX_TAG.PermissionlessCrank);
  });
});

// ── Round robin ───────────────────────────────────────────────────────────────

/** Positioned portfolios with explicit weights and long-leg epoch snaps. */
const weighted = (ws: ReadonlyArray<bigint>, snap: bigint = 0n, lpIndex = -1): PositionedPortfolio[] =>
  ws.map((w, i) => ({ pubkey: pk(i + 1), longLegs: 1, shortLegs: 0, isLp: i === lpIndex, lossWeight: w, kfEpochSnapLong: snap, kfEpochSnapShort: null }));
const keys = (ps: ReadonlyArray<PositionedPortfolio>) => ps.map((p) => p.pubkey.toBase58());

describe("sweep order (security review I2: heaviest stale first, every portfolio once per round)", () => {
  it("orders by loss_weight descending within a batch's selection", () => {
    const all = weighted([5n, 50n, 1n, 500n, 20n]);
    const batch = selectSweepBatch(all, freshSweepCursor(), 3, new Set(), { long: 9n, short: 9n });
    assert.deepEqual(keys(batch), keys([all[3], all[1], all[4]]));
  });

  it("stale at the read (kf_epoch_snap < kf_epoch) goes before not stale, whatever the weight", () => {
    const all: PositionedPortfolio[] = [
      { pubkey: pk(1), longLegs: 1, shortLegs: 0, isLp: false, lossWeight: 1_000n, kfEpochSnapLong: 9n, kfEpochSnapShort: null }, // current
      { pubkey: pk(2), longLegs: 0, shortLegs: 1, isLp: false, lossWeight: 10n, kfEpochSnapLong: null, kfEpochSnapShort: 3n }, // stale short
      { pubkey: pk(3), longLegs: 1, shortLegs: 0, isLp: false, lossWeight: 20n, kfEpochSnapLong: 8n, kfEpochSnapShort: null }, // stale long
    ];
    const epochs = { long: 9n, short: 4n };
    assert.deepEqual(all.map((p) => isStaleAtRead(p, epochs)), [false, true, true]);
    assert.deepEqual(keys(selectSweepBatch(all, freshSweepCursor(), 3, new Set(), epochs)), keys([all[2], all[1], all[0]]));
    // no epochs / no snaps known: everyone counts as stale (weight order only)
    assert.equal(isStaleAtRead(all[0], null), true);
    assert.equal(isStaleAtRead({ pubkey: pk(9), longLegs: 1, shortLegs: 0, isLp: false }, epochs), true);
  });

  it("equal weights: least recently visited first; the LP still goes last in the tx", () => {
    const all = weighted([7n, 7n, 7n, 7n], 0n, 0);
    const cur = freshSweepCursor();
    cur.visits.set(pk(2).toBase58(), -5);
    cur.visits.set(pk(3).toBase58(), -9);
    const batch = selectSweepBatch(all, cur, 3);
    // never-visited pk(1) (LP, -1) and pk(4) (-1) after pk(3) (-9) and pk(2) (-5): pick -9, -5, then -1 by key
    assert.equal(batch.length, 3);
    assert.equal(keys(batch).includes(pk(3).toBase58()), true);
    assert.equal(keys(batch).includes(pk(2).toBase58()), true);
    const lpAt = batch.findIndex((p) => p.isLp);
    assert.ok(lpAt === -1 || lpAt === batch.length - 1);
  });

  it("per cycle (runner excludes what it took): every positioned portfolio exactly once, heaviest batch first", () => {
    const n = 23;
    const ws = Array.from({ length: n }, (_, i) => BigInt(((i * 7919) % 101) + 1));
    const all = weighted(ws);
    const cur = freshSweepCursor();
    for (let cycle = 0; cycle < 4; cycle++) {
      const taken = new Set<string>();
      const seen = new Map<string, number>();
      const batchWeights: bigint[] = [];
      for (let i = 0; i < Math.ceil(n / 10); i++) {
        const batch = selectSweepBatch(all, cur, 10, taken);
        batchWeights.push(batch.reduce((a, p) => a + (p.lossWeight ?? 0n), 0n));
        for (const p of batch) {
          const key = p.pubkey.toBase58();
          seen.set(key, (seen.get(key) ?? 0) + 1);
          taken.add(key);
        }
        markVisited(cur, batch.map((p) => p.pubkey));
      }
      assert.equal(seen.size, n, `cycle ${cycle}`);
      for (const c of seen.values()) assert.equal(c, 1);
      if (cycle === 0) assert.ok(batchWeights[0] >= batchWeights[1] && batchWeights[1] >= batchWeights[2], "heaviest first");
    }
  });

  it("starvation bound across cycles (one batch per cycle): a light laggard is reached every round, gap <= 2*ceil(n/k)-1", () => {
    const n = 23;
    const k = 10;
    // 22 heavy portfolios that are always stale, one very light one
    const all = weighted([...Array(n - 1).fill(10n ** 12n), 1n]);
    const light = pk(n).toBase58();
    const cur = freshSweepCursor();
    const lastBatch = new Map<string, number>();
    let maxGap = 0;
    let lightVisits = 0;
    const B = 60;
    for (let b = 1; b <= B; b++) {
      const batch = selectSweepBatch(all, cur, k, new Set(), { long: 1_000n, short: 1_000n });
      for (const p of batch) {
        const key = p.pubkey.toBase58();
        if (key === light) lightVisits++;
        maxGap = Math.max(maxGap, b - (lastBatch.get(key) ?? 0));
        lastBatch.set(key, b);
      }
      markVisited(cur, batch.map((p) => p.pubkey));
    }
    const round = Math.ceil(n / k);
    assert.equal(lastBatch.size, n);
    assert.ok(maxGap <= 2 * round - 1, `max gap ${maxGap}`);
    assert.equal(lightVisits, B / round, "the light portfolio is visited exactly once per round");
  });

  it("negative control: a pure weight order (no rounds) would starve the light portfolio", () => {
    const all = weighted([...Array(22).fill(10n ** 12n), 1n]);
    const pureWeight = [...all].sort((a, b) => ((b.lossWeight ?? 0n) > (a.lossWeight ?? 0n) ? 1 : -1)).slice(0, 10);
    assert.equal(keys(pureWeight).includes(pk(23).toBase58()), false);
  });

  it("weight order shrinks the stale weight faster than index order in the first batch", () => {
    const ws = Array.from({ length: 30 }, (_, i) => BigInt(i + 1));
    const all = weighted(ws);
    const byWeight = selectSweepBatch(all, freshSweepCursor(), 10).reduce((a, p) => a + (p.lossWeight ?? 0n), 0n);
    const byIndex = all.slice(0, 10).reduce((a, p) => a + (p.lossWeight ?? 0n), 0n);
    assert.equal(byWeight, ws.slice(20).reduce((a, w) => a + w, 0n));
    assert.ok(byWeight > byIndex);
  });

  it("excludes what this cycle already took, and forgets portfolios that closed", () => {
    const all = portfolios(4);
    const batch = selectSweepBatch(all, freshSweepCursor(), 10, new Set([pk(1).toBase58(), pk(2).toBase58()]));
    assert.deepEqual(keys(batch).sort(), keys([all[2], all[3]]).sort());
    assert.deepEqual(selectSweepBatch(all, freshSweepCursor(), 0), []);
    const cur = freshSweepCursor();
    cur.visits.set(pk(1).toBase58(), 1);
    cur.visits.set(pk(77).toBase58(), 2);
    pruneVisits(cur, all);
    assert.deepEqual([...cur.visits.keys()], [pk(1).toBase58()]);
  });
});

// ── Adaptive pace ─────────────────────────────────────────────────────────────

function cov(p: Partial<SweepCoverage>): SweepCoverage {
  return {
    boundLong: 0n, boundShort: 0n, trackerMalformed: false, availableLongDomain: 100n, availableShortDomain: 100n, covered: true, ratio: 0,
    relaxedEligible: true, ineligibleReason: null, staleLong: 5n, staleShort: 5n, laggardLong: 0n, laggardShort: 0n,
    blocksRiskIncrease: false, ...p,
  };
}

describe("planSweepPace", () => {
  const cfg = DEFAULT_SWEEP_CONFIG;
  it("idle with no positioned portfolio (accrual only)", () => {
    assert.deepEqual(planSweepPace(cov({}), 0, cfg), { level: "idle", k: 0, txs: 1 });
  });
  it("relaxed when nothing is stale or the ratio is low", () => {
    assert.deepEqual(planSweepPace(cov({ staleLong: 0n, staleShort: 0n }), 40, cfg), { level: "relaxed", k: 10, txs: 1 });
    assert.deepEqual(planSweepPace(cov({ ratio: 0.1 }), 40, cfg), { level: "relaxed", k: 10, txs: 1 });
  });
  it("speeds up as the ratio approaches 1: steady -> elevated -> urgent", () => {
    const steady = planSweepPace(cov({ ratio: 0.3 }), 40, cfg);
    const elevated = planSweepPace(cov({ ratio: 0.6 }), 40, cfg);
    const urgent = planSweepPace(cov({ ratio: 0.85 }), 40, cfg);
    assert.deepEqual(steady, { level: "steady", k: 10, txs: 2 });
    assert.deepEqual(elevated, { level: "elevated", k: 10, txs: 2 });
    assert.deepEqual(urgent, { level: "urgent", k: 10, txs: 4 });
    assert.ok(steady.txs * steady.k <= elevated.txs * elevated.k && elevated.txs * elevated.k <= urgent.txs * urgent.k);
  });
  it("k is the base when relaxed but grows to the CU cap when urgent", () => {
    const small: SweepConfig = { ...cfg, k: 4 };
    assert.equal(planSweepPace(cov({ ratio: 0.1 }), 40, small).k, 4);
    assert.equal(planSweepPace(cov({ ratio: 0.9 }), 40, small).k, 10);
  });
  it("urgent when not covered, or when the relaxed path is unavailable while stale; txs capped", () => {
    assert.equal(planSweepPace(cov({ covered: false, ratio: 1.5 }), 40, cfg).level, "urgent");
    assert.equal(planSweepPace(cov({ relaxedEligible: false, ratio: 0 }), 40, cfg).level, "urgent");
    const huge = planSweepPace(cov({ covered: false, ratio: Number.POSITIVE_INFINITY }), 500, cfg);
    assert.deepEqual(huge, { level: "urgent", k: 10, txs: cfg.maxTxsPerCycle });
    // no coverage info at all: treat as urgent (full sweep)
    assert.equal(planSweepPace(null, 15, cfg).level, "urgent");
  });
  it("small sets need fewer txs than the cap", () => {
    assert.deepEqual(planSweepPace(cov({ covered: false, ratio: 2 }), 7, cfg), { level: "urgent", k: 10, txs: 1 });
  });
});

describe("sweepConfigFromEnv", () => {
  it("defaults, overrides, and rejects garbage", () => {
    assert.deepEqual(sweepConfigFromEnv({}), DEFAULT_SWEEP_CONFIG);
    const c = sweepConfigFromEnv({ KEEPER_SWEEP_K: "6", KEEPER_SWEEP_REFRESH_CU: "130000", KEEPER_SWEEP_MAX_TXS_PER_CYCLE: "3", KEEPER_SWEEP_HEADROOM_CU: "0" });
    assert.deepEqual([c.k, c.refreshCu, c.maxTxsPerCycle, c.headroomCu], [6, 130_000, 3, 0]);
    const bad = sweepConfigFromEnv({ KEEPER_SWEEP_K: "0", KEEPER_SWEEP_REFRESH_CU: "abc", KEEPER_SWEEP_MAX_TXS_PER_CYCLE: "-1" });
    assert.deepEqual([bad.k, bad.refreshCu, bad.maxTxsPerCycle], [10, 114_000, 8]);
  });
});

// ── Follow-up runner ──────────────────────────────────────────────────────────

interface FakeChain {
  /** Portfolios whose refresh simulates Custom(22) (not stale). */
  notStale: Set<string>;
  /** When true, the next simulated observation crank returns Custom(22) (slot already accrued). */
  slotAccrued: boolean;
  sent: SweepPlan[];
  landResult: "landed" | "failed";
}

function fakeDeps(all: PositionedPortfolio[], chain: FakeChain, visits: SweepCursor, k = 10): SweepFollowupDeps {
  return {
    pickBatch: (exclude) => selectSweepBatch(all, visits, k, exclude),
    plan: (t, accrue, liq) => planSweepTx({ owner: OWNER.publicKey, market: MARKET, lpPortfolio: LP, targets: t, cfg: DEFAULT_SWEEP_CONFIG, accrue, liquidateTargets: liq }),
    simulate: async (plan: CrankPlan): Promise<SimOutcome> => {
      const i = plan.cranks.findIndex(
        (c) => (c.kind === "accrue" && chain.slotAccrued) || (c.kind === "refresh" && chain.notStale.has(c.portfolio.toBase58())),
      );
      if (i >= 0) return { err: { InstructionError: [i + 1, { Custom: 22 }] }, logs: [], marketData: null };
      return { err: null, logs: [], marketData: driftMarket() };
    },
    send: async (plan) => {
      chain.sent.push(plan as SweepPlan);
      return `sig${chain.sent.length}`.padEnd(20, "x");
    },
    waitLanded: async () => chain.landResult,
    onVisited: (pks) => markVisited(visits, pks),
  };
}

describe("runSweepFollowups", () => {
  it("sends [observation crank, refresh x k] txs until every portfolio was taken this cycle", async () => {
    const all = portfolios(27, 3);
    const visits = freshSweepCursor();
    const chain: FakeChain = { notStale: new Set(), slotAccrued: false, sent: [], landResult: "landed" };
    const taken = new Set<string>();
    const r = await runSweepFollowups(8, taken, fakeDeps(all, chain, visits));
    assert.equal(r.error, null);
    assert.equal(chain.sent.length, 3); // 10 + 10 + 7, then nothing left
    for (const p of chain.sent) {
      assert.equal(p.cranks[0].kind, "accrue");
      assert.ok(p.cranks.slice(1).every((c) => c.kind === "refresh"));
      assert.ok(p.computeUnits <= MAX_TX_CU);
    }
    assert.equal(r.refreshed, 27);
    assert.equal(r.txsLanded, 3);
    assert.equal(visits.visits.size, 27);
    assert.equal(taken.size, 27);
  });

  it("respects the tx count (the pace) and continues where the cursor left off next cycle", async () => {
    const all = portfolios(30);
    const visits = freshSweepCursor();
    const chain: FakeChain = { notStale: new Set(), slotAccrued: false, sent: [], landResult: "landed" };
    await runSweepFollowups(1, new Set(), fakeDeps(all, chain, visits));
    assert.equal(visits.visits.size, 10);
    await runSweepFollowups(2, new Set(), fakeDeps(all, chain, visits));
    assert.equal(visits.visits.size, 30);
    const firstTen = chain.sent[0].cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58());
    const later = chain.sent.slice(1).flatMap((p) => p.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58()));
    assert.equal(later.some((x) => firstTen.includes(x)), false);
  });

  it("falls back to refresh-only when the slot is already accrued (observation crank Custom(22))", async () => {
    const chain: FakeChain = { notStale: new Set(), slotAccrued: true, sent: [], landResult: "landed" };
    const r = await runSweepFollowups(1, new Set(), fakeDeps(portfolios(5), chain, freshSweepCursor()));
    assert.equal(r.error, null);
    assert.equal(r.refreshOnly, 1);
    assert.deepEqual(chain.sent[0].cranks.map((c) => c.kind), Array(5).fill("refresh"));
  });

  it("prunes non-stale portfolios (Custom(22) on their refresh): visited, not sent", async () => {
    const all = portfolios(4);
    const visits = freshSweepCursor();
    const chain: FakeChain = { notStale: new Set([pk(2).toBase58(), pk(4).toBase58()]), slotAccrued: false, sent: [], landResult: "landed" };
    const r = await runSweepFollowups(1, new Set(), fakeDeps(all, chain, visits));
    assert.equal(r.refreshed, 2);
    assert.deepEqual(r.pruned.map((p) => p.code), [22, 22]);
    assert.equal(chain.sent[0].cranks.filter((c) => c.kind === "refresh").length, 2);
    assert.equal(visits.visits.size, 4);
  });

  it("all of a batch not stale: no tx, still visited", async () => {
    const all = portfolios(2);
    const visits = freshSweepCursor();
    const chain: FakeChain = { notStale: new Set(all.map((p) => p.pubkey.toBase58())), slotAccrued: false, sent: [], landResult: "landed" };
    const r = await runSweepFollowups(3, new Set(), fakeDeps(all, chain, visits));
    assert.equal(chain.sent.length, 0);
    assert.equal(r.error, null);
    assert.equal(visits.visits.size, 2);
  });

  it("stops at the first tx that does not land, and does not mark its targets visited", async () => {
    const visits = freshSweepCursor();
    const chain: FakeChain = { notStale: new Set(), slotAccrued: false, sent: [], landResult: "failed" };
    const r = await runSweepFollowups(5, new Set(), fakeDeps(portfolios(30), chain, visits));
    assert.equal(chain.sent.length, 1);
    assert.match(r.error ?? "", /failed/);
    assert.equal(visits.visits.size, 0);
  });
});

// ── Health ────────────────────────────────────────────────────────────────────

describe("sweep health fields", () => {
  const coverage = evaluateCoverage(
    decode({ staleLong: 1n, staleShort: 0n, driftLong: { driftGen: 100n * SCALE, staleWeight: 1n, laggardCount: 1n, laggardWeight: 1n }, budgetShort: 51n }),
  );
  const h = sweepHealth(coverage, { level: "urgent", k: 10, txs: 3 }, { txsSent: 3, refreshed: 25, pruned: 1, positioned: 26, neverVisited: 0 });

  it("JSON-safe values: ratio, stale/laggard counts, covered flag", () => {
    assert.equal(h.coverageRatio, 2); // 102 / 51
    assert.equal(h.covered, false);
    assert.equal(h.blocksRiskIncrease, true);
    assert.equal(h.laggardLong, 1);
    assert.equal(h.staleLong, 1);
    assert.equal(h.boundLong, "102");
    assert.doesNotThrow(() => JSON.stringify(h));
    const inf = sweepHealth(evaluateCoverage(decode({ staleLong: 1n, insurance: 0n })), { level: "urgent", k: 10, txs: 1 }, {
      txsSent: 0, refreshed: 0, pruned: 0, positioned: 1, neverVisited: 1,
    });
    assert.equal(inf.coverageRatio, null);
  });

  it("/health market fields: sweep keys present and lossStale = would-refuse-an-order", () => {
    const base: CrankRefreshHealth = {
      staleLong: 1, staleShort: 0, postStaleLong: 1, postStaleShort: 0, positioned: 26, overflow: 0, overflowRefreshed: 0,
      overflowError: null, lossStaleCycles: 0, status: "ok", updatedAt: Date.now(),
    };
    const legacy = crankHealthFields(base);
    assert.equal(Object.keys(legacy).some((k) => k.startsWith("sweep")), false);
    assert.equal(legacy.lossStale, 1);
    const covered = sweepHealth(evaluateCoverage(decode({ staleLong: 1n, driftLong: { staleWeight: 1n } })), { level: "relaxed", k: 10, txs: 1 }, {
      txsSent: 1, refreshed: 10, pruned: 0, positioned: 26, neverVisited: 0,
    });
    const f = crankHealthFields({ ...base, sweep: covered });
    assert.equal(f.lossStale, 0); // stale, but covered: orders are admitted
    assert.equal(f.sweepCovered, true);
    assert.equal(f.sweepTrackerMalformed, false);
    assert.equal(f.sweepPace, "relaxed");
    assert.equal(f.sweepStaleLong, 1);
    assert.equal(f.sweepLaggardLong, 0);
    assert.equal(typeof f.sweepCoverageRatio, "number");
    assert.equal(crankHealthFields({ ...base, sweep: h }).lossStale, 1);
  });

  it("[health] crank line carries ratio / covered / laggards", () => {
    const rec = crankHealthRecord({
      label: "X", market: "m", chainSlot: 10n, engineSlot: 10n, crankOk: true, crankReverted: false, totalOk: 1, totalReverts: 0,
      consecutiveReverts: 0, lastRevertCode: null, lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0, sweep: h,
    });
    assert.equal(rec.cov, 2);
    assert.equal(rec.cvd, 0);
    assert.equal(rec.blk, 1);
    assert.equal(rec.lgL, 1);
    assert.equal(rec.pace, "urgent");
    const noSweep = crankHealthRecord({
      label: "X", market: "m", chainSlot: 10n, engineSlot: 10n, crankOk: true, crankReverted: false, totalOk: 1, totalReverts: 0,
      consecutiveReverts: 0, lastRevertCode: null, lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0,
    });
    assert.equal("cov" in noSweep, false);
  });
});
