/**
 * Bench: forceCloseResolvedLosers over 256 / 2k / 10k synthetic portfolio candidates (dry run, fake chain).
 * Reports the median of 3 runs for the current module and for the frozen pre-perf copy (.legacy.ts).
 * Usage: node --import tsx/esm scripts/bench-resolved-loser-sort.ts
 */
import { Keypair } from "@solana/web3.js";
import { forceCloseResolvedLosers, LoserForceCloseState } from "../src/cross-cluster/resolved-loser-force-close.ts";
import { forceCloseResolvedLosers as legacy } from "../src/cross-cluster/resolved-loser-force-close.legacy.ts";
import { CODEC, MARKET, NOW_SLOT, cfg, syntheticKeys, syntheticWorld } from "../src/cross-cluster/resolved-loser-force-close.synthetic.ts";

const RUNS = 3;
const keeper = Keypair.generate();

async function once(fn: typeof forceCloseResolvedLosers, n: number): Promise<number> {
  const keys = syntheticKeys(n);
  const w = syntheticWorld(keys);
  const t0 = process.hrtime.bigint();
  const r = await fn(w.conn as never, keeper, CODEC, MARKET, NOW_SLOT, true, cfg(), new LoserForceCloseState());
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.outcome === "failed") throw new Error(`bench pass failed: ${r.detail}`);
  return ms;
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

await once(forceCloseResolvedLosers, 256);
await once(legacy, 256); // warm-up
console.log("candidates | legacy ms (median of 3) | current ms (median of 3) | speedup");
for (const n of [256, 2000, 10000]) {
  const l: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    l.push(await once(legacy, n));
    c.push(await once(forceCloseResolvedLosers, n));
  }
  const lm = median(l);
  const cm = median(c);
  console.log(`${String(n).padStart(10)} | ${lm.toFixed(1).padStart(23)} | ${cm.toFixed(1).padStart(24)} | ${(lm / cm).toFixed(2)}x`);
}
