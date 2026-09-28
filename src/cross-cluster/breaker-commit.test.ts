import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloneCircuitBreakerState, splitBreakerCommit } from "./keeper-loop.ts";
import { checkCircuitBreaker, type CircuitBreakerState } from "../circuit-breaker.ts";

const CFG = { maxMovePct: 10, confirmTrips: 3, log: () => {} };
const st = (lastPrice: number): CircuitBreakerState => ({
  symbol: "T", lastPrice, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0,
});
const clone = (s: CircuitBreakerState): CircuitBreakerState => ({ ...s });

describe("splitBreakerCommit — trip accounting must survive a dropped push", () => {
  it("commits the accepted trip reset immediately, defers only lastPrice", () => {
    const current = st(100);
    current.cbConsecutiveTrips = 2;          // two spikes already counted
    const candidate = clone(current);
    const accepted = checkCircuitBreaker(candidate, 101, CFG); // normal level -> accept
    assert.equal(accepted, true);
    assert.equal(candidate.cbConsecutiveTrips, 0, "checkCircuitBreaker resets on accept");

    const { commitNow, deferred } = splitBreakerCommit(current, candidate, 101);

    // the reset is committed even though nothing has been pushed yet
    assert.equal(commitNow.cbConsecutiveTrips, 0);
    // ...but the baseline has NOT advanced
    assert.equal(commitNow.lastPrice, 100);
    // the deferred copy carries the new baseline for use after a confirmed push
    assert.equal(deferred.lastPrice, 101);
    assert.equal(deferred.cbConsecutiveTrips, 0);
  });

  it("a spike cannot accumulate to confirmTrips across dropped pushes", () => {
    // Model the live failure: pushes keep getting dropped (~1 cycle in 5 here),
    // so only `commitNow` is ever persisted. The invariant must still hold.
    let persisted = st(100);
    for (let cycle = 0; cycle < 12; cycle++) {
      const spikeThenNormal = cycle % 2 === 0 ? 500 : 101; // alternating spike / normal
      const candidate = clone(persisted);
      const ok = checkCircuitBreaker(candidate, spikeThenNormal, CFG);
      if (!ok) { persisted = candidate; continue; }          // rejected -> commit accounting
      const { commitNow } = splitBreakerCommit(persisted, candidate, spikeThenNormal);
      persisted = commitNow;                                  // push DROPPED: only this lands
    }
    assert.ok(
      persisted.cbConsecutiveTrips < CFG.confirmTrips,
      `spike accumulated to ${persisted.cbConsecutiveTrips}; breaker would re-baseline onto a bad price`,
    );
    assert.equal(persisted.lastPrice, 100, "baseline never advanced without a confirmed push");
  });
});

// #82 drift anchor through the keeper-loop commit protocol. The breaker's own
// tests hold one state object across calls, so they cannot see a field that the
// keeper drops between cycles. These run every price through the same
// clone -> check -> split -> commit sequence as runCycle().
describe("drift anchor survives the keeper-loop commit protocol (#82)", () => {
  const cycle = (persisted: CircuitBreakerState, price: number, now: number, pushLands = true) => {
    const candidate = cloneCircuitBreakerState(persisted); // runCycle: per market, per cycle
    const ok = checkCircuitBreaker(candidate, price, { ...CFG, now: () => now });
    if (!ok) return { persisted: candidate, ok };
    const { commitNow, deferred } = splitBreakerCommit(persisted, candidate, price);
    return { persisted: pushLands ? deferred : commitNow, ok };
  };

  it("cloneCircuitBreakerState copies every field", () => {
    const full: Required<CircuitBreakerState> = {
      symbol: "T", lastPrice: 125, circuitBreakerTrips: 7, cbTripPrice: 156,
      cbConsecutiveTrips: 2, cbDriftAnchorPrice: 100, cbDriftAnchorAt: 1_000,
    };
    assert.deepEqual(cloneCircuitBreakerState(full), full);
  });

  it("splitBreakerCommit carries the anchor opened by a confirmed relocation", () => {
    let s = st(100);
    for (let i = 0; i < 3; i++) s = cycle(s, 125, 1_000 + i).persisted;
    assert.equal(s.lastPrice, 125, "relocation confirmed and pushed");
    assert.equal(s.cbDriftAnchorPrice, 100);
    assert.equal(s.cbDriftAnchorAt, 1_002);
  });

  it("a staircase of legal relocations is bounded cumulatively inside the window", () => {
    // 25% steps: each is a legal single relocation (under the 30% default
    // cumulative bound); the second takes the walk 56% from the anchor.
    let s = st(100);
    let t = 0;
    const hold = (price: number, cycles: number, pushLands = true) => {
      let accepted = false;
      for (let i = 0; i < cycles; i++, t += 7_000) {
        const r = cycle(s, price, t, pushLands);
        s = r.persisted;
        accepted ||= r.ok;
      }
      return accepted;
    };
    // Asserts the BOUND (baseline within 30% of the anchor), not HOW it is
    // enforced: refusing (current) and clamping to the edge (#2) both satisfy it.
    const EDGE = 100 * 1.3;
    assert.equal(hold(125, 3), true);
    assert.equal(s.lastPrice, 125);
    hold(156, 30);
    assert.ok(s.lastPrice <= EDGE, `walk re-baselined to ${s.lastPrice}, 56% from the anchor inside one window`);
    hold(156, 5, false);
    assert.ok(s.lastPrice <= EDGE, "a dropped push must not lose the anchor");
    assert.equal(s.cbDriftAnchorPrice, 100);
    // Rate limit, not a ceiling: after the window rolls over the same step confirms.
    t += 3_600_000;
    assert.equal(hold(156, 3), true);
    assert.equal(s.lastPrice, 156);
  });
});
