/**
 * keeper-loop.ts decision helpers: which markets count as landed, dropped, held
 * back or still pushable after a cycle. Pure functions only, no RPC.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceNoPushStreaks,
  countPushableMarkets,
  deadlineBypass,
  fixedPushFor,
  landedPushes,
  newMarketStat,
  noteDepthAttempt,
  publishLandedTicks,
  recordMultiAssetPushOutcome,
  recordRawPrice,
  withheldFromPush,
} from "./keeper-loop.ts";
import { pushGenerationKey } from "./auth-mark-pusher.ts";
import type { PushDeadline } from "./push-deadline.ts";

const M1 = "Market1111111111111111111111111111111111111";
const M2 = "Market2222222222222222222222222222222222222";

describe("landedPushes", () => {
  const pushes = [
    { marketAddress: M1, priceE6: 1n },
    { marketAddress: M2, priceE6: 2n },
  ];
  it("is empty when the batch has no signature (nothing landed)", () => {
    assert.deepEqual(landedPushes(pushes, { pushedMarkets: [M1, M2], signature: null }), []);
  });
  it("keeps only markets the batch pushed and drops terminal ones", () => {
    const out = landedPushes(pushes, { pushedMarkets: [M1, M2], terminalMarkets: [M2], signature: "sig" });
    assert.deepEqual(out.map((p) => p.marketAddress), [M1]);
  });
  it("a partial batch lands only the pushed market", () => {
    const out = landedPushes(pushes, { pushedMarkets: [M2], signature: "sig" });
    assert.deepEqual(out.map((p) => p.marketAddress), [M2]);
  });
  it("multi-asset: judged by the asset's generation key, not its market", () => {
    const multi = [
      { marketAddress: M1, priceE6: 1n, assetIndex: 0, multi: true },
      { marketAddress: M1, priceE6: 1n, assetIndex: 1, multi: true },
    ];
    const key1 = pushGenerationKey({ marketAddress: M1, assetIndex: 1 });
    const out = landedPushes(multi, { pushedMarkets: [M1], pushedKeys: [key1], signature: "sig" });
    assert.deepEqual(out.map((p) => p.assetIndex), [1]);
  });
});

describe("publishLandedTicks", () => {
  const push = [{ marketAddress: M1, assetIndex: 0, priceE6: 5n }];
  it("does not publish when nothing landed", () => {
    let calls = 0;
    const publisher = { enabled: true, publish: () => void calls++ } as never;
    publishLandedTicks(publisher, push, { pushedMarkets: [], signature: "sig" }, () => null, 1n, 1);
    assert.equal(calls, 0);
  });
  it("publishes the landed mark with its raw price", () => {
    let seen: unknown[] = [];
    const publisher = { enabled: true, publish: (i: unknown[]) => void (seen = i) } as never;
    publishLandedTicks(publisher, push, { pushedMarkets: [M1], signature: "sig" }, () => 7n, 1n, 1);
    assert.deepEqual(seen, [{ marketAddress: M1, assetIndex: 0, markE6: 5n, oracleE6: 7n }]);
  });
  it("swallows a throwing publisher", () => {
    const publisher = {
      enabled: true,
      publish: () => {
        throw new Error("boom");
      },
    } as never;
    assert.doesNotThrow(() => publishLandedTicks(publisher, push, { pushedMarkets: [M1], signature: "sig" }, () => 1n, 1n, 1));
  });
});

describe("withheldFromPush", () => {
  it("is false with no gate", () => assert.equal(withheldFromPush(M1, undefined), false));
  it("follows the gate", () => {
    assert.equal(withheldFromPush(M1, (m) => m === M1), true);
    assert.equal(withheldFromPush(M2, (m) => m === M1), false);
  });
  it("a throwing gate never stops pushes", () => {
    assert.equal(
      withheldFromPush(M1, () => {
        throw new Error("gate down");
      }),
      false,
    );
  });
});

describe("recordMultiAssetPushOutcome", () => {
  const mk = () => {
    const p = { key: "a1-stat-key", marketAddress: M1, assetIndex: 1 };
    const stat = newMarketStat({ label: "a1", marketAddress: M1, key: p.key, multi: true, assetIndex: 1 });
    const state = { stats: new Map([[p.key, stat]]), landedThisCycle: new Set<string>() };
    return { p, stat, state };
  };
  const genKey = pushGenerationKey({ marketAddress: M1, assetIndex: 1 });

  it("drops an asset with no stat", () => {
    const { p } = mk();
    const empty = { stats: new Map(), landedThisCycle: new Set<string>() };
    assert.equal(recordMultiAssetPushOutcome(empty, p, {}, { dryRun: false, stamp: 1 }), "dropped");
  });
  it("inactive asset: not landed, not an error", () => {
    const { p, stat, state } = mk();
    assert.equal(recordMultiAssetPushOutcome(state, p, { inactiveKeys: [genKey] }, { dryRun: false, stamp: 1 }), "inactive");
    assert.equal(stat.totalErrors, 0);
    assert.match(stat.lastErrorMsg ?? "", /not Active/);
    assert.equal(state.landedThisCycle.size, 0);
  });
  it("dry run counts as landed without a signature", () => {
    const { p, stat, state } = mk();
    stat.noPushCycles = 3;
    assert.equal(recordMultiAssetPushOutcome(state, p, {}, { dryRun: true, stamp: 1 }), "landed");
    assert.equal(stat.lastSig, "DRY_RUN");
    assert.equal(stat.noPushCycles, 0);
    assert.ok(state.landedThisCycle.has(p.key));
  });
  it("pushed key with a signature lands", () => {
    const { p, stat, state } = mk();
    stat.noPushCycles = 3;
    assert.equal(recordMultiAssetPushOutcome(state, p, { pushedKeys: [genKey], signature: "sig" }, { dryRun: false, stamp: 9 }), "landed");
    assert.equal(stat.noPushCycles, 0);
    assert.equal(stat.lastPushAt, 9);
    assert.equal(stat.totalPushes, 1);
    assert.equal(stat.lastSig, "sig");
    assert.ok(state.landedThisCycle.has(p.key));
  });
  it("pushed key without a signature is dropped and counted as an error", () => {
    const { p, stat, state } = mk();
    assert.equal(recordMultiAssetPushOutcome(state, p, { pushedKeys: [genKey], signature: null }, { dryRun: false, stamp: 1 }), "dropped");
    assert.equal(stat.totalErrors, 1);
    assert.equal(state.landedThisCycle.size, 0);
  });
  it("a key missing from the batch is dropped", () => {
    const { p, stat, state } = mk();
    assert.equal(recordMultiAssetPushOutcome(state, p, { pushedKeys: [], signature: "sig" }, { dryRun: false, stamp: 1 }), "dropped");
    assert.equal(stat.totalPushes, 0);
    assert.equal(stat.totalErrors, 1);
    assert.match(stat.lastErrorMsg ?? "", /dropped from batch/);
  });
});

describe("noPush streaks and pushable counts", () => {
  it("advanceNoPushStreaks bumps only markets that did not land, by stat key", () => {
    const a = newMarketStat({ label: "a", marketAddress: M1 });
    const b = newMarketStat({ label: "b", marketAddress: M2, key: `${M2}:1`, multi: true, assetIndex: 1 });
    // M2 (b's market address) is in the set but b's stat key is not: b must still be bumped.
    advanceNoPushStreaks([a, b], new Set([M1, M2]));
    assert.equal(a.noPushCycles, 0);
    assert.equal(b.noPushCycles, 1);
    advanceNoPushStreaks([b], new Set([`${M2}:1`]));
    assert.equal(b.noPushCycles, 1);
  });
  it("countPushableMarkets excludes terminal markets", () => {
    assert.equal(countPushableMarkets([{ marketAddress: M1 }, { marketAddress: M2 }], new Set([M2])), 1);
  });
});

describe("price staleness trackers", () => {
  it("recordRawPrice keeps the unchanged-since time while the price repeats", () => {
    const s = newMarketStat({ label: "a", marketAddress: M1 });
    recordRawPrice(s, 100n, 1000);
    recordRawPrice(s, 100n, 5000);
    assert.equal(s.sourceUnchangedSince, 1000);
    recordRawPrice(s, 101n, 6000);
    assert.equal(s.sourceUnchangedSince, 6000);
  });
  it("noteDepthAttempt starts the absent clock only when depth was expected and missing", () => {
    const s = { depthAbsentSince: null as number | null };
    noteDepthAttempt(s, false, false, 10);
    assert.equal(s.depthAbsentSince, null);
    noteDepthAttempt(s, true, false, 20);
    assert.equal(s.depthAbsentSince, 20);
    noteDepthAttempt(s, true, false, 30);
    assert.equal(s.depthAbsentSince, 20);
    noteDepthAttempt(s, true, true, 40);
    assert.equal(s.depthAbsentSince, null);
    noteDepthAttempt(s, true, false, 50);
    noteDepthAttempt(s, false, false, 60);
    assert.equal(s.depthAbsentSince, null);
  });
  it("fixedPushFor only accepts a positive fixed price on a fixed unit", () => {
    assert.equal(fixedPushFor({ source: "fixed", fixedPriceE6: 5n }), 5n);
    assert.equal(fixedPushFor({ source: "fixed", fixedPriceE6: 0n }), null);
    assert.equal(fixedPushFor({ source: "fixed", fixedPriceE6: undefined }), null);
    assert.equal(fixedPushFor({ source: "pool", fixedPriceE6: 5n }), null);
  });
});

describe("deadlineBypass", () => {
  const dl = (o: Partial<PushDeadline>): PushDeadline => ({ terminal: null, urgent: true, urgentReason: "band pin", ...o }) as PushDeadline;
  it("bypasses with the window median when urgent and Live", () => {
    assert.deepEqual(deadlineBypass(dl({}), 9n), { priceE6: 9n, reason: "band pin" });
  });
  it("falls back to a generic reason", () => {
    assert.equal(deadlineBypass(dl({ urgentReason: null }), 9n)?.reason, "a fail-closed deadline is close");
  });
  it("keeps withholding with no deadline, terminal, not urgent, or no usable median", () => {
    assert.equal(deadlineBypass(undefined, 9n), null);
    assert.equal(deadlineBypass(dl({ terminal: "resolved" as never }), 9n), null);
    assert.equal(deadlineBypass(dl({ urgent: false }), 9n), null);
    assert.equal(deadlineBypass(dl({}), null), null);
    assert.equal(deadlineBypass(dl({}), 0n), null);
  });
});
