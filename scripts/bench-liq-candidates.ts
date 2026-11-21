/**
 * Bench: markLiquidationCandidates + fitLiquidations per liquidation round at 64/256/1024 positioned portfolios
 * (half below maintenance). Every round gets FRESH PublicKey objects (built outside the timer) so no per-object cache
 * can flatter the result. Reports median ns/round of 7 runs. Usage: npx tsx scripts/bench-liq-candidates.ts
 */
import { PublicKey } from "@solana/web3.js";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";
import { fitLiquidations, markLiquidationCandidates } from "../src/cross-cluster/v22/liquidation.ts";
import type { MarginParams } from "../src/cross-cluster/v22/liquidation.ts";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const params: MarginParams = {
  mmrBps: 500n,
  minNonzeroMmReq: 1n,
  assets: new Map([[0, { priceE6: 1_000_000n, rawTargetE6: 1_000_000n, aLong: 1n << 64n, aShort: 1n << 64n }]]),
};

function build(n: number, seed: number): PositionedPortfolio[] {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => {
    const b = new Uint8Array(32);
    for (let j = 0; j < 32; j++) b[j] = Math.floor(rng() * 256);
    const under = i % 2 === 0;
    // notional 1e6 atoms-ish; requirement 5%; equity below (under) or above
    const equity = under ? BigInt(Math.floor(rng() * 40_000)) : 60_000n + BigInt(Math.floor(rng() * 100_000));
    return {
      pubkey: new PublicKey(b),
      longLegs: 1 + (i % 3),
      shortLegs: 0,
      isLp: false,
      activeLegs: 1 + (i % 4),
      risk: { equity, legs: [{ assetIndex: 0, side: 0, basis: 1_000_000n, aBasis: 1n << 64n }] },
    } as PositionedPortfolio;
  });
}
const clone = (ps: PositionedPortfolio[]): PositionedPortfolio[] => ps.map((p) => ({ ...p, pubkey: new PublicKey(p.pubkey.toBytes()) }));

function round(ps: PositionedPortfolio[]): string {
  const { marked, candidates } = markLiquidationCandidates(ps, { params, padBps: 0 });
  const flagged = [...candidates.values()].map((p) => ({ portfolio: p, ratioBps: BigInt(Number(p.risk!.equity) % 50) }));
  const r = fitLiquidations({ flagged, baseCu: 100_000, maxPerTx: 1_000_000, maxCu: 1_000_000_000 });
  return `${marked.length}/${candidates.size}/${r.chosen.length}/${r.deferred.length}`;
}

for (const n of [64, 256, 1024]) {
  const base = build(n, 777 + n);
  const ITER = Math.max(20, Math.floor(20_000 / n));
  const runs: number[] = [];
  let sig = "";
  for (let r = 0; r < 8; r++) {
    const inputs = Array.from({ length: ITER }, () => clone(base));
    const t0 = process.hrtime.bigint();
    for (const ps of inputs) sig = round(ps);
    const ns = Number(process.hrtime.bigint() - t0) / ITER;
    if (r > 0) runs.push(ns); // run 0 = warm-up
  }
  runs.sort((a, b) => a - b);
  console.log(`n=${n} median ${(runs[3] / 1000).toFixed(1)} us/round (${runs[3].toFixed(0)} ns) sig=${sig}`);
}
