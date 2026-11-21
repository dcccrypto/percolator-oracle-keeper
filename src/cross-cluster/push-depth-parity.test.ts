/**
 * Differential test: keeper plus2PctDepthE6 vs a TS port of percolator-prog src/depth_src_v22.rs
 * (isqrt_u128, depth_pred, plus2pct_depth_e6, reserve_value_e6). The prog claims "Identical to the keeper's plus2PctDepthE6".
 * Run with: node --import tsx/esm --test src/cross-cluster/push-depth*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { plus2PctDepthE6, resolvePushDepth } from "./push-depth.ts";

const U64_MAX = (1n << 64n) - 1n;

// ── port of the prog (u128 arithmetic; every intermediate asserted to fit) ──
const U128_MAX = (1n << 128n) - 1n;
const u128 = (x: bigint): bigint => {
  assert.ok(x >= 0n && x <= U128_MAX, "u128 overflow in port");
  return x;
};
function isqrtU128(n: bigint): bigint {
  if (n < 2n) return n;
  const bits = BigInt(n.toString(2).length);
  let x = 1n << ((bits + 1n) / 2n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
function depthPred(m: bigint, r: bigint): boolean {
  const a = u128(m * m);
  const q = u128(r * r);
  if (a >= q) return true;
  return q - a <= a / 50n;
}
function progPlus2Pct(r: bigint): bigint {
  assert.ok(r >= 0n && r <= U64_MAX);
  if (r === 0n) return 0n;
  const q = u128(r * r);
  const t = q - (q + 50n) / 51n; // q - ceil(q/51)
  const m0 = isqrtU128(t);
  const m = depthPred(m0, r) ? m0 : m0 + 1n;
  return r - m;
}
function progReserveBaseAtMark(base: bigint, mark: bigint, dec: number, lotExp: number): bigint | null {
  if (mark === 0n || dec > 18 || lotExp > 15) return null;
  const v = u128(base * mark) / 10n ** BigInt(dec + lotExp);
  return v > U64_MAX ? U64_MAX : v;
}

// deterministic PRNG (xorshift64*), fixed seed
function* rng(seed: bigint): Generator<bigint> {
  let s = seed;
  for (;;) {
    s ^= s >> 12n;
    s ^= (s << 25n) & U64_MAX;
    s ^= s >> 27n;
    yield (s * 0x2545f4914f6cdd1dn) & U64_MAX;
  }
}

describe("keeper plus2PctDepthE6 vs prog plus2pct_depth_e6 (differential)", () => {
  it("edge values: 0, 1, 2, 50, 51, u64::MAX", () => {
    let mismatches = 0;
    for (const r of [0n, 1n, 2n, 50n, 51n, U64_MAX - 1n, U64_MAX]) {
      if (plus2PctDepthE6(r) !== progPlus2Pct(r)) mismatches++;
    }
    assert.equal(mismatches, 0);
  });

  it("every R in 0..=100000", () => {
    let mismatches = 0;
    for (let r = 0n; r <= 100_000n; r++) {
      if (plus2PctDepthE6(r) !== progPlus2Pct(r)) mismatches++;
    }
    assert.equal(mismatches, 0);
  });

  it("200,000 random u64 values (seed fixed) incl. log-uniform magnitudes", () => {
    const g = rng(0x9e3779b97f4a7c15n);
    let mismatches = 0;
    for (let i = 0; i < 200_000; i++) {
      const raw = g.next().value as bigint;
      const shift = BigInt(i % 64); // spread over all bit widths
      const r = i % 2 === 0 ? raw : raw >> shift;
      if (plus2PctDepthE6(r) !== progPlus2Pct(r)) mismatches++;
    }
    assert.equal(mismatches, 0);
  });

  it("BaseAtMark: keeper has no such path (only quote-reserve input); port self-check on cap", () => {
    assert.equal(progReserveBaseAtMark(U64_MAX, U64_MAX, 0, 0), U64_MAX);
    assert.equal(progReserveBaseAtMark(1_000_000n, 2_000_000n, 6, 0), 2_000_000n);
    assert.equal(progReserveBaseAtMark(1n, 0n, 6, 0), null);
  });

  it("R > u64::MAX: keeper attests the same depth as the prog, which caps R at u64::MAX", () => {
    for (const r of [U64_MAX + 1n, U64_MAX * 2n, 1n << 100n]) {
      const pd = resolvePushDepth(true, r);
      assert.ok(pd, "depth resolved");
      assert.equal(pd.depthE6, progPlus2Pct(U64_MAX));
    }
  });
});
