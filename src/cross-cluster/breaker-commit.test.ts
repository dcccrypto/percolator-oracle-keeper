import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acceptedPublishPrice, cloneCircuitBreakerState, commitPublishedBreakerState, splitBreakerCommit,
} from "./keeper-loop.ts";
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

// #82 / #125 trailing-window bound through the keeper-loop commit protocol. The
// breaker's own tests hold one state object across calls, so they cannot see a
// field that the keeper drops between cycles. These run every price through the
// same clone -> check -> split -> commit-on-land sequence as runCycle().
describe("trailing-window bound survives the keeper-loop commit protocol (#82, #125)", () => {
  const cycle = (persisted: CircuitBreakerState, price: number, now: number, pushLands = true, landMs = 400) => {
    const candidate = cloneCircuitBreakerState(persisted); // runCycle: per market, per cycle
    const accepted = checkCircuitBreaker(candidate, price, { ...CFG, now: () => now });
    if (accepted === null) return { persisted: candidate, ok: false };
    // #116: publish (and re-baseline to) what the breaker ACCEPTED — a clamped
    // relocation accepts the bound edge, not `price`.
    const { commitNow, deferred } = splitBreakerCommit(persisted, candidate, accepted);
    return {
      persisted: pushLands ? commitPublishedBreakerState(commitNow, deferred, now + landMs) : commitNow,
      ok: true,
    };
  };

  it("cloneCircuitBreakerState copies every field, and does not alias the window arrays", () => {
    const full: Required<CircuitBreakerState> = {
      symbol: "T", lastPrice: 125, circuitBreakerTrips: 7, cbTripPrice: 156,
      cbConsecutiveTrips: 2,
      cbWindowMax: [{ price: 125, at: 1_000 }],
      cbWindowMin: [{ price: 100, at: 900 }, { price: 125, at: 1_000 }],
    };
    const c = cloneCircuitBreakerState(full);
    assert.deepEqual(c, full);
    assert.notEqual(c.cbWindowMax, full.cbWindowMax);
    assert.notEqual(c.cbWindowMin, full.cbWindowMin);
  });

  it("commitPublishedBreakerState keeps the replaced mark in the window until it actually stopped being in force", () => {
    // The check runs at t=0; the push lands at t=5s. The old mark 100 was on
    // chain until 5s, so it must bind until 5s + W — not 0 + W.
    const W = 3_600_000;
    const current: CircuitBreakerState = { ...st(100) };
    const candidate = cloneCircuitBreakerState(current);
    const accepted = checkCircuitBreaker(candidate, 108, { ...CFG, now: () => 0 });
    assert.equal(accepted, 108);
    const { commitNow, deferred } = splitBreakerCommit(current, candidate, 108);
    const landed = commitPublishedBreakerState(commitNow, deferred, 5_000);
    assert.equal(landed.lastPrice, 108);
    // at 0 + W + 1s the check-time record of 100 has expired, the landing-time one has not
    const probe = cloneCircuitBreakerState(landed);
    probe.lastPrice = 130; // pretend we walked up to 130 since
    assert.equal(
      checkCircuitBreaker(probe, 135, { ...CFG, confirmTrips: 1, now: () => W + 1_000 }),
      null,
      "100 was in force until 5s — 135 is +35% from it inside the window",
    );
    assert.equal(checkCircuitBreaker(probe, 135, { ...CFG, confirmTrips: 1, now: () => W + 5_001 }), 135);
  });

  it("in-threshold creep is bounded through the protocol, with and without dropped pushes", () => {
    for (const dropEvery of [0, 5]) {
      let s = st(100);
      let n = 0;
      for (let t = 0; t < 3_600_000; t += 1_500) {
        const pushLands = dropEvery === 0 || ++n % dropEvery !== 0;
        s = cycle(s, 100 * 1.01 ** Math.floor(t / 1_500), t, pushLands).persisted;
        assert.ok(s.lastPrice <= 130 + 1e-9, `creep escaped to ${s.lastPrice} (drop 1/${dropEvery})`);
      }
    }
  });

  it("a staircase of legal relocations is bounded cumulatively inside the window", () => {
    // 25% steps: each is a legal single relocation (under the 30% default
    // cumulative bound); the second takes the walk 56% from the start.
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
    const EDGE = 100 * 1.3;
    assert.equal(hold(125, 3), true);
    assert.equal(s.lastPrice, 125);
    hold(156, 30);
    assert.ok(s.lastPrice <= EDGE, `walk re-baselined to ${s.lastPrice}, 56% from 100 inside one window`);
    hold(156, 5, false);
    assert.ok(s.lastPrice <= EDGE, "a dropped push must not lose the window");
    assert.equal(s.cbWindowMin?.[0].price, 100);
    // Rate limit, not a ceiling: once 100 leaves the trailing window the step confirms.
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
    // #125: a landed push commits through commitPublishedBreakerState at the landing stamp.
    assert.match(src, /commitPublishedBreakerState\(\s*crossClusterCircuitBreakerStates\.get\(p\.marketAddress\),\s*pendingCircuitBreakerState,\s*stamp,?\s*\)/);
  });
});
