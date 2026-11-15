/**
 * adl-state.ts branch coverage (K-COV): header predicates, the asset-index / short-account guards, the exact decimal
 * inverse, the /health shapes, and the multi-asset `adlHealthOf` listing. Tests only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADL_ONE, adlFraction, adlHealth, adlHealthOf, decodeAdlState, isV18MarketHeader, isWrapperMarketHeader, parseAdlFraction } from "./adl-state.ts";
import { engineSlotBase } from "./market-layout.ts";
import { v22Ctx, v22MarketBytes } from "./v22/test-helpers.ts";

const LAYOUT_V22 = v22Ctx().layout;

const MAGIC = 0x5045_5243_5631_3600n;

function header(o: { magic?: bigint; version?: number; kind?: number; len?: number } = {}): Uint8Array {
  const b = Buffer.alloc(o.len ?? 16);
  b.writeBigUInt64LE(o.magic ?? MAGIC, 0);
  b.writeUInt16LE(o.version ?? 18, 8);
  b[10] = o.kind ?? 1;
  return new Uint8Array(b);
}

function w128(b: Uint8Array, off: number, v: bigint): void {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  buf.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
  buf.writeBigUInt64LE(v >> 64n, off + 8);
}

describe("isV18MarketHeader / isWrapperMarketHeader", () => {
  it("accepts a v18 market header; rejects short, wrong magic, wrong version, wrong kind", () => {
    assert.equal(isV18MarketHeader(header()), true);
    assert.equal(isV18MarketHeader(header({ len: 15 })), false);
    assert.equal(isV18MarketHeader(header({ magic: 1n })), false);
    assert.equal(isV18MarketHeader(header({ version: 19 })), false);
    assert.equal(isV18MarketHeader(header({ kind: 2 })), false);
  });
  it("wrapper header ignores the version but needs magic + kind 1 + 16 bytes", () => {
    assert.equal(isWrapperMarketHeader(header({ version: 19 })), true);
    assert.equal(isWrapperMarketHeader(header({ len: 15 })), false);
    assert.equal(isWrapperMarketHeader(header({ magic: 1n })), false);
    assert.equal(isWrapperMarketHeader(header({ kind: 0 })), false);
  });
  it("honours a non-zero byteOffset view", () => {
    const h = header();
    const padded = new Uint8Array(h.length + 8);
    padded.set(h, 8);
    assert.equal(isV18MarketHeader(padded.subarray(8)), true);
  });
});

describe("decodeAdlState guards (v2.2 layout)", () => {
  it("reads the a/OI words of a v2.2 slot and flags reduce-only", () => {
    const d = v22MarketBytes({ slots: 1 });
    const e = engineSlotBase(LAYOUT_V22, 0);
    w128(d, e + 49, ADL_ONE);
    w128(d, e + 65, ADL_ONE);
    assert.equal(decodeAdlState(d)!.reduceOnly, false);
    w128(d, e + 49, 900_000_000_000_000n);
    w128(d, e + 289, 5n);
    w128(d, e + 305, 6n);
    const s = decodeAdlState(d)!;
    assert.equal(s.reduceOnly, true);
    assert.equal(s.oiEffLong, 5n);
    assert.equal(s.oiEffShort, 6n);
  });
  it("a negative, fractional or out-of-range asset index throws RangeError", () => {
    const d = v22MarketBytes({ slots: 1 });
    assert.throws(() => decodeAdlState(d, -1), RangeError);
    assert.throws(() => decodeAdlState(d, 0.5), RangeError);
    assert.throws(() => decodeAdlState(d, 1), /asset 1 not present/);
  });
});

describe("adlFraction / parseAdlFraction", () => {
  it("formats and exactly inverts", () => {
    assert.equal(adlFraction(ADL_ONE), "1.000000");
    assert.equal(adlFraction(0n), "0.000000");
    assert.equal(parseAdlFraction("1.000000"), ADL_ONE);
    assert.equal(parseAdlFraction("0.861700"), 861_700_000_000_000n);
    assert.equal(parseAdlFraction("2"), 2n * ADL_ONE);
    assert.equal(parseAdlFraction("0.000000000000001"), 1n);
  });
  it("refuses signs, exponents, empty parts and more than 15 fractional digits", () => {
    for (const s of ["", "-1", "1e3", ".5", "1.", "0.1234567890123456", "abc", "1.0 "]) assert.equal(parseAdlFraction(s), null, s);
  });
});

describe("adlHealth", () => {
  it("renders fractions and decimal OI", () => {
    assert.deepEqual(adlHealth({ aLong: ADL_ONE, aShort: 861_700_000_000_000n, oiEffLong: 7n, oiEffShort: 8n, reduceOnly: true }), {
      reduceOnly: true, aLong: "1.000000", aShort: "0.861700", oiEffLong: "7", oiEffShort: "8",
    });
  });
});

describe("adlHealthOf", () => {
  it("non-market bytes and an unknown layout give {} (never a guess)", () => {
    assert.deepEqual(adlHealthOf(new Uint8Array(100)), {});
    assert.deepEqual(adlHealthOf(header({ version: 17, len: 4000 })), {});
  });
  it("single-slot market: adl only, no adlAssets", () => {
    const d = v22MarketBytes({ slots: 1 });
    const r = adlHealthOf(d);
    assert.ok(r.adl);
    assert.equal(r.adlAssets, undefined);
  });
  it("multi-slot market lists every non-Disabled slot and skips Disabled ones", () => {
    const d = v22MarketBytes({ slots: 3 });
    const life = (k: number) => engineSlotBase(LAYOUT_V22, k) + LAYOUT_V22.asset.lifecycle;
    d[life(0)] = 2;
    d[life(1)] = 0; // Disabled: skipped
    d[life(2)] = 3; // DrainOnly: listed
    w128(d, engineSlotBase(LAYOUT_V22, 2) + 65, 800_000_000_000_000n);
    const r = adlHealthOf(d, 0);
    assert.deepEqual(r.adlAssets?.map((a) => a.asset), [0, 2]);
    assert.equal(r.adlAssets?.[1].reduceOnly, true);
    assert.equal(r.adlAssets?.[1].aShort, "0.800000");
  });
  it("an asset index beyond the slots is swallowed to {}", () => {
    assert.deepEqual(adlHealthOf(v22MarketBytes({ slots: 2 }), 5), {});
  });
});
