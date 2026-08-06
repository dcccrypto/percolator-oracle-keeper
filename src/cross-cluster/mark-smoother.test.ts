/**
 * Mark-smoother tests (the CATE LP drain fix, part 2 — 2026-07-31).
 *
 * The scenario these lock in: a bot round-tripping a hot pool flips the raw
 * spot between two levels ~1.6% apart in runs of 30–60s. Published raw, the
 * engine ratchets that oscillation into permanent LP losses. The smoother's
 * median-over-window must HOLD the majority level through the churn, while
 * still following genuine sustained moves and pricing new pools immediately.
 *
 * Assertions are exact-value, so replacing the median with a mean (or an
 * EWMA) fails the two-level tests — the estimator choice is the fix.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/mark-smoother.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMarkSmoother } from "./mark-smoother.ts";

const POOL = "PooL111111111111111111111111111111111111111";
const T0 = 1_000_000;
const TICK = 7_000; // the keeper's push cadence

describe("createMarkSmoother", () => {
  it("withholds prices until minSamples readings exist", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    assert.equal(s.smooth(POOL, 4700n, T0), null);
    assert.equal(s.smooth(POOL, 4712n, T0 + TICK), null);
    // Third sample crosses the threshold: 3 is odd, so the oldest is dropped
    // and the median averages the two newest — (4712 + 4706) / 2.
    assert.equal(s.smooth(POOL, 4706n, T0 + 2 * TICK), 4709n);
  });

  it("is the identity on a constant series after the window primes", () => {
    const s = createMarkSmoother();
    assert.equal(s.smooth(POOL, 4643n, T0), null);
    assert.equal(s.smooth(POOL, 4643n, T0 + TICK), null);
    for (let i = 2; i < 20; i++) {
      assert.equal(s.smooth(POOL, 4643n, T0 + i * TICK), 4643n);
    }
  });

  it("HOLDS the majority level through a two-level bot ping-pong (the CATE pattern)", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    // Real pattern observed on-chain: runs of ~4 pushes at 4643, ~2 at 4717.
    const pattern = [4643n, 4643n, 4643n, 4643n, 4717n, 4717n];
    const out: Array<bigint | null> = [];
    for (let i = 0; i < 60; i++) {
      out.push(s.smooth(POOL, pattern[i % pattern.length], T0 + i * TICK));
    }
    // After warmup, the published mark must sit EXACTLY on the majority level
    // and never flip once — that flip is what the engine ratchets into losses.
    const warm = out.slice(12);
    for (const px of warm) assert.equal(px, 4643n);
  });

  it("settles between the levels on a perfectly balanced ping-pong", () => {
    // 50/50 churn has no majority level — the fair price of a pool a bot
    // round-trips symmetrically is the midpoint, and CRUCIALLY the output
    // must still be STABLE, not oscillating.
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    const out: Array<bigint | null> = [];
    for (let i = 0; i < 40; i++) {
      out.push(s.smooth(POOL, i % 2 === 0 ? 4600n : 4700n, T0 + i * TICK));
    }
    const warm = out.slice(14);
    for (const px of warm) assert.equal(px, 4650n);
  });

  it("follows a genuine sustained move with bounded lag", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    // Flat at 4600, then a real pump: +10 per push, never retracing.
    let last: bigint | null = null;
    for (let i = 0; i < 13; i++) last = s.smooth(POOL, 4600n, T0 + i * TICK);
    assert.equal(last, 4600n);
    const ramp: bigint[] = [];
    for (let i = 0; i < 26; i++) {
      const raw = 4600n + BigInt(i + 1) * 10n;
      const smoothed = s.smooth(POOL, raw, T0 + (13 + i) * TICK);
      if (smoothed === null) throw new Error("smoother unexpectedly withheld after priming");
      ramp.push(smoothed);
    }
    // Output must be monotone non-decreasing (median of a monotone window)…
    for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] >= ramp[i - 1]);
    // …and once the window holds only ramp samples, lag is exactly the
    // half-window median position: 13 samples ≈ 6 ticks behind the raw spot.
    const lastRaw = 4600n + 26n * 10n;
    const lastOut = ramp[ramp.length - 1];
    assert.ok(lastRaw - lastOut <= 70n, `lag too large: ${lastRaw - lastOut}`);
    assert.ok(lastOut > 4600n, "smoother never followed the move");
  });

  it("evicts samples older than the window and withholds while re-priming", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    for (let i = 0; i < 12; i++) s.smooth(POOL, 4600n, T0 + i * TICK);
    // 10-minute gap — everything above is stale. The first readings after the
    // gap are below minSamples, so publishing is withheld instead of raw.
    const afterGap = T0 + 12 * TICK + 600_000;
    assert.equal(s.smooth(POOL, 5000n, afterGap), null);
    assert.equal(s.smooth(POOL, 5004n, afterGap + TICK), null);
    assert.equal(s.smooth(POOL, 5002n, afterGap + 2 * TICK), 5003n);
  });

  it("withholds the first manipulated reading after a full sample-window gap", () => {
    const s = createMarkSmoother();
    const fair = 1_000_000n;
    const manip = 3_000_000n;
    let t = T0;

    for (let i = 0; i < 12; i++) {
      assert.equal(s.smooth(POOL, fair, t), i < 2 ? null : fair);
      t += TICK;
    }

    // Control: while the window is healthy, the median rejects a single 3x spike.
    assert.equal(s.smooth(POOL, manip, t), fair);

    // Regression for issue #93: after a full window gap, the same 3x spike must
    // not be published raw as the mark.
    t += 200_000;
    assert.equal(s.smooth(POOL, manip, t), null);
  });

  it("keeps pools independent", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 1 });
    const A = "PoolAAA";
    const B = "PoolBBB";
    for (let i = 0; i < 9; i++) {
      s.smooth(A, 100n, T0 + i * TICK);
      s.smooth(B, 900n, T0 + i * TICK);
    }
    assert.equal(s.smooth(A, 100n, T0 + 9 * TICK), 100n);
    assert.equal(s.smooth(B, 900n, T0 + 9 * TICK), 900n);
  });

  it("median (not mean): a single wild outlier does not move the mark", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    for (let i = 0; i < 11; i++) s.smooth(POOL, 4600n, T0 + i * TICK);
    // One garbage reading 100x off (e.g. a torn/misparsed account).
    // A mean would jump ~9x; the median must not move AT ALL.
    assert.equal(s.smooth(POOL, 460_000n, T0 + 11 * TICK), 4600n);
  });

  it("default window is 180s — the live-tested value; 90s let 50-70s churn runs through", () => {
    // Pins DEFAULT_WINDOW_MS: every other test passes windowMs explicitly, so
    // a silent revert of the 90s→180s widening would otherwise pass CI.
    // At the keeper's 7s cadence a 180s window holds ~26 samples: samples
    // older than 180s must be evicted, samples inside must not be.
    const s = createMarkSmoother({ minSamples: 3 });
    for (let i = 0; i < 26; i++) s.smooth(POOL, 4600n, T0 + i * TICK);
    // One old-level sample at T0 is now 175s old at the next tick — still in
    // window; a 4700 stream shorter than half the window cannot flip the mark.
    for (let i = 26; i < 32; i++) {
      assert.equal(s.smooth(POOL, 4700n, T0 + i * TICK), 4600n);
    }
    // With a 90s window those six 4700s (42s) would be 6 of ~13 samples and
    // the even-median would already sit at the midpoint — assert it doesn't.
  });

  it("reset drops all state and withholds until the window re-primes", () => {
    const s = createMarkSmoother({ windowMs: 90_000, minSamples: 3 });
    for (let i = 0; i < 10; i++) s.smooth(POOL, 4600n, T0 + i * TICK);
    s.reset();
    assert.equal(s.smooth(POOL, 9999n, T0 + 11 * TICK), null);
    assert.equal(s.smooth(POOL, 10001n, T0 + 12 * TICK), null);
    assert.equal(s.smooth(POOL, 9997n, T0 + 13 * TICK), 9999n);
  });
});

describe("keeper-loop wiring", () => {
  it("the loop pushes the smoothed mark, not raw spot", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("./keeper-loop.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    // Tripwire: the smoother must be constructed and applied to the pool
    // price before it enters the push list.
    assert.match(src, /createMarkSmoother\(/);
    assert.match(src, /markSmoother\.smooth\(entry\.poolAddress,\s*rawPriceE6/);
    assert.match(src, /priceE6 === null/);
    assert.match(src, /checkCircuitBreaker\(/);
  });
});
