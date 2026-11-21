/**
 * Deterministic recorded-style pool bytes + fake Connection for the batch read path
 * (readAllPoolPricesE6). Shared by scripts/bench-price-reader.ts and the differential test.
 * Layouts mirror non-usd-quote-guard.test.ts. Not a test file (no .test suffix).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID, WSOL_MINT } from "@percolatorct/sdk";
import type { readAllPoolPricesE6 } from "./price-reader.ts";

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const SOL_E6 = 150_000_000n;

type Acc = { owner?: PublicKey; data: Buffer };
export type Entries = Parameters<typeof readAllPoolPricesE6>[1];

let seedCounter = 0;
function key(): PublicKey {
  const seed = new Uint8Array(32);
  new DataView(seed.buffer).setUint32(0, ++seedCounter, true);
  return Keypair.fromSeed(seed).publicKey;
}

function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

function isqrt(target: bigint): bigint {
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  return x;
}

export interface Board {
  accts: Map<string, Acc>;
  entries: Entries;
  dec: Map<string, { base: number; quote: number }>;
  refPool: string;
}

/** n pool entries cycling through every venue/quote kind, incl. refused ones, one bad address, plus a SOL/USD reference pool. */
export function buildBoard(n: number): Board {
  seedCounter = 0;
  const accts = new Map<string, Acc>();
  const entries: Entries = [];
  const dec = new Map<string, { base: number; quote: number }>();

  const ref = key();
  {
    const b = Buffer.alloc(300);
    WSOL_MINT.toBuffer().copy(b, 73);
    USDC.toBuffer().copy(b, 105);
    b[233] = 9; b[234] = 6;
    const x = isqrt((SOL_E6 << 128n) / 1_000_000_000n);
    b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
    b.writeBigUInt64LE(x >> 64n, 261);
    accts.set(ref.toBase58(), { owner: RAYDIUM_CLMM_OWNER, data: b });
  }

  for (let i = 0; i < n; i++) {
    const kind = i % 7;
    const pool = key();
    const baseMint = key();
    const quote = kind === 1 ? USDT : kind === 5 ? key() /* non-USD quote */ : kind === 3 || kind === 4 ? WSOL_MINT : USDC;
    const pa = pool.toBase58();
    if (kind === 0 || kind === 1 || kind === 6) {
      // raydium-clmm, USD quote, mint-bound (kind 6: wrong-token mainnetCa -> refused)
      const b = Buffer.alloc(300);
      baseMint.toBuffer().copy(b, 73);
      quote.toBuffer().copy(b, 105);
      b[233] = 6; b[234] = 6;
      const x = isqrt((BigInt(1 + (i % 50)) * 1_000_000n << 128n) / 1_000_000n);
      b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
      b.writeBigUInt64LE(x >> 64n, 261);
      accts.set(pa, { owner: RAYDIUM_CLMM_OWNER, data: b });
      entries.push({
        poolAddress: pa, dexType: "raydium-clmm", label: `ray${i}`, symbol: `R${i}`,
        mainnetCa: kind === 6 ? key().toBase58() : kind === 0 ? baseMint.toBase58() : undefined,
      });
    } else if (kind === 2 || kind === 3 || kind === 5) {
      const d = Buffer.alloc(256);
      d.writeInt32LE(-2304 + (i % 100), 76);
      d.writeUInt16LE(20, 80);
      baseMint.toBuffer().copy(d, 88);
      quote.toBuffer().copy(d, 120);
      accts.set(pa, { owner: METEORA_DLMM_PROGRAM_ID, data: d });
      entries.push({ poolAddress: pa, dexType: "meteora-dlmm", label: `met${i}`, symbol: `M${i}`, mainnetCa: i % 2 ? baseMint.toBase58() : undefined });
      dec.set(pa, { base: 6, quote: quote.equals(WSOL_MINT) ? 9 : 6 });
    } else {
      const bv = key(), qv = key();
      const d = Buffer.alloc(301);
      baseMint.toBuffer().copy(d, 43);
      quote.toBuffer().copy(d, 75);
      bv.toBuffer().copy(d, 139);
      qv.toBuffer().copy(d, 171);
      accts.set(pa, { owner: PUMPSWAP_OWNER, data: d });
      accts.set(bv.toBase58(), { data: vault(1_000_000_000_000n + BigInt(i) * 1_000_000n) });
      accts.set(qv.toBase58(), { data: vault(250n * 10n ** 9n + BigInt(i)) });
      entries.push({ poolAddress: pa, dexType: "pumpswap", label: `pump${i}`, symbol: `P${i}` });
      dec.set(pa, { base: 6, quote: 9 });
    }
  }
  if (n > 0) entries.push({ poolAddress: "not-a-pubkey!", dexType: "raydium-clmm", label: "bad", symbol: "BAD" });
  return { accts, entries, dec, refPool: ref.toBase58() };
}

export function fakeConn(accts: Map<string, Acc>, endpoint: string): Connection {
  const get = (k: PublicKey) => accts.get(k.toBase58()) ?? null;
  const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });
  return {
    rpcEndpoint: endpoint,
    getAccountInfoAndContext: (k: PublicKey) => Promise.resolve(ctx(get(k))),
    getMultipleAccountsInfoAndContext: (ks: PublicKey[]) => Promise.resolve(ctx(ks.map(get))),
  } as unknown as Connection;
}
