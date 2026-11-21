// Deterministic synthetic pool fixtures for the price-reader bench + differential test.
import { PublicKey } from "@solana/web3.js";

const PUMP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAY = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const MET = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface FixtureEntry {
  poolAddress: string;
  dexType: "raydium-clmm" | "meteora-dlmm" | "pumpswap";
  label: string;
  symbol?: string;
  mainnetCa?: string;
}

export interface Fixture {
  entries: FixtureEntry[];
  accounts: Map<string, { data: Buffer; owner: PublicKey }>;
  solRefPool: string;
}

function key(r: () => number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256)));
}

function u64(buf: Buffer, off: number, v: bigint) {
  buf.writeBigUInt64LE(v, off);
}

function raydium(base: PublicKey, quote: PublicKey, r: () => number): Buffer {
  const b = Buffer.alloc(273);
  b.set(base.toBytes(), 73);
  b.set(quote.toBytes(), 105);
  b[233] = 9;
  b[234] = 6;
  // sqrtPriceX64 u128 ~ 2^64 * k
  const sq = (1n << 64n) / 40n + BigInt(Math.floor(r() * 1e9)) * 1000n;
  b.writeBigUInt64LE(sq & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(sq >> 64n, 261);
  return b;
}

function meteora(base: PublicKey, quote: PublicKey, r: () => number): Buffer {
  const b = Buffer.alloc(160);
  b.set(base.toBytes(), 88);
  b.set(quote.toBytes(), 120);
  b.writeInt32LE(Math.floor(r() * 2000) - 1000, 76);
  b.writeUInt16LE(1 + Math.floor(r() * 100), 80);
  return b;
}

function pump(base: PublicKey, quote: PublicKey, bv: PublicKey, qv: PublicKey): Buffer {
  const b = Buffer.alloc(211);
  b.set(base.toBytes(), 43);
  b.set(quote.toBytes(), 75);
  b.set(bv.toBytes(), 139);
  b.set(qv.toBytes(), 171);
  return b;
}

function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  u64(b, 64, amount);
  return b;
}

/** n pools: ~1 raydium SOL/USDC ref + raydium USDC, meteora USDC/WSOL, pumpswap WSOL, plus a few refusals. */
export function buildFixture(n: number, seed = 7, withSolRef = true): Fixture {
  const r = rng(seed);
  const entries: FixtureEntry[] = [];
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  const add = (e: Omit<FixtureEntry, "poolAddress">, pk: PublicKey, data: Buffer, owner: PublicKey) => {
    entries.push({ ...e, poolAddress: pk.toBase58() });
    accounts.set(pk.toBase58(), { data, owner });
  };
  const mintDec = Buffer.alloc(82);
  if (withSolRef) {
    const pk = key(r);
    add({ dexType: "raydium-clmm", label: "SOL/USDC - raydium-clmm", symbol: "SOL/USDC", mainnetCa: WSOL.toBase58() }, pk, raydium(WSOL, USDC, r), RAY);
  }
  while (entries.length < n) {
    const i = entries.length;
    const tok = key(r);
    const pk = key(r);
    const m = i % 8;
    const label = `T${i}/USDC - x`;
    if (m === 0 || m === 1) add({ dexType: "raydium-clmm", label, mainnetCa: tok.toBase58() }, pk, raydium(tok, m ? USDT : USDC, r), RAY);
    else if (m === 2 || m === 3) add({ dexType: "meteora-dlmm", label, mainnetCa: tok.toBase58() }, pk, meteora(tok, USDC, r), MET);
    else if (m === 4) add({ dexType: "meteora-dlmm", label, mainnetCa: tok.toBase58() }, pk, meteora(tok, WSOL, r), MET);
    else if (m === 5 || m === 6) {
      const bv = key(r);
      const qv = key(r);
      add({ dexType: "pumpswap", label, mainnetCa: tok.toBase58() }, pk, pump(tok, WSOL, bv, qv), PUMP);
      accounts.set(bv.toBase58(), { data: vault(BigInt(1e12) + BigInt(Math.floor(r() * 1e9))), owner: PUMP });
      accounts.set(qv.toBase58(), { data: vault(BigInt(5e10) + BigInt(Math.floor(r() * 1e9))), owner: PUMP });
    } else {
      // refusal: raydium wrong token binding
      add({ dexType: "raydium-clmm", label, mainnetCa: key(r).toBase58() }, pk, raydium(tok, USDC, r), RAY);
    }
  }
  void mintDec;
  return { entries, accounts, solRefPool: entries[0].poolAddress };
}

/** Mock connection: serves getMultipleAccountsInfoAndContext from the fixture; counts calls. */
export function mockConn(fx: Fixture, rpcEndpoint: string) {
  const mintAcct = { data: Buffer.alloc(82, 0), owner: PUMP };
  mintAcct.data[44] = 6;
  // hex-keyed so the mock does not spend the bench in base58 encoding
  const byHex = new Map<string, { data: Buffer; owner: PublicKey }>();
  for (const [k, v] of fx.accounts) byHex.set(Buffer.from(new PublicKey(k).toBytes()).toString("hex"), v);
  return {
    rpcEndpoint,
    calls: 0,
    async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
      (this as { calls: number }).calls++;
      return {
        context: { slot: 100 },
        value: ks.map((k) => {
          const a = byHex.get(Buffer.from(k.toBytes()).toString("hex")) ?? (mintAcct as { data: Buffer; owner: PublicKey });
          // fresh Buffer per call like web3.js
          return { data: Buffer.from(a.data), owner: a.owner, lamports: 1, executable: false };
        }),
      };
    },
    async getAccountInfoAndContext(k: PublicKey) {
      const a = fx.accounts.get(k.toBase58());
      return { context: { slot: 100 }, value: a ? { data: Buffer.from(a.data), owner: a.owner, lamports: 1, executable: false } : null };
    },
    async getAccountInfo() {
      return { data: mintAcct.data, owner: PUMP, lamports: 1, executable: false };
    },
  };
}
