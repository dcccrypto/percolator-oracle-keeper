/**
 * Bench: cloneCircuitBreakerState + checkCircuitBreaker, 50 markets x 3600
 * rising prices (+0.01%, +1 s per step). Median of 5. Usage: npx tsx scripts/bench-circuit-breaker.ts
 */
import { checkCircuitBreaker, type CircuitBreakerState } from "../src/circuit-breaker.ts";
import { checkCircuitBreaker as frozenCheck } from "../src/test-fixtures/circuit-breaker.frozen.ts";
import { cloneCircuitBreakerState } from "../src/cross-cluster/keeper-loop.ts";

const MARKETS = 50;
const N = Number(process.env.BENCH_N ?? 3600);
const RUNS = 5;

function oldClone(s: CircuitBreakerState): CircuitBreakerState {
  const c: CircuitBreakerState = { ...s };
  if (s.cbWindowMax) c.cbWindowMax = s.cbWindowMax.slice();
  if (s.cbWindowMin) c.cbWindowMin = s.cbWindowMin.slice();
  return c;
}

function once(old: boolean): { ms: number; checksum: number } {
  const states: CircuitBreakerState[] = Array.from({ length: MARKETS }, () => ({ lastPrice: 0 }) as CircuitBreakerState);
  const px = states.map((_, i) => 1 + i);
  let checksum = 0;
  let now = 1_700_000_000_000;
  const cfg = { maxMovePct: 50, confirmTrips: 3, now: () => now, log: () => {} };
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    now += 1000;
    for (let m = 0; m < MARKETS; m++) {
      px[m] *= 1.0001;
      const cand = old ? oldClone(states[m]) : cloneCircuitBreakerState(states[m]);
      const r = (old ? frozenCheck : checkCircuitBreaker)(cand, px[m], cfg);
      if (r !== null) { states[m] = { ...cand, lastPrice: r }; checksum += r; }
      else states[m] = cand;
    }
  }
  return { ms: performance.now() - t0, checksum };
}
for (const old of [true, false]) {
  once(old);
  const runs = Array.from({ length: RUNS }, () => once(old));
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${old ? "old" : "new"} median ${ms[2].toFixed(1)} ms (runs: ${ms.map((x) => x.toFixed(0)).join(", ")}) checksum ${runs[0].checksum.toFixed(6)}`);
}
