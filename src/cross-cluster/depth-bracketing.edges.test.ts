/**
 * Edge/branch pins for depth bracketing + a property test against a straight reference implementation.
 * Run with: node --import tsx/esm --test src/cross-cluster/depth-bracketing.edges.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DepthSampleWindow,
  MAX_SAMPLES_PER_POOL,
  SLOT_MS,
  conservativeReserves,
  depthMinWindowMs,
  depthPushJitterPct,
  jitteredIntervalMs,
  postPushRereadDelayMs,
  recordPostPushReads,
} from "./depth-bracketing.ts";

describe("depth bracketing: untaken branches", () => {
  it("jitter span rounds to 0 for tiny intervals: interval returned unchanged, rng never called", () => {
    const boom = () => {
      throw new Error("rng must not be called");
    };
    assert.equal(jitteredIntervalMs(1, 30, boom), 1);
    assert.equal(jitteredIntervalMs(3, 30, boom), 3); // floor(3*30/100)=0
    assert.equal(jitteredIntervalMs(4, 30, (lo) => lo), 3); // span 1 is the smallest that draws
  });
  it("jitter: NaN / negative / zero inputs return the interval unchanged", () => {
    const boom = () => {
      throw new Error("no rng");
    };
    assert.equal(jitteredIntervalMs(NaN, 30, boom), NaN);
    assert.equal(jitteredIntervalMs(0, 30, boom), 0);
    assert.equal(jitteredIntervalMs(-5, 30, boom), -5);
    assert.equal(jitteredIntervalMs(7000, NaN, boom), 7000);
    assert.equal(jitteredIntervalMs(7000, -1, boom), 7000);
  });
  it("jitter: fractional interval is floored; rng below lo is clamped up, above is clamped down", () => {
    assert.equal(jitteredIntervalMs(7000.9, 50, () => -1e9), 3500);
    assert.equal(jitteredIntervalMs(7000.9, 50, () => 1e9), 7000);
  });
  it("jitter: default CSPRNG is used when no rng passed", () => {
    for (let i = 0; i < 50; i++) {
      const v = jitteredIntervalMs(1000, 30);
      assert.ok(v >= 700 && v <= 1000);
    }
  });
  it("re-read delay: default rng, swapped min/max, zero and negative bounds, clamped bad rng", () => {
    for (let i = 0; i < 50; i++) {
      const d = postPushRereadDelayMs();
      assert.ok([1, 2, 3].includes(d / SLOT_MS));
    }
    assert.equal(postPushRereadDelayMs((lo) => lo, 3, 1), 1 * SLOT_MS); // swapped: lo=1, hi=3
    assert.equal(postPushRereadDelayMs((_l, hi) => hi - 1, 3, 1), 1 * SLOT_MS); // swapped bounds collapse to maxSlots
    assert.equal(postPushRereadDelayMs((lo) => lo, -4, -2), 0);
    assert.equal(postPushRereadDelayMs(() => -99, 1, 3), 1 * SLOT_MS);
    assert.equal(postPushRereadDelayMs(() => 99, 1, 3), 3 * SLOT_MS);
    assert.equal(postPushRereadDelayMs(() => 0, 2, 2), 2 * SLOT_MS);
  });
  it("env: default process.env path, boundaries, whitespace, non-digit, unsafe ints", () => {
    const j = depthPushJitterPct(true);
    assert.ok(j >= 0 && j <= 50);
    assert.equal(depthPushJitterPct(false), 0);
    const w = depthMinWindowMs();
    assert.ok(w >= 1000 && w <= 600000);
    const e = (k: string, v: string | undefined) => ({ [k]: v });
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "0")), 0);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "50")), 50);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "51")), 30);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", " 12 ")), 12);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "")), 30);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", undefined)), 30);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "-1")), 30);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "1.5")), 30);
    assert.equal(depthPushJitterPct(true, e("KEEPER_DEPTH_PUSH_JITTER_PCT", "9".repeat(30))), 30);
    assert.equal(depthMinWindowMs(e("KEEPER_DEPTH_MIN_WINDOW_MS", "999")), 30_000);
    assert.equal(depthMinWindowMs(e("KEEPER_DEPTH_MIN_WINDOW_MS", "1000")), 1000);
    assert.equal(depthMinWindowMs(e("KEEPER_DEPTH_MIN_WINDOW_MS", "600000")), 600000);
    assert.equal(depthMinWindowMs(e("KEEPER_DEPTH_MIN_WINDOW_MS", "600001")), 30_000);
  });
  it("window: empty book / unknown pool", () => {
    const w = new DepthSampleWindow();
    assert.equal(w.minReserve("p", 0), undefined);
    assert.equal(w.lastPre("p", 0), undefined);
    assert.equal(w.conservative("p", 5n, 0), 5n);
    assert.equal(w.conservative("p", undefined, 0), undefined);
    assert.equal(w.size("p"), 0);
    assert.equal(conservativeReserves(w, new Map(), 0).size, 0);
    assert.deepEqual(recordPostPushReads(w, new Map(), ["p"], 0), []);
  });
  it("window: negative reserve ignored, zero kept; edge of window inclusive", () => {
    const w = new DepthSampleWindow(1000);
    w.record("p", -1n, "pre", 0);
    assert.equal(w.size("p"), 0);
    w.record("p", 0n, "pre", 0);
    assert.equal(w.size("p"), 1);
    assert.equal(w.minReserve("p", 1000), 0n); // age == windowMs kept
    assert.equal(w.minReserve("p", 1001), undefined); // age > windowMs dropped
    assert.equal(w.size("p"), 0);
    assert.equal(w.lastPre("p", 1001), undefined);
  });
  it("window: capped at MAX_SAMPLES_PER_POOL, oldest evicted; overflow-size values compare exactly", () => {
    const w = new DepthSampleWindow(10_000_000);
    const big = 2n ** 200n;
    for (let i = 0; i < MAX_SAMPLES_PER_POOL + 10; i++) w.record("p", big + BigInt(i), "pre", i);
    assert.equal(w.size("p"), MAX_SAMPLES_PER_POOL);
    assert.equal(w.minReserve("p", 100), big + 10n);
    assert.equal(w.conservative("p", big + 5n, 100), big + 5n);
    assert.equal(w.conservative("p", big + 50n, 100), big + 10n);
  });
  it("lastPre skips post samples; none when only post", () => {
    const w = new DepthSampleWindow();
    w.record("p", 9n, "post", 0);
    assert.equal(w.lastPre("p", 0), undefined);
    w.record("p", 7n, "pre", 1);
    w.record("p", 3n, "post", 2);
    assert.equal(w.lastPre("p", 2), 7n);
  });
  it("detectBracket: exact threshold edge, pre<=0, post>=pre, 100% drop, huge values", () => {
    const w = new DepthSampleWindow(30_000, 20);
    assert.equal(w.detectBracket("p", 0n, 0n), null);
    assert.equal(w.detectBracket("p", -5n, -9n), null);
    assert.equal(w.detectBracket("p", 100n, 100n), null);
    assert.equal(w.detectBracket("p", 100n, 101n), null);
    assert.equal(w.detectBracket("p", 100n, 81n), null); // 19%
    assert.equal(w.detectBracket("p", 100n, 80n)?.dropPct, 20); // exactly on the edge
    assert.equal(w.detectBracket("p", 100n, 0n)?.dropPct, 100);
    const big = 10n ** 40n;
    assert.equal(w.detectBracket("p", big, big - big / 5n)?.dropPct, 20);
    assert.equal(w.detectBracket("p", big, big - big / 5n + 1n), null);
    // drop 0 threshold: any strict drop fires
    const z = new DepthSampleWindow(30_000, 0);
    assert.equal(z.detectBracket("p", 10n ** 30n, 10n ** 30n - 1n)?.dropPct, 0);
    // negative threshold falls back to the 20% default
    const n = new DepthSampleWindow(30_000, -3);
    assert.equal(n.detectBracket("p", 100n, 81n), null);
    assert.ok(n.detectBracket("p", 100n, 80n));
  });
  it("recordPostPushReads: post without any pre records but signals nothing", () => {
    const w = new DepthSampleWindow();
    const sig = recordPostPushReads(w, new Map([["p", 1n]]), ["p"], 0);
    assert.deepEqual(sig, []);
    assert.equal(w.size("p"), 1);
  });
});

// ---- property test vs a straight reference ----
function refJitter(intervalMs: number, pct: number, v: number): number {
  if (!(intervalMs > 0) || !(pct > 0)) return intervalMs;
  const p = pct > 50 ? 50 : pct;
  const I = Math.floor(intervalMs);
  const span = Math.floor((I * p) / 100);
  if (span <= 0) return intervalMs;
  const lo = I - span;
  let r = v;
  if (r < lo) r = lo;
  if (r > I) r = I;
  return r;
}

describe("property: window + bracket vs reference (6000 cases)", () => {
  it("matches a naive reference model", () => {
    let s = 12345;
    const rnd = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
    let mismatches = 0;
    for (let c = 0; c < 6000; c++) {
      // jitter
      const interval = rnd(20) === 0 ? rnd(5) : rnd(20_000) + rnd(100) / 100;
      const pct = rnd(80) - 5;
      const draw = rnd(30_000) - 5000;
      if (!Object.is(jitteredIntervalMs(interval, pct, () => draw), refJitter(interval, pct, draw))) mismatches++;

      // window model
      const windowMs = 1000 + rnd(5000);
      const dropPct = rnd(101);
      const win = new DepthSampleWindow(windowMs, dropPct);
      const ref: { at: number; r: bigint; ph: string }[] = [];
      let now = 0;
      const n = rnd(90);
      for (let i = 0; i < n; i++) {
        now += rnd(800);
        const mag = rnd(4) === 0 ? 2n ** BigInt(rnd(180)) : BigInt(rnd(1000));
        const r = rnd(15) === 0 ? -mag : mag;
        const ph = rnd(2) ? "pre" : "post";
        win.record("p", r, ph as "pre" | "post", now);
        if (r >= 0n) {
          ref.push({ at: now, r, ph });
          while (ref.length > MAX_SAMPLES_PER_POOL) ref.shift();
        }
        // prune like the impl: only samples within the window at `now`
        for (let k = ref.length - 1; k >= 0; k--) if (now - ref[k].at > windowMs) ref.splice(k, 1);
      }
      const q = now + rnd(windowMs * 2);
      const live = ref.filter((x) => q - x.at <= windowMs);
      const refMin = live.length ? live.reduce((m, x) => (x.r < m ? x.r : m), live[0].r) : undefined;
      if (win.minReserve("p", q) !== refMin) mismatches++;
      const pres = live.filter((x) => x.ph === "pre");
      if (win.lastPre("p", q) !== (pres.length ? pres[pres.length - 1].r : undefined)) mismatches++;
      const cur = rnd(5) === 0 ? undefined : BigInt(rnd(1000));
      const refCons = cur === undefined ? undefined : refMin !== undefined && refMin < cur ? refMin : cur;
      if (win.conservative("p", cur, q) !== refCons) mismatches++;

      // detectBracket reference: drop% in basis points, floored
      const pre = BigInt(rnd(3) === 0 ? 0 : rnd(100000));
      const post = BigInt(rnd(100000));
      const sig = win.detectBracket("p", pre, post);
      let expected: number | null = null;
      if (pre > 0n && post < pre) {
        const bps = ((pre - post) * 10000n) / pre;
        if (bps >= BigInt(dropPct * 100)) expected = Number(bps) / 100;
      }
      if ((sig === null ? null : sig.dropPct) !== expected) mismatches++;
    }
    assert.equal(mismatches, 0);
  });
});
