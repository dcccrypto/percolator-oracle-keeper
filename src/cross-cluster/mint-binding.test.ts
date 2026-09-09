/**
 * #100 — the market's token must be one side of the pool being priced.
 *
 * The defect this closes: `dex_pool_address` is creator-supplied, and nothing
 * checked that the pool prices the token the market is FOR. `baseMint` was parsed
 * and used only to fetch decimals. A pool for an entirely different token was
 * accepted as the AuthMark every trade settles against.
 *
 * Also pinned here: `mainnet_ca` was already SELECTed by db-markets and then
 * dropped when building the entry, which is why the value existed but the check
 * could not. rowsToEntries carrying it is asserted, because the binding is
 * silently a no-op without it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { checkMintBinding } from "./price-reader.ts";
import { rowsToEntries } from "./db-markets.ts";

const TOKEN = new PublicKey("So11111111111111111111111111111111111111112");
const USDC  = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OTHER = new PublicKey("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");

describe("#100 mint binding", () => {
  it("accepts when the market token is the pool's BASE mint", () => {
    assert.deepEqual(checkMintBinding(TOKEN.toBase58(), TOKEN, USDC), { ok: true });
  });

  it("accepts when it is the QUOTE mint — a WSOL/TOKEN pool is legitimate", () => {
    assert.deepEqual(checkMintBinding(TOKEN.toBase58(), USDC, TOKEN), { ok: true });
  });

  it("REJECTS a pool for an entirely different token", () => {
    const r = checkMintBinding(TOKEN.toBase58(), OTHER, USDC);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /WRONG TOKEN/);
    assert.match((r as { reason: string }).reason, /Refusing to use it as the AuthMark/);
  });

  it("accepts when mainnetCa is absent — pre-seeded entries predate the column", () => {
    assert.deepEqual(checkMintBinding(undefined, OTHER, USDC), { ok: true });
  });

  it("is exact, not a prefix match", () => {
    const truncated = TOKEN.toBase58().slice(0, 30);
    assert.equal(checkMintBinding(truncated, TOKEN, USDC).ok, false);
  });
});

describe("#100 mainnet_ca must survive the DB -> entry mapping", () => {
  const dexByPool = new Map([["POOL1", "raydium-clmm" as const]]);

  it("carries mainnet_ca onto the entry", () => {
    const [e] = rowsToEntries(
      [{
        slab_address: "SLAB1", dex_pool_address: "POOL1", symbol: "TKN",
        mint_address: "MINT1", mainnet_ca: TOKEN.toBase58(),
      } as never],
      dexByPool as never,
    );
    assert.equal(
      e.mainnetCa, TOKEN.toBase58(),
      "without this the binding is silently a no-op — the column was already queried and then dropped",
    );
  });

  it("leaves mainnetCa undefined when the DB has null", () => {
    const [e] = rowsToEntries(
      [{
        slab_address: "SLAB1", dex_pool_address: "POOL1", symbol: "TKN",
        mint_address: "MINT1", mainnet_ca: null,
      } as never],
      dexByPool as never,
    );
    assert.equal(e.mainnetCa, undefined);
  });
});
