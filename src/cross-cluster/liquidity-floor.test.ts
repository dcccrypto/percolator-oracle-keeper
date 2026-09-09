/**
 * #100 — minimum-liquidity floor for PumpSwap pools.
 *
 * The floor answers "how much USD does it take to move this mark", so it measures
 * the QUOTE reserve — what an attacker must put up. Base-side depth is denominated
 * in the very token whose price is in doubt and cannot bound the cost of moving it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pumpswapQuoteDepthUsdE6 } from "./price-reader.ts";

/** Build a minimal SPL token-account buffer with `amount` at offset 64. */
function vault(amount: bigint, len = 165): Uint8Array {
  const b = new Uint8Array(len);
  // A deliberately-truncated buffer has no room for the amount field; that is the
  // case under test, so do not write past the end while building it.
  if (len >= 72) {
    const dv = new DataView(b.buffer);
    dv.setUint32(64, Number(amount & 0xffff_ffffn), true);
    dv.setUint32(68, Number((amount >> 32n) & 0xffff_ffffn), true);
  }
  return b;
}

describe("#100 pumpswapQuoteDepthUsdE6", () => {
  it("USD-stable quote: 1,500 USDC (6dp) -> $1,500", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1_500_000_000n), 6, false, undefined), 1_500_000_000n);
  });

  it("WSOL quote: 10 SOL (9dp) at $200 -> $2,000", () => {
    assert.equal(
      pumpswapQuoteDepthUsdE6(vault(10_000_000_000n), 9, true, 200_000_000n),
      2_000_000_000n,
    );
  });

  it("returns NULL for a WSOL pool with no SOL/USD rate — unknown, not fine", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(10_000_000_000n), 9, true, undefined), null);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(10_000_000_000n), 9, true, 0n), null);
  });

  it("returns NULL for a truncated vault buffer", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(1n, 40), 6, false, undefined), null);
  });

  it("an empty vault is zero depth, not unknown", () => {
    assert.equal(pumpswapQuoteDepthUsdE6(vault(0n), 6, false, undefined), 0n);
  });

  it("handles a 64-bit amount without truncating the high word", () => {
    // 2^33 raw units at 0dp — exercises the high u32 half.
    assert.equal(pumpswapQuoteDepthUsdE6(vault(8_589_934_592n), 0, false, undefined),
      8_589_934_592n * 1_000_000n);
  });

  it("a thin pool measures far below a plausible floor", () => {
    const depth = pumpswapQuoteDepthUsdE6(vault(25_000_000n), 6, false, undefined); // $25
    assert.equal(depth, 25_000_000n);
    assert.ok(depth! < 1_000_000_000n, "$25 is below a $1,000 floor");
  });
});

describe("#100 the floor must be applied on BOTH read paths", () => {
  /**
   * Structural, and honest about it — same reasoning as the binding guard.
   * The binding shipped on the wrong path once already (#110); this pins that the
   * floor cannot repeat it.
   */
  it("every computeDexSpotPriceE6('pumpswap') site is preceded by a floor check", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "price-reader.ts"),
      "utf8",
    );
    const lines = src.split("\n");
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('"pumpswap",') && lines[Math.max(0, 0)] !== undefined)
      .filter(({ i }) => lines.slice(Math.max(0, i - 3), i + 1).join("\n").includes("computeDexSpotPriceE6"));

    assert.equal(sites.length, 2, `expected 2 pumpswap price sites (both read paths), found ${sites.length}`);

    const unguarded = sites.filter(({ i }) =>
      !lines.slice(Math.max(0, i - 30), i).join("\n").includes("MIN_POOL_LIQUIDITY_USD_E6"),
    );
    assert.deepEqual(
      unguarded.map(({ i }) => `line ${i + 1}`),
      [],
      "a pumpswap price computed without a preceding liquidity-floor check — that path " +
        "would accept a thin creator-supplied pool as the AuthMark",
    );
  });
});
