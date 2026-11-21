/**
 * Branch-coverage + seeded property tests for mark-smoother.ts.
 *
 * Targets: full-window age eviction, lowerBound at both ends, the /health priming
 * status object, empty-window / null returns, markCadenceCheck verdicts, and a
 * >= 5,000-sequence seeded property test against mark-smoother.reference.ts.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/mark-smoother.branches.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMarkSmoother, markCadenceCheck, DEFAULT_MIN_SAMPLES } from "./mark-smoother.ts";
import { createMarkSmootherRef } from "./mark-smoother.reference.ts";

const P = "pool";
const T0 = 1_000_000;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("window eviction when every older sample is past the cutoff", () => {
  it("a long gap evicts the whole old window; only the new sample survives and the pool re-primes", () => {
    const s = createMarkSmoother({ windowMs: 10_000, minSamples: 3, minSpanMs: 0 });
    for (let i = 0; i < 5; i++) s.smooth(P, 100n + BigInt(i), T0 + i * 1000);
    assert.equal(s.status(P).samples, 5);
    assert.equal(s.smooth(P, 999n, T0 + 1_000_000), null);
    assert.deepEqual(s.status(P), { samples: 1, spanMs: 0, minSamples: 3, minSpanMs: 0 });
    assert.equal(s.peek(P), null);
    s.smooth(P, 1000n, T0 + 1_001_000);
    assert.equal(s.smooth(P, 1001n, T0 + 1_002_000), 1000n); // 999,1000,1001 -> drop oldest -> (1000+1001)/2
  });

  it("window so tight that even the new sample is older than the cutoff (negative window) matches the reference", () => {
    const a = createMarkSmoother({ windowMs: -1, minSamples: 3 });
    const b = createMarkSmootherRef({ windowMs: -1, minSamples: 3 });
    for (let i = 0; i < 4; i++) {
      assert.equal(a.smooth(P, BigInt(i), T0 + i), b.smooth(P, BigInt(i), T0 + i));
      assert.deepEqual(a.status(P), b.status(P));
    }
    assert.equal(a.status(P).samples, 0);
  });

  it("sample exactly at the cutoff is retained (strict <)", () => {
    const s = createMarkSmoother({ windowMs: 5_000, minSamples: 1, minSpanMs: 0 });
    s.smooth(P, 1n, T0);
    s.smooth(P, 2n, T0 + 5_000);
    assert.equal(s.status(P).samples, 2);
    s.smooth(P, 3n, T0 + 5_001);
    assert.equal(s.status(P).samples, 2);
  });
});

describe("sorted-window binary search at both ends", () => {
  const mk = () => createMarkSmoother({ windowMs: 1_000_000, minSamples: 1, minSpanMs: 0 });
  it("new minimum then new maximum inserts at index 0 and at the tail", () => {
    const s = mk();
    s.smooth(P, 50n, T0);
    s.smooth(P, 10n, T0 + 1); // below everything
    s.smooth(P, 90n, T0 + 2); // above everything
    // window [50,10,90] odd -> drop oldest (50) -> [10,90] -> 50
    assert.equal(s.peek(P), 50n);
    s.smooth(P, 5n, T0 + 3); // [50,10,90,5] even -> sorted 5,10,50,90 -> (10+50)/2
    assert.equal(s.peek(P), 30n);
    s.smooth(P, 100n, T0 + 4); // odd 5, drop oldest 50 -> 5,10,90,100 -> 50
    assert.equal(s.peek(P), 50n);
  });
  it("removing the oldest when it is the smallest / the largest value", () => {
    const lo = createMarkSmoother({ windowMs: 2_500, minSamples: 1, minSpanMs: 0 });
    for (let i = 0; i < 6; i++) lo.smooth(P, BigInt(i), T0 + i * 1000); // oldest always the smallest
    assert.equal(lo.status(P).samples, 3);
    const hi = createMarkSmoother({ windowMs: 2_500, minSamples: 1, minSpanMs: 0 });
    for (let i = 0; i < 6; i++) hi.smooth(P, BigInt(100 - i), T0 + i * 1000); // oldest always the largest
    assert.equal(hi.status(P).samples, 3);
    assert.equal(hi.peek(P), 95n); // window 97,96,95 odd -> drop 97 -> (96+95)/2 = 95
    assert.equal(lo.peek(P), 4n); // window 3,4,5 -> drop 3 -> (4+5)/2 = 4
  });
  it("duplicates of the oldest value are handled", () => {
    const s = mk();
    for (const [i, v] of [7n, 7n, 7n, 7n, 7n].entries()) s.smooth(P, v, T0 + i);
    assert.equal(s.peek(P), 7n);
  });
});

describe("priming-gate status object (/health)", () => {
  it("unknown pool: zeros plus the thresholds", () => {
    const s = createMarkSmoother({ windowMs: 60_000 });
    assert.deepEqual(s.status("nope"), { samples: 0, spanMs: 0, minSamples: DEFAULT_MIN_SAMPLES, minSpanMs: 50_000 });
  });
  it("tracks samples/span as the window fills, with explicit overrides", () => {
    const s = createMarkSmoother({ windowMs: 60_000, minSamples: 2, minSpanMs: 7_000 });
    s.smooth(P, 1n, T0);
    assert.deepEqual(s.status(P), { samples: 1, spanMs: 0, minSamples: 2, minSpanMs: 7_000 });
    assert.equal(s.smooth(P, 2n, T0 + 5_000), null); // count ok, span 5000 < 7000
    assert.deepEqual(s.status(P), { samples: 2, spanMs: 5_000, minSamples: 2, minSpanMs: 7_000 });
    assert.equal(s.smooth(P, 4n, T0 + 7_000), 3n); // 3 samples, span met, drop oldest(1) -> (2+4)/2
    assert.equal(s.status(P).spanMs, 7_000);
  });
  it("status is read-only and reset() clears it", () => {
    const s = createMarkSmoother();
    s.smooth(P, 1n, T0);
    s.status(P);
    s.status(P);
    assert.equal(s.status(P).samples, 1);
    s.reset();
    assert.equal(s.status(P).samples, 0);
    assert.equal(s.peek(P), null);
  });
});

describe("null / empty returns", () => {
  it("peek: unseen pool, below minSamples, and at minSamples (span waived)", () => {
    const s = createMarkSmoother({ minSamples: 3 });
    assert.equal(s.peek("x"), null);
    s.smooth(P, 1n, T0);
    s.smooth(P, 2n, T0 + 1);
    assert.equal(s.peek(P), null);
    s.smooth(P, 3n, T0 + 2);
    assert.equal(s.smooth(P, 3n, T0 + 3), null); // span gate holds smooth...
    assert.notEqual(s.peek(P), null); // ...but not peek
  });
  it("pools are independent", () => {
    const s = createMarkSmoother({ minSamples: 1, minSpanMs: 0 });
    s.smooth("a", 10n, T0);
    assert.equal(s.peek("b"), null);
    assert.equal(s.peek("a"), 10n);
  });
  it("count cap: >64 dense samples are trimmed to 64", () => {
    const s = createMarkSmoother({ windowMs: 10_000_000, minSamples: 1, minSpanMs: 0 });
    for (let i = 0; i < 200; i++) s.smooth(P, BigInt(i), T0 + i);
    assert.equal(s.status(P).samples, 64);
  });
});

describe("markCadenceCheck", () => {
  it("ok / fragile / never verdicts", () => {
    assert.equal(markCadenceCheck(1_000, 15_000).verdict, "ok");
    assert.equal(markCadenceCheck(5_000, 15_000).verdict, "fragile"); // exact works, +2% drops a sample
    assert.equal(markCadenceCheck(6_000, 15_000).verdict, "never");
    assert.equal(markCadenceCheck(4_000, 15_000).verdict, "never");
  });
  it("honours option overrides and reports detail", () => {
    const r = markCadenceCheck(5_000, 15_000, { minSpanFraction: 0.5, minSamples: 2, jitterFraction: 0.01 });
    assert.equal(r.verdict, "ok");
    assert.match(r.detail, /CC_INTERVAL_MS=5000/);
    assert.match(r.detail, /\+1%/);
  });
});

describe("seeded property test vs mark-smoother.reference.ts", () => {
  const OPTS = [
    {},
    { windowMs: 15_000 },
    { windowMs: 30_000, minSamples: 1, minSpanMs: 0 },
    { minSamples: 5 },
    { windowMs: 8_000, minSamples: 2, minSpanMs: 3_000 },
  ];
  it("5,000+ random sequences produce identical smooth/peek/status", () => {
    const N = 5_200;
    let mismatches = 0;
    let compared = 0;
    for (let seed = 1; seed <= N; seed++) {
      const rng = makeRng(seed * 2654435761);
      const opts = OPTS[seed % OPTS.length];
      const a = createMarkSmoother(opts);
      const b = createMarkSmootherRef(opts);
      const len = 5 + Math.floor(rng() * 25);
      let t = T0;
      let px = BigInt(1 + Math.floor(rng() * 1_000_000));
      for (let i = 0; i < len; i++) {
        const r = rng();
        // mostly steady steps, some jitter, occasional full-window gap, rare backwards step / repeat timestamp
        t += r < 0.6 ? 2000 : r < 0.8 ? Math.floor(rng() * 9000) : r < 0.88 ? 0 : r < 0.93 ? -Math.floor(rng() * 5000) : Math.floor(rng() * 400_000);
        const q = rng();
        px = q < 0.3 ? px : q < 0.4 ? 0n : px + BigInt(Math.floor((rng() - 0.5) * 4000));
        if (px < 0n) px = -px;
        const pool = `p${Math.floor(rng() * 2)}`;
        if (rng() < 0.01) {
          a.reset();
          b.reset();
        }
        const x = a.smooth(pool, px, t);
        const y = b.smooth(pool, px, t);
        compared++;
        if (x !== y) mismatches++;
        for (const p of ["p0", "p1", "unseen"]) {
          if (a.peek(p) !== b.peek(p)) mismatches++;
          const sa = a.status(p);
          const sb = b.status(p);
          if (JSON.stringify(sa) !== JSON.stringify(sb)) mismatches++;
        }
      }
    }
    assert.ok(compared > 5_000 * 5);
    assert.equal(mismatches, 0);
  });
});
