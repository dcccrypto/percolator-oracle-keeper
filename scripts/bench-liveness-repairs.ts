/** Bench: livenessRepairsFor over a v2.2 market fixture, slots 1 and 8, N=10k, median of 5. Run: npx tsx scripts/bench-liveness-repairs.ts */
import { livenessRepairsFor } from "../src/cross-cluster/v22/loop.ts";
import { v22MarketBytes } from "../src/cross-cluster/v22/test-helpers.ts";

const N = 10_000;
for (const slots of [1, 8]) {
  const data = v22MarketBytes({ slots, currentSlot: 50_000n });
  const ctx = { data, readSlot: 50_000, slots };
  for (let i = 0; i < 500; i++) livenessRepairsFor(ctx);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) livenessRepairsFor(ctx);
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  console.log(`livenessRepairsFor slots=${slots} N=${N} median=${runs[2].toFixed(1)}ms (${((runs[2] * 1000) / N).toFixed(2)}us/call)`);
}
