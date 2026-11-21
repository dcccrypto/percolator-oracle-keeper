import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCircuitBreaker, recordMarkInForce, type CircuitBreakerState } from "./circuit-breaker.ts";
import {
  checkCircuitBreaker as oldCheck,
  recordMarkInForce as oldRecord,
} from "./test-fixtures/circuit-breaker.frozen.ts";
import { cloneCircuitBreakerState } from "./cross-cluster/keeper-loop.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function oldClone(s: CircuitBreakerState): CircuitBreakerState {
  const c: CircuitBreakerState = { ...s };
  if (s.cbWindowMax) c.cbWindowMax = s.cbWindowMax.slice();
  if (s.cbWindowMin) c.cbWindowMin = s.cbWindowMin.slice();
  return c;
}

test("10k random walks: new breaker matches frozen old implementation", () => {
  let mismatches = 0;
  for (let w = 0; w < 10_000; w++) {
    const r = rng(w + 1);
    let now = 1_700_000_000_000;
    const cfg = {
      maxMovePct: 1 + r() * 10,
      confirmTrips: 1 + Math.floor(r() * 4),
      driftWindowMs: 20_000 + Math.floor(r() * 60_000),
      now: () => now,
      log: () => {},
    };
    let a: CircuitBreakerState = { lastPrice: 0 } as CircuitBreakerState;
    let b: CircuitBreakerState = { lastPrice: 0 } as CircuitBreakerState;
    let px = 1 + r() * 100;
    const steps = 20 + Math.floor(r() * 80);
    for (let k = 0; k < steps; k++) {
      now += Math.floor(r() * 5000);
      const jump = r() < 0.1 ? (r() - 0.5) * 0.6 : (r() - 0.5) * 0.04;
      px = Math.max(0.0001, px * (1 + jump));
      const ca = cloneCircuitBreakerState(a);
      const cb = oldClone(b);
      const ra = checkCircuitBreaker(ca, px, cfg);
      const rb = oldCheck(cb, px, cfg);
      const reject = r() < 0.2; // exercise the rollback path: candidate discarded
      if (!reject) { a = ca; b = cb; }
      if (r() < 0.1) {
        recordMarkInForce(a, px, now);
        oldRecord(b, px, now);
      }
      try {
        assert.equal(ra, rb);
        assert.deepStrictEqual(a, b);
      } catch {
        mismatches++;
        break;
      }
    }
  }
  assert.equal(mismatches, 0);
});

test("clone does not alias: mutating a candidate leaves the source untouched", () => {
  const now = 1_700_000_000_000;
  const s: CircuitBreakerState = { lastPrice: 10 } as CircuitBreakerState;
  recordMarkInForce(s, 10, now);
  recordMarkInForce(s, 10.5, now + 1000);
  const snap = JSON.stringify(s);
  const c = cloneCircuitBreakerState(s);
  checkCircuitBreaker(c, 10.4, { maxMovePct: 50, confirmTrips: 1, now: () => now + 2000, log: () => {} });
  recordMarkInForce(c, 11, now + 3000);
  assert.equal(JSON.stringify(s), snap);
  // a plain spread (non-owner) must not let writes leak back either
  const sp = { ...c };
  const before = JSON.stringify(c);
  recordMarkInForce(sp, 12, now + 4000);
  assert.equal(JSON.stringify(c), before);
});

test("snapshots taken with cloneCircuitBreakerState stay frozen while the original is written", () => {
  const now = 1_700_000_000_000;
  const s: CircuitBreakerState = { lastPrice: 10 } as CircuitBreakerState;
  recordMarkInForce(s, 10, now);
  const c = cloneCircuitBreakerState(s);
  const snap = cloneCircuitBreakerState(c);
  const before = JSON.stringify(snap);
  recordMarkInForce(c, 12, now + 1000);
  assert.equal(JSON.stringify(snap), before);
});
