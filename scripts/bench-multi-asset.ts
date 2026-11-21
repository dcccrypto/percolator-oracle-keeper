/**
 * Bench of the per-cycle multi-asset work: refreshStateForMarket (N-asset decode) + sampleAssetAccrual +
 * observationAssetsFor, on a synthetic market with 1 / 16 / 64 asset slots, 10,000 iterations, median of 5 runs.
 *
 *   node --import tsx/esm scripts/bench-multi-asset.ts [path-to-multi-asset-module]
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { layoutById, marketAccountLen, ABS_WRAPPER_VERSION, ABS_MAX_MARKET_SLOTS } from "../src/cross-cluster/market-layout.ts";
import type { MarketEntry } from "../src/cross-cluster/registry.ts";

const modPath = process.argv[2] ?? "../src/cross-cluster/multi-asset.ts";
const url = modPath.startsWith(".") ? new URL(modPath, import.meta.url).href : pathToFileURL(resolve(modPath)).href;
const M = (await import(url)) as typeof import("../src/cross-cluster/multi-asset.ts");

export function syntheticMarket(slots: number): Buffer {
  const l = layoutById("v2.2-drift");
  const b = Buffer.alloc(marketAccountLen(l, slots));
  b.writeUInt16LE(l.wrapperVersion, ABS_WRAPPER_VERSION);
  b.writeUInt32LE(slots, ABS_MAX_MARKET_SLOTS);
  let seed = 12345;
  for (let i = l.groupOff + 64; i < b.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 7 === 0) b[i] = seed & 0xff;
  }
  return b;
}

const ITER = 10_000;
const MARKET = "BenchMarket1111111111111111111111111111111111";
for (const n of [1, 16, 64]) {
  const data = syntheticMarket(n);
  const assets = Array.from({ length: Math.min(n, 16) }, (_, i) => i);
  const entry: MarketEntry = {
    label: "bench",
    marketAddress: MARKET,
    assetIndex: 0,
    lpPortfolio: "x",
    ...(n > 1 ? { assets: assets.map((i) => ({ assetIndex: i, source: "fixed" as const, fixedPriceE6: "1000000" })) } : {}),
  } as MarketEntry;
  M.bindObservationRegistry(() => [entry]);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      try {
        M.refreshStateForMarket(data, MARKET);
      } catch {
        /* synthetic data may not decode asset 0 */
      }
      M.sampleAssetAccrual(data, M.observationAssetsFor(MARKET), 100n, 0);
    }
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  console.log(`assets=${n} observed=${assets.length} median_ms=${runs[2].toFixed(1)} runs=${runs.map((x) => x.toFixed(0)).join(",")}`);
}
