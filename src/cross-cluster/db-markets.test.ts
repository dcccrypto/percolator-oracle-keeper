/**
 * The keeper's market list, read from Supabase instead of the Vercel blob.
 *
 * The invariants worth locking in are the DROP rules: a row that cannot be
 * priced must never reach the registry, because a registry entry with a bad or
 * guessed dexType feeds straight into the price push. See
 * percolator-launch/docs/MARKET-REGISTRATION-SPEC-2026-07-30.md.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/db-markets.test.ts
 * Or via:   pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rowsToEntries, type DbMarketRow } from "./db-markets.ts";
import type { DexType } from "./registry.ts";

const row = (over: Partial<DbMarketRow> = {}): DbMarketRow => ({
  slab_address: "SLAB1",
  dex_pool_address: "POOL1",
  symbol: "FOO",
  mint_address: "MINT1",
  mainnet_ca: null,
  ...over,
});

describe("rowsToEntries", () => {
  it("maps a DB row to a MarketEntry using the classified dexType", () => {
    const out = rowsToEntries([row()], new Map<string, DexType>([["POOL1", "meteora-dlmm"]]));
    assert.equal(out.length, 1);
    assert.equal(out[0].marketAddress, "SLAB1");
    assert.equal(out[0].poolAddress, "POOL1");
    assert.equal(out[0].dexType, "meteora-dlmm");
    assert.equal(out[0].symbol, "FOO");
    assert.equal(out[0].collateral, "MINT1");
    assert.equal(out[0].assetIndex, 0);
  });

  it("drops a row whose pool could not be classified rather than guessing", () => {
    // A guessed dexType would be validated against the pool's real owner on the
    // first price read and skipped anyway — but only after it had entered the
    // registry. Keep it out.
    assert.equal(rowsToEntries([row()], new Map()).length, 0);
  });

  it("drops a row with no pool address — there is nothing to price from", () => {
    const out = rowsToEntries(
      [row({ dex_pool_address: null })],
      new Map<string, DexType>([["POOL1", "pumpswap"]]),
    );
    assert.equal(out.length, 0);
  });

  it("keeps the priceable rows when only some are unclassifiable", () => {
    const out = rowsToEntries(
      [row({ slab_address: "A", dex_pool_address: "PA" }), row({ slab_address: "B", dex_pool_address: "PB" })],
      new Map<string, DexType>([["PA", "pumpswap"]]),
    );
    assert.deepEqual(out.map((e) => e.marketAddress), ["A"]);
  });

  it("falls back to the slab prefix for a label when symbol is null", () => {
    const out = rowsToEntries(
      [row({ symbol: null, slab_address: "ABCDEFGHIJKL" })],
      new Map<string, DexType>([["POOL1", "pumpswap"]]),
    );
    assert.equal(out.length, 1);
    assert.match(out[0].label, /ABCDEFGH/);
  });
});
