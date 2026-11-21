/**
 * Differential pin for the PublicKey-cache / byte-compare perf change in price-reader.ts.
 * The digests below were produced by the code BEFORE the change (base 33eda56, via scripts/bench-price-reader.ts)
 * over the same deterministic fixture: prices (e6), e12 prices, quote reserves and refusal strings (skipReasons).
 * Any behaviour drift changes the digest.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/price-reader-differential.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  checkMintBinding,
  raydiumPriceIsNotUsd,
  readAllPoolPricesE6,
  resetSlotWatermarksForTests,
} from "./price-reader.ts";
import { buildBoard, fakeConn } from "./price-reader-fixture.ts";

beforeEach(() => resetSlotWatermarksForTests());

const PINNED: Record<number, string> = { 50: "df539bb3b15d0026", 200: "1337b3d53db949c8" };

async function run(n: number) {
  const { accts, entries, dec, refPool } = buildBoard(n);
  const conn = fakeConn(accts, `https://diff-${n}-${Math.random()}`);
  const skip = new Map<string, string>(), e12 = new Map<string, bigint>(), qr = new Map<string, bigint>();
  const out = await readAllPoolPricesE6(conn, entries, dec, refPool, skip, e12, qr);
  const digest = createHash("sha256")
    .update(JSON.stringify([[...out], [...skip], [...e12], [...qr]], (_, v) => (typeof v === "bigint" ? v.toString() : v)))
    .digest("hex").slice(0, 16);
  return { out, skip, digest };
}

describe("price-reader differential (identical to pre-change output)", () => {
  for (const n of [50, 200]) {
    it(`N=${n}: prices, e12, reserves and refusal strings match the pre-change digest`, async () => {
      const r = await run(n);
      assert.ok(r.out.size > 0 && r.skip.size > 0, "fixture must exercise both prices and refusals");
      assert.equal(r.digest, PINNED[n]);
    });
  }

  it("repeated cycles (warm cache) give the same digest as the first", async () => {
    const a = await run(50);
    const b = await run(50);
    assert.equal(a.digest, b.digest);
  });

  it("pins the refusal strings checkMintBinding produced before", () => {
    const base = new PublicKey("So11111111111111111111111111111111111111112");
    const quote = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const other = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
    assert.deepEqual(checkMintBinding(other, base, quote), {
      ok: false,
      reason:
        `pool prices the WRONG TOKEN: market mainnet_ca ${other} is neither base ${base.toBase58()} nor quote ${quote.toBase58()}. ` +
        `Refusing to use it as the AuthMark.`,
    });
    assert.equal(checkMintBinding(quote.toBase58(), base, quote).ok, false);
    assert.equal(checkMintBinding("not base58 !!", base, quote).ok, false);
    assert.equal(checkMintBinding(base.toBase58(), base, quote).ok, true);
  });

  it("raydiumPriceIsNotUsd: USDC/USDT usd, others not", () => {
    assert.equal(raydiumPriceIsNotUsd(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")), false);
    assert.equal(raydiumPriceIsNotUsd(new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")), false);
    assert.equal(raydiumPriceIsNotUsd(new PublicKey("So11111111111111111111111111111111111111112")), true);
  });
});
