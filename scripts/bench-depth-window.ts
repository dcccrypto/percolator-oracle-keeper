// Bench: DepthSampleWindow record+minReserve. 500 pools x 200 rounds, median of 9 runs.
// Reports CPU time (user+system) so a loaded machine does not skew it.
// Run: node --import tsx/esm scripts/bench-depth-window.ts
import { DepthSampleWindow } from "../src/cross-cluster/depth-bracketing.js";

const POOLS = Array.from({ length: 500 }, (_, i) => `pool${i}`);
const ROUNDS = 200;
const RUNS = 9;

function once(): { ms: number; pairs: number; sink: bigint } {
  const w = new DepthSampleWindow();
  let sink = 0n;
  let pairs = 0;
  const c0 = process.cpuUsage();
  for (let r = 0; r < ROUNDS; r++) {
    const t = r * 1000;
    for (let p = 0; p < POOLS.length; p++) {
      const reserve = BigInt(1_000_000 + ((r * 7919 + p * 104729) % 500_000));
      w.record(POOLS[p], reserve, r % 2 ? "post" : "pre", t + 1000);
      sink += w.minReserve(POOLS[p], t) ?? 0n;
      pairs++;
    }
  }
  return { ms: (() => { const c = process.cpuUsage(c0); return (c.user + c.system) / 1000; })(), pairs, sink };
}

once(); // warm-up
const times: number[] = [];
let last = once();
for (let i = 0; i < RUNS; i++) {
  last = once();
  times.push(last.ms);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
const per100k = (median / last.pairs) * 100_000;
console.log(`pairs=${last.pairs} median=${median.toFixed(0)}ms per100k=${per100k.toFixed(0)}ms sink=${last.sink}`);
