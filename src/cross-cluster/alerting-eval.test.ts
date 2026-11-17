/**
 * Coverage: the pure evaluators in alerting.ts that the scoped alerting suites leave unexercised —
 * loss-stale / prolonged / lapsed / bankrupt / layout crank alerts, crankHealthRecord, zero-push cycles,
 * evaluateMarketPush and evaluateBandPinExpiry. Pure; no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  crankHealthRecord,
  evaluateBandPinExpiry,
  evaluateCrankHealth,
  evaluateMarketPush,
  evaluatePushCycle,
  freshStreaks,
} from "./alerting.ts";
import type { BandPinSample, CrankHealthSample, MarketPushSample } from "./alerting.ts";

const T = DEFAULT_THRESHOLDS;
const NOW = 10_000_000_000;

function sample(p: Partial<CrankHealthSample> = {}): CrankHealthSample {
  return {
    label: "SOL",
    market: "Mkt1",
    chainSlot: 1_000_000n,
    engineSlot: 999_990n,
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
const kinds = (a: { kind: string }[]) => a.map((x) => x.kind);

describe("evaluateCrankHealth: loss-stale / lapsed / bankrupt / layout", () => {
  it("loss-stale fires at lossStaleCycles with unknown counts rendered '?' and nulls in data", () => {
    const { active } = evaluateCrankHealth(sample({ lossStaleCycles: T.lossStaleCycles }), freshStreaks(), T, NOW);
    const a = active.find((x) => x.kind === "loss-stale")!;
    assert.equal(a.severity, "critical");
    assert.match(a.message, /stale \?L\/\?S, positioned \?, overflow 0, follow-up refreshed 0/);
    assert.equal(a.data!.staleLong, null);
    assert.equal(a.data!.positioned, null);
    // below threshold: nothing
    assert.deepEqual(evaluateCrankHealth(sample({ lossStaleCycles: T.lossStaleCycles - 1 }), freshStreaks(), T, NOW).active, []);
  });

  it("loss-stale carries the real counts when known", () => {
    const { active } = evaluateCrankHealth(
      sample({ lossStaleCycles: 5, staleLong: 2, staleShort: 1, positioned: 9, overflow: 3, overflowRefreshed: 2 }),
      freshStreaks(),
      T,
      NOW,
    );
    const a = active.find((x) => x.kind === "loss-stale")!;
    assert.match(a.message, /stale 2L\/1S, positioned 9, overflow 3, follow-up refreshed 2/);
    assert.equal(a.data!.overflowRefreshed, 2);
  });

  it("loss-stale-prolonged: episode start is tracked, fires only past lossStaleProlongedMs, and resets on a clean cycle", () => {
    const first = evaluateCrankHealth(sample({ lossStaleCycles: 1 }), freshStreaks(), T, NOW);
    assert.equal(first.streaks.lossStaleSince, NOW);
    assert.ok(!kinds(first.active).includes("loss-stale-prolonged"));
    // Exactly at the bound (comparison is strict >): still quiet, start preserved.
    const mid = evaluateCrankHealth(sample({ lossStaleCycles: 2 }), first.streaks, T, NOW + T.lossStaleProlongedMs);
    assert.equal(mid.streaks.lossStaleSince, NOW);
    assert.ok(!kinds(mid.active).includes("loss-stale-prolonged"));
    // Past the bound.
    const late = evaluateCrankHealth(
      sample({ lossStaleCycles: 4, staleLong: 1, staleShort: 0, positioned: 2 }),
      first.streaks,
      T,
      NOW + T.lossStaleProlongedMs + 60_000,
    );
    const a = late.active.find((x) => x.kind === "loss-stale-prolonged")!;
    assert.equal(a.severity, "critical");
    assert.equal(a.data!.sinceMs, NOW);
    assert.equal(a.data!.lossStaleMinutes, 6);
    assert.match(a.message, /LOSS-STALE for > 5 min \(~6 min observed, 4 consecutive cycles\)/);
    // A clean cycle ends the episode.
    const clean = evaluateCrankHealth(sample({ lossStaleCycles: 0 }), late.streaks, T, NOW + 10 * 60_000);
    assert.equal(clean.streaks.lossStaleSince, null);
    assert.ok(!kinds(clean.active).includes("loss-stale-prolonged"));
  });

  it("loss-stale-prolonged with sparse fields uses '?' / null fallbacks", () => {
    const prev = { ...freshStreaks(), lossStaleSince: NOW - 3_600_000 };
    const { active } = evaluateCrankHealth(sample({ lossStaleCycles: 1 }), prev, T, NOW);
    const a = active.find((x) => x.kind === "loss-stale-prolonged")!;
    assert.match(a.message, /stale \?L\/\?S, positioned \?, overflow 0/);
    assert.equal(a.data!.staleShort, null);
  });

  it("lapsed-bucket needs lapsedBucketCycles consecutive cycles and clears to zero", () => {
    let st = freshStreaks();
    let out = evaluateCrankHealth(sample({ lapsedBuckets: 2 }), st, T, NOW);
    for (let i = 1; i < T.lapsedBucketCycles; i++) {
      assert.ok(!kinds(out.active).includes("lapsed-bucket"));
      st = out.streaks;
      out = evaluateCrankHealth(sample({ lapsedBuckets: 2 }), st, T, NOW);
    }
    const a = out.active.find((x) => x.kind === "lapsed-bucket")!;
    assert.equal(a.severity, "warn");
    assert.equal(a.data!.cycles, T.lapsedBucketCycles);
    assert.equal(evaluateCrankHealth(sample({ lapsedBuckets: 0 }), out.streaks, T, NOW).streaks.lapsedCycles, 0);
  });

  it("bankrupt-unliquidated counts only the unliquidated remainder and clears when all liquidated", () => {
    let out = evaluateCrankHealth(sample({ bankruptFound: 3, bankruptLiquidated: 1 }), freshStreaks(), T, NOW);
    assert.ok(!kinds(out.active).includes("bankrupt-unliquidated"));
    out = evaluateCrankHealth(sample({ bankruptFound: 3, bankruptLiquidated: 1 }), out.streaks, T, NOW);
    const a = out.active.find((x) => x.kind === "bankrupt-unliquidated")!;
    assert.equal(a.severity, "critical");
    assert.match(a.message, /^2 bankrupt account\(s\) not liquidated for 2 cycles/);
    assert.deepEqual([a.data!.bankrupt, a.data!.liquidated, a.data!.cycles], [3, 1, 2]);
    // Liquidated >= found -> unliquidated clamps to 0 and the streak resets.
    assert.equal(evaluateCrankHealth(sample({ bankruptFound: 1, bankruptLiquidated: 2 }), out.streaks, T, NOW).streaks.bankruptCycles, 0);
  });

  it("market-layout: critical when positions unknown/present, warn when provably empty; UNKNOWN vs unsupported wording", () => {
    const layout = (over: Partial<NonNullable<CrankHealthSample["layout"]>>) => ({
      id: "L1",
      problem: "bad header",
      kind: "unsupported",
      accountLen: 123,
      provisional: false,
      hasPositions: null as boolean | null,
      ...over,
    });
    const get = (l: ReturnType<typeof layout>) =>
      evaluateCrankHealth(sample({ layout: l }), freshStreaks(), T, NOW).active.find((x) => x.kind === "market-layout")!;
    assert.equal(get(layout({})).severity, "critical");
    assert.match(get(layout({})).message, /layout unsupported \(bad header\)/);
    assert.equal(get(layout({ hasPositions: true })).severity, "critical");
    assert.equal(get(layout({ hasPositions: false })).severity, "warn");
    assert.match(get(layout({ kind: "unknown" })).message, /layout UNKNOWN/);
    // No problem: silent.
    assert.deepEqual(evaluateCrankHealth(sample({ layout: layout({ problem: null }) }), freshStreaks(), T, NOW).active, []);
  });

  it("slot-lag and crank-reverts: warn vs critical, '?' when the revert code is unknown", () => {
    const warn = evaluateCrankHealth(sample({ engineSlot: 1_000_000n - BigInt(T.slotLagWarn) }), freshStreaks(), T, NOW).active;
    assert.equal(warn.find((x) => x.kind === "slot-lag")!.severity, "warn");
    const crit = evaluateCrankHealth(sample({ engineSlot: 1_000_000n - BigInt(T.slotLagCritical) }), freshStreaks(), T, NOW).active;
    assert.equal(crit.find((x) => x.kind === "slot-lag")!.severity, "critical");
    const rev = evaluateCrankHealth(sample({ consecutiveReverts: T.crankConsecutiveReverts }), freshStreaks(), T, NOW).active;
    assert.match(rev.find((x) => x.kind === "crank-reverts")!.message, /Custom\(\?\)/);
    // Undecoded header: no lag alert at all.
    assert.deepEqual(evaluateCrankHealth(sample({ engineSlot: null }), freshStreaks(), T, NOW).active, []);
  });

  it("adl reduce-only: since-boot caveat, one-side-empty wording, critical past the slot bound, reset when not reduce-only", () => {
    const adl = (over: Partial<NonNullable<CrankHealthSample["adl"]>> = {}) => ({
      aLong: 500_000_000_000_000n,
      aShort: 1_000_000_000_000_000n,
      oiEffLong: 10n,
      oiEffShort: 20n,
      reduceOnly: true,
      ...over,
    });
    const a = evaluateCrankHealth(sample({ adl: adl() }), freshStreaks(), T, NOW);
    const first = a.active.find((x) => x.kind === "adl-reduce-only")!;
    assert.equal(first.severity, "warn");
    assert.match(first.message, /since keeper boot/);
    assert.match(first.message, /Both sides still hold OI/);
    assert.equal(a.streaks.adlObserved, true);
    // Second cycle far later, on an episode injected with sinceBoot:false (sinceBoot is fixed at episode start): critical, no "since boot".
    const later = evaluateCrankHealth(
      sample({ adl: adl({ oiEffShort: 0n }), chainSlot: 1_000_000n + BigInt(T.adlReduceOnlyCriticalSlots) }),
      { ...a.streaks, reduceOnlySince: { slot: 1_000_000n, ms: NOW, sinceBoot: false } },
      T,
      NOW + 120_000,
    );
    const crit = later.active.find((x) => x.kind === "adl-reduce-only")!;
    assert.equal(crit.severity, "critical");
    assert.doesNotMatch(crit.message, /since keeper boot/);
    assert.doesNotMatch(crit.message, /Both sides/);
    // Leaves reduce-only: episode cleared; an undecodable (null) read keeps it.
    assert.equal(evaluateCrankHealth(sample({ adl: adl({ reduceOnly: false }) }), later.streaks, T, NOW).streaks.reduceOnlySince, null);
    assert.deepEqual(evaluateCrankHealth(sample({ adl: null }), later.streaks, T, NOW).streaks.reduceOnlySince, later.streaks.reduceOnlySince);
  });
});

describe("crankHealthRecord", () => {
  it("minimal sample: only the base fields plus lsc=0", () => {
    assert.deepEqual(crankHealthRecord(sample()), {
      m: "SOL",
      lag: 10,
      ok: 10,
      rev: 0,
      cons: 0,
      lapsed: 0,
      bankrupt: 0,
      liq: 0,
      lsc: 0,
    });
  });

  it("full sample: stale, positioned, overflow, layout (with error), sweep and ADL reduce-only fields", () => {
    const r = crankHealthRecord(
      sample({
        staleLong: 3,
        staleShort: null,
        positioned: 7,
        overflow: 2,
        overflowRefreshed: undefined,
        lossStaleCycles: 4,
        layout: { id: "L9", problem: "x", kind: "unknown", accountLen: 1, provisional: true, hasPositions: null },
        sweep: { coverageRatio: 0.5, covered: true, blocksRiskIncrease: false, laggardLong: 1, laggardShort: 2, pace: "fast", k: 8, txsSent: 3 },
        adl: { aLong: 500_000_000_000_000n, aShort: 1_000_000_000_000_000n, oiEffLong: 5n, oiEffShort: 6n, reduceOnly: true },
      }),
    );
    assert.deepEqual(r, {
      m: "SOL",
      lag: 10,
      ok: 10,
      rev: 0,
      cons: 0,
      lapsed: 0,
      bankrupt: 0,
      liq: 0,
      stL: 3,
      stS: null,
      pos: 7,
      ovf: 2,
      ovfOk: 0,
      lsc: 4,
      lay: "L9",
      layErr: 1,
      cov: 0.5,
      cvd: 1,
      blk: 0,
      lgL: 1,
      lgS: 2,
      pace: "fast",
      k: 8,
      stx: 3,
      ro: 1,
      aL: "0.500000",
      aS: "1.000000",
      oiL: "5",
      oiS: "6",
    });
  });

  it("layout without a problem has no layErr; adl not reduce-only adds nothing", () => {
    const r = crankHealthRecord(
      sample({
        layout: { id: "L2", problem: null, kind: "ok", accountLen: 1, provisional: false, hasPositions: true },
        adl: { aLong: 1n, aShort: 1n, oiEffLong: 1n, oiEffShort: 1n, reduceOnly: false },
        overflow: 1,
        overflowRefreshed: 1,
      }),
    );
    assert.equal(r.lay, "L2");
    assert.ok(!("layErr" in r));
    assert.ok(!("ro" in r));
    assert.equal(r.ovfOk, 1);
  });
});

describe("evaluatePushCycle", () => {
  const ps = (registered: number, pushed: number) => ({ cycle: 1, registered, attempted: registered, pushed });
  it("streaks only while markets are registered and zero landed; alert at zeroPushCycles", () => {
    let z = 0;
    for (let i = 0; i < T.zeroPushCycles - 1; i++) {
      const r = evaluatePushCycle(ps(3, 0), z, T);
      assert.deepEqual(r.active, []);
      z = r.zeroStreak;
    }
    const hit = evaluatePushCycle(ps(3, 0), z, T);
    assert.equal(hit.active[0].kind, "zero-pushes");
    assert.equal(hit.active[0].subject, "*");
    assert.equal(hit.active[0].severity, "critical");
    assert.equal(evaluatePushCycle(ps(3, 1), hit.zeroStreak, T).zeroStreak, 0);
    assert.equal(evaluatePushCycle(ps(0, 0), hit.zeroStreak, T).zeroStreak, 0);
  });
});

describe("evaluateMarketPush", () => {
  const ms = (p: Partial<MarketPushSample> = {}): MarketPushSample => ({
    label: "SOL",
    market: "Mkt1",
    noPushCycles: 0,
    lastPushAt: NOW - 5_000,
    lastError: null,
    markGap: null,
    sourceUnchangedSince: null,
    terminal: false,
    ...p,
  });

  it("healthy -> ok, no alerts", () => {
    assert.deepEqual(evaluateMarketPush(ms(), T, NOW), { status: "ok", active: [] });
  });

  it("terminal markets are never alerted, even if everything else is bad", () => {
    const r = evaluateMarketPush(ms({ terminal: true, unregistered: true, noPushCycles: 999 }), T, NOW);
    assert.deepEqual(r, { status: "ok", active: [] });
  });

  it("unregistered -> critical market-unregistered and returns early", () => {
    const r = evaluateMarketPush(ms({ unregistered: true, noPushCycles: 999 }), T, NOW);
    assert.equal(r.status, "unregistered");
    assert.deepEqual(kinds(r.active), ["market-unregistered"]);
    assert.equal(r.active[0].severity, "critical");
  });

  it("no-push: 'never since keeper boot' vs seconds-ago, and the last error is quoted", () => {
    const never = evaluateMarketPush(ms({ noPushCycles: T.marketNoPushCycles, lastPushAt: null }), T, NOW);
    assert.equal(never.status, "no-push");
    assert.match(never.active[0].message, /last push never since keeper boot; last error: none/);
    const ago = evaluateMarketPush(ms({ noPushCycles: T.marketNoPushCycles, lastPushAt: NOW - 90_500, lastError: "rpc 429" }), T, NOW);
    assert.match(ago.active[0].message, /last push 90s ago; last error: rpc 429/);
    assert.equal(evaluateMarketPush(ms({ noPushCycles: T.marketNoPushCycles - 1 }), T, NOW).status, "ok");
  });

  it("mark-lagging needs BOTH age and pct; direction picks the wording", () => {
    const gap = (pct: number, ageMs: number, dir: 1 | -1) => ms({ markGap: { pct, ageMs, checks: 4, dir } });
    assert.equal(evaluateMarketPush(gap(T.markLagPct - 1, T.markLagMs, 1), T, NOW).status, "ok");
    assert.equal(evaluateMarketPush(gap(T.markLagPct, T.markLagMs - 1, 1), T, NOW).status, "ok");
    const below = evaluateMarketPush(gap(12.34, 130_000, 1), T, NOW);
    assert.equal(below.status, "mark-lagging");
    assert.match(below.active[0].message, /12\.3% BELOW the source price for 130s \(4 checks\).*a long opened now/);
    assert.equal(below.active[0].data!.gapPct, 12.34);
    const above = evaluateMarketPush(gap(12, 130_000, -1), T, NOW);
    assert.match(above.active[0].message, /ABOVE.*a short opened now/);
  });

  it("no-push outranks mark-lagging and source-frozen in status but all alerts are emitted", () => {
    const r = evaluateMarketPush(
      ms({
        noPushCycles: T.marketNoPushCycles,
        markGap: { pct: 50, ageMs: 999_999, checks: 9, dir: 1 },
        sourceUnchangedSince: NOW - T.sourceFrozenMs,
      }),
      T,
      NOW,
    );
    assert.equal(r.status, "no-push");
    assert.deepEqual(kinds(r.active), ["market-no-push", "mark-lagging", "source-frozen"]);
  });

  it("source-frozen: warn at sourceFrozenMs, critical at sourceDeadMs; status mark-lagging wins over source-frozen", () => {
    const warn = evaluateMarketPush(ms({ sourceUnchangedSince: NOW - T.sourceFrozenMs }), T, NOW);
    assert.equal(warn.status, "source-frozen");
    assert.equal(warn.active[0].severity, "warn");
    assert.equal(warn.active[0].data!.unchangedMinutes, T.sourceFrozenMs / 60_000);
    const dead = evaluateMarketPush(ms({ sourceUnchangedSince: NOW - T.sourceDeadMs }), T, NOW);
    assert.equal(dead.active[0].severity, "critical");
    assert.equal(evaluateMarketPush(ms({ sourceUnchangedSince: NOW - T.sourceFrozenMs + 1 }), T, NOW).status, "ok");
    const both = evaluateMarketPush(
      ms({ sourceUnchangedSince: NOW - T.sourceFrozenMs, markGap: { pct: 20, ageMs: T.markLagMs, checks: 1, dir: 1 } }),
      T,
      NOW,
    );
    assert.equal(both.status, "mark-lagging");
    // sourceDeadMs below sourceFrozenMs: the alert is critical as soon as it fires, never warn; below sourceFrozenMs nothing fires.
    const odd = evaluateMarketPush(ms({ sourceUnchangedSince: NOW - 1_000 }), { ...T, sourceFrozenMs: 1_000, sourceDeadMs: 10 }, NOW);
    assert.equal(odd.active[0].severity, "critical");
    const odd2 = evaluateMarketPush(ms({ sourceUnchangedSince: NOW - 1_000 }), { ...T, sourceFrozenMs: 2_000, sourceDeadMs: 10 }, NOW);
    assert.deepEqual(odd2.active, []);
  });

  it("depth-unavailable: only when depthAbsentSince is set and old enough (null and undefined are both 'not absent')", () => {
    assert.deepEqual(evaluateMarketPush(ms({ depthAbsentSince: null }), T, NOW).active, []);
    assert.deepEqual(evaluateMarketPush(ms({ depthAbsentSince: undefined }), T, NOW).active, []);
    assert.deepEqual(evaluateMarketPush(ms({ depthAbsentSince: NOW - T.depthAbsentMs + 1 }), T, NOW).active, []);
    const r = evaluateMarketPush(ms({ depthAbsentSince: NOW - T.depthAbsentMs - 60_000 }), T, NOW);
    assert.deepEqual(kinds(r.active), ["depth-unavailable"]);
    assert.equal(r.active[0].severity, "warn");
    assert.equal(r.active[0].data!.absentMinutes, 31);
    assert.equal(r.status, "ok");
  });
});

describe("evaluateBandPinExpiry", () => {
  const pin = (over: Partial<NonNullable<BandPinSample["pin"]>> = {}) => ({
    assetIndex: 2,
    sinceSlot: 100n,
    durationSlots: 4_600n,
    maxPinSlots: 9_000n,
    remaining: 4_400n,
    expired: false,
    ...over,
  });
  const bp = (p: Partial<BandPinSample> = {}): BandPinSample => ({
    label: "SOL",
    market: "Mkt1",
    terminal: false,
    pin: pin(),
    noPushCycles: 0,
    lastPushAt: NOW,
    ...p,
  });

  it("silent for terminal, unpinned, and pins still far from expiry", () => {
    assert.deepEqual(evaluateBandPinExpiry(bp({ terminal: true }), T), []);
    assert.deepEqual(evaluateBandPinExpiry(bp({ pin: null }), T), []);
    assert.deepEqual(evaluateBandPinExpiry(bp({ pin: pin({ remaining: BigInt(T.bandPinExpirySlots) + 1n }) }), T), []);
  });

  it("warn when pushes are landing, with the boundary (remaining == threshold) included", () => {
    const [a] = evaluateBandPinExpiry(bp({ pin: pin({ remaining: BigInt(T.bandPinExpirySlots) }) }), T);
    assert.equal(a.kind, "band-pin-expiring");
    assert.equal(a.severity, "warn");
    assert.match(a.message, /expires in 4500 slots \(pinned 4600\/9000\); pushes are landing/);
    assert.equal(a.data!.expired, false);
    assert.equal(a.data!.remainingSlots, "4500");
  });

  it("critical when no push has ever landed or the last cycle(s) landed none", () => {
    assert.equal(evaluateBandPinExpiry(bp({ lastPushAt: null }), T)[0].severity, "critical");
    const [a] = evaluateBandPinExpiry(bp({ noPushCycles: 3 }), T);
    assert.equal(a.severity, "critical");
    assert.match(a.message, /NO push has landed for it/);
  });

  it("critical and 'EXPIRED' wording once the pin expired, even with healthy pushes and remaining 0", () => {
    const [a] = evaluateBandPinExpiry(bp({ pin: pin({ expired: true, remaining: 0n, durationSlots: 9_100n }) }), T);
    assert.equal(a.severity, "critical");
    assert.match(a.message, /EXPIRED \(9100 > 9000 slots\)/);
    assert.match(a.message, /pushes are landing/);
    assert.equal(a.data!.expired, true);
  });
});
