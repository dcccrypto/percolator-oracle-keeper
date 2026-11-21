/**
 * Differential: the memoised-PublicKey / byte-compare price-reader guards must behave exactly like the original
 * base58-string implementations (same booleans, same refusal messages), and the batch read must be identical on a
 * cold and a warm key cache, including malformed rows.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/price-reader-keys-differential.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { WSOL_MINT } from "@percolatorct/sdk";
import {
  checkMintBinding,
  poolIsSolUsd,
  quoteIsNotUsdOrWsol,
  raydiumPriceIsNotUsd,
  readAllPoolPricesE6,
  resetSlotWatermarksForTests,
} from "./price-reader.ts";

beforeEach(() => resetSlotWatermarksForTests());

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const RAYDIUM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

// ── The ORIGINAL implementations, verbatim from 12b4d5a ──
const OLD_STABLES = new Set([USDC.toBase58(), USDT.toBase58()]);
const oldNotUsd = (q: PublicKey) => !OLD_STABLES.has(q.toBase58());
const oldPoolIsSolUsd = (b: PublicKey, q: PublicKey) => b.equals(WSOL_MINT) && !oldNotUsd(q);
const oldQuoteNotUsdOrWsol = (q: PublicKey) => !q.equals(WSOL_MINT) && oldNotUsd(q);
function oldBinding(mainnetCa: string | undefined, baseMint: PublicKey, quoteMint: PublicKey) {
  if (!mainnetCa) return { ok: true };
  const base = baseMint.toBase58();
  const quote = quoteMint.toBase58();
  if (mainnetCa === base) return { ok: true };
  return {
    ok: false,
    reason:
      mainnetCa === quote
        ? `pool prices the WRONG TOKEN: market mainnet_ca ${mainnetCa} is the pool's QUOTE, the price is for ` +
          `base ${base}. Refusing to use it as the AuthMark.`
        : `pool prices the WRONG TOKEN: market mainnet_ca ${mainnetCa} is neither ` +
          `base ${base} nor quote ${quote}. Refusing to use it as the AuthMark.`,
  };
}

let s = 0x1234abcd;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
const randKey = () => new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(rnd() * 256)));

describe("guards: old (base58 string) vs new (byte compare)", () => {
  it("same result over fixture + random mints", () => {
    const pool = [USDC, USDT, WSOL_MINT, PublicKey.default, ...Array.from({ length: 300 }, randKey)];
    for (const q of pool) {
      assert.equal(raydiumPriceIsNotUsd(q), oldNotUsd(q));
      assert.equal(quoteIsNotUsdOrWsol(q), oldQuoteNotUsdOrWsol(q));
      for (const b of [WSOL_MINT, USDC, pool[5]]) assert.equal(poolIsSolUsd(b, q), oldPoolIsSolUsd(b, q));
    }
  });

  it("checkMintBinding: same ok/refusal messages, incl. malformed and absent mainnet_ca", () => {
    const keys = [USDC, WSOL_MINT, ...Array.from({ length: 60 }, randKey)];
    const cas: Array<string | undefined> = [undefined, "", "not-base58-!!", "abc", ...keys.map((k) => k.toBase58())];
    for (const ca of cas) {
      for (const b of keys.slice(0, 8)) {
        for (const q of keys.slice(0, 8)) {
          assert.deepEqual(checkMintBinding(ca, b, q), oldBinding(ca, b, q), `${ca} ${b.toBase58()} ${q.toBase58()}`);
        }
      }
    }
  });
});

function raydium(accts: Map<string, Buffer>, base: PublicKey, quote: PublicKey): string {
  const pool = Keypair.generate().publicKey;
  const b = Buffer.alloc(300);
  base.toBuffer().copy(b, 73);
  quote.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  const target = (150_000_000n << 128n) / 1_000_000_000n;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(x >> 64n, 261);
  accts.set(pool.toBase58(), b);
  return pool.toBase58();
}

describe("batch read: cold vs warm cache, refusals and messages unchanged", () => {
  it("prices, skip set and log lines identical across two cycles", async () => {
    const accts = new Map<string, Buffer>();
    const good = Keypair.generate().publicKey;
    const wrongTok = Keypair.generate().publicKey;
    const entries: Parameters<typeof readAllPoolPricesE6>[1] = [];
    const goodPool = raydium(accts, good, USDC);
    entries.push({ poolAddress: goodPool, dexType: "raydium-clmm", label: "GOOD", symbol: "GOOD", mainnetCa: good.toBase58() });
    const nonUsd = raydium(accts, good, Keypair.generate().publicKey);
    entries.push({ poolAddress: nonUsd, dexType: "raydium-clmm", label: "NONUSD", symbol: "NONUSD", mainnetCa: good.toBase58() });
    const wrong = raydium(accts, good, USDC);
    entries.push({ poolAddress: wrong, dexType: "raydium-clmm", label: "WRONG", symbol: "WRONG", mainnetCa: wrongTok.toBase58() });
    entries.push({ poolAddress: "not-a-pubkey", dexType: "raydium-clmm", label: "BAD", symbol: "BAD", mainnetCa: undefined });
    const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });
    const conn = {
      rpcEndpoint: "https://ep-keys-diff",
      getAccountInfoAndContext: (k: PublicKey) => Promise.resolve(ctx(null)),
      getMultipleAccountsInfoAndContext: (ks: PublicKey[]) =>
        Promise.resolve(ctx(ks.map((k) => (accts.has(k.toBase58()) ? { owner: RAYDIUM_OWNER, data: accts.get(k.toBase58())! } : null)))),
    } as unknown as Connection;

    const run = async () => {
      const logs: string[] = [];
      const ow = console.warn, oe = console.error;
      console.warn = (...a: unknown[]) => void logs.push("W " + a.join(" "));
      console.error = (...a: unknown[]) => void logs.push("E " + a.join(" "));
      try {
        resetSlotWatermarksForTests();
        const out = await readAllPoolPricesE6(conn, entries, new Map());
        return { out: [...out].map(([k, v]) => `${k}=${v}`), logs };
      } finally {
        console.warn = ow;
        console.error = oe;
      }
    };
    const cold = await run();
    const warm = await run();
    assert.deepEqual(warm, cold);
    assert.deepEqual(cold.out, [`${goodPool}=149999999`]);
    assert.ok(cold.logs.includes("W [price-reader] skipping BAD: malformed poolAddress not-a-pubkey"));
    assert.ok(
      cold.logs.includes(
        `E [price-reader] WRONG: WRONG-TOKEN pool refused — mainnet_ca ${wrongTok.toBase58()} is neither base nor quote of ${wrong}`,
      ),
    );
  });
});
