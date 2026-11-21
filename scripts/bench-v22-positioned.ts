/**
 * Bench: analysePortfolios (v2.2 positioned-portfolio classifier) over 256 and 2,048 synthetic decodable portfolios
 * with 1-16 legs, plus parseAccrueAnchors. Median of 5 runs, ops/s (portfolios/s) and PublicKey.toBase58 calls per
 * pass (allocation proxy: each call allocates a Buffer + string) and heap bytes allocated per pass.
 * Usage: node --expose-gc --import tsx/esm scripts/bench-v22-positioned.ts
 */
import { PublicKey } from "@solana/web3.js";
import { analysePortfolios, parseAccrueAnchors } from "../src/cross-cluster/v22/positioned.ts";
import { key, portfolioBytes } from "../src/cross-cluster/v22/test-helpers.ts";

const RUNS = 5;
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function mkKey(i: number): PublicKey {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(0, i + 1, true);
  new DataView(b.buffer).setUint32(4, Math.imul(i + 7, 2654435761) >>> 0, true);
  b[31] = 1;
  return new PublicKey(b);
}

function dataset(n: number) {
  const rng = makeRng(n);
  const keeper = key(200);
  const accts = [];
  for (let i = 0; i < n; i++) {
    const nLegs = 1 + Math.floor(rng() * 16);
    const legs = Array.from({ length: nLegs }, (_, j) => ({ side: (rng() < 0.5 ? 0 : 1) as 0 | 1, basis: BigInt(1 + Math.floor(rng() * 1e9)) * (rng() < 0.5 ? -1n : 1n), assetIndex: j % 3 }));
    accts.push({ pubkey: mkKey(i), data: portfolioBytes({ owner: i % 50 === 0 ? keeper : key(i % 40), capital: 1000n, legs }) });
  }
  return { accts, keeper, lp: accts[3].pubkey };
}

let b58 = 0;
const orig = PublicKey.prototype.toBase58;
PublicKey.prototype.toBase58 = function (this: PublicKey) {
  b58++;
  return orig.call(this);
};

const g = (globalThis as { gc?: () => void }).gc;
for (const n of [256, 2048]) {
  const { accts, keeper, lp } = dataset(n);
  const opts = { lpPortfolio: lp, portfolioLen: accts[0].data.length, keeperOwner: keeper, anchorOverride: accts[50].pubkey, assetIndices: [0, 1] };
  analysePortfolios(accts, opts); // warm
  const times: number[] = [];
  let calls = 0;
  let bytes = 0;
  let checksum = 0;
  for (let r = 0; r < RUNS; r++) {
    g?.();
    b58 = 0;
    const h0 = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    const REPS = 1;
    for (let k = 0; k < REPS; k++) {
      const out = analysePortfolios(accts, opts);
      checksum += out.all.length + out.minLegAbs.size;
    }
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    bytes = (process.memoryUsage().heapUsed - h0) / REPS;
    times.push(dt / REPS);
    calls = b58 / REPS;
  }
  times.sort((a, b) => a - b);
  const med = times[2];
  console.log(`analysePortfolios n=${n}: median ${med.toFixed(2)} ms/pass, ${Math.round((n / med) * 1000)} portfolios/s, toBase58 calls/pass ${calls}, heap~${(bytes / 1024).toFixed(0)} KiB/pass (no-gc delta), checksum ${checksum}`);
}

const raw = Array.from({ length: 40 }, (_, i) => `${mkKey(i).toBase58()}:${mkKey(i + 100).toBase58()}`).join(",");
const times: number[] = [];
for (let r = 0; r < RUNS; r++) {
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 2000; k++) parseAccrueAnchors(raw);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6 / 2000);
}
times.sort((a, b) => a - b);
console.log(`parseAccrueAnchors 40 pairs: median ${times[2].toFixed(3)} ms/call, ${Math.round(1000 / times[2])} calls/s`);

// Isolated cost of the per-account key work this file does besides parsing: toBase58 for every positioned account.
{
  const ks = Array.from({ length: 2048 }, (_, i) => mkKey(i));
  const t: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 20; k++) for (const x of ks) orig.call(x);
    t.push(Number(process.hrtime.bigint() - t0) / 1e6 / 20);
  }
  t.sort((a, b) => a - b);
  console.log(`toBase58 x2048 keys: median ${t[2].toFixed(2)} ms`);
}
