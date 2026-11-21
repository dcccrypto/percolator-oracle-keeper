/**
 * Differential test: the optimised DepthSampleWindow must return byte-identical results to the original
 * (filter-on-every-call) implementation, including out-of-order and equal timestamps, cap eviction and tiny windows.
 * Run with: node --import tsx/esm --test src/cross-cluster/depth-bracketing.diff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DepthSampleWindow } from "./depth-bracketing.js";
import { LegacyDepthSampleWindow } from "./depth-bracketing.legacy.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function run(seed: number, windowMs: number, dropPct: number, ops: number, mode: "ordered" | "chaos"): number {
  const rnd = lcg(seed);
  const a = new DepthSampleWindow(windowMs, dropPct);
  const b = new LegacyDepthSampleWindow(windowMs, dropPct);
  const pools = ["p0", "p1", "p2", "p3"];
  let clock = 1_000_000;
  let checked = 0;
  for (let i = 0; i < ops; i++) {
    const pool = pools[Math.floor(rnd() * pools.length)];
    const r = rnd();
    // chaos: jump back/forward, repeat the same stamp; ordered: mostly monotone with equal stamps.
    if (mode === "chaos") clock += Math.floor((rnd() - 0.45) * windowMs * 0.6);
    else clock += rnd() < 0.2 ? 0 : Math.floor(rnd() * (windowMs / 8));
    const now = rnd() < 0.15 ? clock + Math.floor((rnd() - 0.5) * windowMs * 2) : clock;
    const reserve = BigInt(Math.floor(rnd() * 50)) * 1_000n + (rnd() < 0.05 ? -1n : 0n);
    if (r < 0.45) {
      const phase = rnd() < 0.5 ? "pre" : "post";
      a.record(pool, reserve, phase, now);
      b.record(pool, reserve, phase, now);
    } else if (r < 0.7) {
      assert.equal(a.minReserve(pool, now), b.minReserve(pool, now), `minReserve op ${i}`);
      checked++;
    } else if (r < 0.85) {
      assert.equal(a.lastPre(pool, now), b.lastPre(pool, now), `lastPre op ${i}`);
      checked++;
    } else if (r < 0.95) {
      const pre = BigInt(Math.floor(rnd() * 50)) * 1_000n;
      const post = BigInt(Math.floor(rnd() * 50)) * 1_000n;
      assert.deepEqual(a.detectBracket(pool, pre, post), b.detectBracket(pool, pre, post), `detectBracket op ${i}`);
      checked++;
    } else {
      const cur = rnd() < 0.1 ? undefined : reserve < 0n ? 0n : reserve;
      assert.equal(a.conservative(pool, cur, now), b.conservative(pool, cur, now), `conservative op ${i}`);
      checked++;
    }
    assert.equal(a.size(pool), b.size(pool), `size op ${i}`);
  }
  return checked;
}

describe("DepthSampleWindow differential vs legacy", () => {
  it("matches on NaN / Infinity timestamps and windows", () => {
    const stamps = [1000, NaN, Infinity, 2000, -Infinity, 500];
    for (const win of [30_000, NaN, Infinity]) {
      for (let m = 0; m < 300; m++) {
        const a = new DepthSampleWindow(win);
        const b = new LegacyDepthSampleWindow(win);
        let x = m + 1;
        for (let i = 0; i < 8; i++) {
          x = (Math.imul(x, 1103515245) + 12345) >>> 0;
          const at = stamps[x % stamps.length];
          const now = stamps[(x >>> 8) % stamps.length];
          const r = BigInt((x >>> 4) % 9);
          a.record("p", r, "pre", at);
          b.record("p", r, "pre", at);
          assert.equal(a.size("p"), b.size("p"));
          assert.equal(a.minReserve("p", now), b.minReserve("p", now));
          assert.equal(a.lastPre("p", now), b.lastPre("p", now));
        }
      }
    }
  });

  it("replays >= 20k random calls with 0 mismatches", () => {
    let total = 0;
    for (const [seed, win, drop, mode] of [
      [1, 30_000, 20, "ordered"],
      [2, 30_000, 20, "chaos"],
      [3, 1_000, 5, "chaos"],
      [4, 1_000, 33.5, "ordered"],
      [5, 600_000, 20, "ordered"], // long window: exercises the 64-sample cap
      [6, 600_000, 0, "chaos"],
      [7, 5, 20, "chaos"],
    ] as const) {
      total += run(seed, win, drop, 12_000, mode);
    }
    assert.ok(total >= 20_000, `only ${total} comparisons`);
  });
});
