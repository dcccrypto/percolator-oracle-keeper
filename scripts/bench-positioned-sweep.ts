/**
 * Bench: sweep cursor/ordering (selectSweepBatch, markVisited, pruneVisits, refreshPositionedFrom)
 * at N = 1k / 5k / 20k positioned portfolios, 20 rounds each (a round = ceil(N/K) batches
 * walked through the cursor, plus one prune and one refreshPositionedFrom of 64 fresh entries).
 * Reports the median ms per N over 5 runs. Usage: npx tsx scripts/bench-positioned-sweep.ts
 */
import { PublicKey } from "@solana/web3.js";
import { freshSweepCursor, markVisited, pruneVisits, refreshPositionedFrom, selectSweepBatch } from "../src/cross-cluster/positioned-sweep.ts";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";

const SIZES = [1000, 5000, 20000];
const ROUNDS = 20;
const K = 8;
const RUNS = 5;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeSet(n: number, rng: () => number): PositionedPortfolio[] {
  return Array.from({ length: n }, () => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = Math.floor(rng() * 256);
    return {
      pubkey: new PublicKey(b),
      longLegs: 1,
      shortLegs: 0,
      isLp: rng() < 0.01,
      lossWeight: BigInt(Math.floor(rng() * 50)),
      kfEpochSnapLong: BigInt(Math.floor(rng() * 3)),
      kfEpochSnapShort: null,
    } as PositionedPortfolio;
  });
}

function once(n: number): { ms: number; checksum: number } {
  const rng = makeRng(777 + n);
  const positioned = makeSet(n, rng);
  const cursor = freshSweepCursor();
  const epochs = { long: 2n, short: 0n };
  let checksum = 0;
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < ROUNDS; r++) {
    // One cycle: a K-batch pick + record, with the exclude set empty (the cranker's steady state).
    const batch = selectSweepBatch(positioned, cursor, K, new Set(), epochs);
    markVisited(cursor, batch.map((p) => p.pubkey));
    for (const p of batch) checksum = (checksum + p.pubkey.toBytes()[0] + 1) | 0;
    pruneVisits(cursor, positioned);
    const fresh = positioned.slice(0, 64).map((p) => ({ ...p, pubkey: new PublicKey(p.pubkey.toBytes()), lossWeight: (p.lossWeight ?? 0n) + 1n }));
    refreshPositionedFrom(positioned, fresh);
  }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, checksum };
}

for (const n of SIZES) {
  const times: number[] = [];
  let cs = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = once(n);
    times.push(r.ms);
    cs = r.checksum;
  }
  times.sort((a, b) => a - b);
  console.log(`N=${n} rounds=${ROUNDS} median=${times[Math.floor(RUNS / 2)].toFixed(1)}ms checksum=${cs}`);
}
