/**
 * Bench: readAllPoolPricesE6 (the per-cycle batch read) over N registry entries with fixture account data and a
 * fake Connection (no RPC). Mix: raydium-clmm USDC, meteora-dlmm USDC/WSOL, pumpswap WSOL, plus a SOL/USD reference
 * pool. Prints median-of-5 ms per cycle and a sha256 of the output map so a change can prove identical prices.
 *
 *   node --import tsx/esm scripts/bench-price-reader.ts
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID, WSOL_MINT } from "@percolatorct/sdk";
import { readAllPoolPricesE6, resetSlotWatermarksForTests } from "../src/cross-cluster/price-reader.ts";

const SIZES = [200, 2000];
const RUNS = 5;
const CYCLES_PER_RUN = 20;

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

let keySeq = 0;
function nextKey(): PublicKey {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(++keySeq, 0);
  b[31] = 7;
  return new PublicKey(b);
}

type Acc ={ owner?: PublicKey; data: Buffer };

function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

function sqrtX64(priceE6: bigint): { lo: bigint; hi: bigint } {
  const target = (priceE6 << 128n) / 1_000_000_000n;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  return { lo: x & ((1n << 64n) - 1n), hi: x >> 64n };
}

function raydium(accts: Map<string, Acc>, base: PublicKey): string {
  const pool = nextKey();
  const b = Buffer.alloc(300);
  base.toBuffer().copy(b, 73);
  USDC.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  const { lo, hi } = sqrtX64(150_000_000n);
  b.writeBigUInt64LE(lo, 253);
  b.writeBigUInt64LE(hi, 261);
  accts.set(pool.toBase58(), { owner: RAYDIUM_OWNER, data: b });
  return pool.toBase58();
}

function meteora(accts: Map<string, Acc>, base: PublicKey, quote: PublicKey): string {
  const pool = nextKey();
  const d = Buffer.alloc(256);
  d.writeInt32LE(-2304, 76);
  d.writeUInt16LE(20, 80);
  base.toBuffer().copy(d, 88);
  quote.toBuffer().copy(d, 120);
  accts.set(pool.toBase58(), { owner: METEORA_DLMM_PROGRAM_ID, data: d });
  return pool.toBase58();
}

function pump(accts: Map<string, Acc>, base: PublicKey): string {
  const pool = nextKey();
  const bv = nextKey();
  const qv = nextKey();
  const d = Buffer.alloc(301);
  base.toBuffer().copy(d, 43);
  WSOL_MINT.toBuffer().copy(d, 75);
  bv.toBuffer().copy(d, 139);
  qv.toBuffer().copy(d, 171);
  accts.set(pool.toBase58(), { owner: PUMPSWAP_OWNER, data: d });
  accts.set(bv.toBase58(), { data: vault(1_000_000_000_000n) });
  accts.set(qv.toBase58(), { data: vault(250n * 10n ** 9n) });
  return pool.toBase58();
}

function build(n: number) {
  const accts = new Map<string, Acc>();
  const entries: Parameters<typeof readAllPoolPricesE6>[1] = [];
  const dec = new Map<string, { base: number; quote: number }>();
  for (let i = 0; i < n; i++) {
    const base = nextKey();
    const ca = base.toBase58();
    const k = i % 4;
    let pool: string;
    let dexType: "raydium-clmm" | "meteora-dlmm" | "pumpswap";
    if (k === 0) { pool = raydium(accts, base); dexType = "raydium-clmm"; }
    else if (k === 1) { pool = meteora(accts, base, USDC); dexType = "meteora-dlmm"; dec.set(pool, { base: 6, quote: 6 }); }
    else if (k === 2) { pool = meteora(accts, base, WSOL_MINT); dexType = "meteora-dlmm"; dec.set(pool, { base: 6, quote: 9 }); }
    else { pool = pump(accts, base); dexType = "pumpswap"; dec.set(pool, { base: 6, quote: 9 }); }
    entries.push({ poolAddress: pool, dexType, label: `m${i}`, symbol: `m${i}`, mainnetCa: ca });
  }
  const ref = raydium(accts, WSOL_MINT); // SOL/USD reference pool, not in the registry
  return { accts, entries, dec, ref };
}

function fakeConn(accts: Map<string, Acc>): Connection {
  const get = (k: PublicKey) => accts.get(k.toBase58()) ?? null;
  const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });
  return {
    rpcEndpoint: "https://bench-price-reader",
    getAccountInfoAndContext: (k: PublicKey) => Promise.resolve(ctx(get(k))),
    getMultipleAccountsInfoAndContext: (ks: PublicKey[]) => Promise.resolve(ctx(ks.map(get))),
  } as unknown as Connection;
}

const quiet = (fn: () => Promise<void>) => fn();
void quiet;

async function runSize(n: number): Promise<void> {
  const { accts, entries, dec, ref } = build(n);
  const conn = fakeConn(accts);
  const hash = createHash("sha256");
  const once = async (): Promise<Map<string, bigint>> => {
    resetSlotWatermarksForTests();
    return readAllPoolPricesE6(conn, entries, dec, ref);
  };
  const first = await once(); // warm-up + checksum
  for (const [k, v] of [...first].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(`${k}:${v}\n`);
  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.cpuUsage();
    for (let c = 0; c < CYCLES_PER_RUN; c++) await once();
    const u = process.cpuUsage(t0);
    times.push((u.user + u.system) / 1000 / CYCLES_PER_RUN);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(RUNS / 2)];
  console.log(
    `entries=${n} priced=${first.size} median_cpu_ms_per_cycle=${med.toFixed(3)} cycles_per_s=${(1000 / med).toFixed(1)} ` +
      `all=[${times.map((t) => t.toFixed(3)).join(",")}] sha256=${hash.digest("hex").slice(0, 16)}`,
  );
}

for (const n of SIZES) await runSize(n);
