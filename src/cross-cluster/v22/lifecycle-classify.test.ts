/**
 * lifecycle-classify.ts on real rc23 (v2.2-b) market bytes from the v22 test helpers: every catch block, every price
 * band, every never-connected reason and the quiet clock, asserting the classification (not just no-throw).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assetSlotsOff, engineSlotBase, layoutById } from "../market-layout.ts";
import {
  WARN_BAND_BPS,
  assetZeroOracleAuthority,
  classifyMarket,
  observeQuiet,
  openInterestIsZero,
  priceBandOf,
  quietMsOf,
  tradeFeeAccrualSum,
} from "./lifecycle-classify.ts";
import type { ClassifyInput } from "./lifecycle-classify.ts";
import { v22MarketBytes } from "./test-helpers.ts";

const L = layoutById("v2.2-b");
const MODE_OFF = 592 + 674; // market-state.ts GROUP_V19.mode
const STALE = 18_000n;
const NOW = 1_000_000n;
const keeper = Keypair.generate();
const OTHER = Keypair.generate().publicKey;

function market(o: { slots?: number; staleSlots?: bigint; lastGood?: bigint; authority?: PublicKey; mode?: number; oi?: bigint; oiShort?: bigint; feeAt?: Array<[number, bigint]>; lifecycle?: number } = {}): Uint8Array {
  const b = Buffer.from(v22MarketBytes({ slots: o.slots, lifecycle: o.lifecycle }));
  b.writeBigUInt64LE(o.staleSlots ?? STALE, 16 + 136);
  b.writeBigUInt64LE(o.lastGood ?? NOW, 16 + 152);
  if (o.authority) Buffer.from(o.authority.toBytes()).copy(b, assetSlotsOff(L) + 120);
  if (o.mode !== undefined) b[MODE_OFF] = o.mode;
  if (o.oi) b.writeBigUInt64LE(o.oi, engineSlotBase(L, 0) + 289);
  for (const [off, v] of o.feeAt ?? []) b.writeBigUInt64LE(v, off);
  return new Uint8Array(b);
}
const agedBy = (age: bigint): bigint => NOW - age;

function cin(data: Uint8Array, o: Partial<ClassifyInput> = {}): ClassifyInput {
  return { data, readSlot: NOW, registered: true, keeper: keeper.publicKey, keeperLandedPush: true, keeperObservedMs: 3_600_000, neverConnectedGraceSlots: 1_500n, quietMs: 0, deadInterestMs: 14 * 86_400_000, ...o };
}

describe("openInterestIsZero", () => {
  it("true for an Active asset with no OI; false with long or short OI", () => {
    assert.equal(openInterestIsZero(market()), true);
    assert.equal(openInterestIsZero(market({ oi: 1n })), false);
    const b = Buffer.from(market());
    b.writeBigUInt64LE(7n, engineSlotBase(L, 0) + 289 + 16); // oi_eff_short
    assert.equal(openInterestIsZero(new Uint8Array(b)), false);
  });
  it("DrainOnly (3) and Recovery (5) assets count; Disabled/other lifecycles are skipped, and none counted = null", () => {
    assert.equal(openInterestIsZero(market({ lifecycle: 3, oi: 4n })), false);
    assert.equal(openInterestIsZero(market({ lifecycle: 5, oi: 4n })), false);
    assert.equal(openInterestIsZero(market({ lifecycle: 3 })), true);
    assert.equal(openInterestIsZero(market({ lifecycle: 0, oi: 4n })), null, "no Active asset: unknown, not zero");
    assert.equal(openInterestIsZero(market({ lifecycle: 4 })), null);
  });
  it("a disabled asset's OI is ignored when a later asset is Active and flat", () => {
    const b = Buffer.from(market({ slots: 2, lifecycle: 0, oi: 9n }));
    b[engineSlotBase(L, 1) + L.asset.lifecycle] = 2;
    assert.equal(openInterestIsZero(new Uint8Array(b)), true);
  });
  it("unknown layout, non-market bytes and a truncated asset all give null (catch path)", () => {
    assert.equal(openInterestIsZero(new Uint8Array(0)), null);
    assert.equal(openInterestIsZero(new Uint8Array(64)), null);
    const full = market();
    assert.equal(openInterestIsZero(full.slice(0, engineSlotBase(L, 0) + 300)), null);
    const noHeader = Buffer.from(market());
    noHeader.fill(0, 0, 8); // wrapper magic gone: decodeAdlState returns null for the asset
    assert.equal(openInterestIsZero(new Uint8Array(noHeader)), null);
  });
});

describe("tradeFeeAccrualSum", () => {
  it("sums the three monotonic counters", () => {
    assert.equal(tradeFeeAccrualSum(market()), 0n);
    assert.equal(tradeFeeAccrualSum(market({ feeAt: [[16 + 464, 42n]] })), 42n);
  });
  it("null for unreadable bytes (catch path)", () => {
    assert.equal(tradeFeeAccrualSum(new Uint8Array(8)), null);
    assert.equal(tradeFeeAccrualSum(market().slice(0, 100)), null);
  });
});

describe("assetZeroOracleAuthority", () => {
  it("returns asset 0's oracle authority key", () => {
    assert.equal(assetZeroOracleAuthority(market({ authority: OTHER }))?.equals(OTHER), true);
  });
  it("null for an unknown layout and for a truncated account (catch path)", () => {
    assert.equal(assetZeroOracleAuthority(new Uint8Array(16)), null);
    assert.equal(assetZeroOracleAuthority(market().slice(0, assetSlotsOff(L) + 10)), null);
  });
});

describe("priceBandOf", () => {
  it("fresh / warn / matured edges with pct and remaining", () => {
    const f = priceBandOf(market({ lastGood: agedBy(8_999n) }), NOW);
    assert.equal(f.kind, "fresh");
    const w = priceBandOf(market({ lastGood: agedBy(9_000n) }), NOW);
    assert.equal(w.kind, "warn");
    if (w.kind === "warn") {
      assert.equal(w.pctBps, 5_000);
      assert.equal(w.remainingSlots, 9_000n);
      assert.equal(w.ageSlots, 9_000n);
      assert.equal(w.staleSlots, STALE);
    }
    assert.equal(WARN_BAND_BPS, 5_000n);
    const m = priceBandOf(market({ lastGood: agedBy(18_000n) }), NOW);
    assert.equal(m.kind, "matured");
    if (m.kind === "matured") {
      assert.equal(m.pctBps, 10_000);
      assert.equal(m.lastGoodOracleSlot, agedBy(18_000n));
    }
  });
  it("a last-good slot ahead of the read slot has age 0 (fresh)", () => {
    const b = priceBandOf(market({ lastGood: NOW + 50n }), NOW);
    assert.equal(b.kind, "fresh");
    if (b.kind === "fresh") assert.equal(b.ageSlots, 0n);
  });
  it("stale_slots = 0 is no-window with the age", () => {
    assert.deepEqual(priceBandOf(market({ staleSlots: 0n, lastGood: agedBy(500n) }), NOW), { kind: "no-window", ageSlots: 500n });
  });
  it("not-live for a Resolved market and for bytes that are not a market", () => {
    assert.deepEqual(priceBandOf(market({ mode: 1 }), NOW), { kind: "not-live" });
    assert.deepEqual(priceBandOf(new Uint8Array(32), NOW), { kind: "not-live" });
  });
});

describe("classifyMarket", () => {
  const old = agedBy(5_000n);
  it("terminal: Resolved (mode 1), Recovery (mode 2) and unreadable bytes are all [terminal] and nothing else", () => {
    const r = classifyMarket(cin(market({ mode: 1 }), { registered: false }));
    assert.equal(r.terminal, "resolved");
    assert.deepEqual(r.classes, ["terminal"]);
    assert.equal(r.registered, false);
    assert.equal(r.keeperCanPush, false);
    assert.equal(r.oiZero, null);
    assert.equal(r.neverConnected, null);
    assert.deepEqual(r.price, { kind: "not-live" });
    const rec = classifyMarket(cin(market({ mode: 2 })));
    assert.equal(rec.terminal, "recovery");
    assert.deepEqual(rec.classes, ["terminal"]);
    const junk = classifyMarket(cin(new Uint8Array(40)));
    assert.equal(junk.terminal, null);
    assert.deepEqual(junk.classes, ["terminal"]);
  });
  it("healthy: fresh price, OI > 0, keeper is the authority and has landed a push", () => {
    const lc = classifyMarket(cin(market({ lastGood: agedBy(100n), authority: keeper.publicKey, oi: 3n })));
    assert.deepEqual(lc.classes, ["healthy"]);
    assert.equal(lc.terminal, null);
    assert.equal(lc.keeperCanPush, true);
    assert.equal(lc.keeperIsAuthority, true);
    assert.equal(lc.oiZero, false);
    assert.equal(lc.lastGoodOracleSlot, agedBy(100n));
    assert.equal(lc.deadInterest, false);
  });
  it("dead-price-warn and dead-price-matured carry lastGoodOracleSlot", () => {
    const w = classifyMarket(cin(market({ lastGood: agedBy(10_000n), authority: keeper.publicKey, oi: 1n })));
    assert.deepEqual(w.classes, ["dead-price-warn"]);
    assert.equal(w.lastGoodOracleSlot, agedBy(10_000n));
    const m = classifyMarket(cin(market({ lastGood: agedBy(20_000n), authority: keeper.publicKey, oi: 1n })));
    assert.deepEqual(m.classes, ["dead-price-matured"]);
    assert.equal(m.lastGoodOracleSlot, agedBy(20_000n));
  });
  it("no-resolve-window: stale_slots 0, lastGood derived from the age", () => {
    const lc = classifyMarket(cin(market({ staleSlots: 0n, lastGood: agedBy(200n), authority: keeper.publicKey, oi: 1n })));
    assert.deepEqual(lc.classes, ["no-resolve-window"]);
    assert.equal(lc.lastGoodOracleSlot, agedBy(200n));
  });
  it("never-connected reasons, in priority order, and classes list it first", () => {
    const unreg = classifyMarket(cin(market({ lastGood: old, authority: OTHER, oi: 1n }), { registered: false }));
    assert.equal(unreg.neverConnected, "no-registry-row");
    assert.deepEqual(unreg.classes, ["never-connected"]);
    assert.equal(unreg.keeperCanPush, false);
    const wrong = classifyMarket(cin(market({ lastGood: old, authority: OTHER, oi: 1n })));
    assert.equal(wrong.neverConnected, "not-oracle-authority");
    assert.equal(wrong.keeperIsAuthority, false);
    const m = market({ lastGood: old, authority: keeper.publicKey, oi: 1n });
    assert.equal(classifyMarket(cin(m, { keeperLandedPush: false })).neverConnected, "no-accepted-push");
    assert.equal(classifyMarket(cin(m, { keeperLandedPush: false, keeperObservedMs: 1_500 * 400 - 1 })).neverConnected, null, "observation just short of the grace");
    assert.equal(classifyMarket(cin(m, { keeperLandedPush: false, keeperObservedMs: 1_500 * 400 })).neverConnected, "no-accepted-push", "exactly the grace");
    assert.equal(classifyMarket(cin(m)).neverConnected, null);
  });
  it("price age exactly at the grace is named; one slot younger is not", () => {
    assert.equal(classifyMarket(cin(market({ lastGood: agedBy(1_500n), authority: OTHER }))).neverConnected, "not-oracle-authority");
    assert.equal(classifyMarket(cin(market({ lastGood: agedBy(1_499n), authority: OTHER }))).neverConnected, null);
  });
  it("an all-zero authority is a decodable key that is not the keeper: not-oracle-authority", () => {
    const lc = classifyMarket(cin(market({ lastGood: old, oi: 1n })));
    assert.equal(lc.neverConnected, "not-oracle-authority");
    assert.equal(lc.keeperIsAuthority, false);
  });
  it("never-connected + dead-price-matured are reported together, worst first", () => {
    const lc = classifyMarket(cin(market({ lastGood: agedBy(20_000n), authority: OTHER, oi: 1n })));
    assert.deepEqual(lc.classes, ["never-connected", "dead-price-matured"]);
  });
  it("dead-interest: fresh + OI 0 + quiet long enough; boundaries and the blockers", () => {
    const fresh = market({ lastGood: agedBy(100n), authority: keeper.publicKey });
    const lim = 14 * 86_400_000;
    const at = classifyMarket(cin(fresh, { quietMs: lim }));
    assert.equal(at.deadInterest, true);
    assert.deepEqual(at.classes, ["dead-interest"]);
    assert.equal(at.quietMs, lim);
    assert.equal(at.oiZero, true);
    assert.equal(classifyMarket(cin(fresh, { quietMs: lim - 1 })).deadInterest, false);
    // OI unknown (no Active asset) is not dead-interest
    const unknown = classifyMarket(cin(market({ lifecycle: 4, lastGood: agedBy(100n), authority: keeper.publicKey }), { quietMs: lim }));
    assert.equal(unknown.oiZero, null);
    assert.equal(unknown.deadInterest, false);
    assert.deepEqual(unknown.classes, ["healthy"]);
  });
  it("dead-interest sits with never-connected when both hold (grace 0 forces never-connected on a fresh price)", () => {
    const lc = classifyMarket(cin(market({ lastGood: agedBy(100n), authority: OTHER }), { quietMs: 99 * 86_400_000, neverConnectedGraceSlots: 0n }));
    assert.deepEqual(lc.classes, ["never-connected", "dead-interest"]);
  });
});

describe("quiet clock", () => {
  it("first sight starts now; an absent fee sum is remembered as 0 on first sight", () => {
    assert.deepEqual(observeQuiet(undefined, { oiZero: true, feeSum: 5n, nowMs: 100 }), { quietSinceMs: 100, feeSum: "5" });
    assert.deepEqual(observeQuiet(undefined, { oiZero: true, feeSum: null, nowMs: 100 }), { quietSinceMs: 100, feeSum: "0" });
  });
  it("unchanged counters keep the clock; a changed counter, OI, unknown OI or an unreadable sum restart it", () => {
    const prev = { quietSinceMs: 1_000, feeSum: "10" };
    assert.deepEqual(observeQuiet(prev, { oiZero: true, feeSum: 10n, nowMs: 9_000 }), prev);
    assert.deepEqual(observeQuiet(prev, { oiZero: true, feeSum: 11n, nowMs: 9_000 }), { quietSinceMs: 9_000, feeSum: "11" });
    assert.deepEqual(observeQuiet(prev, { oiZero: false, feeSum: 10n, nowMs: 9_000 }), { quietSinceMs: 9_000, feeSum: "10" });
    assert.deepEqual(observeQuiet(prev, { oiZero: null, feeSum: 10n, nowMs: 9_000 }), { quietSinceMs: 9_000, feeSum: "10" });
    assert.deepEqual(observeQuiet(prev, { oiZero: true, feeSum: null, nowMs: 9_000 }), { quietSinceMs: 9_000, feeSum: "10" }, "unreadable sum keeps the old sum but restarts the clock");
  });
  it("u128-safe sums are compared as decimal strings", () => {
    const big = (1n << 100n) + 1n;
    const a = observeQuiet(undefined, { oiZero: true, feeSum: big, nowMs: 1 });
    assert.equal(a.feeSum, big.toString());
    assert.equal(observeQuiet(a, { oiZero: true, feeSum: big, nowMs: 50 }).quietSinceMs, 1);
  });
  it("quietMsOf: 0 for none, elapsed otherwise, never negative", () => {
    assert.equal(quietMsOf(undefined, 5), 0);
    assert.equal(quietMsOf({ quietSinceMs: 1_000, feeSum: "0" }, 4_000), 3_000);
    assert.equal(quietMsOf({ quietSinceMs: 9_000, feeSum: "0" }, 4_000), 0);
  });
});
