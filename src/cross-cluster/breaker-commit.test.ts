import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitBreakerCommit } from "./keeper-loop.ts";
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
