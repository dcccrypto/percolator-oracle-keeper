/**
 * Differential test: the optimised circuit breaker must behave exactly like the
 * frozen pre-optimisation copy (circuit-breaker-reference.fixture.ts) on a
 * seeded stream — same returned price, same stored state (deep-equal) and same
 * log lines at EVERY step, including the caller-side commit pattern.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as neu from "./circuit-breaker.js";
import * as old from "./circuit-breaker-reference.fixture.js";
import { buildStream } from "./circuit-breaker.bench.js";

function replay(
  mod: typeof neu,
  stream: number[][],
  extra: Partial<neu.CircuitBreakerConfig>,
  trace: (m: number, s: number, out: number | null, st: neu.CircuitBreakerState, logs: string[]) => void,
): void {
  const states: neu.CircuitBreakerState[] = stream.map((_, i) => ({
    symbol: `M${i}`, lastPrice: 0, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0,
  }));
  let t = 1_700_000_000_000;
  let logs: string[] = [];
  const cfg = { maxMovePct: 10, confirmTrips: 3, now: () => t, log: (m: string) => { logs.push(m); }, ...extra };
  for (let s = 0; s < stream[0].length; s++) {
    t += 5_000;
    for (let m = 0; m < stream.length; m++) {
      const st = states[m];
      logs = [];
      const out = mod.checkCircuitBreaker(st, stream[m][s], cfg);
      trace(m, s, out, st, logs);
      if (out === null) continue;
      if (st.lastPrice === 0) {
        st.lastPrice = out;
        mod.recordMarkInForce(st, out, t);
      } else if (out !== st.lastPrice) {
        mod.recordMarkInForce(st, st.lastPrice, t);
        st.lastPrice = out;
        mod.recordMarkInForce(st, out, t);
      }
    }
  }
}

for (const [name, extra, samples] of [
  ["default config", {}, 300],
  ["short window (exercises pruning)", { driftWindowMs: 60_000 }, 300],
  ["sustained relocation on", { sustainedRelocationMs: 120_000, sustainedRelocationMinChecks: 5 }, 300],
  ["tight band + confirmTrips 1", { maxCumulativeMovePct: 12, confirmTrips: 1, driftWindowMs: 300_000 }, 300],
] as Array<[string, Partial<neu.CircuitBreakerConfig>, number]>) {
  test(`differential: ${name} — identical decisions, state and logs at every step`, () => {
    const stream = buildStream(40, samples, 4242);
    const recorded: string[] = [];
    replay(old as unknown as typeof neu, stream, extra, (m, s, out, st, logs) => {
      recorded.push(JSON.stringify([out, st, logs]));
    });
    let i = 0;
    let steps = 0;
    replay(neu, stream, extra, (m, s, out, st, logs) => {
      assert.equal(JSON.stringify([out, st, logs]), recorded[i], `step ${i} (market ${m}, sample ${s})`);
      i++;
      steps++;
    });
    assert.equal(steps, 40 * samples);
    assert.ok(recorded.some((r) => JSON.parse(r)[2].length > 0), "stream must exercise log/trip paths");
  });
}

test("recordMarkInForce never mutates a previously captured deque; out-of-order time matches reference", () => {
  for (const mod of [neu, old as unknown as typeof neu]) {
    const st: neu.CircuitBreakerState = { symbol: "X", lastPrice: 100, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0 };
    mod.recordMarkInForce(st, 100, 1000);
    mod.recordMarkInForce(st, 90, 2000);
    const maxBefore = st.cbWindowMax;
    const snap = JSON.stringify(maxBefore);
    mod.recordMarkInForce(st, 120, 500); // out of order, dominates
    assert.equal(JSON.stringify(maxBefore), snap);
    assert.notEqual(st.cbWindowMax, maxBefore);
  }
  const a: neu.CircuitBreakerState = { symbol: "X", lastPrice: 1, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0 };
  const b = { ...a };
  for (const [p, t] of [[100, 1000], [NaN, 1500], [0, 1600], [-5, 1700], [90, 500], [100, 2000], [Infinity, 2100]] as Array<[number, number]>) {
    neu.recordMarkInForce(a, p, t);
    old.recordMarkInForce(b, p, t);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  }
});
