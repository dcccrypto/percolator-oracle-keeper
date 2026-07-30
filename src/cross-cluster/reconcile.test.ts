/**
 * Registry reconciliation.
 *
 * register-poll was append-only, so a market removed upstream kept being priced
 * from the local copy forever — observed 2026-07-29: the feed served 1 market,
 * registry.json held 3, and all 3 were pushed every ~7s, two of them blocklisted
 * in both repos.
 *
 * The absence threshold is the safety valve, and these tests are the reason it
 * can be trusted: dropping is what makes this dangerous, so "does NOT drop
 * early" and "resets on reappearance" matter more than the happy path.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/reconcile.test.ts
 * Or via:   pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileMarkets } from "./register-poll.ts";
import type { MarketEntry } from "./registry.ts";

const mk = (a: string): MarketEntry =>
  ({
    label: a,
    marketAddress: a,
    poolAddress: "P" + a,
    dexType: "pumpswap",
    assetIndex: 0,
  }) as MarketEntry;

const reg = (...addrs: string[]) => ({ markets: addrs.map(mk) });

describe("reconcileMarkets", () => {
  it("adds a market present in desired but missing locally", () => {
    const r = reg();
    const out = reconcileMarkets(r, [mk("A")], new Map(), 3);
    assert.deepEqual(out.added, ["A"]);
    assert.deepEqual(out.removed, []);
    assert.equal(r.markets.length, 1);
  });

  it("is a no-op when local already matches desired", () => {
    const r = reg("A");
    const out = reconcileMarkets(r, [mk("A")], new Map(), 3);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.removed, []);
    assert.equal(r.markets.length, 1);
  });

  it("does NOT drop a missing market before the threshold", () => {
    const r = reg("A");
    const absences = new Map<string, number>();
    for (let i = 0; i < 2; i++) reconcileMarkets(r, [], absences, 3);
    assert.equal(r.markets.length, 1, "dropped before the threshold");
  });

  it("drops a market on the Nth consecutive absence, not before", () => {
    const r = reg("A");
    const absences = new Map<string, number>();
    assert.deepEqual(reconcileMarkets(r, [], absences, 3).removed, []);
    assert.deepEqual(reconcileMarkets(r, [], absences, 3).removed, []);
    assert.deepEqual(reconcileMarkets(r, [], absences, 3).removed, ["A"]);
    assert.equal(r.markets.length, 0);
  });

  it("resets the absence counter when a market reappears", () => {
    // Without the reset, intermittent absences would accumulate across
    // unrelated cycles and eventually retire a perfectly live market.
    const r = reg("A");
    const absences = new Map<string, number>();
    reconcileMarkets(r, [], absences, 3);
    reconcileMarkets(r, [], absences, 3);
    reconcileMarkets(r, [mk("A")], absences, 3); // reappears
    reconcileMarkets(r, [], absences, 3);
    reconcileMarkets(r, [], absences, 3);
    assert.equal(r.markets.length, 1, "counter did not reset on reappearance");
  });

  it("adds and drops independently in the same pass", () => {
    const r = reg("OLD");
    const absences = new Map<string, number>([["OLD", 2]]);
    const out = reconcileMarkets(r, [mk("NEW")], absences, 3);
    assert.deepEqual(out.added, ["NEW"]);
    assert.deepEqual(out.removed, ["OLD"]);
    assert.deepEqual(r.markets.map((m) => m.marketAddress), ["NEW"]);
  });

  it("retires the real-world case: 3 local, 1 desired", () => {
    // The exact shape observed on 2026-07-29.
    const r = reg("KEEP", "RETIRED1", "RETIRED2");
    const absences = new Map<string, number>();
    for (let i = 0; i < 3; i++) reconcileMarkets(r, [mk("KEEP")], absences, 3);
    assert.deepEqual(r.markets.map((m) => m.marketAddress), ["KEEP"]);
  });

  it("does not mutate the desired entries it adopts", () => {
    const desired = mk("A");
    const r = reg();
    reconcileMarkets(r, [desired], new Map(), 3);
    assert.equal(r.markets[0].marketAddress, desired.marketAddress);
    assert.equal(r.markets[0].dexType, "pumpswap");
  });
});
