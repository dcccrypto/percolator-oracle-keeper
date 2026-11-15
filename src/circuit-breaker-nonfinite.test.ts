import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCircuitBreaker, type CircuitBreakerState } from "./circuit-breaker.ts";

function mk(lastPrice = 100): CircuitBreakerState {
  return { symbol: "T", lastPrice, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0 };
}

function drive(price: number, checks: number, stepMs: number) {
  const s = mk();
  let t = 1_000_000;
  const out: Array<number | null> = [];
  for (let i = 0; i < checks; i++) {
    out.push(checkCircuitBreaker(s, price, {
      maxMovePct: 10, confirmTrips: 3, sustainedRelocationMs: 300_000,
      now: () => t, log: () => {},
    }));
    t += stepMs;
  }
  return { s, out };
}

describe("circuit breaker: non-finite / non-positive source on sustained path", () => {
  for (const [name, p] of [["NaN", NaN], ["zero", 0], ["negative", -5], ["Infinity", Infinity]] as const) {
    it(`${name} source is never published`, () => {
      const { s, out } = drive(p, 40, 30_000);
      const bad = out.filter((x) => x !== null && !(Number.isFinite(x) && x > 0));
      assert.deepEqual(bad, [], `published ${String(bad[0])}; lastPrice=${s.lastPrice}`);
      assert.ok(Number.isFinite(s.lastPrice) && s.lastPrice > 0);
    });
  }
});
