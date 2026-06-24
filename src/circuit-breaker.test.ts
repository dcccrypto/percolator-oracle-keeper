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
    assert.equal(accepted, false);
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
    assert.equal(r1, false);
    assert.equal(r2, false);
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
    assert.equal(r2, false, "2nd trip must still be blocked (confirmTrips=3 not reached)");
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
