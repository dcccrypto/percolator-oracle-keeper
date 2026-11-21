// Differential: the optimised isqrt / plus2PctDepthE6 vs the original implementations, >= 200k inputs, 0 mismatches.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isqrt, plus2PctDepthE6 } from "./push-depth.ts";

function oldIsqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
function oldDepth(r: bigint): bigint {
  if (r === 0n) return 0n;
  const target = 50n * r * r;
  let m = oldIsqrt(target / 51n);
  while (51n * m * m < target) m += 1n;
  while (m > 0n && 51n * (m - 1n) * (m - 1n) >= target) m -= 1n;
  return r - m;
}

describe("push-depth old vs new differential", () => {
  let s = 0xdeadbeefn;
  const rnd = () => (s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n));
  it("plus2PctDepthE6: 150k realistic + 60k huge (<2^96) + edges", () => {
    const xs: bigint[] = [];
    for (let i = 0n; i < 3000n; i++) xs.push(i);
    for (let i = 0; i < 150_000; i++) xs.push(1_000_000n + (rnd() % (10n ** 15n - 1_000_000n)));
    for (let i = 0; i < 60_000; i++) xs.push(((rnd() << 32n) | (rnd() >> 32n)) >> (rnd() % 96n));
    for (let e = 0n; e <= 96n; e++) for (const d of [-1n, 0n, 1n]) if ((1n << e) + d >= 0n) xs.push((1n << e) + d);
    assert.ok(xs.length >= 200_000);
    for (const r of xs) assert.equal(plus2PctDepthE6(r), oldDepth(r), `R=${r}`);
  });
  it("isqrt: 100k values incl. squares, +/-1, and beyond 2^1024", () => {
    for (let i = 0; i < 100_000; i++) {
      const w = rnd() % 20n;
      let n = 0n;
      for (let k = 0n; k <= w; k++) n = (n << 64n) | rnd();
      n >>= rnd() % 64n;
      for (const v of [n, n * n, n * n - 1n, n * n + 1n]) if (v >= 0n) assert.equal(isqrt(v), oldIsqrt(v), `n=${v}`);
    }
  });
});
