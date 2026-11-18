/**
 * Bench: planSettleRound over 200 / 2,000 / 10,000 synthetic counterparties of mixed weights, in each mode
 * (off / strict / prefer), with and without an anchor. Median of 5 runs (after a warm-up).
 * Usage: node --import tsx/esm scripts/bench-settle-pairing.ts
 */
import { PublicKey } from "@solana/web3.js";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";

// BENCH_IMPL=frozen benches the pre-optimisation copy (settle-pairing.frozen.ts).
const { planSettleRound } = await import(process.env.BENCH_IMPL === "frozen" ? "../src/cross-cluster/v22/settle-pairing.frozen.ts" : "../src/cross-cluster/v22/settle-pairing.ts");

const RUNS = 5;
const SIZES = [200, 2000, 10000];
const MODES = ["off", "strict", "prefer"] as const;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function mk(n: number): PositionedPortfolio[] {
  const rng = makeRng(777 + n);
  return Array.from({ length: n }, (_, i) => {
    const b = new Uint8Array(32);
    b[0] = i & 0xff;
    b[1] = (i >> 8) & 0xff;
    b[2] = (i >> 16) & 0xff;
    b[3] = 9;
    const legs = rng() < 0.9 ? 1 : 2; // mixed weights; no solo so rounds are long
    return { pubkey: new PublicKey(b), longLegs: legs, shortLegs: 0, isLp: false, lossWeight: BigInt(Math.floor(rng() * 1000)) };
  });
}

const lp = new PublicKey(new Uint8Array(32).fill(5));
const anchor = new PublicKey(new Uint8Array(32).fill(6));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const n of SIZES) {
  const cps = mk(n);
  for (const mode of MODES) {
    for (const withAnchor of [false, true]) {
      // maxTxsPerRound large enough that the whole set is planned (worst case for the loop)
      const run = () => planSettleRound({ mode, lp, counterparties: cps, anchor: withAnchor ? anchor : null, maxTxsPerRound: 100000 });
      run();
      const ts: number[] = [];
      let txs = 0;
      for (let r = 0; r < RUNS; r++) {
        const t0 = process.hrtime.bigint();
        txs = run().txs.length;
        ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      console.log(`n=${String(n).padStart(5)} mode=${mode.padEnd(6)} anchor=${String(withAnchor).padEnd(5)} txs=${String(txs).padStart(5)} median=${median(ts).toFixed(2)} ms`);
    }
  }
}
