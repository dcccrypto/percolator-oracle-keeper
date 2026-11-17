/**
 * Bench: planSettleRound for N = 100 / 1,000 / 5,000 synthetic portfolios, median ms of 20 runs, per mode.
 * Usage: node --import tsx/esm scripts/bench-settle-plan.ts
 */
import { PublicKey } from "@solana/web3.js";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function synth(n: number, seed: number): PositionedPortfolio[] {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => {
    const b = new Uint8Array(32);
    for (let j = 0; j < 32; j++) b[j] = Math.floor(rng() * 256);
    const r = rng();
    const longLegs = r < 0.6 ? 1 : r < 0.8 ? 0 : 1 + Math.floor(rng() * 2);
    const shortLegs = r < 0.6 ? 0 : r < 0.8 ? 1 : Math.floor(rng() * 3);
    const p: PositionedPortfolio = { pubkey: new PublicKey(b), longLegs, shortLegs, isLp: false };
    if (rng() < 0.7) p.activeLegs = Math.min(4, longLegs + shortLegs + Math.floor(rng() * 2));
    if (rng() < 0.7) p.lossWeight = BigInt(Math.floor(rng() * 20)) * 1_000_000n;
    if (rng() < 0.05) p.liqWeight = 3;
    return p;
  });
}

const RUNS = 20;
// argv[2]: optional path to another settle-pairing module (the pre-change copy) to bench instead.
const { planSettleRound } = await import(process.argv[2] ?? "../src/cross-cluster/v22/settle-pairing.ts");
for (const mode of ["prefer", "strict", "off"] as const) {
  for (const n of [100, 1000, 5000]) {
    const lp = new PublicKey(new Uint8Array(32).fill(7));
    const run = (cps: PositionedPortfolio[]) => planSettleRound({ mode, lp, lpWeight: 7, counterparties: cps, maxTxsPerRound: 16 });
    run(synth(n, 1));
    const wall: number[] = [];
    const cpu: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      // Fresh key objects every run (production re-parses portfolios each tick, so no per-key cache carries over).
      const cps = synth(n, 4242 + n + i);
      const c0 = process.cpuUsage();
      const t0 = process.hrtime.bigint();
      run(cps);
      wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
    }
    const med = (xs: number[]) => (xs.sort((a, b) => a - b), (xs[9] + xs[10]) / 2);
    console.log(`mode=${mode} N=${n} wall_median=${med(wall).toFixed(3)}ms cpu_median=${med(cpu).toFixed(3)}ms`);
  }
}
