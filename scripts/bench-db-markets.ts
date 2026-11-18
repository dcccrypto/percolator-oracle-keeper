/**
 * Bench: capMarketRows and rowsToEntries over 2k and 10k synthetic rows (mixed null/invalid
 * created_at, 20 deployers). Median of 5 runs, ns/op = ns per row.
 * Usage: node --import tsx scripts/bench-db-markets.ts
 */
import { capMarketRows, rowsToEntries, type DbMarketRow, type DexCache } from "../src/cross-cluster/db-markets.ts";

const RUNS = 5;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function makeRows(n: number, seed = 42): DbMarketRow[] {
  const rng = makeRng(seed);
  const rows: DbMarketRow[] = [];
  for (let i = 0; i < n; i++) {
    const k = rng();
    const created_at =
      k < 0.1 ? null : k < 0.2 ? "not-a-date" : new Date(1_700_000_000_000 + Math.floor(rng() * 1e9)).toISOString();
    rows.push({
      slab_address: `slab${Math.floor(rng() * 1e9).toString(36).padStart(8, "0")}${i}`,
      dex_pool_address: `pool${i}`,
      symbol: `S${i}`,
      mint_address: `mint${i}`,
      mainnet_ca: null,
      deployer: `dep${Math.floor(rng() * 20)}`,
      created_at,
    });
  }
  return rows;
}

function median(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

const warn = console.warn;
console.warn = () => {};
for (const n of [2000, 10000]) {
  const rows = makeRows(n);
  const dex: DexCache = new Map(rows.map((r) => [r.dex_pool_address as string, "raydium" as never]));
  const caps = { maxTotal: n, maxPerDeployer: n };
  const time = (f: () => unknown) => {
    f();
    const t: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      f();
      t.push(Number(process.hrtime.bigint() - t0));
    }
    return median(t);
  };
  const cap = time(() => capMarketRows(rows, caps));
  const ent = time(() => rowsToEntries(rows, dex));
  console.log(
    `n=${n} capMarketRows ${(cap / 1e6).toFixed(2)} ms (${(cap / n).toFixed(0)} ns/op) | ` +
      `rowsToEntries ${(ent / 1e6).toFixed(2)} ms (${(ent / n).toFixed(0)} ns/op)`,
  );
}
console.warn = warn;
