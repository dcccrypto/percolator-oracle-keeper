/**
 * #112 — SOLCAT stopped being pushed because its pumpswap price was quantized.
 *
 * The SDK prices a WSOL-quoted pumpswap pool as `quotePerBaseE6 * sol / 1e6`,
 * truncating the SOL price to whole micro-SOL first. SOLCAT trades at ~1.8e-6
 * SOL, which truncates to `1`: its mark read ~117 instead of ~213 (SOL $117.75),
 * a 50% phantom drop that the circuit breaker refused forever.
 *
 * Fixture reserves are SOLCAT's real mainnet vault balances (2026-09-28).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/pumpswap-precision.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { WSOL_MINT } from "@percolatorct/sdk";
import { readAllPoolPricesE6, readPoolPriceE6, resetSlotWatermarksForTests } from "./price-reader.ts";

beforeEach(() => resetSlotWatermarksForTests());

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const BASE_AMT = 135_682_102_366_305n; // SOLCAT, 6dp
const QUOTE_AMT = 245_409_236_912n; // WSOL, 9dp
const SOL_E6 = 117_753_929n; // the SOL mark pushed alongside SOLCAT's last push
/** Exact USD e6 price, truncated once at the end. ~212. */
const EXACT = (QUOTE_AMT * 1_000_000n * SOL_E6) / (BASE_AMT * 1_000_000_000n);

const mint = Keypair.generate().publicKey;
const baseVault = Keypair.generate().publicKey;
const quoteVault = Keypair.generate().publicKey;

function pumpPool(quoteMint: PublicKey = WSOL_MINT): Buffer {
  const b = Buffer.alloc(301);
  mint.toBuffer().copy(b, 43);
  quoteMint.toBuffer().copy(b, 75);
  baseVault.toBuffer().copy(b, 139);
  quoteVault.toBuffer().copy(b, 171);
  return b;
}
function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}
/** Raydium CLMM SOL(9dp)/USDC(6dp) pool at SOL_E6. */
function raydiumSolUsd(): Buffer {
  const b = Buffer.alloc(300);
  WSOL_MINT.toBuffer().copy(b, 73);
  USDC.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  // sqrtPriceX64 = sqrt(SOL_E6 / 1e6 * 1e6 / 1e9) * 2^64, via integer sqrt.
  let target = (SOL_E6 << 128n) / 1_000_000_000n;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(x >> 64n, 261);
  return b;
}
const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });

describe("#112 pumpswap price is not quantized to whole micro-SOL", () => {
  it("live batch path (readAllPoolPricesE6) prices SOLCAT at its exact level", async () => {
    const solPool = Keypair.generate().publicKey.toBase58();
    const catPool = Keypair.generate().publicKey.toBase58();
    let call = 0;
    const conn = {
      rpcEndpoint: "https://ep-112-batch",
      getMultipleAccountsInfoAndContext: () =>
        Promise.resolve(
          ctx(
            call++ === 0
              ? [
                  { owner: RAYDIUM_CLMM_OWNER, data: raydiumSolUsd() },
                  { owner: PUMPSWAP_OWNER, data: pumpPool() },
                ]
              : [{ data: vault(BASE_AMT) }, { data: vault(QUOTE_AMT) }],
          ),
        ),
    } as unknown as Connection;
    const out = await readAllPoolPricesE6(
      conn,
      [
        { poolAddress: solPool, dexType: "raydium-clmm", label: "SOL/USDC", symbol: "SOL/USDC" },
        { poolAddress: catPool, dexType: "pumpswap", label: "SOLCAT", symbol: "SOLCAT" },
      ],
      new Map([[catPool, { base: 6, quote: 9 }]]),
    );
    const sol = out.get(solPool)!;
    const want = (QUOTE_AMT * 1_000_000n * sol) / (BASE_AMT * 1_000_000_000n);
    const got = out.get(catPool);
    assert.ok(want > 200n, `fixture sanity: ${want}`);
    // Before the fix this was `sol / 1e6` (≈117): 1 micro-SOL × SOL/USD.
    assert.equal(got, want);
  });

  it("single-pool path (readPoolPriceE6) matches", async () => {
    const catPool = Keypair.generate().publicKey.toBase58();
    const conn = {
      rpcEndpoint: "https://ep-112-single",
      getAccountInfoAndContext: () => Promise.resolve(ctx({ owner: PUMPSWAP_OWNER, data: pumpPool() })),
      getMultipleAccountsInfoAndContext: () =>
        Promise.resolve(ctx([{ data: vault(BASE_AMT) }, { data: vault(QUOTE_AMT) }])),
    } as unknown as Connection;
    const res = await readPoolPriceE6(
      conn,
      { poolAddress: catPool, dexType: "pumpswap", label: "SOLCAT" },
      new Map([[catPool, { base: 6, quote: 9 }]]),
      SOL_E6,
    );
    assert.equal(res.skipReason, undefined);
    assert.equal(res.priceE6, EXACT);
  });

  it("a USD-stable quote keeps its e6 scale", async () => {
    // 1,000,000 base (6dp) vs 250 USDC (6dp) -> $0.00025 = 250 e6. No SOL leg.
    const pool = Keypair.generate().publicKey.toBase58();
    const conn = {
      rpcEndpoint: "https://ep-112-usdc",
      getAccountInfoAndContext: () => Promise.resolve(ctx({ owner: PUMPSWAP_OWNER, data: pumpPool(USDC) })),
      getMultipleAccountsInfoAndContext: () =>
        Promise.resolve(ctx([{ data: vault(1_000_000_000_000n) }, { data: vault(250_000_000n) }])),
    } as unknown as Connection;
    const res = await readPoolPriceE6(
      conn,
      { poolAddress: pool, dexType: "pumpswap", label: "USDC-quoted" },
      new Map([[pool, { base: 6, quote: 6 }]]),
      SOL_E6,
    );
    assert.equal(res.skipReason, undefined);
    assert.equal(res.priceE6, 250n);
  });
});
