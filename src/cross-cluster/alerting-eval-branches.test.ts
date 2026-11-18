/**
 * Branch coverage for the alert decisions in alerting.ts: ADL episodes, layout/loss-stale/prolonged, the health record,
 * market-push status (unregistered / no-push / mark-lag gating / source-frozen / depth), band-pin expiry, env parsing,
 * Telegram target parsing, and the sink's dedupe / resend / webhook-retry / Telegram paging timing.
 * Every test asserts alert kind, severity and message data.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AlertSink,
  DEFAULT_THRESHOLDS,
  TELEGRAM_QUEUE_CAP,
  TELEGRAM_REPEAT_MS,
  crankHealthRecord,
  evaluateBandPinExpiry,
  evaluateCrankHealth,
  evaluateMarketPush,
  evaluatePushCycle,
  freshStreaks,
  getAlertSink,
  slotLag,
  telegramTargetFromEnv,
  telegramTargetOrOff,
  thresholdsFromEnv,
  validateWebhookUrl,
} from "./alerting.ts";
import type { Alert, BandPinSample, CrankHealthSample, MarketPushSample } from "./alerting.ts";

const T = DEFAULT_THRESHOLDS;
const ONE = 1_000_000_000_000_000n;

function sample(p: Partial<CrankHealthSample> = {}): CrankHealthSample {
  return {
    label: "SOL",
    market: "Mkt1",
    chainSlot: 1_000_000n,
    engineSlot: 999_960n,
    crankOk: true,
    crankReverted: false,
    totalOk: 10,
    totalReverts: 0,
    consecutiveReverts: 0,
    lastRevertCode: null,
    lapsedBuckets: 0,
    bankruptFound: 0,
    bankruptLiquidated: 0,
    ...p,
  };
}

const adl = (over: Partial<NonNullable<CrankHealthSample["adl"]>> = {}) => ({
  aLong: ONE,
  aShort: ONE / 2n,
  oiEffLong: 5n,
  oiEffShort: 7n,
  reduceOnly: true,
  ...over,
});

function push(p: Partial<MarketPushSample> = {}): MarketPushSample {
  return {
    label: "BOME",
    market: "MktB",
    noPushCycles: 0,
    lastPushAt: null,
    lastError: null,
    markGap: null,
    sourceUnchangedSince: null,
    terminal: false,
    ...p,
  };
}

describe("evaluateCrankHealth: ADL reduce-only episodes", () => {
  it("first reduce-only read opens an episode flagged sinceBoot, warn, both-sides-hold-OI wording", () => {
    const r = evaluateCrankHealth(sample({ adl: adl() }), freshStreaks(), T, 5_000);
    assert.equal(r.active.length, 1);
    const a = r.active[0];
    assert.equal(a.kind, "adl-reduce-only");
    assert.equal(a.severity, "warn");
    assert.match(a.message, /since keeper boot/);
    assert.match(a.message, /a_long=1\.000000 a_short=0\.500000/);
    assert.match(a.message, /OI long 5 \/ short 7/);
    assert.match(a.message, /abandoned position/);
    assert.equal(a.data?.reduceOnlySlots, 0);
    assert.equal(a.data?.sinceSlot, "1000000");
    assert.equal(r.streaks.reduceOnlySince?.sinceBoot, true);
    assert.equal(r.streaks.adlObserved, true);
  });

  it("critical exactly at adlReduceOnlyCriticalSlots, warn one slot before", () => {
    const since = { slot: 1_000_000n, ms: 0, sinceBoot: false };
    const prev = { ...freshStreaks(), adlObserved: true, reduceOnlySince: since };
    const before = evaluateCrankHealth(
      sample({ adl: adl(), chainSlot: 1_000_000n + BigInt(T.adlReduceOnlyCriticalSlots) - 1n }), prev, T, 600_000);
    assert.equal(before.active[0].severity, "warn");
    const at = evaluateCrankHealth(
      sample({ adl: adl(), chainSlot: 1_000_000n + BigInt(T.adlReduceOnlyCriticalSlots) }), prev, T, 600_000);
    assert.equal(at.active[0].severity, "critical");
    assert.equal(at.active[0].data?.reduceOnlySlots, T.adlReduceOnlyCriticalSlots);
    assert.equal(at.active[0].data?.reduceOnlyMinutes, 10);
    assert.doesNotMatch(at.active[0].message, /since keeper boot/);
  });

  it("a one-sided-empty market drops the abandoned-position hint", () => {
    const r = evaluateCrankHealth(sample({ adl: adl({ oiEffShort: 0n }) }), freshStreaks(), T, 0);
    assert.match(r.active[0].message, /tag 44 RebalanceReduce\.$/);
    assert.doesNotMatch(r.active[0].message, /abandoned/);
  });

  it("an unknown ADL read (null / undefined) never resets an open episode and raises nothing", () => {
    const since = { slot: 900_000n, ms: 1, sinceBoot: false };
    const prev = { ...freshStreaks(), adlObserved: true, reduceOnlySince: since };
    for (const unknown of [null, undefined]) {
      const r = evaluateCrankHealth(sample({ adl: unknown }), prev, T, 10);
      assert.equal(r.active.length, 0);
      assert.deepEqual(r.streaks.reduceOnlySince, since);
      assert.equal(r.streaks.adlObserved, true);
    }
  });

  it("a decoded not-reduce-only read ends the episode; a chain slot behind the episode start clamps to 0 slots", () => {
    const since = { slot: 2_000_000n, ms: 0, sinceBoot: false };
    const prev = { ...freshStreaks(), adlObserved: true, reduceOnlySince: since };
    const clamp = evaluateCrankHealth(sample({ adl: adl() }), prev, T, 0);
    assert.equal(clamp.active[0].data?.reduceOnlySlots, 0);
    const ended = evaluateCrankHealth(sample({ adl: adl({ reduceOnly: false }) }), prev, T, 0);
    assert.equal(ended.active.length, 0);
    assert.equal(ended.streaks.reduceOnlySince, null);
  });
});

describe("evaluateCrankHealth: layout, loss-stale, prolonged", () => {
  const layout = (o: Partial<NonNullable<CrankHealthSample["layout"]>> = {}) => ({
    id: "L9", problem: "bad len", kind: "unknown", accountLen: 123, provisional: false, hasPositions: null as boolean | null, ...o,
  });

  it("layout problem: critical when positions unknown/present, warn only when proven empty; wording follows kind", () => {
    const unknown = evaluateCrankHealth(sample({ layout: layout() }), freshStreaks(), T).active[0];
    assert.equal(unknown.kind, "market-layout");
    assert.equal(unknown.severity, "critical");
    assert.match(unknown.message, /layout UNKNOWN \(bad len\)/);
    assert.deepEqual(unknown.data, { market: "Mkt1", layout: "L9", kind: "unknown", accountLen: 123, hasPositions: null });
    const present = evaluateCrankHealth(sample({ layout: layout({ hasPositions: true, kind: "v17" }) }), freshStreaks(), T).active[0];
    assert.equal(present.severity, "critical");
    assert.match(present.message, /layout unsupported/);
    const empty = evaluateCrankHealth(sample({ layout: layout({ hasPositions: false }) }), freshStreaks(), T).active[0];
    assert.equal(empty.severity, "warn");
  });

  it("a layout with problem=null raises nothing", () => {
    assert.equal(evaluateCrankHealth(sample({ layout: layout({ problem: null }) }), freshStreaks(), T).active.length, 0);
  });

  it("loss-stale fires at exactly lossStaleCycles and carries stale/overflow data; below it does not", () => {
    const below = evaluateCrankHealth(sample({ lossStaleCycles: T.lossStaleCycles - 1 }), freshStreaks(), T, 0);
    assert.equal(below.active.length, 0);
    const at = evaluateCrankHealth(
      sample({ lossStaleCycles: T.lossStaleCycles, staleLong: 2, staleShort: 0, positioned: 9, overflow: 3, overflowRefreshed: 1 }),
      freshStreaks(), T, 0).active;
    assert.equal(at.length, 1);
    assert.equal(at[0].kind, "loss-stale");
    assert.equal(at[0].severity, "critical");
    assert.match(at[0].message, /stale 2L\/0S, positioned 9, overflow 3, follow-up refreshed 1/);
    assert.deepEqual(at[0].data, { market: "Mkt1", cycles: 3, staleLong: 2, staleShort: 0, positioned: 9, overflow: 3, overflowRefreshed: 1 });
  });

  it("loss-stale with unknown counts prints '?' and null data", () => {
    const a = evaluateCrankHealth(sample({ lossStaleCycles: 3 }), freshStreaks(), T, 0).active[0];
    assert.match(a.message, /stale \?L\/\?S, positioned \?, overflow 0, follow-up refreshed 0/);
    assert.equal(a.data?.staleLong, null);
    assert.equal(a.data?.positioned, null);
  });

  it("prolonged: strictly greater than lossStaleProlongedMs, anchored to the first loss-stale cycle", () => {
    const start = 1_000;
    const first = evaluateCrankHealth(sample({ lossStaleCycles: 1 }), freshStreaks(), T, start);
    assert.equal(first.streaks.lossStaleSince, start);
    assert.equal(first.active.length, 0);
    const exactly = evaluateCrankHealth(sample({ lossStaleCycles: 1 }), first.streaks, T, start + T.lossStaleProlongedMs);
    assert.equal(exactly.active.length, 0, "exactly at the bound is not yet prolonged");
    const over = evaluateCrankHealth(
      sample({ lossStaleCycles: 4, staleLong: 1, staleShort: 1, positioned: 2 }), first.streaks, T, start + T.lossStaleProlongedMs + 60_000);
    const kinds = over.active.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["loss-stale", "loss-stale-prolonged"]);
    const p = over.active.find((a) => a.kind === "loss-stale-prolonged") as Alert;
    assert.equal(p.severity, "critical");
    assert.match(p.message, /LOSS-STALE for > 5 min \(~6 min observed, 4 consecutive cycles\)/);
    assert.equal(p.data?.lossStaleMinutes, 6);
    assert.equal(p.data?.sinceMs, start);
    // first clean cycle ends the episode
    const clean = evaluateCrankHealth(sample({ lossStaleCycles: 0 }), over.streaks, T, start + 999_999);
    assert.equal(clean.streaks.lossStaleSince, null);
    assert.equal(clean.active.length, 0);
  });
});

describe("evaluateCrankHealth: slot-lag / reverts / lapsed / bankrupt boundaries", () => {
  it("slot-lag exact boundaries: 299 none, 300 warn, 449 warn, 450 critical; chain behind engine clamps to 0", () => {
    const at = (lag: bigint) => evaluateCrankHealth(sample({ engineSlot: 1_000_000n - lag }), freshStreaks(), T).active;
    assert.equal(at(299n).length, 0);
    assert.equal(at(300n)[0].severity, "warn");
    assert.equal(at(449n)[0].severity, "warn");
    const crit = at(450n)[0];
    assert.equal(crit.severity, "critical");
    assert.equal(crit.data?.lag, 450);
    assert.match(crit.message, /450 slots behind chain \(engine 999550 vs chain 1000000\)/);
    assert.equal(slotLag({ chainSlot: 5n, engineSlot: 9n }), 0);
    assert.equal(slotLag({ chainSlot: 5n, engineSlot: null }), null);
  });

  it("crank-reverts: threshold-1 none, threshold critical; unknown code prints Custom(?)", () => {
    assert.equal(evaluateCrankHealth(sample({ consecutiveReverts: 2 }), freshStreaks(), T).active.length, 0);
    const a = evaluateCrankHealth(sample({ consecutiveReverts: 3, lastRevertCode: null, totalOk: 4, totalReverts: 8 }), freshStreaks(), T).active[0];
    assert.equal(a.kind, "crank-reverts");
    assert.equal(a.severity, "critical");
    assert.match(a.message, /3x consecutively \(last Custom\(\?\)\)/);
    assert.deepEqual(a.data, { consecutive: 3, lastCode: null, ok: 4, rev: 8, market: "Mkt1" });
    const b = evaluateCrankHealth(sample({ consecutiveReverts: 3, lastRevertCode: 21 }), freshStreaks(), T).active[0];
    assert.match(b.message, /Custom\(21\)/);
  });

  it("lapsed bucket: warn at the Nth consecutive cycle with streak carried", () => {
    let st = freshStreaks();
    let out = evaluateCrankHealth(sample({ lapsedBuckets: 2 }), st, T);
    st = out.streaks;
    out = evaluateCrankHealth(sample({ lapsedBuckets: 2 }), st, T);
    st = out.streaks;
    assert.equal(out.active.length, 0);
    out = evaluateCrankHealth(sample({ lapsedBuckets: 2 }), st, T);
    assert.equal(out.active[0].kind, "lapsed-bucket");
    assert.equal(out.active[0].severity, "warn");
    assert.deepEqual(out.active[0].data, { lapsedBuckets: 2, cycles: 3, market: "Mkt1" });
  });

  it("bankrupt-unliquidated: critical at bankruptCycles, partially liquidated counts only the remainder", () => {
    const s = sample({ bankruptFound: 3, bankruptLiquidated: 1 });
    const one = evaluateCrankHealth(s, freshStreaks(), T);
    assert.equal(one.active.length, 0);
    const two = evaluateCrankHealth(s, one.streaks, T);
    assert.equal(two.active[0].kind, "bankrupt-unliquidated");
    assert.equal(two.active[0].severity, "critical");
    assert.match(two.active[0].message, /^2 bankrupt account\(s\) not liquidated for 2 cycles/);
    assert.deepEqual(two.active[0].data, { bankrupt: 3, liquidated: 1, cycles: 2, market: "Mkt1" });
    // over-liquidated (more than found) never goes negative / alerts
    const over = evaluateCrankHealth(sample({ bankruptFound: 0, bankruptLiquidated: 2 }), two.streaks, T);
    assert.equal(over.active.length, 0);
    assert.equal(over.streaks.bankruptCycles, 0);
  });
});

describe("crankHealthRecord", () => {
  it("minimal sample: base fields only, lsc defaults 0", () => {
    assert.deepEqual(crankHealthRecord(sample()), {
      m: "SOL", lag: 40, ok: 10, rev: 0, cons: 0, lapsed: 0, bankrupt: 0, liq: 0, lsc: 0,
    });
  });

  it("includes stale, positioned, overflow, layout, sweep and reduce-only extras when present", () => {
    const r = crankHealthRecord(
      sample({
        engineSlot: null,
        staleLong: 1,
        staleShort: undefined,
        positioned: 4,
        overflow: 2,
        overflowRefreshed: undefined,
        lossStaleCycles: 2,
        layout: { id: "L1", problem: "x", kind: "k", accountLen: 1, provisional: false, hasPositions: true },
        sweep: { coverageRatio: 0.5, covered: true, blocksRiskIncrease: false, laggardLong: 1, laggardShort: 2, pace: "fast", k: 3, txsSent: 4 },
        adl: adl(),
      }),
    );
    assert.equal(r.lag, null);
    assert.equal(r.stL, 1);
    assert.equal(r.stS, null);
    assert.equal(r.pos, 4);
    assert.equal(r.ovf, 2);
    assert.equal(r.ovfOk, 0);
    assert.equal(r.lsc, 2);
    assert.equal(r.lay, "L1");
    assert.equal(r.layErr, 1);
    assert.deepEqual([r.cov, r.cvd, r.blk, r.lgL, r.lgS, r.pace, r.k, r.stx], [0.5, 1, 0, 1, 2, "fast", 3, 4]);
    assert.deepEqual([r.ro, r.aL, r.aS, r.oiL, r.oiS], [1, "1.000000", "0.500000", "5", "7"]);
    // layout without a problem has no layErr; adl not reduce-only has no ro
    const q = crankHealthRecord(sample({ layout: { id: "L2", problem: null, kind: "k", accountLen: 1, provisional: false, hasPositions: null }, adl: adl({ reduceOnly: false }) }));
    assert.equal(q.lay, "L2");
    assert.equal("layErr" in q, false);
    assert.equal("ro" in q, false);
  });
});

describe("evaluatePushCycle", () => {
  it("zero-pushes critical at exactly zeroPushCycles; message carries counts", () => {
    const s = { cycle: 1, registered: 7, attempted: 5, pushed: 0 };
    const below = evaluatePushCycle(s, T.zeroPushCycles - 2, T);
    assert.equal(below.active.length, 0);
    const at = evaluatePushCycle(s, T.zeroPushCycles - 1, T);
    assert.equal(at.zeroStreak, 10);
    assert.equal(at.active[0].kind, "zero-pushes");
    assert.equal(at.active[0].severity, "critical");
    assert.equal(at.active[0].subject, "*");
    assert.match(at.active[0].message, /10 consecutive cycles \(7 markets registered, 5 attempted/);
    assert.deepEqual(at.active[0].data, { zeroStreak: 10, registered: 7, attempted: 5 });
  });
});

describe("evaluateMarketPush", () => {
  const NOW = 10_000_000;

  it("terminal markets are ok and silent even when everything else is degraded", () => {
    const r = evaluateMarketPush(push({ terminal: true, unregistered: true, noPushCycles: 999 }), T, NOW);
    assert.deepEqual(r, { status: "ok", active: [] });
  });

  it("unregistered market is critical market-unregistered and short-circuits every other check", () => {
    const r = evaluateMarketPush(push({ unregistered: true, noPushCycles: 999 }), T, NOW);
    assert.equal(r.status, "unregistered");
    assert.equal(r.active.length, 1);
    assert.equal(r.active[0].kind, "market-unregistered");
    assert.equal(r.active[0].severity, "critical");
    assert.equal(r.active[0].subject, "BOME");
    assert.match(r.active[0].message, /^MktB has no row in the keeper's registry/);
    assert.deepEqual(r.active[0].data, { market: "MktB" });
  });

  it("healthy market is ok", () => {
    assert.deepEqual(evaluateMarketPush(push(), T, NOW), { status: "ok", active: [] });
  });

  it("no-push: threshold-1 ok, threshold critical; 'never since keeper boot' vs seconds-ago and last error", () => {
    assert.equal(evaluateMarketPush(push({ noPushCycles: 39 }), T, NOW).status, "ok");
    const never = evaluateMarketPush(push({ noPushCycles: 40 }), T, NOW);
    assert.equal(never.status, "no-push");
    assert.equal(never.active[0].kind, "market-no-push");
    assert.equal(never.active[0].severity, "critical");
    assert.match(never.active[0].message, /last push never since keeper boot; last error: none/);
    const ago = evaluateMarketPush(push({ noPushCycles: 41, lastPushAt: NOW - 90_500, lastError: "blockhash expired" }), T, NOW);
    assert.match(ago.active[0].message, /last push 90s ago; last error: blockhash expired/);
    assert.deepEqual(ago.active[0].data, { market: "MktB", noPushCycles: 41, lastPushAt: NOW - 90_500, lastError: "blockhash expired" });
  });

  it("mark-lag gating: needs BOTH age >= markLagMs and gap >= markLagPct", () => {
    const gap = (pct: number, ageMs: number, dir: 1 | -1 = 1) => push({ markGap: { pct, ageMs, checks: 12, dir } });
    assert.equal(evaluateMarketPush(gap(50, T.markLagMs - 1), T, NOW).status, "ok");
    assert.equal(evaluateMarketPush(gap(T.markLagPct - 0.01, 10 * T.markLagMs), T, NOW).status, "ok");
    const hit = evaluateMarketPush(gap(T.markLagPct, T.markLagMs), T, NOW);
    assert.equal(hit.status, "mark-lagging");
    assert.equal(hit.active[0].kind, "mark-lagging");
    assert.equal(hit.active[0].severity, "critical");
    assert.match(hit.active[0].message, /held 10\.0% BELOW the source price for 120s \(12 checks\)/);
    assert.match(hit.active[0].message, /a long opened now is a free option/);
    assert.deepEqual(hit.active[0].data, { market: "MktB", gapPct: 10, gapAgeMs: 120_000, checks: 12, dir: 1 });
    const short = evaluateMarketPush(gap(33.333, 200_000, -1), T, NOW);
    assert.match(short.active[0].message, /33\.3% ABOVE/);
    assert.match(short.active[0].message, /a short opened now/);
  });

  it("no-push outranks mark-lagging in status but both alerts are emitted", () => {
    const r = evaluateMarketPush(
      push({ noPushCycles: 50, markGap: { pct: 40, ageMs: 300_000, checks: 3, dir: 1 } }), T, NOW);
    assert.equal(r.status, "no-push");
    assert.deepEqual(r.active.map((a) => a.kind), ["market-no-push", "mark-lagging"]);
  });

  it("source-frozen: warn at sourceFrozenMs, critical at sourceDeadMs, none just under", () => {
    const since = (ms: number) => push({ sourceUnchangedSince: NOW - ms });
    assert.equal(evaluateMarketPush(since(T.sourceFrozenMs - 1), T, NOW).status, "ok");
    const warn = evaluateMarketPush(since(T.sourceFrozenMs), T, NOW);
    assert.equal(warn.status, "source-frozen");
    assert.equal(warn.active[0].kind, "source-frozen");
    assert.equal(warn.active[0].severity, "warn");
    assert.equal(warn.active[0].data?.unchangedMinutes, 120);
    assert.match(warn.active[0].message, /has not changed for 120 min/);
    assert.equal(evaluateMarketPush(since(T.sourceDeadMs - 1), T, NOW).active[0].severity, "warn");
    const dead = evaluateMarketPush(since(T.sourceDeadMs), T, NOW);
    assert.equal(dead.active[0].severity, "critical");
    assert.equal(dead.active[0].data?.unchangedMinutes, 360);
  });

  it("sourceDeadMs below sourceFrozenMs is floored to sourceFrozenMs (never critical before the warn bound)", () => {
    const t = { ...T, sourceFrozenMs: 1000, sourceDeadMs: 10 };
    const r = evaluateMarketPush(push({ sourceUnchangedSince: NOW - 1000 }), t, NOW);
    assert.equal(r.active[0].severity, "critical");
    assert.equal(evaluateMarketPush(push({ sourceUnchangedSince: NOW - 999 }), t, NOW).active.length, 0);
  });

  it("source-frozen does not override a no-push / mark-lagging status", () => {
    const r = evaluateMarketPush(
      push({ noPushCycles: 40, sourceUnchangedSince: NOW - T.sourceDeadMs }), T, NOW);
    assert.equal(r.status, "no-push");
    const m = evaluateMarketPush(
      push({ markGap: { pct: 20, ageMs: 200_000, checks: 1, dir: 1 }, sourceUnchangedSince: NOW - T.sourceDeadMs }), T, NOW);
    assert.equal(m.status, "mark-lagging");
    assert.deepEqual(m.active.map((a) => a.kind), ["mark-lagging", "source-frozen"]);
  });

  it("depth-unavailable: warn at depthAbsentMs, not below; null/undefined never alert; status stays ok", () => {
    assert.equal(evaluateMarketPush(push({ depthAbsentSince: NOW - T.depthAbsentMs + 1 }), T, NOW).active.length, 0);
    assert.equal(evaluateMarketPush(push({ depthAbsentSince: null }), T, NOW).active.length, 0);
    assert.equal(evaluateMarketPush(push({ depthAbsentSince: undefined }), T, NOW).active.length, 0);
    const r = evaluateMarketPush(push({ depthAbsentSince: NOW - T.depthAbsentMs }), T, NOW);
    assert.equal(r.status, "ok");
    assert.equal(r.active[0].kind, "depth-unavailable");
    assert.equal(r.active[0].severity, "warn");
    assert.equal(r.active[0].data?.absentMinutes, 30);
    assert.match(r.active[0].message, /no depth has been attested for 30 min/);
  });

  it("defaults nowMs to the wall clock", () => {
    const r = evaluateMarketPush(push({ noPushCycles: 40, lastPushAt: Date.now() - 5_000 }), T);
    assert.match(r.active[0].message, /last push [4-6]s ago/);
  });
});

describe("evaluateBandPinExpiry", () => {
  const pin = (o: Partial<NonNullable<BandPinSample["pin"]>> = {}) => ({
    assetIndex: 2, sinceSlot: 100n, durationSlots: 4_000n, maxPinSlots: 9_000n, remaining: 5_000n, expired: false, ...o,
  });
  const bp = (o: Partial<BandPinSample> = {}): BandPinSample => ({
    label: "BAND", market: "MktP", terminal: false, pin: pin(), noPushCycles: 0, lastPushAt: 1, ...o,
  });

  it("terminal or unpinned markets are silent", () => {
    assert.deepEqual(evaluateBandPinExpiry(bp({ terminal: true, pin: pin({ expired: true }) }), T), []);
    assert.deepEqual(evaluateBandPinExpiry(bp({ pin: null }), T), []);
  });

  it("remaining > bandPinExpirySlots is silent; == it warns (pushes landing)", () => {
    assert.deepEqual(evaluateBandPinExpiry(bp({ pin: pin({ remaining: 4_501n }) }), T), []);
    const [a] = evaluateBandPinExpiry(bp({ pin: pin({ remaining: 4_500n }) }), T);
    assert.equal(a.kind, "band-pin-expiring");
    assert.equal(a.severity, "warn");
    assert.match(a.message, /expires in 4500 slots \(pinned 4000\/9000\); pushes are landing/);
    assert.deepEqual(a.data, {
      market: "MktP", assetIndex: 2, pinSinceSlot: "100", remainingSlots: "4500", maxPinSlots: "9000",
      expired: false, noPushCycles: 0, lastPushAt: 1,
    });
  });

  it("critical when no push landed (never pushed, or noPushCycles > 0) even if not yet expired", () => {
    const near = pin({ remaining: 10n });
    assert.equal(evaluateBandPinExpiry(bp({ pin: near, lastPushAt: null }), T)[0].severity, "critical");
    const c = evaluateBandPinExpiry(bp({ pin: near, noPushCycles: 1 }), T)[0];
    assert.equal(c.severity, "critical");
    assert.match(c.message, /NO push has landed for it/);
  });

  it("expired pin is critical even with pushes landing, with the EXPIRED wording and huge remaining ignored", () => {
    const [a] = evaluateBandPinExpiry(bp({ pin: pin({ expired: true, remaining: 99_999n, durationSlots: 9_001n }) }), T);
    assert.equal(a.severity, "critical");
    assert.match(a.message, /EXPIRED \(9001 > 9000 slots\)/);
    assert.match(a.message, /pushes are landing/);
    assert.equal(a.data?.expired, true);
  });
});

describe("thresholdsFromEnv", () => {
  it("all-empty env gives defaults; blank/whitespace values fall back", () => {
    assert.deepEqual(thresholdsFromEnv({}), T);
    assert.deepEqual(thresholdsFromEnv({ ALERT_SLOT_LAG_WARN: "   ", ALERT_COOLDOWN_MS: "" }), T);
  });

  it("every ALERT_* override is read into its own field", () => {
    const t = thresholdsFromEnv({
      ALERT_SLOT_LAG_WARN: "11", ALERT_SLOT_LAG_CRITICAL: "12", ALERT_CRANK_REVERTS: "13", ALERT_ZERO_PUSH_CYCLES: "14",
      ALERT_LAPSED_BUCKET_CYCLES: "15", ALERT_BANKRUPT_CYCLES: "16", ALERT_COOLDOWN_MS: "17",
      ALERT_ADL_REDUCE_ONLY_CRITICAL_SLOTS: "18", ALERT_LOSS_STALE_CYCLES: "19", ALERT_LOSS_STALE_PROLONGED_MS: "20",
      ALERT_MARKET_NO_PUSH_CYCLES: "21", ALERT_MARK_LAG_MS: "22", ALERT_MARK_LAG_PCT: "23", ALERT_SOURCE_FROZEN_MS: "24",
      ALERT_SOURCE_DEAD_MS: "25", ALERT_DEPTH_ABSENT_MS: "26", ALERT_BAND_PIN_EXPIRY_SLOTS: "27",
    });
    assert.deepEqual(Object.values(t), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
  });

  it("rejects zero, negative, fractional, non-numeric, and critical < warn", () => {
    for (const bad of ["0", "-3", "1.5", "abc", "Infinity"]) {
      assert.throws(() => thresholdsFromEnv({ ALERT_COOLDOWN_MS: bad }), /ALERT_COOLDOWN_MS=.* must be a positive integer/);
    }
    assert.throws(() => thresholdsFromEnv({ ALERT_SLOT_LAG_WARN: "500", ALERT_SLOT_LAG_CRITICAL: "400" }), /CRITICAL must be >= .*WARN/);
    assert.doesNotThrow(() => thresholdsFromEnv({ ALERT_SLOT_LAG_WARN: "400", ALERT_SLOT_LAG_CRITICAL: "400" }));
  });
});

describe("validateWebhookUrl / telegram config", () => {
  it("blank is off, https is normalised, http and garbage are refused without echoing the value", () => {
    assert.equal(validateWebhookUrl(undefined), undefined);
    assert.equal(validateWebhookUrl("  "), undefined);
    assert.equal(validateWebhookUrl(" https://hooks.example.com/x "), "https://hooks.example.com/x");
    assert.throws(() => validateWebhookUrl("http://secret.example/x"), (e: Error) => /https/.test(e.message) && !e.message.includes("secret"));
    assert.throws(() => validateWebhookUrl("not a url"), (e: Error) => /not a valid URL/.test(e.message) && !e.message.includes("not a url"));
  });

  it("telegramTargetFromEnv: neither -> off; trims; both-or-neither; format checks never echo values", () => {
    assert.equal(telegramTargetFromEnv({}), undefined);
    assert.equal(telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: " ", KEEPER_ALERT_TELEGRAM_CHAT_ID: "" }), undefined);
    assert.deepEqual(
      telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: " 123:abc_D-e ", KEEPER_ALERT_TELEGRAM_CHAT_ID: "-1001" }),
      { botToken: "123:abc_D-e", chatId: "-1001" });
    assert.deepEqual(
      telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "1:a", KEEPER_ALERT_TELEGRAM_CHAT_ID: "@chan_1" }),
      { botToken: "1:a", chatId: "@chan_1" });
    assert.throws(() => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "1:a" }), /must be set together/);
    assert.throws(() => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_CHAT_ID: "1" }), /must be set together/);
    assert.throws(
      () => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "SECRETTOKEN", KEEPER_ALERT_TELEGRAM_CHAT_ID: "1" }),
      (e: Error) => /not a bot token/.test(e.message) && !e.message.includes("SECRETTOKEN"));
    assert.throws(
      () => telegramTargetFromEnv({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "1:a", KEEPER_ALERT_TELEGRAM_CHAT_ID: "chatname" }),
      (e: Error) => /numeric chat id or @channel/.test(e.message) && !e.message.includes("chatname"));
  });

  it("telegramTargetOrOff logs one error and returns undefined on misconfig; passes a good target through", () => {
    const errs: string[] = [];
    assert.equal(telegramTargetOrOff({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "1:a" }, (l) => errs.push(l)), undefined);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /Telegram alerts OFF: .*must be set together/);
    assert.deepEqual(
      telegramTargetOrOff({ KEEPER_ALERT_TELEGRAM_BOT_TOKEN: "1:a", KEEPER_ALERT_TELEGRAM_CHAT_ID: "9" }, (l) => errs.push(l)),
      { botToken: "1:a", chatId: "9" });
    assert.equal(errs.length, 1);
  });
});

// ── Sink ─────────────────────────────────────────────────────────────────────

function mkSink(o: { webhook?: boolean; tg?: boolean; post?: (u: string, b: string) => Promise<void> } = {}) {
  let clock = 1_000_000;
  const logs: string[] = [];
  const errs: string[] = [];
  const posts: { url: string; body: string }[] = [];
  const sink = new AlertSink({
    thresholds: T,
    webhookUrl: o.webhook === false ? undefined : "https://hooks.example.com/SECRETPATH",
    telegram: o.tg ? { botToken: "42:TOKENSECRET", chatId: "-7" } : undefined,
    post: o.post ?? (async (url, body) => void posts.push({ url, body })),
    now: () => clock,
    log: (l) => logs.push(l),
    logError: (l) => errs.push(l),
  });
  return { sink, logs, errs, posts, advance: (ms: number) => void (clock += ms) };
}

const crit = (kind: Alert["kind"], subject = "SOL", extra: Partial<Alert> = {}): Alert =>
  ({ kind, severity: "critical", subject, message: "boom", ...extra });

describe("AlertSink timing and delivery", () => {
  it("reconcile: fires at cooldown boundary exactly (cooldown-1 suppressed, cooldown re-fires)", async () => {
    const { sink, errs, advance } = mkSink({ webhook: false });
    const a = crit("crank-reverts");
    assert.equal((await sink.reconcile("crank", [a])).length, 1);
    advance(T.cooldownMs - 1);
    assert.equal((await sink.reconcile("crank", [a])).length, 0);
    advance(1);
    assert.equal((await sink.reconcile("crank", [a])).length, 1);
    assert.equal(errs.filter((l) => l.startsWith("[ALERT] ")).length, 2);
  });

  it("reconcile: resolved line carries the severity it last fired with; resolving clears the cooldown so a re-trigger fires at once", async () => {
    const { sink, logs, errs } = mkSink({ webhook: false });
    await sink.reconcile("crank", [{ kind: "slot-lag", severity: "warn", subject: "SOL", message: "m" }]);
    await sink.reconcile("crank", []);
    const resolved = logs.filter((l) => l.startsWith("[ALERT-RESOLVED] "));
    assert.equal(resolved.length, 1);
    assert.deepEqual(JSON.parse(resolved[0].slice("[ALERT-RESOLVED] ".length)),
      { kind: "slot-lag", severity: "warn", subject: "SOL", message: "condition cleared" });
    await sink.reconcile("crank", []);
    assert.equal(logs.filter((l) => l.startsWith("[ALERT-RESOLVED] ")).length, 1, "resolved only once");
    const again = await sink.reconcile("crank", [{ kind: "slot-lag", severity: "warn", subject: "SOL", message: "m" }]);
    assert.equal(again.length, 1);
    assert.equal(errs.filter((l) => l.startsWith("[ALERT] ")).length, 2);
  });

  it("fire: dedupe key separates one-shots inside the cooldown; same key is suppressed then re-sent after it", async () => {
    const { sink, advance } = mkSink({ webhook: false });
    const a = crit("p3-senior-draw", "SOL", { dedupe: "d1" });
    assert.equal(await sink.fire("p3", a), true);
    assert.equal(await sink.fire("p3", a), false);
    assert.equal(await sink.fire("p3", { ...a, dedupe: "d2" }), true);
    assert.equal(await sink.fire("p3", { ...a, dedupe: undefined }), true);
    advance(T.cooldownMs - 1);
    assert.equal(await sink.fire("p3", a), false);
    advance(1);
    assert.equal(await sink.fire("p3", a), true);
  });

  it("webhook body is { text, alert } with severity tag; RESOLVED text is tagged and bigint-safe", async () => {
    const { sink, posts } = mkSink();
    await sink.reconcile("s", [crit("zero-pushes", "*", { data: { n: 1 } })]);
    await sink.reconcile("s", []);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].url, "https://hooks.example.com/SECRETPATH");
    const first = JSON.parse(posts[0].body);
    assert.equal(first.text, "[CRITICAL] percolator-keeper zero-pushes *: boom");
    assert.equal(first.alert.kind, "zero-pushes");
    const second = JSON.parse(posts[1].body);
    assert.equal(second.text, "[RESOLVED] percolator-keeper zero-pushes *: condition cleared");
  });

  it("failed webhook rolls the cooldown back for retries, but gives up after WEBHOOK_RETRY_CAP consecutive failures", async () => {
    let calls = 0;
    const { sink, errs } = mkSink({ post: async () => { calls++; throw new Error("down: https://hooks.example.com/SECRETPATH"); } });
    const a = crit("crank-reverts");
    // failures 1 and 2 roll back (retry next cycle); failure 3 keeps the cooldown
    assert.equal((await sink.reconcile("c", [a])).length, 1);
    assert.equal((await sink.reconcile("c", [a])).length, 1);
    assert.equal((await sink.reconcile("c", [a])).length, 1);
    assert.equal(calls, 3);
    assert.equal((await sink.reconcile("c", [a])).length, 0, "cooldown stands after 3 failures");
    assert.equal(calls, 3);
    assert.ok(errs.some((l) => l.includes("webhook delivery failed: down: <url>")));
    assert.ok(errs.filter((l) => l.startsWith("[alerting]")).every((l) => !l.includes("SECRETPATH")));
  });

  it("a RESOLVED webhook failure does not touch retry state and a non-Error rejection is stringified", async () => {
    let n = 0;
    const { sink, errs } = mkSink({ post: async () => { if (++n > 1) throw "plain string"; } });
    await sink.reconcile("c", [crit("crank-reverts")]);
    await sink.reconcile("c", []);
    assert.ok(errs.some((l) => l === "[alerting] webhook delivery failed: plain string"));
  });

  it("a successful webhook after earlier failures resets the failure count", async () => {
    let fail = true;
    const { sink } = mkSink({ post: async () => { if (fail) throw new Error("x"); } });
    const a = crit("crank-reverts");
    await sink.reconcile("c", [a]);
    await sink.reconcile("c", [a]); // 2 failures
    fail = false;
    await sink.reconcile("c", [a]); // success -> counter reset
    await sink.reconcile("c", []); // resolve clears
    assert.equal((await sink.reconcile("c", [a])).length, 1);
  });

  it("no webhook and no telegram: log only, health lines are one-line JSON with bigint support", async () => {
    const { sink, logs, posts } = mkSink({ webhook: false });
    sink.health("crank", { slot: 5n });
    await sink.reconcile("c", [crit("crank-reverts")]);
    assert.equal(posts.length, 0);
    const h = JSON.parse(logs[0].replace("[health] ", ""));
    assert.equal(h.scope, "crank");
    assert.equal(h.slot, "5");
    assert.equal(sink.thresholds, T);
    assert.equal(sink.telegramEnabled, false);
  });
});

describe("AlertSink Telegram paging", () => {
  const tgPosts = (posts: { url: string; body: string }[]) =>
    posts.filter((p) => p.url.startsWith("https://api.telegram.org/bot42:TOKENSECRET/sendMessage")).map((p) => JSON.parse(p.body));

  it("only critical pages; warn does not; body carries chat_id and text; telegramEnabled true", async () => {
    const { sink, posts } = mkSink({ webhook: false, tg: true });
    assert.equal(sink.telegramEnabled, true);
    await sink.reconcile("c", [{ kind: "lapsed-bucket", severity: "warn", subject: "A", message: "w" }, crit("crank-reverts", "B")]);
    await sink.flush();
    const msgs = tgPosts(posts);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].chat_id, "-7");
    assert.equal(msgs[0].text, "[CRITICAL] percolator-keeper crank-reverts B: boom");
    assert.equal(msgs[0].disable_web_page_preview, true);
  });

  it("repeat page only after TELEGRAM_REPEAT_MS even though the log cooldown re-fires sooner", async () => {
    const { sink, posts, advance } = mkSink({ webhook: false, tg: true });
    const a = crit("crank-reverts");
    await sink.reconcile("c", [a]);
    advance(T.cooldownMs);
    await sink.reconcile("c", [a]);
    await sink.flush();
    assert.equal(tgPosts(posts).length, 1);
    advance(TELEGRAM_REPEAT_MS - T.cooldownMs - 1);
    await sink.reconcile("c", [a]);
    await sink.flush();
    assert.equal(tgPosts(posts).length, 1, "1 ms short of the repeat window");
    advance(T.cooldownMs); // cooldown elapsed again and now past repeat window
    await sink.reconcile("c", [a]);
    await sink.flush();
    assert.equal(tgPosts(posts).length, 2);
  });

  it("RESOLVED pages only for alerts that were paged; a warn that cleared sends nothing", async () => {
    const { sink, posts } = mkSink({ webhook: false, tg: true });
    await sink.reconcile("c", [{ kind: "lapsed-bucket", severity: "warn", subject: "A", message: "w" }]);
    await sink.reconcile("c", []);
    await sink.flush();
    assert.equal(tgPosts(posts).length, 0);
    await sink.reconcile("c", [crit("crank-reverts", "B")]);
    await sink.reconcile("c", []);
    await sink.flush();
    const msgs = tgPosts(posts);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].text, "[RESOLVED] percolator-keeper crank-reverts B: condition cleared");
  });

  it("market-no-push is suppressed while zero-pushes is active (in the same set or still active from before), and pages once it clears", async () => {
    const { sink, posts } = mkSink({ webhook: false, tg: true });
    await sink.reconcile("push", [crit("zero-pushes", "*"), crit("market-no-push", "BOME")]);
    await sink.flush();
    let kinds = tgPosts(posts).map((m) => m.text.split(" ")[2]);
    assert.deepEqual(kinds, ["zero-pushes"]);
    // zero-pushes is still in activeKeys from the reconcile above: a later one-shot market-no-push stays suppressed
    await sink.fire("push2", crit("market-no-push", "WIF"));
    await sink.flush();
    assert.equal(tgPosts(posts).length, 1);
    // once zero-pushes clears, a new market-no-push pages
    await sink.reconcile("push", []);
    await sink.fire("push2", crit("market-no-push", "JUP"));
    await sink.flush();
    kinds = tgPosts(posts).map((m) => m.text.split(" ")[2]);
    assert.deepEqual(kinds, ["zero-pushes", "zero-pushes", "market-no-push"], "second zero-pushes entry is its RESOLVED page");
  });

  it("a failed Telegram send scrubs the token, frees the repeat slot, and does not page RESOLVED", async () => {
    const calls: string[] = [];
    let fail = true;
    const { sink, errs } = mkSink({
      webhook: false, tg: true,
      post: async (url) => { calls.push(url); if (fail) throw new Error(`fetch failed for ${url}`); },
    });
    const a = crit("crank-reverts");
    await sink.reconcile("c", [a]);
    await sink.flush();
    const msg = errs.find((l) => l.startsWith("[alerting] telegram delivery failed"));
    assert.ok(msg);
    assert.ok(!msg.includes("TOKENSECRET"));
    assert.match(msg, /<token>/);
    // the failed page freed its slot: next cooldown window pages again instead of waiting 2h
    fail = false;
    await sink.reconcile("c", []);
    await sink.flush();
    assert.equal(calls.length, 1, "RESOLVED not sent for a page nobody got");
    await sink.reconcile("c", [a]);
    await sink.flush();
    assert.equal(calls.length, 2);
  });

  it("queue cap: beyond TELEGRAM_QUEUE_CAP pending, messages drop with ONE error line, and a drain line reports the count", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sink, errs } = mkSink({ webhook: false, tg: true, post: async () => { await gate; } });
    const alerts = Array.from({ length: TELEGRAM_QUEUE_CAP + 3 }, (_, i) => crit("crank-reverts", `M${i}`));
    await sink.reconcile("c", alerts);
    assert.equal(errs.filter((l) => l.includes("telegram queue full")).length, 1);
    assert.match(errs.find((l) => l.includes("telegram queue full")) as string, /\(20 pending\)/);
    release();
    await sink.flush();
    assert.ok(errs.some((l) => l.includes("telegram queue drained; 3 message(s) were dropped")));
  });

  it("long messages are truncated to 4000 chars for Telegram", async () => {
    const { sink, posts } = mkSink({ webhook: false, tg: true });
    await sink.reconcile("c", [crit("crank-reverts", "S", { message: "x".repeat(6000) })]);
    await sink.flush();
    assert.equal(tgPosts(posts)[0].text.length, 4000);
  });
});

describe("getAlertSink", () => {
  it("returns one process-wide sink built from env, and is stable across calls", () => {
    const keep = process.env.KEEPER_ALERT_WEBHOOK_URL;
    delete process.env.KEEPER_ALERT_WEBHOOK_URL;
    try {
      const a = getAlertSink();
      assert.equal(a, getAlertSink());
      assert.equal(a.thresholds.cooldownMs, thresholdsFromEnv(process.env).cooldownMs);
    } finally {
      if (keep !== undefined) process.env.KEEPER_ALERT_WEBHOOK_URL = keep;
    }
  });
});
