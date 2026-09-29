/**
 * A pumpswap pool quoted in a token that is neither WSOL nor a USD stable
 * (COLLECT/CARDS, Murphy/DOGE-quoted) prices in QUOTE-TOKEN units. The SDK only
 * converts WSOL quotes, so that number was published as if it were USD
 * (~4.5x / ~10x too high). Such pools must be refused on both read paths, and
 * the liquidity floor must not count their quote token as $1.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/pumpswap-quote-guard.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { WSOL_MINT } from "@percolatorct/sdk";
import {
  pumpswapQuoteDepthUsdE6,
  readAllPoolPricesE6,
  readPoolPriceE6,
  resetSlotWatermarksForTests,
} from "./price-reader.ts";

beforeEach(() => resetSlotWatermarksForTests());

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const CARDS = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
const SOL_E6 = 150_000_000n;

// 1,000,000 base (6dp) vs 250 quote units (6dp) -> 250 e6 "per base" in quote units.
const BASE_AMT = 1_000_000_000_000n;
const QUOTE_AMT = 250_000_000n;

function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

/** A pumpswap pool plus its two vaults, keyed for an address-routed mock. */
function pumpFixture(quoteMint: PublicKey) {
  const pool = Keypair.generate().publicKey;
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const data = Buffer.alloc(301);
  Keypair.generate().publicKey.toBuffer().copy(data, 43);
  quoteMint.toBuffer().copy(data, 75);
  baseVault.toBuffer().copy(data, 139);
  quoteVault.toBuffer().copy(data, 171);
  const accounts = new Map<string, { owner?: PublicKey; data: Buffer }>([
    [pool.toBase58(), { owner: PUMPSWAP_OWNER, data }],
    [baseVault.toBase58(), { data: vault(BASE_AMT) }],
    [quoteVault.toBase58(), { data: vault(QUOTE_AMT) }],
  ]);
  return { pool: pool.toBase58(), accounts };
}

const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });

function mockConn(accounts: Map<string, { owner?: PublicKey; data: Buffer }>, ep: string) {
  const fetched: string[] = [];
  const conn = {
    rpcEndpoint: ep,
    getAccountInfoAndContext: (k: PublicKey) => {
      fetched.push(k.toBase58());
      return Promise.resolve(ctx(accounts.get(k.toBase58()) ?? null));
    },
    getMultipleAccountsInfoAndContext: (ks: PublicKey[]) => {
      ks.forEach((k) => fetched.push(k.toBase58()));
      return Promise.resolve(ctx(ks.map((k) => accounts.get(k.toBase58()) ?? null)));
    },
  } as unknown as Connection;
  return { conn, fetched };
}

describe("pumpswap non-USD, non-WSOL quote is refused", () => {
  it("single-pool path (readPoolPriceE6) skips a CARDS-quoted pool", async () => {
    const f = pumpFixture(CARDS);
    const { conn } = mockConn(f.accounts, "https://ep-cards-single");
    const res = await readPoolPriceE6(
      conn,
      { poolAddress: f.pool, dexType: "pumpswap", label: "COLLECT" },
      new Map([[f.pool, { base: 6, quote: 6 }]]),
      SOL_E6,
    );
    assert.equal(res.priceE6, 0n);
    assert.equal(res.skipped, true);
    assert.match(res.skipReason ?? "", /quote mint CARDS.* is neither WSOL nor a USD stable/);
  });

  it("live batch path (readAllPoolPricesE6) publishes no entry for it, and fetches no vaults", async () => {
    const cards = pumpFixture(CARDS);
    const wsol = pumpFixture(WSOL_MINT);
    const usdt = pumpFixture(USDT);
    const all = new Map([...cards.accounts, ...wsol.accounts, ...usdt.accounts]);
    const { conn, fetched } = mockConn(all, "https://ep-cards-batch");
    const dec = { base: 6, quote: 6 };
    const out = await readAllPoolPricesE6(
      conn,
      [
        { poolAddress: cards.pool, dexType: "pumpswap", label: "COLLECT", symbol: "COLLECT" },
        { poolAddress: wsol.pool, dexType: "pumpswap", label: "W", symbol: "W" },
        { poolAddress: usdt.pool, dexType: "pumpswap", label: "U", symbol: "U" },
      ],
      new Map([
        [cards.pool, dec],
        [wsol.pool, { base: 6, quote: 9 }],
        [usdt.pool, dec],
      ]),
    );
    assert.equal(out.has(cards.pool), false, "CARDS-quoted price must not be published as USD");
    // USDT-quoted is unchanged: 250 e6.
    assert.equal(out.get(usdt.pool), 250n);
    // WSOL-quoted with no SOL/USD this cycle stays unpriced (pre-existing behaviour).
    assert.equal(out.has(wsol.pool), false);
    // Refused before the vault fetch: none of CARDS's vaults were requested.
    const cardsVaults = [...cards.accounts.keys()].slice(1);
    assert.deepEqual(fetched.filter((k) => cardsVaults.includes(k)), []);
  });

  it("USDT-quoted single-pool read is unchanged", async () => {
    const f = pumpFixture(USDT);
    const { conn } = mockConn(f.accounts, "https://ep-usdt-single");
    const res = await readPoolPriceE6(
      conn,
      { poolAddress: f.pool, dexType: "pumpswap", label: "USDT-quoted" },
      new Map([[f.pool, { base: 6, quote: 6 }]]),
      SOL_E6,
    );
    assert.equal(res.skipReason, undefined);
    assert.equal(res.priceE6, 250n);
  });

  it("liquidity floor does not count a CARDS quote reserve as $1/unit", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1_500_000_000n), 6, CARDS, SOL_E6), null);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1_500_000_000n), 6, USDT, undefined), 1_500_000_000n);
  });
});
