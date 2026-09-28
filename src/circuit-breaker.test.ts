/**
 * Unit tests for the circuit-breaker helper (issue #30 fix).
 *
 * Covers:
 *   - Normal within-threshold prices are accepted.
 *   - A single spike is blocked and does NOT re-baseline lastPrice.
 *   - A spike that disappears (price returns to normal) resets the run
 *     counter so the spike can never accumulate to confirmation.
 *   - A sustained, consistent relocation accumulates trips and is accepted
 *     (re-baselined) after CONFIRM_TRIPS consecutive trips.
 *   - A run of inconsistent spikes (each at a different level) never confirms.
 *   - First price (lastPrice === 0) is always accepted regardless of value.
 *   - confirmTrips boundary: accepted on exactly the Nth trip, not the N-1th.
 *
 * Run with: node --import tsx/esm --test src/circuit-breaker.test.ts
 * Or via:   pnpm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCircuitBreaker } from "./circuit-breaker.ts";
import type { CircuitBreakerState } from "./circuit-breaker.ts";

// ── helpers ──────────────────────────────────────────────────

/** Build a fresh state with a given baseline price. */
function makeState(lastPrice = 100, symbol = "TEST"): CircuitBreakerState {
  return {
    symbol,
    lastPrice,
    circuitBreakerTrips: 0,
    cbTripPrice: 0,
    cbConsecutiveTrips: 0,
  };
}

/** Silent log sink for tests. */
const silent = () => {};

/** Standard 10% threshold, 3 confirmations. */
const cfg = { maxMovePct: 10, confirmTrips: 3, log: silent };

// ── first-price bootstrap ─────────────────────────────────────

describe("first price (lastPrice === 0)", () => {
  it("always accepts any first price", () => {
    const s = makeState(0);
    assert.ok(checkCircuitBreaker(s, 999_999, cfg));
    assert.equal(s.circuitBreakerTrips, 0);
  });
});

// ── within-threshold prices ───────────────────────────────────

describe("within-threshold prices", () => {
  it("accepts a small positive move", () => {
    const s = makeState(100);
    assert.ok(checkCircuitBreaker(s, 105, cfg)); // 5% — within 10%
    assert.equal(s.cbConsecutiveTrips, 0);
  });

  it("accepts a small negative move", () => {
    const s = makeState(100);
    assert.ok(checkCircuitBreaker(s, 95, cfg)); // 5% down
  });

  it("accepts exactly at the threshold boundary", () => {
    const s = makeState(100);
    assert.ok(checkCircuitBreaker(s, 110, cfg)); // exactly 10% — within (≤)
  });

  it("resets cbConsecutiveTrips when a normal price follows a partial run", () => {
    const s = makeState(100);
    // Two trips at a high level
    checkCircuitBreaker(s, 120, cfg);
    checkCircuitBreaker(s, 121, cfg);
    assert.equal(s.cbConsecutiveTrips, 2);
    // Normal price — must reset the counter
    checkCircuitBreaker(s, 102, cfg);
    assert.equal(s.cbConsecutiveTrips, 0);
    assert.equal(s.cbTripPrice, 0);
  });
});

// ── single-spike blocking ─────────────────────────────────────

describe("single spike — must be blocked and NOT re-baseline", () => {
  it("blocks a >threshold spike", () => {
    const s = makeState(100);
    const accepted = checkCircuitBreaker(s, 120, cfg); // 20% spike
    assert.equal(accepted, null);
  });

  it("does NOT update lastPrice on a blocked spike", () => {
    const s = makeState(100);
    checkCircuitBreaker(s, 120, cfg);
    assert.equal(s.lastPrice, 100); // baseline must be unchanged
  });

  it("increments circuitBreakerTrips on a blocked spike", () => {
    const s = makeState(100);
    checkCircuitBreaker(s, 120, cfg);
    assert.equal(s.circuitBreakerTrips, 1);
  });

  it("the spike that disappears (price returns to normal) resets the counter", () => {
    const s = makeState(100);
    // Trip 1
    checkCircuitBreaker(s, 120, cfg);
    assert.equal(s.cbConsecutiveTrips, 1);
    // Price returns to normal — resets the run
    checkCircuitBreaker(s, 102, cfg);
    assert.equal(s.cbConsecutiveTrips, 0);
    assert.equal(s.lastPrice, 100); // baseline unchanged
  });

  it("a spike that recurs only once (1 trip then normal) never reaches confirmTrips=3", () => {
    const s = makeState(100);
    checkCircuitBreaker(s, 120, cfg); // trip 1
    checkCircuitBreaker(s, 102, cfg); // normal — resets counter
    checkCircuitBreaker(s, 120, cfg); // trip 1 again (new run)
    assert.equal(s.cbConsecutiveTrips, 1);
    assert.equal(s.lastPrice, 100);
  });
});

// ── sustained relocation — wedge fix ─────────────────────────

describe("sustained relocation — un-wedge after confirmTrips (issue #30)", () => {
  it("blocks the first (confirmTrips - 1) trips", () => {
    const s = makeState(100);
    const r1 = checkCircuitBreaker(s, 120, cfg);
    const r2 = checkCircuitBreaker(s, 121, cfg);
    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.equal(s.lastPrice, 100); // not yet re-baselined
  });

  it("accepts on the Nth (= confirmTrips) consecutive consistent trip and re-baselines", () => {
    const s = makeState(100);
    checkCircuitBreaker(s, 120, cfg); // trip 1 — blocked
    checkCircuitBreaker(s, 121, cfg); // trip 2 — blocked
    const r3 = checkCircuitBreaker(s, 119, cfg); // trip 3 — confirmed
    assert.ok(r3, "3rd consistent trip must be accepted (relocation confirmed)");
    assert.ok(
      s.lastPrice >= 115 && s.lastPrice <= 125,
      `lastPrice must re-baseline near 120, got ${s.lastPrice}`,
    );
  });

  it("re-baselines to the confirming price, not the original", () => {
    const s = makeState(100);
    checkCircuitBreaker(s, 120, cfg);
    checkCircuitBreaker(s, 121, cfg);
    checkCircuitBreaker(s, 119, cfg); // confirms
    // After confirmation, subsequent pushes near 120 must be accepted without tripping
    const r4 = checkCircuitBreaker(s, 122, cfg);
    assert.ok(r4, "push near new baseline must be accepted");
    assert.equal(s.circuitBreakerTrips, 3); // no new trip
  });

  it("resets cbConsecutiveTrips and cbTripPrice after confirmation", () => {
    const s = makeState(100);
    checkCircuitBreaker(s, 120, cfg);
    checkCircuitBreaker(s, 121, cfg);
    checkCircuitBreaker(s, 119, cfg); // confirms
    assert.equal(s.cbConsecutiveTrips, 0);
    assert.equal(s.cbTripPrice, 0);
  });

  it("N-1 trips are not enough — the Nth trip is needed", () => {
    const s = makeState(100);
    // confirmTrips = 3, so 2 trips must not confirm
    checkCircuitBreaker(s, 120, cfg);
    const r2 = checkCircuitBreaker(s, 121, cfg);
    assert.equal(r2, null, "2nd trip must still be blocked (confirmTrips=3 not reached)");
    assert.equal(s.lastPrice, 100);
  });
});

// ── inconsistent spikes never confirm ────────────────────────

describe("inconsistent spikes — each at a different level, never confirm", () => {
  it("a run of different-level spikes resets each time and never confirms", () => {
    const s = makeState(100);
    // Each spike is far from the previous one — they break each other's run.
    checkCircuitBreaker(s, 120, cfg); // run starts at 120, cbConsecutive=1
    checkCircuitBreaker(s, 200, cfg); // >10% from 120 — new run at 200, cbConsecutive=1
    checkCircuitBreaker(s, 300, cfg); // >10% from 200 — new run at 300, cbConsecutive=1
    // Despite 3 trips, no run ever reached confirmTrips
    assert.equal(s.lastPrice, 100, "lastPrice must remain at original baseline");
    assert.equal(s.circuitBreakerTrips, 3);
  });
});

// ── confirmTrips = 1 edge case ────────────────────────────────

describe("confirmTrips = 1 (instant re-baseline on first trip)", () => {
  it("accepts the very first tripping price with confirmTrips=1", () => {
    const s = makeState(100);
    const r = checkCircuitBreaker(s, 120, { maxMovePct: 10, confirmTrips: 1, log: silent });
    assert.ok(r, "confirmTrips=1 — first trip should immediately re-baseline");
    assert.ok(s.lastPrice >= 115 && s.lastPrice <= 125);
  });
});

// ── #76 / #82 ────────────────────────────────────────────────────────────────

describe("#76 a republished last-known price must not clear a relocation run", () => {
  const cfg = { maxMovePct: 10, confirmTrips: 3, log: () => {} };
  const fresh = () => ({
    symbol: "T", lastPrice: 100, circuitBreakerTrips: 0,
    cbTripPrice: 0, cbConsecutiveTrips: 0,
  });

  it("an IDENTICAL price does not reset the run", () => {
    const s = fresh();
    checkCircuitBreaker(s, 130, cfg);            // trip 1 at the new level
    assert.equal(s.cbConsecutiveTrips, 1);
    checkCircuitBreaker(s, 100, cfg);            // republish of lastPrice
    assert.equal(
      s.cbConsecutiveTrips, 1,
      "a republish of the baseline is not a new observation and must not clear the run",
    );
  });

  it("a genuinely DIFFERENT in-threshold price still resets — #30's invariant holds", () => {
    const s = fresh();
    checkCircuitBreaker(s, 130, cfg);
    assert.equal(s.cbConsecutiveTrips, 1);
    checkCircuitBreaker(s, 105, cfg);            // real tick back at the normal level
    assert.equal(
      s.cbConsecutiveTrips, 0,
      "an intermittent spike must still be unable to accumulate to confirmTrips",
    );
  });
});

describe("#82 cumulative drift bound", () => {
  const base = { maxMovePct: 10, confirmTrips: 2, log: () => {} };
  const fresh = (lastPrice = 100): CircuitBreakerState => ({
    symbol: "T", lastPrice, circuitBreakerTrips: 0,
    cbTripPrice: 0, cbConsecutiveTrips: 0,
  });

  /** Walk one confirmed relocation toward `to`; returns the last result. */
  function relocate(s: CircuitBreakerState, to: number, cfg: typeof base & { now: () => number }) {
    // Emulates the caller: an accepted price becomes the baseline once pushed.
    let r: number | null = null;
    for (let i = 0; i < cfg.confirmTrips; i++) {
      r = checkCircuitBreaker(s, to, cfg);
      if (r !== null) s.lastPrice = r;
    }
    return r;
  }
  const close = (a: number | null, b: number) =>
    assert.ok(a !== null && Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`);

  it("allows a single confirmed relocation inside the bound", () => {
    const s = fresh();
    const cfg = { ...base, maxCumulativeMovePct: 30, now: () => 0 };
    assert.equal(relocate(s, 115, cfg), 115);
    assert.equal(s.lastPrice, 115);
  });

  it("RATE-LIMITS a walk past the bound to the bound edge, then holds for the window", () => {
    const s = fresh();
    const cfg = { ...base, maxCumulativeMovePct: 25, now: () => 0 };
    assert.equal(relocate(s, 115, cfg), 115, "first step is legal");
    // second step is legal on its own (115 -> 132 is ~15%) but cumulative from
    // the anchor 100 would be 32% > 25%: advance to the edge 125, not to 132.
    close(relocate(s, 132, cfg), 125);
    close(s.lastPrice, 125);
    // the window's budget is spent — further confirmations are refused
    assert.equal(relocate(s, 132, cfg), null);
    close(s.lastPrice, 125);
  });

  it("is a RATE limit, not a wedge — the walk completes after the window rolls", () => {
    const s = fresh();
    let t = 0;
    const cfg = { ...base, maxCumulativeMovePct: 25, driftWindowMs: 1000, now: () => t };
    relocate(s, 115, cfg);
    close(relocate(s, 132, cfg), 125);
    t = 2000;                                    // window rolls over
    assert.equal(relocate(s, 132, cfg), 132, "#30's un-wedging must survive");
    assert.equal(s.lastPrice, 132);
  });

  it("defaults to 3x maxMovePct when unset", () => {
    const s = fresh();
    const cfg = { ...base, now: () => 0 };       // default cumulative = 30%
    assert.equal(relocate(s, 115, cfg), 115);
    close(relocate(s, 132, cfg), 130);           // 32% from anchor -> clamped to +30%
  });
});

describe("#116 held moves past the cumulative bound converge (no re-anchoring wedge)", () => {
  const HOUR = 3_600_000;
  const fresh = (lastPrice: number): CircuitBreakerState => ({
    symbol: "T", lastPrice, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0,
  });
  /** Feed `price` once per `stepMs` for `durMs`; returns every accepted value. */
  function hold(s: CircuitBreakerState, price: number, clock: { t: number }, durMs: number, stepMs = 1_500) {
    const cfg = { maxMovePct: 10, confirmTrips: 3, log: () => {}, now: () => clock.t };
    const accepted: number[] = [];
    for (const end = clock.t + durMs; clock.t < end; clock.t += stepMs) {
      const r = checkCircuitBreaker(s, price, cfg);
      if (r !== null) { accepted.push(r); s.lastPrice = r; }
    }
    return accepted;
  }

  it("a held +100% move (KARDASHEV 553 -> 1108) converges one bound-width per window", () => {
    const s = fresh(553);
    const clock = { t: 0 };
    const first = hold(s, 1108, clock, HOUR - 60_000);
    assert.equal(first.length, 1, "exactly one step inside the first window");
    assert.ok(Math.abs(first[0] - 553 * 1.3) < 1e-9, `first step to the +30% edge, got ${first[0]}`);
    hold(s, 1108, clock, 2 * HOUR);
    assert.equal(s.lastPrice, 1108, "reaches the real price once the remainder fits the bound");
  });

  it("the same move was refused FOREVER without the rate limit (documents the wedge)", () => {
    // Guard against re-introducing it: after 5 hours we must be at the target.
    const s = fresh(215);
    const clock = { t: 0 };
    hold(s, 323, clock, 5 * HOUR);              // SOLCAT +50.2%
    assert.equal(s.lastPrice, 323);
  });

  it("clamps downward moves to the lower edge", () => {
    const s = fresh(100);
    const clock = { t: 0 };
    const steps = hold(s, 40, clock, 3 * HOUR);
    assert.ok(Math.abs(steps[0] - 70) < 1e-9, `first step to -30%, got ${steps[0]}`);
    assert.ok(Math.abs(steps[1] - 49) < 1e-9, `second window -30% again, got ${steps[1]}`);
    assert.equal(s.lastPrice, 40);
  });

  it("never publishes past anchor ± bound inside a window", () => {
    const s = fresh(100);
    const clock = { t: 0 };
    const cfg = { maxMovePct: 10, confirmTrips: 3, log: () => {}, now: () => clock.t };
    for (; clock.t < HOUR - 1; clock.t += 1_500) {
      const r = checkCircuitBreaker(s, 1_000, cfg); // attacker holds 10x
      if (r !== null) s.lastPrice = r;
      assert.ok(s.lastPrice <= 130 + 1e-9, `mark ${s.lastPrice} escaped the +30% bound`);
    }
  });

  it("a held +40% cannot overshoot the edge by one in-threshold step", () => {
    // After the clamp to 130, 140 is only 7.7% from the baseline — in-threshold.
    // Without bounding in-threshold steps inside the window the mark would reach
    // 140 (edge + one step) within seconds.
    const s = fresh(100);
    const clock = { t: 0 };
    const steps = hold(s, 140, clock, 3_600_000 - 60_000);
    assert.deepEqual(steps.map((x) => Math.round(x * 1e6) / 1e6), [130]);
    assert.ok(Math.abs(s.lastPrice - 130) < 1e-9);
    hold(s, 140, clock, 120_000);               // window rolls: in-threshold, accepted
    assert.equal(s.lastPrice, 140);
  });

  it("a spike that reverts before confirmTrips moves nothing", () => {
    const s = fresh(100);
    const cfg = { maxMovePct: 10, confirmTrips: 3, log: () => {}, now: () => 0 };
    assert.equal(checkCircuitBreaker(s, 500, cfg), null);
    assert.equal(checkCircuitBreaker(s, 500, cfg), null);
    assert.equal(checkCircuitBreaker(s, 101, cfg), 101); // reverts: run cleared
    assert.equal(checkCircuitBreaker(s, 500, cfg), null);
    assert.equal(s.lastPrice, 100);
    assert.equal(s.cbDriftAnchorPrice, undefined, "no relocation ever confirmed");
  });

  it("does not clamp BACKWARD when in-threshold steps already carried the baseline past the edge", () => {
    const s = fresh(150);                       // walked here by <10% steps
    s.cbDriftAnchorPrice = 100;
    s.cbDriftAnchorAt = 0;
    const cfg = { maxMovePct: 10, confirmTrips: 1, log: () => {}, now: () => 10 };
    assert.equal(checkCircuitBreaker(s, 200, cfg), null, "edge 130 is behind 150 — refuse, do not pull back");
    assert.equal(s.lastPrice, 150);
  });

  it("a clamped relocation can return to the anchor", () => {
    const s = fresh(100);
    const clock = { t: 0 };
    hold(s, 200, clock, 60_000);
    assert.ok(Math.abs(s.lastPrice - 130) < 1e-9);
    hold(s, 100, clock, 60_000);                // 23% back down, 0% from the anchor
    assert.equal(s.lastPrice, 100);
  });
});
