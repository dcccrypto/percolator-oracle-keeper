/**
 * D1 monitoring (d1-watch.ts): close-only episodes on band markets, the tag-104 wind-down SLA, and the /health rollup.
 * Pure tracker / evaluator tests plus the V22Loop wiring through the shared AlertSink (fires, escalates to critical past
 * bound + grace, resolves when the side resets, survives an undecodable read, stays silent on a healthy market).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { AlertSink, DEFAULT_THRESHOLDS } from "../alerting.ts";
import { ADL_ONE } from "../adl-state.ts";
import { engineSlotBase, layoutById } from "../market-layout.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { V22_ASSET_BAND_OFF } from "./market.ts";
import {
  ADL_D1_ALERT_SCOPE,
  AdlEpisodeTracker,
  DEFAULT_ADL_D1_THRESHOLDS,
  adlD1ThresholdsFromEnv,
  adlEpisodeLevel,
  evaluateAdlD1,
} from "./d1-watch.ts";
import type { AdlAssetReading } from "./d1-watch.ts";
import { key, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const L = layoutById("v2.2-b");
const T = DEFAULT_ADL_D1_THRESHOLDS; // bound 9,000, grace 1,500

const reading = (closeOnly: boolean, assetIndex = 0): AdlAssetReading => ({
  assetIndex,
  closeOnly,
  oiEffLong: 5_000n,
  oiEffShort: 4_000n,
  aLong: closeOnly ? 924_000_000_000_000n : ADL_ONE,
  aShort: ADL_ONE,
});

describe("d1-watch: thresholds", () => {
  it("defaults are the tag-104 bound (9,000) and a 1,500-slot grace", () => {
    assert.deepEqual(adlD1ThresholdsFromEnv({}), { boundSlots: 9_000n, graceSlots: 1_500n });
  });
  it("custom values; garbage / zero / non-integer fall back to the default with one error each (never throws)", () => {
    const errs: string[] = [];
    assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_BOUND_SLOTS: "4500", ALERT_ADL_WIND_DOWN_GRACE_SLOTS: "300" }, (l) => errs.push(l)), { boundSlots: 4_500n, graceSlots: 300n });
    assert.equal(errs.length, 0);
    for (const v of ["abc", "0", "-5", "1.5", "9000ms"]) {
      assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_BOUND_SLOTS: v }, (l) => errs.push(l)), T);
    }
    assert.equal(errs.length, 5);
  });
  it("levels: close-only < bound <= wind-down-due < bound + grace <= overdue", () => {
    assert.equal(adlEpisodeLevel(0n, T), "close-only");
    assert.equal(adlEpisodeLevel(8_999n, T), "close-only");
    assert.equal(adlEpisodeLevel(9_000n, T), "wind-down-due");
    assert.equal(adlEpisodeLevel(10_499n, T), "wind-down-due");
    assert.equal(adlEpisodeLevel(10_500n, T), "overdue");
  });
});

describe("d1-watch: episode tracker", () => {
  it("counts the age from the first close-only read; a side reset ends the episode and is recorded", () => {
    const tr = new AdlEpisodeTracker(T);
    assert.deepEqual(tr.observe([reading(false)], 1_000n), []);
    const [a] = tr.observe([reading(true)], 2_000n);
    assert.equal(a.ageSlots, 0n);
    assert.equal(a.sinceBoot, false);
    const [b] = tr.observe([reading(true)], 3_500n);
    assert.equal(b.ageSlots, 1_500n);
    assert.equal(b.observedSinceSlot, 2_000n);
    assert.equal(b.slotsToBound, 7_500n);
    assert.deepEqual(tr.observe([reading(false)], 4_000n), []);
    const sm = tr.summary([]);
    assert.equal(sm.endedEpisodes, 1);
    assert.equal(sm.longestEndedSlots, "2000");
    assert.equal(sm.endedPastBound, 0);
  });
  it("an episode already running at the first read after boot is flagged sinceBoot (age = lower bound)", () => {
    const tr = new AdlEpisodeTracker(T);
    const [a] = tr.observe([reading(true)], 50_000n);
    assert.equal(a.sinceBoot, true);
  });
  it("an episode that ended past the bound is counted (a wind-down or organic reset finished it late)", () => {
    const tr = new AdlEpisodeTracker(T);
    tr.observe([reading(true)], 1_000n);
    tr.observe([reading(false)], 10_500n);
    assert.equal(tr.summary([]).endedPastBound, 1);
  });
  it("assets are independent; reset() (terminal market) ends every episode", () => {
    const tr = new AdlEpisodeTracker(T);
    const eps = tr.observe([reading(true, 0), reading(false, 1), reading(true, 2)], 1_000n);
    assert.deepEqual(eps.map((e) => e.assetIndex), [0, 2]);
    tr.reset(2_000n);
    assert.equal(tr.summary([]).endedEpisodes, 2);
    assert.deepEqual(tr.observe([reading(false)], 3_000n), []);
  });
});

describe("d1-watch: evaluation (pure)", () => {
  const sample = (age: bigint, terminal = false) => {
    const tr = new AdlEpisodeTracker(T);
    tr.observe([reading(true)], 1_000n);
    const nowSlot = 1_000n + age;
    const readings = [reading(true)];
    return { label: "BAND/T", market: "M", nowSlot, terminal, episodes: tr.observe(readings, nowSlot), readings };
  };
  it("close-only below the bound: one WARN adl-close-only, no critical", () => {
    const a = evaluateAdlD1(sample(100n), T);
    assert.deepEqual(a.map((x) => [x.kind, x.severity]), [["adl-close-only", "warn"]]);
    assert.equal(a[0].subject, "BAND/T#0");
    assert.match(a[0].message, /tag 104/);
    assert.match(a[0].message, /8900 slots from now/);
  });
  it("past the bound but inside the grace: still WARN only (the wind-down may be landing)", () => {
    assert.deepEqual(evaluateAdlD1(sample(9_500n), T).map((x) => x.severity), ["warn"]);
  });
  it("past bound + grace: CRITICAL adl-wind-down-overdue naming what the wind-down needs, with the OI on both sides", () => {
    const a = evaluateAdlD1(sample(10_500n), T);
    assert.deepEqual(a.map((x) => [x.kind, x.severity]), [["adl-close-only", "warn"], ["adl-wind-down-overdue", "critical"]]);
    assert.match(a[1].message, /arming call/);
    assert.match(a[1].message, /answers 27/);
    assert.equal(a[1].data?.oiEffLong, "5000");
    assert.equal(a[1].data?.boundSlots, "9000");
  });
  it("terminal market: never alerted", () => {
    assert.deepEqual(evaluateAdlD1(sample(20_000n, true), T), []);
  });
});

// ── V22Loop wiring ───────────────────────────────────────────────────────────

const MARKET = key(900);
const LP = key(901);

/** A band market whose asset 0 has A_long / A_short set (u128 @49 / @65 of the engine slot) and OI @289 / @305. */
function bandMarket(o: { aLong: bigint; aShort: bigint; currentSlot: bigint; lifecycle?: number }): Uint8Array {
  const b = Buffer.from(v22MarketBytes({ band: true, currentSlot: o.currentSlot, lifecycle: o.lifecycle }));
  const e = engineSlotBase(L, 0);
  const w128 = (off: number, v: bigint) => {
    b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, e + off);
    b.writeBigUInt64LE(v >> 64n, e + off + 8);
  };
  w128(49, o.aLong);
  w128(65, o.aShort);
  w128(289, 5_000n);
  w128(305, 4_000n);
  b.writeBigUInt64LE(1n, e + V22_ASSET_BAND_OFF.epoch);
  b.writeBigUInt64LE(o.currentSlot, e + V22_ASSET_BAND_OFF.anchorSlot);
  return new Uint8Array(b);
}

function chain(init: { market: Uint8Array; slot: number }) {
  const st = { ...init };
  const acct = (d: Uint8Array | null) => (d ? { data: Buffer.from(d), owner: key(1), lamports: 1, executable: false } : null);
  const conn = {
    async getMultipleAccountsInfoAndContext() {
      return { context: { slot: st.slot }, value: [acct(st.market), acct(registryBytes({ bound: true, ext: true, bond: false })), acct(vaultLpStateBytes(LP))] };
    },
    async getAccountInfo() {
      return null; // no vault LP portfolio: the LP-cert check keeps its (empty) state
    },
    async getSlot() {
      return st.slot;
    },
  };
  return { st, conn };
}

function loopOn(c: ReturnType<typeof chain>, now: { t: number }) {
  const lines: string[] = [];
  const errs: string[] = [];
  const sink = new AlertSink({ thresholds: { ...DEFAULT_THRESHOLDS }, now: () => now.t, log: (l) => lines.push(l), logError: (l) => errs.push(l) });
  const loop = new V22Loop({
    conn: c.conn as never,
    keeper: Keypair.generate(),
    programId: WRAPPER_PROGRAM_ID,
    markets: () => [{ marketAddress: MARKET.toBase58(), label: "BAND/T" }],
    flags: v22FlagsFromEnv({ KEEPER_V22: "on" }),
    dryRun: true,
    alertSink: sink,
    adlD1Thresholds: { ...T },
    now: () => now.t,
    log: () => {},
  });
  const fired = (kind: string) => errs.filter((l) => l.startsWith("[ALERT]") && l.includes(`"kind":"${kind}"`));
  const resolved = (kind: string) => lines.filter((l) => l.startsWith("[ALERT-RESOLVED]") && l.includes(`"kind":"${kind}"`));
  return { loop, fired, resolved, errs, lines };
}

type D1Health = { d1: Record<string, unknown>; markets: Record<string, { adlCloseOnly?: { episodes: Array<{ level: string; ageSlots: string }>; endedEpisodes: number } }> };

describe("d1-watch: V22Loop fires, escalates, resolves and reports on /health", () => {
  it("close-only -> WARN; past bound + grace -> CRITICAL (no cooldown wait); side reset -> both resolve", async () => {
    const now = { t: 1_000_000 };
    const c = chain({ market: bandMarket({ aLong: 924_000_000_000_000n, aShort: ADL_ONE, currentSlot: 50_000n }), slot: 50_000 });
    const h = loopOn(c, now);

    await h.loop.tick();
    assert.equal(h.fired("adl-close-only").length, 1);
    assert.match(h.fired("adl-close-only")[0], /"severity":"warn"/);
    assert.equal(h.fired("adl-wind-down-overdue").length, 0);
    let health = h.loop.healthFields() as D1Health;
    assert.equal(health.d1.closeOnlyMarkets, 1);
    assert.equal(health.d1.windDownDueMarkets, 0);
    assert.equal(health.d1.windDownOverdueMarkets, 0);
    assert.equal(health.markets[MARKET.toBase58()].adlCloseOnly?.episodes[0].level, "close-only");

    c.st.slot = 59_100; // 9,100 slots in: past the bound, inside the grace
    c.st.market = bandMarket({ aLong: 924_000_000_000_000n, aShort: ADL_ONE, currentSlot: 59_100n });
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.fired("adl-wind-down-overdue").length, 0);
    health = h.loop.healthFields() as D1Health;
    assert.equal(health.d1.windDownDueMarkets, 1);
    assert.equal(health.d1.windDownOverdueMarkets, 0);

    c.st.slot = 60_600; // 10,600 slots: bound + grace passed with no wind-down
    c.st.market = bandMarket({ aLong: 924_000_000_000_000n, aShort: ADL_ONE, currentSlot: 60_600n });
    now.t += 20_000; // far inside the 15-min cooldown of the WARN
    await h.loop.tick();
    assert.equal(h.fired("adl-wind-down-overdue").length, 1, "the critical pages at once");
    assert.match(h.fired("adl-wind-down-overdue")[0], /"severity":"critical"/);
    assert.equal(h.fired("adl-close-only").length, 1, "the WARN is not repeated inside its cooldown");
    health = h.loop.healthFields() as D1Health;
    assert.equal(health.d1.windDownOverdueMarkets, 1);
    assert.equal(health.markets[MARKET.toBase58()].adlCloseOnly?.episodes[0].ageSlots, "10600");

    // the wind-down lands: the reduce-only side resets, A returns to 1
    c.st.market = bandMarket({ aLong: ADL_ONE, aShort: ADL_ONE, currentSlot: 60_700n });
    c.st.slot = 60_700;
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.resolved("adl-close-only").length, 1);
    assert.equal(h.resolved("adl-wind-down-overdue").length, 1);
    health = h.loop.healthFields() as D1Health;
    assert.equal(health.d1.closeOnlyMarkets, 0);
    assert.equal(health.markets[MARKET.toBase58()].adlCloseOnly?.endedEpisodes, 1);
  });

  it("NEGATIVE CONTROL: a healthy market (A = 1 on both sides) for 30,000 slots never alerts and reports zeros", async () => {
    const now = { t: 1_000_000 };
    const c = chain({ market: bandMarket({ aLong: ADL_ONE, aShort: ADL_ONE, currentSlot: 50_000n }), slot: 50_000 });
    const h = loopOn(c, now);
    for (let i = 0; i < 10; i++) {
      c.st.slot = 50_000 + i * 3_000;
      c.st.market = bandMarket({ aLong: ADL_ONE, aShort: ADL_ONE, currentSlot: BigInt(c.st.slot) });
      now.t += 20_000;
      await h.loop.tick();
    }
    assert.equal(h.fired("adl-close-only").length, 0);
    assert.equal(h.fired("adl-wind-down-overdue").length, 0);
    const health = h.loop.healthFields() as D1Health;
    assert.deepEqual([health.d1.closeOnlyMarkets, health.d1.windDownOverdueMarkets, health.d1.lpCrankStaleCriticalMarkets], [0, 0, 0]);
    // and the same chain left close-only for the same span DOES page (the control is not vacuous)
    const c2 = chain({ market: bandMarket({ aLong: 924_000_000_000_000n, aShort: ADL_ONE, currentSlot: 50_000n }), slot: 50_000 });
    const h2 = loopOn(c2, now);
    for (let i = 0; i < 10; i++) {
      c2.st.slot = 50_000 + i * 3_000;
      c2.st.market = bandMarket({ aLong: 924_000_000_000_000n, aShort: ADL_ONE, currentSlot: BigInt(c2.st.slot) });
      now.t += 20_000;
      await h2.loop.tick();
    }
    assert.equal(h2.fired("adl-wind-down-overdue").length, 1);
  });

  it("a Resolved market (not Live) or a non-band market is never alerted", async () => {
    const now = { t: 1 };
    const resolved = chain({ market: bandMarket({ aLong: 924_000_000_000_000n, aShort: ADL_ONE, currentSlot: 50_000n, lifecycle: 4 }), slot: 50_000 });
    const h = loopOn(resolved, now);
    await h.loop.tick();
    assert.equal(h.fired("adl-close-only").length, 0);
    const plain = chain({ market: v22MarketBytes({ currentSlot: 50_000n }), slot: 50_000 });
    const h2 = loopOn(plain, now);
    await h2.loop.tick();
    assert.equal(h2.fired("adl-close-only").length, 0);
  });

  it("scope name is stable", () => {
    assert.equal(ADL_D1_ALERT_SCOPE, "v22-adl-close-only");
  });
});

// ── branch coverage: env edges, tracker edges, evaluator edges ─────────────────

describe("d1-watch: untaken branches", () => {
  it("env: whitespace-only is unset (default, no error); padded values are trimmed; > 10,000,000 is refused", () => {
    const errs: string[] = [];
    assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_BOUND_SLOTS: "   " }, (l) => errs.push(l)), T);
    assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_BOUND_SLOTS: " 4500 " }, (l) => errs.push(l)), { boundSlots: 4_500n, graceSlots: 1_500n });
    assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_GRACE_SLOTS: "10000000" }, (l) => errs.push(l)), { boundSlots: 9_000n, graceSlots: 10_000_000n });
    assert.equal(errs.length, 0);
    assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_GRACE_SLOTS: "10000001" }, (l) => errs.push(l)), T);
    assert.equal(errs.length, 1);
  });
  it("env: the default logger is console.error", () => {
    const orig = console.error;
    const seen: string[] = [];
    console.error = (m: string) => void seen.push(String(m));
    try {
      assert.deepEqual(adlD1ThresholdsFromEnv({ ALERT_ADL_WIND_DOWN_BOUND_SLOTS: "nope" }), T);
    } finally {
      console.error = orig;
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0], /ALERT_ADL_WIND_DOWN_BOUND_SLOTS/);
  });
  it("tracker: a clock that did not advance gives age 0; a later episode is not sinceBoot; ended-below-bound is not counted past bound", () => {
    const tr = new AdlEpisodeTracker(T);
    assert.equal(tr.observe([reading(false)], 100n).length, 0); // first read, healthy
    const e1 = tr.observe([reading(true)], 200n);
    assert.equal(e1[0].sinceBoot, false);
    const e2 = tr.observe([reading(true)], 150n); // slot went backwards
    assert.equal(e2[0].ageSlots, 0n);
    assert.equal(e2[0].slotsToBound, 9_000n);
    tr.observe([reading(false)], 100n); // ends with now < start: age 0
    const sum = tr.summary([]);
    assert.equal(sum.endedEpisodes, 1);
    assert.equal(sum.endedPastBound, 0);
    assert.equal(sum.longestEndedSlots, "0");
    tr.reset(500n); // nothing open: no-op
    assert.equal(tr.summary([]).endedEpisodes, 1);
  });
  it("tracker: a vanished asset and reset() end episodes; past-bound ends are counted; a long ended episode becomes the longest", () => {
    const tr = new AdlEpisodeTracker(T);
    tr.observe([reading(true, 0), reading(true, 1)], 1_000n);
    tr.observe([reading(true, 0)], 1_100n); // asset 1 vanished: ended at age 100
    assert.equal(tr.summary([]).endedEpisodes, 1);
    assert.equal(tr.summary([]).longestEndedSlots, "100");
    tr.reset(1_000n + 9_000n);
    const s = tr.summary([]);
    assert.equal(s.endedEpisodes, 2);
    assert.equal(s.endedPastBound, 1);
    assert.equal(s.longestEndedSlots, "9000");
  });
  it("evaluate: no matching reading omits OI; sinceBoot and 'already eligible' are worded; terminal is silent", () => {
    const tr = new AdlEpisodeTracker(T);
    tr.observe([reading(true)], 1_000n);
    const eps = tr.observe([reading(true)], 1_000n + 9_000n);
    const base = { label: "M", market: "mk", nowSlot: 10_000n, terminal: false, episodes: eps };
    const alerts = evaluateAdlD1({ ...base, readings: [] }, T);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, "adl-close-only");
    assert.equal(alerts[0].data && "oiEffLong" in alerts[0].data, false);
    assert.match(alerts[0].message, /observed since keeper boot/);
    assert.match(alerts[0].message, /already eligible/);
    assert.doesNotMatch(alerts[0].message, /OI long/);
    assert.deepEqual(evaluateAdlD1({ ...base, terminal: true, readings: [] }, T), []);
  });
});
