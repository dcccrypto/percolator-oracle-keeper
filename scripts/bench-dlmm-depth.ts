/**
 * Microbenchmark: computeDlmmDepth on a synthetic pool (same layout as the dlmm-depth test fixtures) for
 * binStep 1, 10 and 100. Prints median microseconds per call (2,000 calls each, after warmup) and a sha256
 * of the results so a change can prove identical output.
 *
 *   node --import tsx/esm scripts/bench-dlmm-depth.ts
 */
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BIN_ARRAY_LEN, BINS_PER_ARRAY, binArrayIndexOf, computeDlmmDepth, planDlmmBinArrays } from "../src/cross-cluster/dlmm-depth.ts";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const disc = (n: string) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8);
const Q64 = 2 ** 64;
const CALLS = 2000;

function poolBytes(activeId: number, binStep: number): Buffer {
  const b = Buffer.alloc(904);
  disc("LbPair").copy(b, 0);
  b.writeInt32LE(activeId, 76);
  b.writeUInt16LE(binStep, 80);
  Keypair.generate().publicKey.toBuffer().copy(b, 88);
  USDC.toBuffer().copy(b, 120);
  return b;
}
function binArray(pool: PublicKey, index: number, binStep: number, activeId: number): Buffer {
  const b = Buffer.alloc(BIN_ARRAY_LEN);
  disc("BinArray").copy(b, 0);
  b.writeBigInt64LE(BigInt(index), 8);
  b[16] = 1;
  pool.toBuffer().copy(b, 24);
  for (let j = 0; j < BINS_PER_ARRAY; j++) {
    const id = index * BINS_PER_ARRAY + j;
    const o = 56 + j * 144;
    b.writeBigUInt64LE(id >= activeId ? 1_000_000_000n : 0n, o);
    b.writeBigUInt64LE(id <= activeId ? 1_000_000_000n : 0n, o + 8);
    const p = BigInt(Math.floor(Math.pow(1 + binStep / 1e4, id) * Q64));
    b.writeBigUInt64LE(p & ((1n << 64n) - 1n), o + 16);
    b.writeBigUInt64LE(p >> 64n, o + 24);
  }
  return b;
}

const out = createHash("sha256");
for (const binStep of [1, 10, 100]) {
  const activeId = 68;
  const pool = Keypair.generate().publicKey;
  const poolData = poolBytes(activeId, binStep);
  const plan = planDlmmBinArrays(poolData);
  if (!plan.ok) throw new Error(plan.reason);
  const binArrays = new Map<number, Uint8Array | null>();
  for (const i of plan.indexes) binArrays.set(i, binArray(pool, i, binStep, activeId));
  void binArrayIndexOf;
  const run = () => computeDlmmDepth({ lbPair: pool, poolData, binArrays, decimals: { base: 9, quote: 6 } });
  for (let i = 0; i < 50; i++) run();
  const times: number[] = [];
  let last: unknown;
  for (let i = 0; i < CALLS; i++) {
    const t = process.hrtime.bigint();
    last = run();
    times.push(Number(process.hrtime.bigint() - t) / 1000);
  }
  times.sort((a, b) => a - b);
  out.update(JSON.stringify(last, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  const r = last as { ok: boolean };
  console.log(`binStep=${binStep} arrays=${plan.indexes.length} ok=${r.ok} median=${times[CALLS >> 1].toFixed(1)} us/call`);
}
console.log(`output sha256 ${out.digest("hex").slice(0, 16)}`);
