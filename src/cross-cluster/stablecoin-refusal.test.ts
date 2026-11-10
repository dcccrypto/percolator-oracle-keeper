/**
 * R6: stablecoin-underlying refusal at v2.2 market admission (flag KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS).
 * Run with: node --import tsx/esm --test src/cross-cluster/stablecoin-refusal.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileMarkets, refuseStablecoinUnderlyingsEnabled } from "./register-poll.ts";
import { STABLECOIN_MINTS, isStablecoinMint } from "./stablecoin-mints.ts";
import type { MarketEntry } from "./registry.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const mk = (a: string, mainnetCa?: string): MarketEntry =>
  ({ label: a, marketAddress: a, poolAddress: "P" + a, dexType: "pumpswap", assetIndex: 0, mainnetCa }) as MarketEntry;

describe("stablecoin mint list", () => {
  it("has the 32 mainnet mints and recognises USDC", () => {
    assert.equal(STABLECOIN_MINTS.size, 32);
    assert.ok(isStablecoinMint(USDC));
    assert.ok(!isStablecoinMint(BONK));
    assert.ok(!isStablecoinMint(undefined));
  });
});

describe("env flag", () => {
  it("defaults off; only '1' enables", () => {
    assert.equal(refuseStablecoinUnderlyingsEnabled({}), false);
    assert.equal(refuseStablecoinUnderlyingsEnabled({ KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS: "0" }), false);
    assert.equal(refuseStablecoinUnderlyingsEnabled({ KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS: "1" }), true);
  });
});

describe("reconcileMarkets stablecoin refusal", () => {
  it("flag OFF: a new stable-underlying market is admitted (no change)", () => {
    const r = { markets: [] as MarketEntry[] };
    const out = reconcileMarkets(r, [mk("S", USDC)], new Map(), 3, false);
    assert.deepEqual(out.added, ["S"]);
    assert.equal(r.markets.length, 1);
  });

  it("flag ON: a new stable-underlying market is refused", () => {
    const r = { markets: [] as MarketEntry[] };
    const out = reconcileMarkets(r, [mk("S", USDC)], new Map(), 3, true);
    assert.deepEqual(out.added, []);
    assert.equal(r.markets.length, 0);
  });

  it("flag ON: an already-admitted stable market stays tracked (not evicted) and still updates", () => {
    const r = { markets: [mk("S", USDC)] };
    const absences = new Map<string, number>();
    const out = reconcileMarkets(r, [mk("S", USDC)], absences, 3, true);
    assert.deepEqual(out.removed, []);
    assert.equal(r.markets.length, 1);
    const changed = { ...mk("S", USDC), poolAddress: "NEWPOOL" } as MarketEntry;
    const out2 = reconcileMarkets(r, [changed], absences, 3, true);
    assert.deepEqual(out2.updated, ["S"]);
    assert.equal(r.markets[0].poolAddress, "NEWPOOL");
  });

  it("flag ON: non-stable markets are admitted; missing mainnetCa fails open", () => {
    const r = { markets: [] as MarketEntry[] };
    const out = reconcileMarkets(r, [mk("N", BONK), mk("U", undefined)], new Map(), 3, true);
    assert.deepEqual(out.added.sort(), ["N", "U"]);
  });

  it("flag ON: refusing one stable does not block other new markets in the same cycle", () => {
    const r = { markets: [] as MarketEntry[] };
    const out = reconcileMarkets(r, [mk("S", USDC), mk("N", BONK)], new Map(), 3, true);
    assert.deepEqual(out.added, ["N"]);
  });
});
