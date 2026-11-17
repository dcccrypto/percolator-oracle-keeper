/**
 * lifecycle-classify.ts: the four audit leads of J-20261117-K-BUG-QUIETFEESUMNULL, each pinned with a repro.
 * (1) observeQuiet with feeSum null, (2) lastGood derivation, (3) grace arithmetic, (4) warn/matured boundary.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { assetSlotsOff, layoutById } from "../market-layout.ts";
import { staleResolveWindow } from "../market-state.ts";
import { classifyMarket, observeQuiet, openInterestIsZero, priceBandOf, quietMsOf, tradeFeeAccrualSum, assetZeroOracleAuthority } from "./lifecycle-classify.ts";
import type { ClassifyInput } from "./lifecycle-classify.ts";
import { v22MarketBytes } from "./test-helpers.ts";

const L = layoutById("v2.2-b");
const keeper = Keypair.generate();
const NOW = 1_000_000n;

function market(o: { stale?: bigint; lastGood?: bigint; authority?: Uint8Array } = {}): Uint8Array {
  const b = Buffer.from(v22MarketBytes({}));
  b.writeBigUInt64LE(o.stale ?? 18_000n, 16 + 136);
  b.writeBigUInt64LE(o.lastGood ?? NOW, 16 + 152);
  if (o.authority) Buffer.from(o.authority).copy(b, assetSlotsOff(L) + 120);
  return new Uint8Array(b);
}
const cin = (data: Uint8Array, o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  data, readSlot: NOW, registered: true, keeper: keeper.publicKey, keeperLandedPush: true, keeperObservedMs: 3_600_000,
  neverConnectedGraceSlots: 1_500n, quietMs: 0, deadInterestMs: 1_000, ...o,
});

describe("lead 1: observeQuiet and an unreadable fee sum", () => {
  it("an unreadable fee sum restarts the clock exactly like oiZero === null (same policy, not a flaky-read hole)", () => {
    let q = observeQuiet(undefined, { oiZero: true, feeSum: 5n, nowMs: 1_000 });
    q = observeQuiet(q, { oiZero: true, feeSum: null, nowMs: 5_000 });
    assert.equal(q.quietSinceMs, 5_000);
    assert.equal(q.feeSum, "5", "the last good sum is kept");
    let r = observeQuiet(undefined, { oiZero: true, feeSum: 5n, nowMs: 1_000 });
    r = observeQuiet(r, { oiZero: null, feeSum: 5n, nowMs: 5_000 });
    assert.equal(r.quietSinceMs, 5_000);
  });
  it("both reads come from the same account bytes: undecodable data nulls both, so no read is 'flaky' on its own", () => {
    const junk = new Uint8Array(64);
    assert.equal(tradeFeeAccrualSum(junk), null);
    assert.equal(openInterestIsZero(junk), null);
    assert.equal(assetZeroOracleAuthority(junk), null);
  });
  it("a good read after a null read resumes from the kept sum and the new clock start", () => {
    let q = observeQuiet(undefined, { oiZero: true, feeSum: 5n, nowMs: 0 });
    q = observeQuiet(q, { oiZero: true, feeSum: null, nowMs: 100 });
    q = observeQuiet(q, { oiZero: true, feeSum: 5n, nowMs: 200 });
    assert.equal(q.quietSinceMs, 100);
    assert.equal(quietMsOf(q, 300), 200);
    assert.equal(quietMsOf(undefined, 300), 0);
    assert.equal(quietMsOf(q, 50), 0, "never negative");
  });
});

describe("lead 2: lastGoodOracleSlot derivation", () => {
  it("is never negative and equals the on-chain slot when readSlot >= lastGood", () => {
    for (const age of [0n, 1n, 8_999n, 9_000n, 17_999n, 18_000n, 100_000n]) {
      const lc = classifyMarket(cin(market({ lastGood: NOW - age })));
      assert.equal(lc.lastGoodOracleSlot, NOW - age);
    }
    assert.equal(classifyMarket(cin(market({ lastGood: 0n }), { readSlot: 5n })).lastGoodOracleSlot, 0n);
  });
  it("lastGood ahead of readSlot (read from an older slot): age clamps to 0 and the reported slot is readSlot (cosmetic, informational only)", () => {
    const lc = classifyMarket(cin(market({ lastGood: NOW + 50n })));
    assert.equal(lc.price.kind, "fresh");
    assert.equal(lc.lastGoodOracleSlot, NOW);
    assert.ok(lc.lastGoodOracleSlot >= 0n);
  });
  it("no-window and matured keep their own slot", () => {
    assert.equal(classifyMarket(cin(market({ stale: 0n, lastGood: NOW - 7n }))).lastGoodOracleSlot, NOW - 7n);
    assert.equal(classifyMarket(cin(market({ lastGood: NOW - 99_999n }))).lastGoodOracleSlot, NOW - 99_999n);
  });
});

describe("lead 3: never-connected grace arithmetic", () => {
  const unregistered = (grace: bigint, age: bigint) => classifyMarket(cin(market({ stale: 0n, lastGood: NOW > age ? NOW - age : 0n }), { registered: false, neverConnectedGraceSlots: grace })).neverConnected;
  it("age is compared to the grace as bigints, inclusive at the edge", () => {
    assert.equal(unregistered(1_500n, 1_499n), null);
    assert.equal(unregistered(1_500n, 1_500n), "no-registry-row");
  });
  it("huge bigint grace: Number() loses precision but only Infinity/large values result, so it never mislabels", () => {
    const huge = 2n ** 2000n; // Number(huge) === Infinity
    assert.equal(unregistered(huge, 10n ** 9n), null);
    const lc = classifyMarket(cin(market({ stale: 0n, lastGood: 0n }), { neverConnectedGraceSlots: huge, keeperObservedMs: Number.MAX_VALUE }));
    assert.equal(lc.neverConnected, null);
  });
  it("no-accepted-push needs observation >= grace * 400 ms", () => {
    const auth = keeper.publicKey.toBytes();
    const d = market({ stale: 0n, lastGood: NOW - 1_500n, authority: auth });
    const at = (ms: number) => classifyMarket(cin(d, { keeperLandedPush: false, keeperObservedMs: ms })).neverConnected;
    assert.equal(at(1_500 * 400 - 1), null);
    assert.equal(at(1_500 * 400), "no-accepted-push");
  });
  it("registered with a different authority is not-oracle-authority", () => {
    const d = market({ stale: 0n, lastGood: NOW - 2_000n, authority: Keypair.generate().publicKey.toBytes() });
    assert.equal(classifyMarket(cin(d)).neverConnected, "not-oracle-authority");
  });
});

describe("lead 4: warn / matured boundary vs market-state staleResolveWindow", () => {
  it("agrees at every edge for even and odd windows, including 1 and u64 max", () => {
    for (const stale of [1n, 2n, 3n, 7n, 18_000n, 18_001n, 2n ** 64n - 1n]) {
      const half = (stale * 5_000n + 9_999n) / 10_000n; // smallest age with age*10000 >= stale*5000
      for (const age of [0n, half - 1n, half, stale - 1n, stale, stale + 1n]) {
        if (age < 0n || age > NOW) continue;
        const d = market({ stale, lastGood: NOW - age });
        const band = priceBandOf(d, NOW);
        const w = staleResolveWindow(d, NOW)!;
        const expect = w.matured ? "matured" : age * 10_000n >= stale * 5_000n ? "warn" : "fresh";
        assert.equal(band.kind, expect, `stale=${stale} age=${age}`);
        if (band.kind === "warn") assert.equal(band.remainingSlots, w.remaining);
        assert.equal(band.kind === "matured", age >= stale);
      }
    }
  });
  it("not-live and no-window bands", () => {
    assert.equal(priceBandOf(new Uint8Array(10), NOW).kind, "not-live");
    assert.deepEqual(priceBandOf(market({ stale: 0n, lastGood: NOW - 5n }), NOW), { kind: "no-window", ageSlots: 5n });
  });
  it("classes: warn, matured, no-resolve-window, healthy; terminal for undecodable bytes", () => {
    assert.deepEqual(classifyMarket(cin(market({ lastGood: NOW - 9_000n }), { neverConnectedGraceSlots: 10n ** 12n })).classes, ["dead-price-warn"]);
    assert.deepEqual(classifyMarket(cin(market({ lastGood: NOW - 18_000n }), { neverConnectedGraceSlots: 10n ** 12n })).classes, ["dead-price-matured"]);
    assert.deepEqual(classifyMarket(cin(market({ stale: 0n }), { neverConnectedGraceSlots: 10n ** 12n })).classes, ["no-resolve-window"]);
    assert.deepEqual(classifyMarket(cin(market(), { neverConnectedGraceSlots: 10n ** 12n })).classes, ["healthy"]);
    assert.deepEqual(classifyMarket(cin(new Uint8Array(10), { neverConnectedGraceSlots: 10n ** 12n })).classes, ["terminal"]);
  });
});
