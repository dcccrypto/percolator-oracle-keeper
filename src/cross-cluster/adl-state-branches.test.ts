/**
 * cross-cluster/adl-state.ts: branch coverage for the helpers and error paths the other suites skip
 * (isV18MarketHeader, isWrapperMarketHeader, parseAdlFraction, adlHealth, adlHealthOf, the decodeAdlState guards).
 *
 * Byte layouts are REAL: v18 ANSEM (VERSION 18, 1 slot), v19 JUP2 (1 slot) and the v19 cap4b market (5 active slots),
 * all read from devnet and stored under __fixtures__. Per-slot offsets come from market-layout.ts (SDK-keyed rows),
 * not hand-picked numbers. Mutations are made on copies of those bytes.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/adl-state-branches.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADL_ONE,
  adlFraction,
  adlHealth,
  adlHealthOf,
  decodeAdlState,
  isV18MarketHeader,
  isWrapperMarketHeader,
  parseAdlFraction,
} from "./adl-state.ts";
import { detectLayout, engineSlotBase } from "./market-layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));
const V18 = fx("ansem-market-v18");
const JUP = fx("v22-jup2-market-v19");
const FIVE = fx("v22-cap4b-market-v19-5assets");
const copy = (d: Uint8Array) => new Uint8Array(d);
const w128 = (d: Uint8Array, o: number, x: bigint) => {
  const v = new DataView(d.buffer, d.byteOffset);
  v.setBigUint64(o, x & 0xffff_ffff_ffff_ffffn, true);
  v.setBigUint64(o + 8, x >> 64n, true);
};
const known = (d: Uint8Array) => {
  const det = detectLayout(d);
  assert.ok(det.known);
  return det;
};
const slotBase = (d: Uint8Array, k: number) => {
  const det = known(d);
  return engineSlotBase(det.layout, k);
};
const AS_LIFECYCLE = 16;
const AS_A_SHORT = 65;

describe("isV18MarketHeader / isWrapperMarketHeader", () => {
  it("real v18 market: both true", () => {
    assert.equal(isV18MarketHeader(V18), true);
    assert.equal(isWrapperMarketHeader(V18), true);
  });
  it("real v19 market: wrapper header true, v18 header false (VERSION differs)", () => {
    assert.equal(isWrapperMarketHeader(JUP), true);
    assert.equal(isV18MarketHeader(JUP), false);
  });
  it("shorter than 16 bytes: false for both, even with a valid prefix", () => {
    assert.equal(isV18MarketHeader(V18.subarray(0, 15)), false);
    assert.equal(isWrapperMarketHeader(V18.subarray(0, 15)), false);
    assert.equal(isV18MarketHeader(new Uint8Array(0)), false);
    assert.equal(isWrapperMarketHeader(new Uint8Array(0)), false);
  });
  it("exactly 16 bytes of a real header is enough", () => {
    assert.equal(isV18MarketHeader(V18.subarray(0, 16)), true);
    assert.equal(isWrapperMarketHeader(JUP.subarray(0, 16)), true);
  });
  it("wrong magic / wrong kind: false for both", () => {
    const m = copy(V18);
    m[0] ^= 0xff;
    assert.equal(isV18MarketHeader(m), false);
    assert.equal(isWrapperMarketHeader(m), false);
    const k = copy(V18);
    k[10] = 2;
    assert.equal(isV18MarketHeader(k), false);
    assert.equal(isWrapperMarketHeader(k), false);
  });
  it("respects a non-zero byteOffset view", () => {
    const padded = new Uint8Array(V18.length + 7);
    padded.set(V18, 7);
    assert.equal(isV18MarketHeader(padded.subarray(7)), true);
  });
});

describe("decodeAdlState guards", () => {
  it("non-market (wrong magic or kind) -> null, never throws", () => {
    const m = copy(JUP);
    m[3] ^= 1;
    assert.equal(decodeAdlState(m), null);
    const k = copy(JUP);
    k[10] = 0;
    assert.equal(decodeAdlState(k), null);
    assert.equal(decodeAdlState(new Uint8Array(4)), null);
  });
  it("market header with an unknown VERSION throws the unknown-layout error", () => {
    const d = copy(JUP);
    new DataView(d.buffer).setUint16(8, 99, true);
    assert.throws(() => decodeAdlState(d), /decodeAdlState: unknown market layout/);
  });
  it("truncated market (header only / one byte short of the slot) throws", () => {
    assert.throws(() => decodeAdlState(JUP.subarray(0, 64)), /unknown market layout/);
    assert.throws(() => decodeAdlState(JUP.subarray(0, JUP.length - 1)), /unknown market layout/);
  });
  it("max_market_slots = 0 throws", () => {
    const d = copy(JUP);
    const det = known(d);
    // find max_market_slots absolute offset the same way the detector does: it is the u32 the detector reads
    const ABS_MAX_MARKET_SLOTS = det.layout.groupOff + det.layout.header.maxMarketSlots;
    new DataView(d.buffer).setUint32(ABS_MAX_MARKET_SLOTS, 0, true);
    assert.throws(() => decodeAdlState(d), /max_market_slots is 0/);
  });
  it("asset index out of range: -1, == slots, 1.5, NaN all throw RangeError; last valid index decodes", () => {
    for (const bad of [-1, 1, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => decodeAdlState(JUP, bad), RangeError, `asset ${bad}`);
    }
    assert.throws(() => decodeAdlState(FIVE, 5), /asset 5 not present/);
    assert.ok(decodeAdlState(FIVE, 4));
  });
  it("every slot of the real 5-asset market decodes at its own stride (a_long = a_short = ADL_ONE)", () => {
    for (let k = 0; k < 5; k++) {
      const s = decodeAdlState(FIVE, k)!;
      assert.equal(s.aLong, ADL_ONE, `slot ${k}`);
      assert.equal(s.aShort, ADL_ONE, `slot ${k}`);
      assert.equal(s.reduceOnly, false);
    }
  });
  it("reduce-only when only a_long is off ADL_ONE, and when only a_short is (each side independently)", () => {
    const l = copy(JUP);
    w128(l, slotBase(l, 0) + 49, ADL_ONE - 1n);
    assert.equal(decodeAdlState(l)!.reduceOnly, true);
    const s = copy(JUP);
    w128(s, slotBase(s, 0) + AS_A_SHORT, ADL_ONE + 1n);
    assert.equal(decodeAdlState(s)!.reduceOnly, true);
  });
  it("u128 values above 2^64 are read across both halves", () => {
    const d = copy(JUP);
    const big = (1n << 100n) + 12345n;
    w128(d, slotBase(d, 0) + 289, big);
    assert.equal(decodeAdlState(d)!.oiEffLong, big);
  });
  it("works on a subarray view with a non-zero byteOffset", () => {
    const padded = new Uint8Array(JUP.length + 13);
    padded.set(JUP, 13);
    assert.equal(decodeAdlState(padded.subarray(13))!.aLong, ADL_ONE);
  });
});

describe("adlFraction / parseAdlFraction / adlHealth", () => {
  it("adlFraction renders 0, ADL_ONE, > ADL_ONE and pads the fraction", () => {
    assert.equal(adlFraction(0n), "0.000000");
    assert.equal(adlFraction(ADL_ONE), "1.000000");
    assert.equal(adlFraction(ADL_ONE * 3n + ADL_ONE / 20n), "3.050000");
  });
  it("parseAdlFraction is the exact inverse for 6-digit published strings", () => {
    for (const a of [0n, 861_700_000_000_000n, ADL_ONE, ADL_ONE * 2n + 1_000_000_000n]) {
      assert.equal(parseAdlFraction(adlFraction(a)), a);
    }
  });
  it("parseAdlFraction: integer form, up to 15 fractional digits exact, no-fraction ok", () => {
    assert.equal(parseAdlFraction("1"), ADL_ONE);
    assert.equal(parseAdlFraction("0"), 0n);
    assert.equal(parseAdlFraction("0.000000000000001"), 1n);
    assert.equal(parseAdlFraction("1.000000"), ADL_ONE);
    assert.equal(parseAdlFraction("0.5"), ADL_ONE / 2n);
  });
  it("parseAdlFraction: null (never a rounded guess) for sign, exponent, empty parts, > 15 digits, junk", () => {
    for (const bad of ["", "-1", "+1", "1e3", "1.", ".5", "0.1234567890123456", "1.2.3", " 1", "1 ", "abc", "0x10", "1,5"]) {
      assert.equal(parseAdlFraction(bad), null, JSON.stringify(bad));
    }
  });
  it("adlHealth formats fractions as decimals and OI as raw integers", () => {
    const h = adlHealth({ aLong: ADL_ONE, aShort: 861_700_000_000_000n, oiEffLong: 7n, oiEffShort: 1n << 70n, reduceOnly: true });
    assert.deepEqual(h, { reduceOnly: true, aLong: "1.000000", aShort: "0.861700", oiEffLong: "7", oiEffShort: (1n << 70n).toString() });
  });
});

describe("adlHealthOf", () => {
  it("non-market account -> {}", () => {
    const d = copy(JUP);
    d[0] ^= 1;
    assert.deepEqual(adlHealthOf(d), {});
  });
  it("unknown layout, truncated, empty, and out-of-range asset -> {} (the catch; never a guess)", () => {
    const v = copy(JUP);
    new DataView(v.buffer).setUint16(8, 99, true);
    assert.deepEqual(adlHealthOf(v), {});
    assert.deepEqual(adlHealthOf(JUP.subarray(0, JUP.length - 1)), {});
    assert.deepEqual(adlHealthOf(new Uint8Array(0)), {});
    assert.deepEqual(adlHealthOf(JUP, 3), {});
    assert.deepEqual(adlHealthOf(FIVE, -1), {});
  });
  it("single-slot market (v19 JUP): { adl } only, no adlAssets", () => {
    assert.equal(known(JUP).slots, 1);
    const j = adlHealthOf(JUP);
    assert.deepEqual(Object.keys(j), ["adl"]);
    assert.equal(j.adl!.reduceOnly, false);
    assert.equal(j.adl!.aLong, "1.000000");
  });
  it("real v18 ANSEM has 14 slots (the max in the fixtures): adlAssets lists all 14, only asset 0 carries OI", () => {
    assert.equal(known(V18).slots, 14);
    const a = adlHealthOf(V18);
    assert.equal(a.adlAssets!.length, 14);
    assert.equal(a.adl!.oiEffLong, "16511677058");
    assert.equal(a.adlAssets![13].oiEffLong, "0");
  });
  it("5-slot market: adlAssets lists all 5 in order, adl is the requested asset", () => {
    const h = adlHealthOf(FIVE, 2);
    assert.equal(h.adlAssets!.length, 5);
    assert.deepEqual(h.adlAssets!.map((x) => x.asset), [0, 1, 2, 3, 4]);
    assert.deepEqual(h.adl, adlHealth(decodeAdlState(FIVE, 2)!));
    assert.ok(h.adlAssets!.every((x) => !x.reduceOnly));
  });
  it("a Disabled slot (lifecycle 0) is skipped; the other three stay", () => {
    const d = copy(FIVE);
    d[slotBase(d, 1) + AS_LIFECYCLE] = 0;
    d[slotBase(d, 4) + AS_LIFECYCLE] = 0;
    const h = adlHealthOf(d);
    assert.deepEqual(h.adlAssets!.map((x) => x.asset), [0, 2, 3]);
  });
  it("ALL slots Disabled -> adlAssets is an empty array (zero iterations kept), adl still present", () => {
    const d = copy(FIVE);
    for (let k = 0; k < 5; k++) d[slotBase(d, k) + AS_LIFECYCLE] = 0;
    const h = adlHealthOf(d);
    assert.deepEqual(h.adlAssets, []);
    assert.ok(h.adl);
  });
  it("a reduce-only asset other than the entry's own is visible in adlAssets", () => {
    const d = copy(FIVE);
    w128(d, slotBase(d, 3) + AS_A_SHORT, 861_700_000_000_000n);
    const h = adlHealthOf(d, 0);
    assert.equal(h.adl!.reduceOnly, false);
    assert.equal(h.adlAssets![3].reduceOnly, true);
    assert.equal(h.adlAssets![3].aShort, "0.861700");
    assert.equal(h.adlAssets![2].reduceOnly, false);
  });
  it("a non-Disabled lifecycle other than Active (DrainOnly 3, Recovery 5) is still listed", () => {
    const d = copy(FIVE);
    d[slotBase(d, 1) + AS_LIFECYCLE] = 3;
    d[slotBase(d, 2) + AS_LIFECYCLE] = 5;
    assert.deepEqual(adlHealthOf(d).adlAssets!.map((x) => x.asset), [0, 1, 2, 3, 4]);
  });
});
