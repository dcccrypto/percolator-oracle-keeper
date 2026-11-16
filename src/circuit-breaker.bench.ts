/**
 * Micro-benchmark for the circuit breaker. Run:
 *   node --expose-gc --import tsx src/circuit-breaker.bench.ts
 * 1,000 markets x 200 samples, fixed seed, 5 runs, median ms + heap delta.
 */
import { checkCircuitBreaker, recordMarkInForce, type CircuitBreakerState } from "./circuit-breaker.js";

const MARKETS = 1000;
const SAMPLES = 200;
const RUNS = 5;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic stream: mostly small steps, occasional spikes and relocations. */
export function buildStream(markets: number, samples: number, seed = 1337): number[][] {
  const rnd = mulberry32(seed);
  const out: number[][] = [];
  for (let m = 0; m < markets; m++) {
    let p = 1 + rnd() * 1000;
    const row: number[] = [];
    for (let s = 0; s < samples; s++) {
      const r = rnd();
      if (r < 0.002) p *= 1 + (rnd() - 0.5) * 0.8; // spike / relocation
      else p *= 1 + (rnd() - 0.5) * 0.02;
      row.push(p);
    }
    out.push(row);
  }
  return out;
}

export function run(stream: number[][]): { decisions: number; trips: number; logs: number } {
  const states: CircuitBreakerState[] = stream.map((_, i) => ({
    symbol: `M${i}`,
    lastPrice: 0,
    circuitBreakerTrips: 0,
    cbTripPrice: 0,
    cbConsecutiveTrips: 0,
  }));
  let t = 1_700_000_000_000;
  const cfg = { maxMovePct: 10, confirmTrips: 3, now: () => t, log: () => { logs++; } };
  let decisions = 0;
  let logs = 0;
  for (let s = 0; s < stream[0].length; s++) {
    t += 5_000;
    for (let m = 0; m < stream.length; m++) {
      const st = states[m];
      const out = checkCircuitBreaker(st, stream[m][s], cfg);
      decisions++;
      if (out !== null) {
        if (st.lastPrice === 0) {
          st.lastPrice = out;
          recordMarkInForce(st, out, t);
        } else if (out !== st.lastPrice) {
          recordMarkInForce(st, st.lastPrice, t);
          st.lastPrice = out;
          recordMarkInForce(st, out, t);
        }
      }
    }
  }
  return { decisions, trips: states.reduce((a, s) => a + s.circuitBreakerTrips, 0), logs };
}

if (process.argv[1]?.endsWith("circuit-breaker.bench.ts")) {
  const stream = buildStream(MARKETS, SAMPLES);
  const g = (globalThis as { gc?: () => void }).gc;
  run(stream); // warm-up
  const times: number[] = [];
  const heaps: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    g?.();
    const h0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = run(stream);
    times.push(performance.now() - t0);
    heaps.push(process.memoryUsage().heapUsed - h0);
    if (i === 0) console.log(`decisions=${r.decisions} trips=${r.trips} logs=${r.logs}`);
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`runs ms: ${times.map((x) => x.toFixed(1)).join(", ")}`);
  console.log(`median ms: ${med(times).toFixed(1)}  (heap delta incl. retained state, median MB: ${(med(heaps) / 1e6).toFixed(1)})`);
}
