/**
 * Branch coverage for multi-asset.ts that k6-multi-asset.test.ts does not take: fixed-price parsing, row validation,
 * registryRowProblems, observation-hint fallbacks, refresh-state fallbacks, accrual pruning.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/multi-asset-branches.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetSource, MarketEntry } from "./registry.ts";
import {
  MAX_OBSERVATION_HINTS,
  SINGLE_ASSET_OBSERVATION,
  accrueCrankCuFor,
  assetSourceProblem,
  bindObservationRegistry,
  decodeAssetRefreshStates,
  decodeMarketRefreshStateFor,
  getMarketAccrual,
  isMultiAssetEntry,
  isMultiAssetMarket,
  laggingAssets,
  multiAssetKey,
  observationAssetsFor,
  observationHints,
  parseFixedPriceE6,
  priceUnitsOf,
  priceUnitsOfRegistry,
  pruneMarketAccrual,
  recordMarketAccrual,
  refreshStateForMarket,
  registryRowProblems,
  resetMultiAssetState,
  sampleAssetAccrual,
  validateMultiAssetEntry,
} from "./multi-asset.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import { detectLayout, engineSlotBase } from "./market-layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const market = new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", "k6-2xhs-market-v22.b64"), "utf8").trim(), "base64"));

const MKT = "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw";
const MKT2 = "3vW8VARnfB4y3QdJaWYebSv5WQvChnAHFL3MNLSH4JAy";
const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";

const pool = (i: number, extra: Partial<AssetSource> = {}): AssetSource => ({ assetIndex: i, source: "pool", poolAddress: POOL, dexType: "meteora-dlmm", ...extra });
const fixed = (i: number, p: string | number = "100000000", extra: Partial<AssetSource> = {}): AssetSource => ({ assetIndex: i, source: "fixed", fixedPriceE6: p, ...extra });
const row = (assets?: AssetSource[], extra: Partial<MarketEntry> = {}): MarketEntry =>
  ({ label: "L", marketAddress: MKT, lpPortfolio: "x", assetIndex: 0, poolAddress: POOL, dexType: "raydium-clmm", ...(assets ? { assets } : {}), ...extra }) as MarketEntry;

/** Copy of the real market with asset `i`'s slot_last / lifecycle overwritten. */
function patched(i: number, o: { slotLast?: bigint; lifecycle?: number }): Uint8Array {
  const d = new Uint8Array(market);
  const det = detectLayout(d);
  assert.ok(det.known);
  const base = engineSlotBase(det.layout, i);
  if (o.slotLast !== undefined) new DataView(d.buffer).setBigUint64(base + det.layout.asset.slotLast, o.slotLast, true);
  if (o.lifecycle !== undefined) d[base + det.layout.asset.lifecycle] = o.lifecycle;
  return d;
}

beforeEach(() => resetMultiAssetState());
afterEach(() => resetMultiAssetState());

describe("multi-asset small helpers", () => {
  it("multiAssetKey / isMultiAssetEntry", () => {
    assert.equal(multiAssetKey(MKT, 3), `${MKT}#3`);
    assert.equal(isMultiAssetEntry({}), false);
    assert.equal(isMultiAssetEntry({ assets: [] }), false);
    assert.equal(isMultiAssetEntry({ assets: [fixed(0)] }), true);
  });

  it("parseFixedPriceE6: safe positive integer number, decimal string (trimmed), everything else null", () => {
    assert.equal(parseFixedPriceE6(5), 5n);
    assert.equal(parseFixedPriceE6(0), null);
    assert.equal(parseFixedPriceE6(-3), null);
    assert.equal(parseFixedPriceE6(1.5), null);
    assert.equal(parseFixedPriceE6(Number.MAX_SAFE_INTEGER + 1), null);
    assert.equal(parseFixedPriceE6(" 123 "), 123n);
    assert.equal(parseFixedPriceE6("0"), null);
    assert.equal(parseFixedPriceE6("0000"), null);
    assert.equal(parseFixedPriceE6("-1"), null);
    assert.equal(parseFixedPriceE6("1.5"), null);
    assert.equal(parseFixedPriceE6(""), null);
    assert.equal(parseFixedPriceE6(10n), null);
    assert.equal(parseFixedPriceE6(undefined), null);
  });

  it("observationHints: oracle leg on the first hint only; CU helpers clamp to the single-asset base", () => {
    assert.deepEqual(observationHints([0, 2, 4], 3), [
      { assetIndex: 0, oracleAccounts: 3 },
      { assetIndex: 2, oracleAccounts: 0 },
      { assetIndex: 4, oracleAccounts: 0 },
    ]);
    assert.equal(accrueCrankCuFor(100, 0), 100);
    assert.equal(accrueCrankCuFor(100, 1), 100);
    assert.equal(accrueCrankCuFor(100, 3), 100 + 2 * 40_000);
  });
});

describe("priceUnitsOf", () => {
  it("single-asset row carries mainnetCa / symbol when set, omits them when not; defaults for missing pool fields", () => {
    const withBoth = priceUnitsOf(row(undefined, { mainnetCa: "CA", symbol: "SOL" }))[0]!;
    assert.equal(withBoth.mainnetCa, "CA");
    assert.equal(withBoth.symbol, "SOL");
    assert.equal(withBoth.key, MKT);
    assert.equal(withBoth.multi, false);
    const bare = priceUnitsOf(row(undefined))[0]!;
    assert.equal("mainnetCa" in bare, false);
    assert.equal("symbol" in bare, false);
    const missing = priceUnitsOf({ label: "L", marketAddress: MKT, assetIndex: 0 } as MarketEntry)[0]!;
    assert.equal(missing.poolAddress, "");
    assert.equal(missing.dexType, "fixed");
  });

  it("multi-asset: sorted, invalid assets skipped, pool and fixed units with and without symbol / mainnetCa", () => {
    const units = priceUnitsOf(
      row([fixed(3, "7"), pool(1, { mainnetCa: "CA", symbol: "AAA" }), fixed(2, "9", { symbol: "SYN" }), pool(0), { assetIndex: 4, source: "fixed" }]),
    );
    assert.deepEqual(units.map((u) => u.assetIndex), [0, 1, 2, 3]);
    const [u0, u1, u2, u3] = units;
    assert.equal(u0!.label, "L [0]");
    assert.equal("mainnetCa" in u0!, false);
    assert.equal("symbol" in u0!, false);
    assert.equal(u1!.label, "L [1 AAA]");
    assert.equal(u1!.mainnetCa, "CA");
    assert.equal(u1!.symbol, "AAA");
    assert.equal(u1!.source, "pool");
    assert.equal(u2!.source, "fixed");
    assert.equal(u2!.symbol, "SYN");
    assert.equal(u2!.fixedPriceE6, 9n);
    assert.equal(u2!.poolAddress, `fixed:${MKT}#2`);
    assert.equal(u3!.fixedPriceE6, 7n);
    assert.equal("symbol" in u3!, false);
    assert.equal(priceUnitsOfRegistry([row(undefined), row([fixed(0)], { marketAddress: MKT2 })]).length, 2);
  });
});

describe("assetSourceProblem / validateMultiAssetEntry", () => {
  it("every rejection reason", () => {
    for (const bad of [-1, 1.5, MAX_OBSERVATION_HINTS, NaN]) assert.match(assetSourceProblem(fixed(bad))!, /not an integer in \[0, 16\)/);
    assert.match(assetSourceProblem({ assetIndex: 0, source: "fixed" })!, /positive integer fixedPriceE6/);
    assert.equal(assetSourceProblem(fixed(0)), null);
    assert.match(assetSourceProblem({ assetIndex: 0, source: "pool", dexType: "pumpswap" })!, /base58 poolAddress/);
    assert.match(assetSourceProblem(pool(0, { poolAddress: "short" }))!, /base58 poolAddress/);
    assert.match(assetSourceProblem(pool(0, { dexType: undefined }))!, /unknown dexType undefined/);
    assert.match(assetSourceProblem(pool(0, { dexType: "orca" as never }))!, /unknown dexType orca/);
    assert.equal(assetSourceProblem(pool(0)), null);
    assert.match(assetSourceProblem({ assetIndex: 2, source: "oracle" } as never)!, /asset 2: unknown source oracle/);
  });

  it("entry level: undefined ok, non-list / empty refused, problems and duplicates collected, over-16 refused", () => {
    assert.deepEqual(validateMultiAssetEntry({ label: "L", marketAddress: MKT }), []);
    assert.deepEqual(validateMultiAssetEntry({ label: "L", marketAddress: MKT, assets: [] }), ['L: "assets" must be a non-empty list']);
    assert.deepEqual(validateMultiAssetEntry({ label: "L", marketAddress: MKT, assets: "x" as never }), ['L: "assets" must be a non-empty list']);
    assert.deepEqual(validateMultiAssetEntry({ label: "L", marketAddress: MKT, assets: [fixed(0), pool(1)] }), []);
    const p = validateMultiAssetEntry({ label: "L", marketAddress: MKT, assets: [fixed(0), fixed(0), { assetIndex: 1, source: "fixed" }] });
    assert.equal(p.length, 2);
    assert.match(p[0]!, /asset 0 listed twice/);
    assert.match(p[1]!, /asset 1: fixed source/);
    const many = Array.from({ length: MAX_OBSERVATION_HINTS + 1 }, (_, i) => fixed(i % MAX_OBSERVATION_HINTS));
    assert.ok(validateMultiAssetEntry({ label: "L", marketAddress: MKT, assets: many }).some((x) => /17 assets > 16 observation hints/.test(x)));
  });
});

describe("registryRowProblems", () => {
  it("valid single and multi rows are clean", () => {
    assert.deepEqual(registryRowProblems([row(undefined), row([fixed(0)], { marketAddress: MKT2 })]), []);
  });

  it("bad / missing marketAddress, duplicates, bad pool / dex on single rows, multi row problems", () => {
    const p = registryRowProblems([
      row(undefined, { marketAddress: "nope" }),
      { marketAddress: undefined } as unknown as MarketEntry,
      null as unknown as MarketEntry,
      row(undefined),
      row(undefined),
      row(undefined, { marketAddress: MKT2, poolAddress: "zz", dexType: "orca" as never }),
      row(undefined, { marketAddress: POOL, dexType: undefined }),
      row([], { marketAddress: "11111111111111111111111111111111" }),
    ]);
    assert.ok(p.some((x) => /^L: marketAddress nope is not a public key/.test(x)));
    assert.ok(p.some((x) => /^\?: marketAddress undefined is not a public key/.test(x)));
    assert.ok(p.some((x) => /duplicate marketAddress/.test(x)));
    assert.ok(p.some((x) => /poolAddress zz is not a public key/.test(x)));
    assert.ok(p.some((x) => /unknown dexType orca/.test(x)));
    assert.ok(p.some((x) => /unknown dexType undefined/.test(x)));
    assert.ok(p.some((x) => /"assets" must be a non-empty list/.test(x)));
  });
});

describe("observation registry binding", () => {
  it("unbound: asset 0 only; bound: single row, unknown market, multi row (deduped, invalid dropped, capped), all-invalid fallback", () => {
    assert.equal(observationAssetsFor(MKT), SINGLE_ASSET_OBSERVATION);
    assert.equal(isMultiAssetMarket(MKT), false);
    const many = Array.from({ length: 20 }, (_, i) => fixed(i));
    const rows: MarketEntry[] = [
      row(undefined, { marketAddress: "SINGLE" }),
      row([fixed(2), fixed(0), fixed(2), fixed(1, "0")], { marketAddress: MKT }),
      row([{ assetIndex: 0, source: "fixed" }], { marketAddress: MKT2 }),
      row(many, { marketAddress: POOL }),
    ];
    bindObservationRegistry(() => rows);
    assert.equal(observationAssetsFor("SINGLE"), SINGLE_ASSET_OBSERVATION);
    assert.equal(observationAssetsFor("unknown"), SINGLE_ASSET_OBSERVATION);
    assert.deepEqual(observationAssetsFor(MKT), [0, 2]);
    assert.equal(isMultiAssetMarket(MKT), true);
    assert.equal(observationAssetsFor(MKT2), SINGLE_ASSET_OBSERVATION);
    assert.equal(observationAssetsFor(POOL).length, MAX_OBSERVATION_HINTS);
    bindObservationRegistry(null);
    assert.equal(observationAssetsFor(MKT), SINGLE_ASSET_OBSERVATION);
  });
});

describe("refresh state over several assets", () => {
  it("out-of-range assets are skipped; if none decode, the base (asset 0) state is returned", () => {
    assert.deepEqual(decodeAssetRefreshStates(market, [0, 99]).map((x) => x.assetIndex), [0]);
    assert.deepEqual(decodeMarketRefreshStateFor(market, [99]), decodeMarketRefreshState(market));
    assert.deepEqual(decodeMarketRefreshStateFor(market, []), decodeMarketRefreshState(market));
  });

  it("no Active/DrainOnly asset observed: slotLast falls back to asset 0; DrainOnly counts as active", () => {
    const base = decodeMarketRefreshState(market);
    const none = decodeMarketRefreshStateFor(patched(1, { lifecycle: 0 }), [1]);
    assert.equal(none.slotLast, base.slotLast);
    assert.equal(none.contributesToLossStale, false);
    const drain = patched(1, { lifecycle: 3, slotLast: base.slotLast - 10n });
    assert.equal(decodeMarketRefreshStateFor(drain, [0, 1]).slotLast, base.slotLast - 10n);
  });

  it("clock-stale asset sets contributesToLossStale; refreshStateForMarket follows the bound registry", () => {
    const base = decodeMarketRefreshState(market);
    const behind = patched(2, { slotLast: base.currentSlot - 1_000_000n });
    const st = decodeMarketRefreshStateFor(behind, [0, 1, 2]);
    assert.equal(st.contributesToLossStale, decodeMarketRefreshState(behind, 2).contributesToLossStale);
    assert.equal(st.slotLast, base.currentSlot - 1_000_000n);
    // unbound -> single-asset path
    assert.deepEqual(refreshStateForMarket(behind, MKT), decodeMarketRefreshState(behind));
    bindObservationRegistry(() => [row([fixed(0), fixed(1), fixed(2)])]);
    assert.deepEqual(refreshStateForMarket(behind, MKT), st);
  });
});

describe("accrual samples", () => {
  it("lag is 0 when the asset is ahead of the read, positive when behind; recorded only for multi-asset markets; prune and lagging filters", () => {
    const base = decodeMarketRefreshState(market);
    const ahead = sampleAssetAccrual(market, [0], base.slotLast - 5n, 1);
    assert.equal(ahead.assets[0]!.lagSlots, 0);
    const behind = sampleAssetAccrual(market, [0], base.slotLast + 400n, 1);
    assert.equal(behind.assets[0]!.lagSlots, 400);

    recordMarketAccrual(MKT, market, base.slotLast); // unbound: single-asset, not recorded
    assert.equal(getMarketAccrual(MKT), undefined);
    bindObservationRegistry(() => [row([fixed(0), fixed(1)]), row([fixed(0)], { marketAddress: MKT2 })]);
    recordMarketAccrual(MKT, market, base.slotLast + 500n, 7);
    recordMarketAccrual(MKT2, market, base.slotLast, 7);
    assert.equal(getMarketAccrual(MKT)!.atMs, 7);
    assert.ok(getMarketAccrual(MKT2));
    recordMarketAccrual(MKT, market, base.slotLast); // default atMs
    assert.ok(getMarketAccrual(MKT)!.atMs > 7);
    pruneMarketAccrual(new Set([MKT]));
    assert.ok(getMarketAccrual(MKT));
    assert.equal(getMarketAccrual(MKT2), undefined);
    assert.deepEqual(laggingAssets(undefined, 1), []);
  });

  it("recordMarketAccrual never throws on bad data", () => {
    bindObservationRegistry(() => [row([fixed(0), fixed(1)])]);
    assert.doesNotThrow(() => recordMarketAccrual(MKT, new Uint8Array(4), 1n));
    assert.equal(getMarketAccrual(MKT)?.assets.length ?? 0, 0);
  });

  it("laggingAssets: Active and DrainOnly at/over the threshold, Disabled excluded", () => {
    const sample = {
      readSlot: 1n,
      atMs: 1,
      assets: [
        { assetIndex: 0, lifecycle: 2, slotLast: 0n, lagSlots: 300, lossStale: false },
        { assetIndex: 1, lifecycle: 3, slotLast: 0n, lagSlots: 299, lossStale: false },
        { assetIndex: 2, lifecycle: 3, slotLast: 0n, lagSlots: 900, lossStale: false },
        { assetIndex: 3, lifecycle: 0, slotLast: 0n, lagSlots: 900, lossStale: false },
      ],
    };
    assert.deepEqual(laggingAssets(sample, 300), [0, 2]);
  });
});
