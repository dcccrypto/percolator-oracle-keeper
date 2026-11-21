/** Differential: fast encoder/isqrt/plus2PctDepthE6 vs the SDK encoder and the original bit-length isqrt, 2k seeded randoms + edges. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodePushAuthMark } from "@percolatorct/sdk";
import { isqrt, plus2PctDepthE6, encodePushAuthMarkMaybeDepth, encodePushAuthMarkDexMode } from "./push-depth.ts";

const U64 = (1n << 64n) - 1n;
function refIsqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
function refPlus2(r: bigint): bigint {
  if (r === 0n) return 0n;
  const target = 50n * r * r;
  let m = refIsqrt(target / 51n);
  while (51n * m * m < target) m += 1n;
  while (m > 0n && 51n * (m - 1n) * (m - 1n) >= target) m -= 1n;
  return r - m;
}
let seed = 0x2545f4914f6cdd1dn;
const rnd64 = () => { seed ^= seed << 13n & U64; seed ^= seed >> 7n; seed ^= seed << 17n & U64; seed &= U64; return seed; };
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

describe("push-depth differential", () => {
  it("isqrt and plus2PctDepthE6 match the original on edges + 2k randoms", () => {
    const vals: bigint[] = [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, U64, U64 - 1n, 1n << 63n, (1n << 53n) - 1n, 1n << 53n, (1n << 53n) + 1n, 10n ** 12n, 10n ** 15n];
    for (let i = 0; i < 2000; i++) vals.push(rnd64() >> BigInt(Number(rnd64() % 64n)));
    for (const v of vals) {
      assert.equal(isqrt(v), refIsqrt(v), `isqrt ${v}`);
      assert.equal(isqrt(v * v), v);
      if (v > 0n) assert.equal(isqrt(v * v - 1n), v - 1n);
      assert.equal(plus2PctDepthE6(v), refPlus2(v), `plus2 ${v}`);
    }
    const huge = 10n ** 400n + 7n;
    assert.equal(isqrt(huge), refIsqrt(huge));
  });

  it("instruction bytes are identical to the SDK (35 B, 44 B depth, 44 B dex) over edges + 2k randoms", () => {
    const cases: any[] = [];
    for (const a of [0, 1, 255, 256, 65535]) for (const v of [1n, 2n, U64])
      cases.push({ assetIndex: a, marketId: v - 1n, nowSlot: v, markE6: v, observationSequence: U64 - v + 1n });
    for (let i = 0; i < 2000; i++)
      cases.push({ assetIndex: Number(rnd64() % 65536n), marketId: rnd64(), nowSlot: rnd64() >> BigInt(Number(rnd64() % 40n)), markE6: (rnd64() >> BigInt(Number(rnd64() % 60n))) + 1n, observationSequence: rnd64() });
    for (const c of cases) {
      const sdk = encodePushAuthMark(c);
      assert.equal(hex(encodePushAuthMarkMaybeDepth(c)), hex(sdk));
      assert.equal(hex(encodePushAuthMarkMaybeDepth(c, null)), hex(sdk));
      const d = (rnd64() % U64) + 1n;
      const sdk44 = encodePushAuthMark({ ...c, depth: { mode: 1, depthE6: d } });
      assert.equal(hex(encodePushAuthMarkMaybeDepth(c, { depthE6: d, source: "x" })), hex(sdk44));
      assert.equal(hex(encodePushAuthMarkDexMode(c)), hex(encodePushAuthMark({ ...c, depth: { mode: 2, depthE6: 0n } })));
    }
  });

  it("invalid / non-bigint args behave exactly like the SDK (same error or same bytes)", () => {
    const bad: any[] = [
      { assetIndex: 3, marketId: 7n, nowSlot: 1n, markE6: 0n, observationSequence: 1n },
      { assetIndex: -1, marketId: 7n, nowSlot: 1n, markE6: 1n, observationSequence: 1n },
      { assetIndex: 65536, marketId: 7n, nowSlot: 1n, markE6: 1n, observationSequence: 1n },
      { assetIndex: 1.5, marketId: 7n, nowSlot: 1n, markE6: 1n, observationSequence: 1n },
      { assetIndex: 3, marketId: U64 + 1n, nowSlot: 1n, markE6: 1n, observationSequence: 1n },
      { assetIndex: 3, marketId: -1n, nowSlot: 1n, markE6: 1n, observationSequence: 1n },
      { assetIndex: 3, marketId: "7", nowSlot: 1n, markE6: "5", observationSequence: 1n },
      { assetIndex: 3, marketId: 7, nowSlot: 1n, markE6: 5n, observationSequence: 1n },
    ];
    for (const c of bad) {
      let s: string, f: string;
      try { s = hex(encodePushAuthMark(c)); } catch (e) { s = "ERR " + (e as Error).message; }
      try { f = hex(encodePushAuthMarkMaybeDepth(c)); } catch (e) { f = "ERR " + (e as Error).message; }
      assert.equal(f, s);
    }
  });
});
