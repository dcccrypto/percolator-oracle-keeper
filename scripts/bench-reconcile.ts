/**
 * Bench: reconcileMarkets at N local = M desired, 0/1/10% churn (churn = that share of
 * desired replaced by new markets, and the same share of local dropped, at threshold 1 so they are removed).
 * Median of 20 runs. Usage: node --import tsx/esm scripts/bench-reconcile.ts
 */
import { reconcileMarkets } from "../src/cross-cluster/register-poll.js";
import type { MarketEntry } from "../src/cross-cluster/registry.js";

const RUNS = 20;
const mk = (i: number, pool = `p${i}`): MarketEntry =>
  ({ label: `m${i}`, marketAddress: `addr${i}`, poolAddress: pool, dexType: "raydium-clmm" }) as unknown as MarketEntry;

function once(n: number, churn: number): number {
  const k = Math.floor(n * churn);
  const local = Array.from({ length: n }, (_, i) => mk(i));
  const desired = Array.from({ length: n }, (_, i) => (i < n - k ? mk(i) : mk(n + i)));
  const reg = { markets: local };
  const t0 = process.hrtime.bigint();
  reconcileMarkets(reg, desired, new Map(), 1);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

for (const n of [500, 2000, 10000]) {
  for (const churn of [0, 0.01, 0.1]) {
    const xs = Array.from({ length: RUNS }, () => once(n, churn)).sort((a, b) => a - b);
    const med = (xs[9] + xs[10]) / 2;
    console.log(`N=M=${n} churn=${churn * 100}%  median ${med.toFixed(3)} ms`);
  }
}
