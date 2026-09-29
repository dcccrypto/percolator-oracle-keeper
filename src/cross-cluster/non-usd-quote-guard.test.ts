/**
 * A pumpswap or meteora-dlmm pool quoted in a token that is neither WSOL nor a
 * USD stable (COLLECT/CARDS 6dp, Murphy's DOGE-quoted pool 8dp) prices in
 * QUOTE-TOKEN units. Only WSOL quotes are converted, so that number was
 * published as if it were USD (~4.5x / ~10x too high). Such pools must be
 * refused on both read paths without dropping any other market in the batch,
 * and the liquidity floor must not count their quote token as $1.
 *
 * Every WSOL/USDC/USDT price below is pinned to the exact e6 value origin/main
 * (fbf370d) produced for the same fixture, so the guard is proven not to move
 * a single publishable price.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/non-usd-quote-guard.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID, WSOL_MINT } from "@percolatorct/sdk";
import {
  pumpswapQuoteDepthUsdE6,
  readAllPoolPricesE6,
  readPoolPriceE6,
  resetSlotWatermarksForTests,
} from "./price-reader.ts";

beforeEach(() => resetSlotWatermarksForTests());

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const CARDS = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp"); // 6dp
const DOGE = Keypair.generate().publicKey; // stands in for Murphy's 8dp quote
const SOL_E6 = 150_000_000n;

type Acc = { owner?: PublicKey; data: Buffer };
const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });

function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

/** pumpswap pool + vaults; 1,000,000 base (6dp) vs 250 quote units. */
function pump(accts: Map<string, Acc>, quoteMint: PublicKey, quoteDec: number) {
  const pool = Keypair.generate().publicKey;
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const d = Buffer.alloc(301);
  Keypair.generate().publicKey.toBuffer().copy(d, 43);
  quoteMint.toBuffer().copy(d, 75);
  bv.toBuffer().copy(d, 139);
  qv.toBuffer().copy(d, 171);
  accts.set(pool.toBase58(), { owner: PUMPSWAP_OWNER, data: d });
  accts.set(bv.toBase58(), { data: vault(1_000_000_000_000n) });
  accts.set(qv.toBase58(), { data: vault(250n * 10n ** BigInt(quoteDec)) });
  return { pool: pool.toBase58(), vaults: [bv.toBase58(), qv.toBase58()], dec: { base: 6, quote: quoteDec } };
}

/** meteora-dlmm pool: activeId i32 @76, binStep u16 @80, mints @88/@120. */
function meteora(accts: Map<string, Acc>, quoteMint: PublicKey, quoteDec: number) {
  const pool = Keypair.generate().publicKey;
  const d = Buffer.alloc(256);
  d.writeInt32LE(-2304, 76);
  d.writeUInt16LE(20, 80);
  Keypair.generate().publicKey.toBuffer().copy(d, 88);
  quoteMint.toBuffer().copy(d, 120);
  accts.set(pool.toBase58(), { owner: METEORA_DLMM_PROGRAM_ID, data: d });
  return { pool: pool.toBase58(), dec: { base: 6, quote: quoteDec } };
}

/** Raydium CLMM SOL(9dp)/USDC(6dp) at SOL_E6 (same builder as #114's test). */
function raydiumSolUsd(accts: Map<string, Acc>) {
  const pool = Keypair.generate().publicKey;
  const b = Buffer.alloc(300);
  WSOL_MINT.toBuffer().copy(b, 73);
  USDC.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  const target = (SOL_E6 << 128n) / 1_000_000_000n;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(x >> 64n, 261);
  accts.set(pool.toBase58(), { owner: RAYDIUM_CLMM_OWNER, data: b });
  return pool.toBase58();
}

function mockConn(accts: Map<string, Acc>, ep: string) {
  const fetched: string[] = [];
  const get = (k: PublicKey) => (fetched.push(k.toBase58()), accts.get(k.toBase58()) ?? null);
  const conn = {
    rpcEndpoint: ep,
    getAccountInfoAndContext: (k: PublicKey) => Promise.resolve(ctx(get(k))),
    getMultipleAccountsInfoAndContext: (ks: PublicKey[]) => Promise.resolve(ctx(ks.map(get))),
  } as unknown as Connection;
  return { conn, fetched };
}

// Exact e6 values origin/main produces for these fixtures.
const PIN = {
  sol: 149_999_999n, // raydium SOL/USDC reference
  pumpWsol: 37_499n, // 0.00025 SOL x SOL/USD (#114 e12 path)
  pumpUsd: 250n, // 0.00025 USDC / USDT
  meteoraWsol: 1_502n, // Fauci-like SOL price x SOL/USD
  meteoraUsd: 10_017n, // same bins read as USD directly (6dp/6dp)
};

/** Every quote kind on both dexes, plus the SOL/USD reference when asked. */
function board(withRaydium: boolean) {
  const accts = new Map<string, Acc>();
  const m = {
    sol: withRaydium ? raydiumSolUsd(accts) : undefined,
    pWsol: pump(accts, WSOL_MINT, 9),
    pUsdc: pump(accts, USDC, 6),
    pUsdt: pump(accts, USDT, 6),
    pCards: pump(accts, CARDS, 6),
    pDoge: pump(accts, DOGE, 8),
    mWsol: meteora(accts, WSOL_MINT, 9),
    mUsdc: meteora(accts, USDC, 6),
    mCards: meteora(accts, CARDS, 6),
  };
  const entries: Parameters<typeof readAllPoolPricesE6>[1] = [];
  const dec = new Map<string, { base: number; quote: number }>();
  if (m.sol) entries.push({ poolAddress: m.sol, dexType: "raydium-clmm", label: "SOL/USDC", symbol: "SOL/USDC" });
  for (const [k, v] of Object.entries(m)) {
    if (!v || typeof v === "string") continue;
    entries.push({ poolAddress: v.pool, dexType: k.startsWith("p") ? "pumpswap" : "meteora-dlmm", label: k, symbol: k });
    dec.set(v.pool, v.dec);
  }
  return { accts, m, entries, dec };
}

describe("batch path (readAllPoolPricesE6) refuses non-USD quotes, keeps the rest", () => {
  it("registry SOL/USDC reference: CARDS/DOGE skipped, every other price pinned", async () => {
    const { accts, m, entries, dec } = board(true);
    const { conn, fetched } = mockConn(accts, "https://ep-guard-batch-reg");
    const out = await readAllPoolPricesE6(conn, entries, dec);
    assert.deepEqual(
      Object.fromEntries(out),
      {
        [m.sol!]: PIN.sol,
        [m.pWsol.pool]: PIN.pumpWsol,
        [m.pUsdc.pool]: PIN.pumpUsd,
        [m.pUsdt.pool]: PIN.pumpUsd,
        [m.mWsol.pool]: PIN.meteoraWsol,
        [m.mUsdc.pool]: PIN.meteoraUsd,
      },
    );
    // Refused before the vault fetch.
    for (const v of [...m.pCards.vaults, ...m.pDoge.vaults]) assert.ok(!fetched.includes(v), v);
  });

  it("SOL_USD_REFERENCE_POOL fallback still resolves SOL/USD; same result minus the ref market", async () => {
    const { accts, m, entries, dec } = board(false);
    const ref = raydiumSolUsd(accts);
    const { conn } = mockConn(accts, "https://ep-guard-batch-ref");
    const out = await readAllPoolPricesE6(conn, entries, dec, ref);
    assert.deepEqual(
      Object.fromEntries(out),
      {
        [m.pWsol.pool]: PIN.pumpWsol,
        [m.pUsdc.pool]: PIN.pumpUsd,
        [m.pUsdt.pool]: PIN.pumpUsd,
        [m.mWsol.pool]: PIN.meteoraWsol,
        [m.mUsdc.pool]: PIN.meteoraUsd,
      },
    );
  });
});

describe("single-pool path (readPoolPriceE6)", () => {
  const { accts, m, dec } = board(false);
  const { conn } = mockConn(accts, "https://ep-guard-single");
  const read = (pool: string, dexType: "pumpswap" | "meteora-dlmm") =>
    readPoolPriceE6(conn, { poolAddress: pool, dexType, label: "t" }, dec, SOL_E6);

  for (const [name, pool, dexType, mint] of [
    ["pumpswap CARDS", m.pCards.pool, "pumpswap", CARDS],
    ["pumpswap DOGE", m.pDoge.pool, "pumpswap", DOGE],
    ["meteora CARDS", m.mCards.pool, "meteora-dlmm", CARDS],
  ] as const) {
    it(`skips ${name}`, async () => {
      const res = await read(pool, dexType);
      assert.equal(res.priceE6, 0n);
      assert.equal(res.skipped, true);
      assert.ok(res.skipReason?.includes(`quote mint ${mint.toBase58()} is neither WSOL nor a USD stable`), res.skipReason);
    });
  }

  it("WSOL / USDC / USDT prices are unchanged", async () => {
    const got = await Promise.all([
      read(m.pWsol.pool, "pumpswap"),
      read(m.pUsdc.pool, "pumpswap"),
      read(m.pUsdt.pool, "pumpswap"),
      read(m.mWsol.pool, "meteora-dlmm"),
      read(m.mUsdc.pool, "meteora-dlmm"),
    ]);
    assert.deepEqual(got.map((r) => r.skipReason), [undefined, undefined, undefined, undefined, undefined]);
    // pumpWsol/meteoraWsol here use SOL_E6 exactly, not the raydium-derived rate.
    assert.deepEqual(got.map((r) => r.priceE6), [37_500n, PIN.pumpUsd, PIN.pumpUsd, 1_502n, PIN.meteoraUsd]);
  });
});

describe("liquidity floor", () => {
  it("returns null (unknown) for a CARDS or DOGE quote reserve instead of $1/unit", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1_500_000_000n), 6, CARDS, SOL_E6), null);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(150_000_000_000n), 8, DOGE, SOL_E6), null);
  });
  it("WSOL / USDC / USDT depths unchanged", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(10_000_000_000n), 9, WSOL_MINT, 200_000_000n), 2_000_000_000n);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1_500_000_000n), 6, USDC, undefined), 1_500_000_000n);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1_500_000_000n), 6, USDT, undefined), 1_500_000_000n);
  });
});
