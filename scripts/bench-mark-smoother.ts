/**
 * Bench: createMarkSmoother().smooth over 200 pools x 500 cycles at 3 s steps
 * (100k calls). Reports the median of 5 runs. Usage: npx tsx scripts/bench-mark-smoother.ts
 */
import { createMarkSmoother } from "../src/cross-cluster/mark-smoother.js";

const POOLS = 200;
const CYCLES = 500;
const STEP_MS = 3000;
const RUNS = 5;

// Deterministic LCG so every run (and before/after) sees identical inputs.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function once(): { ms: number; checksum: bigint } {
  const rng = makeRng(12345);
  const sm = createMarkSmoother({});
  const addrs = Array.from({ length: POOLS }, (_, i) => `pool${i}`);
  const px = addrs.map((_, i) => 1_000_000n + BigInt(i) * 1000n);
  let checksum = 0n;
  const t0 = process.hrtime.bigint();
  for (let c = 0; c < CYCLES; c++) {
    const now = 1_700_000_000_000 + c * STEP_MS;
    for (let p = 0; p < POOLS; p++) {
      px[p] += BigInt(Math.floor((rng() - 0.5) * 2000));
      const r = sm.smooth(addrs[p], px[p], now);
      if (r !== null) checksum += r;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, checksum };
}

once(); // warm-up
const times: number[] = [];
let sum = 0n;
for (let i = 0; i < RUNS; i++) {
  const r = once();
  times.push(r.ms);
  sum = r.checksum;
}
times.sort((a, b) => a - b);
const median = times[Math.floor(RUNS / 2)];
console.log(
  `runs(ms)=${times.map((t) => t.toFixed(0)).join(",")} median=${median.toFixed(0)}ms ` +
    `per-call=${((median * 1000) / (POOLS * CYCLES)).toFixed(2)}us checksum=${sum}`,
);
