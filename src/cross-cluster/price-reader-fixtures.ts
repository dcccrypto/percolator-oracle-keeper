/**
 * Shared byte-level fixtures for the price-reader coverage tests (test support only).
 * Layouts mirror the SDK parsers: raydium mints @73/@105, decimals @233/@234, sqrtPriceX64 @253;
 * meteora activeId i32 @76, binStep u16 @80, mints @88/@120; pumpswap base/quote mint @43/@75, vaults @139/@171.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID, WSOL_MINT } from "@percolatorct/sdk";

export const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
export { METEORA_DLMM_PROGRAM_ID, WSOL_MINT };
export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const CARDS = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
export const SOL_E6 = 150_000_000n;

export type Acc = { owner?: PublicKey; data: Buffer };
export const ctx = <T>(value: T, slot = 1) => ({ context: { slot }, value });

export function vault(amount: bigint, len = 165): Buffer {
  const b = Buffer.alloc(len);
  if (len >= 72) b.writeBigUInt64LE(amount, 64);
  return b;
}

export function mintAcc(decimals: number): Buffer {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  return b;
}

export function put(accts: Map<string, Acc>, pk: PublicKey, acc: Acc) {
  accts.set(pk.toBase58(), acc);
}

/** raydium-clmm pool with the given mints; sqrt = 0 unless `price` (quote per base, e6) is supplied. */
export function raydium(accts: Map<string, Acc>, base: PublicKey, quote: PublicKey, priceE6 = 0n, bd = 9, qd = 6) {
  const pool = Keypair.generate().publicKey;
  const b = Buffer.alloc(300);
  base.toBuffer().copy(b, 73);
  quote.toBuffer().copy(b, 105);
  b[233] = bd;
  b[234] = qd;
  if (priceE6 > 0n) {
    const target = (priceE6 << 128n) / 10n ** BigInt(bd - qd + 6);
    let x = target, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + target / x) / 2n; }
    b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
    b.writeBigUInt64LE(x >> 64n, 261);
  }
  accts.set(pool.toBase58(), { owner: RAYDIUM_CLMM_OWNER, data: b });
  return pool;
}

export function meteora(accts: Map<string, Acc>, base: PublicKey, quote: PublicKey, binStep = 20) {
  const pool = Keypair.generate().publicKey;
  const d = Buffer.alloc(256);
  d.writeInt32LE(-2304, 76);
  d.writeUInt16LE(binStep, 80);
  base.toBuffer().copy(d, 88);
  quote.toBuffer().copy(d, 120);
  accts.set(pool.toBase58(), { owner: METEORA_DLMM_PROGRAM_ID, data: d });
  return pool;
}

export function pump(
  accts: Map<string, Acc>,
  base: PublicKey,
  quote: PublicKey,
  baseAmt = 1_000_000_000_000n,
  quoteAmt = 250_000_000_000n,
) {
  const pool = Keypair.generate().publicKey;
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const d = Buffer.alloc(301);
  base.toBuffer().copy(d, 43);
  quote.toBuffer().copy(d, 75);
  bv.toBuffer().copy(d, 139);
  qv.toBuffer().copy(d, 171);
  accts.set(pool.toBase58(), { owner: PUMPSWAP_OWNER, data: d });
  accts.set(bv.toBase58(), { data: vault(baseAmt) });
  accts.set(qv.toBase58(), { data: vault(quoteAmt) });
  return { pool, bv, qv };
}

export interface MockOpts {
  /** override every read's context slot */
  slot?: number;
  /** throw this on getMultipleAccountsInfoAndContext calls whose key count matches */
  failMultiple?: (call: number, keys: PublicKey[]) => Error | undefined;
}

export function mockConn(accts: Map<string, Acc>, ep: string, opts: MockOpts = {}) {
  const calls = { single: 0, multi: [] as number[], mint: 0 };
  const get = (k: PublicKey) => accts.get(k.toBase58()) ?? null;
  const conn = {
    rpcEndpoint: ep,
    getAccountInfoAndContext: (k: PublicKey) => {
      calls.single++;
      return Promise.resolve(ctx(get(k), opts.slot ?? 1));
    },
    getMultipleAccountsInfoAndContext: (ks: PublicKey[]) => {
      calls.multi.push(ks.length);
      const err = opts.failMultiple?.(calls.multi.length, ks);
      if (err) return Promise.reject(err);
      return Promise.resolve(ctx(ks.map(get), opts.slot ?? 1));
    },
    getAccountInfo: (k: PublicKey) => {
      calls.mint++;
      return Promise.resolve(get(k));
    },
  } as unknown as Connection;
  return { conn, calls };
}
