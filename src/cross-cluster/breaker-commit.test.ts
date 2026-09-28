import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptedPublishPrice, cloneCircuitBreakerState, splitBreakerCommit } from "./keeper-loop.ts";
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
    assert.equal(accepted, 101);
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
      if (ok === null) { persisted = candidate; continue; }  // rejected -> commit accounting
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
    const accepted = checkCircuitBreaker(candidate, price, { ...CFG, now: () => now });
    if (accepted === null) return { persisted: candidate, ok: false };
    // #116: publish (and re-baseline to) what the breaker ACCEPTED — a clamped
    // relocation accepts the bound edge, not `price`.
    const { commitNow, deferred } = splitBreakerCommit(persisted, candidate, accepted);
    return { persisted: pushLands ? deferred : commitNow, ok: true };
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

// #116 — the breaker can accept a CLAMPED price. runCycle must publish exactly
// that value (converted to E6 without crossing the bound), never the smoothed
// price the breaker was shown.
describe("acceptedPublishPrice — what runCycle publishes (#116)", () => {
  it("passes an unclamped price through bit-for-bit", () => {
    const r = acceptedPublishPrice(123_456_789n, 123.456789, 123.456789);
    assert.equal(r.priceE6, 123_456_789n);
    assert.equal(r.priceUsd, 123.456789);
  });

  it("rounds an upward clamp DOWN (toward the old baseline)", () => {
    // edge 0.000553 * 1.3 = 0.0007189 -> 718.9 e6 units -> 718, never 719
    const r = acceptedPublishPrice(1_108n, 0.001108, 0.000553 * 1.3);
    assert.equal(r.priceE6, 718n);
    assert.equal(r.priceUsd, 0.000718);
  });

  it("rounds a downward clamp UP (toward the old baseline)", () => {
    const r = acceptedPublishPrice(200n, 0.0002, 0.000553 * 0.7); // edge 387.1 above smoothed 200 -> 388
    assert.equal(r.priceE6, 388n);
  });

  it("never publishes zero", () => {
    assert.equal(acceptedPublishPrice(1n, 0.000001, 0.0000001).priceE6, 1n);
  });

  it("runCycle publishes and re-baselines to the breaker's accepted value", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("./keeper-loop.ts", import.meta.url), "utf8");
    assert.match(src, /acceptedUsd === null/);
    assert.match(src, /acceptedPublishPrice\(priceE6, priceUsd, acceptedUsd\)/);
    assert.match(src, /splitBreakerCommit\(\s*currentCircuitBreakerState,\s*candidateCircuitBreakerState,\s*publish\.priceUsd,?\s*\)/);
    assert.match(src, /priceE6: publish\.priceE6/);
    assert.match(src, /stat\.lastPriceE6 = publish\.priceE6/);
  });
});
