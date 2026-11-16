/**
 * Branch-coverage tests for src/circuit-breaker.ts: default config fallbacks
 * (clock, log sink, window, cumulative pct), markGap, markWindowBand, the
 * band-edge "spent" branches, exact-threshold and reset behaviour.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCircuitBreaker,
  fmtPrice,
  markGap,
  markWindowBand,
  recordMarkInForce,
} from "./circuit-breaker.ts";
import type { CircuitBreakerState } from "./circuit-breaker.ts";

function mk(lastPrice = 100): CircuitBreakerState {
  return {
    symbol: "T",
    lastPrice,
    circuitBreakerTrips: 0,
    cbTripPrice: 0,
    cbConsecutiveTrips: 0,
  };
}
const silent = () => {};

describe("fmtPrice", () => {
  it("keeps 6 significant digits and passes non-finite through", () => {
    assert.equal(fmtPrice(0.000123456789), "0.000123457");
    assert.equal(fmtPrice(Infinity), "Infinity");
    assert.equal(fmtPrice(NaN), "NaN");
  });
});

describe("markGap", () => {
  it("is null with no episode, no dir, or a non-positive mark", () => {
    assert.equal(markGap(mk(), 120, 1000), null);
    const noDir = { ...mk(), cbGapSince: 5 };
    assert.equal(markGap(noDir, 120, 1000), null);
    const zero = { ...mk(0), cbGapSince: 5, cbGapDir: 1 as const };
    assert.equal(markGap(zero, 120, 1000), null);
    const neg = { ...mk(-5), cbGapSince: 5, cbGapDir: 1 as const };
    assert.equal(markGap(neg, 120, 1000), null);
  });

  it("reports pct, ages, checks and dir; defaults checks to 0; clamps negative age", () => {
    const s = { ...mk(100), cbGapSince: 400, cbGapDir: -1 as const, cbGapChecks: 7 };
    assert.deepEqual(markGap(s, 80, 1000), {
      pct: 20,
      sinceMs: 400,
      ageMs: 600,
      checks: 7,
      dir: -1,
    });
    const s2 = { ...mk(100), cbGapSince: 5000, cbGapDir: 1 as const };
    const g = markGap(s2, 150, 1000);
    assert.equal(g?.checks, 0);
    assert.equal(g?.ageMs, 0);
  });
});

describe("markWindowBand / recordMarkInForce", () => {
  it("is null when either deque is missing or empty", () => {
    assert.equal(markWindowBand(mk(), 30, 1000), null);
    const s = mk();
    s.cbWindowMax = [{ price: 100, at: 0 }];
    assert.equal(markWindowBand(s, 30, 1000), null);
    s.cbWindowMin = [];
    assert.equal(markWindowBand(s, 30, 1000), null);
  });

  it("computes the band from the deque fronts", () => {
    const s = mk();
    recordMarkInForce(s, 100, 10);
    recordMarkInForce(s, 80, 20);
    const b = markWindowBand(s, 10, 1000);
    assert.ok(b);
    assert.ok(Math.abs(b.lo - 90) < 1e-9); // 100 * 0.9
    assert.ok(Math.abs(b.hi - 88) < 1e-9); // 80 * 1.1
    assert.equal(b.hiFreesAt, 1020);
    assert.equal(b.loFreesAt, 1010);
  });

  it("ignores non-positive / non-finite prices and lifts out-of-order times", () => {
    const s = mk();
    recordMarkInForce(s, 0, 1);
    recordMarkInForce(s, -3, 1);
    recordMarkInForce(s, NaN, 1);
    recordMarkInForce(s, Infinity, 1);
    assert.equal(s.cbWindowMax, undefined);
    recordMarkInForce(s, 100, 500);
    recordMarkInForce(s, 100, 100); // older time → lifted to 500
    assert.equal((s as CircuitBreakerState).cbWindowMax?.at(-1)?.at, 500);
  });
});

describe("default clock/log/window fallbacks", () => {
  it("first price with lastPrice 0 returns newPrice untouched", () => {
    const s = mk(0);
    assert.equal(checkCircuitBreaker(s, 42, { maxMovePct: 10, confirmTrips: 3 }), 42);
    assert.equal(s.lastPrice, 0);
    assert.equal(s.cbWindowMax, undefined);
  });

  it("uses Date.now and console.log when cfg.now / cfg.log are absent", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => void logs.push(String(m));
    try {
      const s = mk(100);
      const r = checkCircuitBreaker(s, 150, { maxMovePct: 10, confirmTrips: 3 });
      assert.equal(r, null);
      assert.equal(s.circuitBreakerTrips, 1);
      assert.equal(s.cbTripPrice, 150);
      assert.equal(s.lastPrice, 100);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /Circuit breaker! 100 → 150 \(50\.0% > 10%\) \[1\/3/);
      // default cumulative = 3 × maxMovePct (30%)
      const b = markWindowBand(s, 30, 3_600_000);
      assert.ok(b);
      assert.ok(Math.abs(b.hi - 130) < 1e-9);
    } finally {
      console.log = orig;
    }
  });

  it("logs the sustained relocation via console.log by default", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => void logs.push(String(m));
    try {
      let t = 0;
      const s = mk(100);
      const c = {
        maxMovePct: 50,
        confirmTrips: 1,
        maxCumulativeMovePct: 1,
        sustainedRelocationMs: 10,
        sustainedRelocationMinChecks: 1,
        now: () => t,
      };
      // Gap episode starts at t=0 (band clamps 120 to edge 101).
      assert.equal(checkCircuitBreaker(s, 120, c), 101);
      t = 20;
      assert.equal(checkCircuitBreaker(s, 120, c), 120);
      assert.equal(s.lastPrice, 120);
      assert.equal(s.cbSnapPending, true);
      assert.ok(logs.some((l) => l.includes("SUSTAINED relocation")));
    } finally {
      console.log = orig;
    }
  });
});

describe("threshold and reset behaviour", () => {
  const cfg = { maxMovePct: 10, confirmTrips: 3, log: silent, now: () => 0 };

  it("a move of exactly maxMovePct is not a trip; just above is", () => {
    const s = mk(100);
    assert.equal(checkCircuitBreaker(s, 110, cfg), 110);
    assert.equal(s.circuitBreakerTrips, 0);
    const s2 = mk(100);
    assert.equal(checkCircuitBreaker(s2, 110.01, cfg), null);
    assert.equal(s2.circuitBreakerTrips, 1);
    assert.equal(s2.cbTripPrice, 110.01);
  });

  it("an in-threshold, different price resets the trip run; an identical one does not", () => {
    const s = mk(100);
    checkCircuitBreaker(s, 150, cfg);
    assert.equal(s.cbConsecutiveTrips, 1);
    checkCircuitBreaker(s, 100, cfg); // identical to baseline: keep run
    assert.equal(s.cbConsecutiveTrips, 1);
    assert.equal(s.cbTripPrice, 150);
    checkCircuitBreaker(s, 105, cfg); // new in-threshold: reset
    assert.equal(s.cbConsecutiveTrips, 0);
    assert.equal(s.cbTripPrice, 0);
  });

  it("a trip at an inconsistent level restarts the run at that level", () => {
    const s = mk(100);
    checkCircuitBreaker(s, 150, cfg);
    checkCircuitBreaker(s, 150, cfg);
    assert.equal(s.cbConsecutiveTrips, 2);
    checkCircuitBreaker(s, 60, cfg);
    assert.equal(s.cbConsecutiveTrips, 1);
    assert.equal(s.cbTripPrice, 60);
    assert.equal(s.circuitBreakerTrips, 3);
  });

  it("confirms after confirmTrips and re-baselines to the new level (up, then down)", () => {
    const c = { ...cfg, maxCumulativeMovePct: 1000 };
    const s = mk(100);
    assert.equal(checkCircuitBreaker(s, 150, c), null);
    assert.equal(checkCircuitBreaker(s, 150, c), null);
    assert.equal(checkCircuitBreaker(s, 150, c), 150);
    assert.equal(s.lastPrice, 150);
    assert.equal(s.cbConsecutiveTrips, 0);
    assert.equal(s.cbTripPrice, 0);
    const d = mk(100);
    checkCircuitBreaker(d, 50, c);
    checkCircuitBreaker(d, 50, c);
    assert.equal(checkCircuitBreaker(d, 50, c), 50);
    assert.equal(d.lastPrice, 50);
  });

  it("zero and negative source prices trip (move 100% / >100%) and never publish unconfirmed", () => {
    const s = mk(100);
    assert.equal(checkCircuitBreaker(s, 0, cfg), null);
    assert.equal(s.circuitBreakerTrips, 1);
    assert.equal(s.cbTripPrice, 0); // 0 stored; next trip starts a fresh run
    assert.equal(s.cbConsecutiveTrips, 1);
    const n = mk(100);
    assert.equal(checkCircuitBreaker(n, -5, cfg), null);
    assert.equal(n.cbTripPrice, -5);
    assert.equal(n.lastPrice, 100);
  });
});

describe("band edge / spent branches", () => {
  const log: string[] = [];
  const cfg = {
    maxMovePct: 10,
    confirmTrips: 1,
    maxCumulativeMovePct: 20,
    log: (m: string) => void log.push(m),
    now: () => 0,
  };

  it("in-threshold step beyond the band is clamped to the edge, then held when spent (up)", () => {
    // band [80,120] is not binding for 5% steps; use a tight band instead.
    const c = { ...cfg, maxMovePct: 50, maxCumulativeMovePct: 5 };
    const s = mk(100);
    assert.equal(checkCircuitBreaker(s, 110, c), 105); // edge, strictly between
    s.lastPrice = 105; // caller advances after landing
    log.length = 0;
    assert.equal(checkCircuitBreaker(s, 110, c), 105); // spent → hold
    assert.match(log[0], /CUMULATIVE bound — holding 105 \(price 110/);
  });

  it("downward: edge then hold, and an injected baseline past the edge is held, not pulled back", () => {
    const c = { ...cfg, maxMovePct: 50, maxCumulativeMovePct: 5 };
    const s = mk(100);
    assert.equal(checkCircuitBreaker(s, 90, c), 95);
    s.lastPrice = 95;
    assert.equal(checkCircuitBreaker(s, 90, c), 95);
    // Baseline injected below the band's low edge with a target further down.
    const inj = mk(100);
    recordMarkInForce(inj, 100, 0);
    inj.lastPrice = 90; // already past lo (95) toward the target 85
    assert.equal(checkCircuitBreaker(inj, 85, c), 90);
  });

  it("confirmed relocation that is spent holds and keeps the trip run", () => {
    const c = { ...cfg, maxMovePct: 10, maxCumulativeMovePct: 5, confirmTrips: 1 };
    const s = mk(100);
    s.lastPrice = 100;
    recordMarkInForce(s, 100, 0);
    // First confirmed trip: edge 105 published, baseline moves to 105.
    assert.equal(checkCircuitBreaker(s, 150, c), 105);
    assert.equal(s.lastPrice, 105);
    log.length = 0;
    // Baseline sits on the edge: spent → hold, run is NOT reset.
    assert.equal(checkCircuitBreaker(s, 150, c), 105);
    assert.match(log[0], /is spent/);
    assert.equal(s.cbConsecutiveTrips, 1);
    assert.equal(s.cbTripPrice, 150);
  });
});

describe("sustained relocation gating (gapSustained)", () => {
  it("never snaps when sustainedRelocationMs is 0/undefined", () => {
    let t = 0;
    const c = {
      maxMovePct: 50,
      confirmTrips: 1,
      maxCumulativeMovePct: 1,
      sustainedRelocationMs: 0,
      log: silent,
      now: () => t,
    };
    const s = mk(100);
    checkCircuitBreaker(s, 120, c);
    t = 1e9;
    assert.equal(checkCircuitBreaker(s, 120, c), 101);
    assert.equal(s.cbSnapPending, undefined);
  });

  it("needs both elapsed time and min checks (defaults to 20, floored by confirmTrips)", () => {
    let t = 0;
    const c = {
      maxMovePct: 50,
      confirmTrips: 1,
      maxCumulativeMovePct: 1,
      sustainedRelocationMs: 10,
      log: silent,
      now: () => t,
    };
    const s = mk(100);
    checkCircuitBreaker(s, 120, c); // check 1, t=0
    t = 100; // time satisfied, but only 2 checks < default 20
    assert.equal(checkCircuitBreaker(s, 120, c), 101);
    assert.equal(s.cbGapChecks, 2);
    assert.equal(s.cbSnapPending, undefined);
  });

  it("a direction flip restarts the episode; publishing the source clears it", () => {
    let t = 5;
    const c = {
      maxMovePct: 50,
      confirmTrips: 1,
      maxCumulativeMovePct: 1,
      sustainedRelocationMs: 1e6,
      log: silent,
      now: () => t,
    };
    const s = mk(100);
    checkCircuitBreaker(s, 120, c);
    assert.equal(s.cbGapDir, 1);
    assert.equal(s.cbGapSince, 5);
    t = 9;
    checkCircuitBreaker(s, 80, c);
    assert.equal(s.cbGapDir, -1);
    assert.equal(s.cbGapSince, 9);
    assert.equal(s.cbGapChecks, 1);
    // Source equals the baseline → episode ends.
    checkCircuitBreaker(s, s.lastPrice, c);
    assert.equal(s.cbGapSince, undefined);
    assert.equal(s.cbGapDir, undefined);
    assert.equal(s.cbGapChecks, undefined);
  });
});
