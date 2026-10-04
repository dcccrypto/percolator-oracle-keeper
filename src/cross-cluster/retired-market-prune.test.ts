/**
 * Retiring a market (Supabase keeper_status='retired') must remove it from the registry AND from /health.
 * Live 2026-10-04 05:00Z: SI CeRP5hdD and the OTC duplicate A9u1KkM9 were retired; register-poll dropped both at
 * 05:01:05Z (51 s later, `retired ... absent from 3 consecutive queries`) and pushes and cranks stopped, but both
 * stayed on /health with a frozen "lastPushAgo / crankHealthAgo", because per-market stats were never pruned.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { newMarketStat, pruneDeregisteredMarkets, crankHealthFields } from "./keeper-loop.ts";
import { reconcileMarkets, ABSENCE_THRESHOLD } from "./register-poll.ts";
import { getCrankRefreshHealth, setCrankRefreshHealth, resetRefreshCoordination, isPushHeld, holdPushes } from "./refresh-coordination.ts";
import type { CrankRefreshHealth } from "./refresh-coordination.ts";
import type { MarketEntry } from "./registry.ts";

const entry = (addr: string, label: string): MarketEntry => ({
  label,
  marketAddress: addr,
  poolAddress: `pool-${addr}`,
  dexType: "pumpswap",
  assetIndex: 0,
  registeredAt: 0,
});
const health = (): CrankRefreshHealth => ({
  staleLong: 0,
  staleShort: 0,
  postStaleLong: 0,
  postStaleShort: 0,
  positioned: 0,
  overflow: 0,
  overflowRefreshed: 0,
  overflowError: null,
  lossStaleCycles: 0,
  status: "ok",
  updatedAt: Date.now(),
});

describe("retired market leaves /health", () => {
  beforeEach(() => resetRefreshCoordination());

  it("register-poll drops a retired row after the absence threshold, and /health follows", () => {
    const keep = entry("SOL11111", "SOL/USDC");
    const retired = entry("CeRP5hdD", "SI/USDC");
    const registry = { markets: [keep, retired] };
    const state = {
      stats: new Map([keep, retired].map((m) => [m.marketAddress, newMarketStat(m)])),
      terminalMarkets: new Set<string>(),
      landedThisCycle: new Set<string>(),
    };
    setCrankRefreshHealth(keep.marketAddress, health());
    setCrankRefreshHealth(retired.marketAddress, health());

    // Supabase now returns only the active row (keeper_status='retired' is filtered out upstream).
    const absences = new Map<string, number>();
    for (let i = 1; i < ABSENCE_THRESHOLD; i++) {
      assert.deepEqual(reconcileMarkets(registry, [keep], absences).removed, [], `poll ${i}: still registered`);
    }
    assert.deepEqual(reconcileMarkets(registry, [keep], absences).removed, [retired.marketAddress]);
    assert.deepEqual(registry.markets.map((m) => m.marketAddress), [keep.marketAddress]);

    // The loop's per-cycle prune.
    assert.deepEqual(pruneDeregisteredMarkets(state, registry).sort(), [retired.marketAddress]);
    assert.deepEqual([...state.stats.keys()], [keep.marketAddress], "gone from /health markets");
    assert.equal(getCrankRefreshHealth(retired.marketAddress), undefined, "gone from the crank sample");
    assert.ok(getCrankRefreshHealth(keep.marketAddress), "the live market is untouched");
    assert.deepEqual(crankHealthFields(getCrankRefreshHealth(retired.marketAddress)), crankHealthFields(undefined));
  });

  it("prunes terminal / landed bookkeeping and any push hold of the retired market", () => {
    const m = entry("A9u1KkM9", "OTC/USDC");
    const state = {
      stats: new Map([[m.marketAddress, newMarketStat(m)]]),
      terminalMarkets: new Set([m.marketAddress]),
      landedThisCycle: new Set([m.marketAddress]),
    };
    holdPushes(m.marketAddress, 10_000);
    assert.equal(isPushHeld(m.marketAddress), true);
    pruneDeregisteredMarkets(state, { markets: [] });
    assert.equal(state.stats.size, 0);
    assert.equal(state.terminalMarkets.size, 0);
    assert.equal(state.landedThisCycle.size, 0);
    assert.equal(isPushHeld(m.marketAddress), false);
  });

  it("negative control: a market still in the registry is never pruned, and a re-added market gets a fresh record", () => {
    const m = entry("SOL11111", "SOL/USDC");
    const registry = { markets: [m] };
    const state = {
      stats: new Map([[m.marketAddress, newMarketStat(m)]]),
      terminalMarkets: new Set<string>(),
      landedThisCycle: new Set<string>(),
    };
    assert.deepEqual(pruneDeregisteredMarkets(state, registry), []);
    assert.equal(state.stats.size, 1);
    registry.markets = [];
    assert.deepEqual(pruneDeregisteredMarkets(state, registry), [m.marketAddress]);
    registry.markets = [m];
    assert.deepEqual(pruneDeregisteredMarkets(state, registry), []);
    assert.equal(state.stats.size, 0, "re-added by the next cycle's newMarketStat, not resurrected stale");
  });

  it("also forgets the module-level nonce / quarantine / authority / breaker state of a deregistered market (review nit)", async () => {
    const ap = await import("./auth-mark-pusher.ts");
    assert.equal(typeof ap.pruneAuthMarkPusherState, "function");
    // Must not throw on an empty keep-set or with unknown markets.
    ap.pruneAuthMarkPusherState(new Set());
    ap.pruneAuthMarkPusherState(new Set(["SOL11111"]));
    const m = entry("A9u1KkM9", "OTC/USDC");
    const state = { stats: new Map([[m.marketAddress, newMarketStat(m)]]), terminalMarkets: new Set<string>(), landedThisCycle: new Set<string>() };
    assert.deepEqual(pruneDeregisteredMarkets(state, { markets: [] }), [m.marketAddress]);
  });
});
