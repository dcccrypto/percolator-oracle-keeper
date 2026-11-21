/**
 * Vault-LP crank liveness (lp-cert-liveness.ts): thresholds, horizon derivation, decode, and the V22Loop wiring
 * (fires WARN -> CRITICAL, clears with ALERT-RESOLVED, survives a failed read, and stays silent while cranks are healthy).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { LAYOUT_V22 } from "@percolatorct/sdk";
import { AlertSink, DEFAULT_THRESHOLDS } from "../alerting.ts";
import { engineSlotBase, layoutById } from "../market-layout.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { V22_ASSET_BAND_OFF, V22_CONFIG_OFF } from "./market.ts";
import {
  DEFAULT_LP_CERT_THRESHOLDS,
  FALLBACK_BAND_MAX_EPOCH_SLOTS,
  FALLBACK_BAND_MIN_PIN_EPOCHS,
  LP_CERT_ALERT_SCOPE,
  evaluateVaultLpCrankStaleness,
  lpCertLevelOf,
  lpCertStalenessOf,
  lpCertThresholdsFromEnv,
  readLpCertAssets,
} from "./lp-cert-liveness.ts";
import type { LpCertAsset } from "./lp-cert-liveness.ts";
import { key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const L = layoutById("v2.2-b");
const T = DEFAULT_LP_CERT_THRESHOLDS;

/** A live band asset at E = 600, Pmax = 9,000 (horizon 9,600), anchored at slot 10,000, epoch 7. */
const asset = (o: Partial<LpCertAsset> = {}): LpCertAsset => ({
  assetIndex: 0,
  lifecycle: 2,
  epoch: 7n,
  anchorSlot: 10_000n,
  pinSinceSlot: 0n,
  maxEpochSlots: 600n,
  maxPinSlots: 9_000n,
  lpLegEpochSnap: 6n, // uncertified this epoch
  ...o,
});

describe("lp-cert-liveness: staleness and horizon (pure)", () => {
  it("horizon = E + Pmax from the on-chain config (9,600 at 600 + 9,000)", () => {
    const s = lpCertStalenessOf(asset(), 10_100n);
    assert.ok(s);
    assert.equal(s.horizonSlots, 9_600n);
    assert.equal(s.deadlineSlot, 19_600n);
    assert.equal(s.staleSlots, 100n);
    assert.equal(s.remainingSlots, 9_500n);
    assert.equal(s.horizonSource, "on-chain");
  });
  it("certified this epoch (snap >= epoch): 0 stale slots, level ok, however old the anchor", () => {
    const s = lpCertStalenessOf(asset({ lpLegEpochSnap: 7n }), 25_000n);
    assert.ok(s);
    assert.equal(s.certified, true);
    assert.equal(s.staleSlots, 0n);
    assert.equal(lpCertLevelOf(s, T), "ok");
  });
  it("an edge pin that started before anchor + E shortens the horizon to (pinSince - anchor) + Pmax", () => {
    const s = lpCertStalenessOf(asset({ pinSinceSlot: 10_050n }), 10_100n);
    assert.ok(s);
    assert.equal(s.deadlineSlot, 19_050n);
    assert.equal(s.horizonSlots, 9_050n);
  });
  it("a duration pin stamped after anchor + E does not extend the horizon past anchor + E + Pmax", () => {
    const s = lpCertStalenessOf(asset({ pinSinceSlot: 10_700n }), 10_800n);
    assert.ok(s);
    assert.equal(s.deadlineSlot, 19_600n);
  });
  it("config words reading 0: falls back to the engine floors (E 150, Pmax 8E) and says so", () => {
    const s = lpCertStalenessOf(asset({ maxEpochSlots: 0n, maxPinSlots: 0n }), 10_100n);
    assert.ok(s);
    assert.equal(s.horizonSlots, FALLBACK_BAND_MAX_EPOCH_SLOTS * 9n); // 150 + 1,200
    assert.equal(s.horizonSource, "fallback-engine-floor");
  });
  it("not applicable: LP holds no leg on the asset, band epoch 0, or the asset is not Active / DrainOnly", () => {
    assert.equal(lpCertStalenessOf(asset({ lpLegEpochSnap: null }), 20_000n), null);
    assert.equal(lpCertStalenessOf(asset({ epoch: 0n }), 20_000n), null);
    assert.equal(lpCertStalenessOf(asset({ lifecycle: 4 }), 20_000n), null);
    assert.ok(lpCertStalenessOf(asset({ lifecycle: 3 }), 20_000n), "DrainOnly still resolves by BandPinExpired");
  });
});

describe("lp-cert-liveness: thresholds (25% WARN / 50% CRITICAL of the horizon)", () => {
  const at = (stale: bigint) => {
    const s = lpCertStalenessOf(asset(), 10_000n + stale);
    assert.ok(s);
    return s;
  };
  it("boundaries at 9,600: 2,399 ok, 2,400 warn, 4,799 warn, 4,800 critical", () => {
    assert.equal(lpCertLevelOf(at(2_399n), T), "ok");
    assert.equal(lpCertLevelOf(at(2_400n), T), "warn");
    assert.equal(lpCertLevelOf(at(4_799n), T), "warn");
    assert.equal(lpCertLevelOf(at(4_800n), T), "critical");
    assert.equal(lpCertLevelOf(at(20_000n), T), "critical");
  });
  it("evaluate: one alert per market, kind vault-lp-crank-stale, severity by level, data carries the deadline", () => {
    const sample = (stale: bigint) => ({ label: "BAND/T", market: "M", terminal: false, nowSlot: 10_000n + stale, assets: [at(stale)] });
    assert.deepEqual(evaluateVaultLpCrankStaleness(sample(2_399n), T), []);
    const [w] = evaluateVaultLpCrankStaleness(sample(2_400n), T);
    assert.equal(w.kind, "vault-lp-crank-stale");
    assert.equal(w.severity, "warn");
    assert.equal(w.data?.deadlineSlot, "19600");
    assert.match(w.message, /25% of the 9600-slot resolve horizon/);
    const [c] = evaluateVaultLpCrankStaleness(sample(4_800n), T);
    assert.equal(c.severity, "critical");
  });
  it("terminal market: never alerted", () => {
    assert.deepEqual(evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: true, nowSlot: 30_000n, assets: [at(9_000n)] }, T), []);
  });
  it("multi-asset: the critical asset wins over a warn asset; among equals the nearest deadline", () => {
    const warnA = lpCertStalenessOf(asset({ assetIndex: 1 }), 12_500n);
    const critB = lpCertStalenessOf(asset({ assetIndex: 2, anchorSlot: 7_000n }), 12_500n);
    assert.ok(warnA && critB);
    const [a] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 12_500n, assets: [warnA, critB] }, T);
    assert.equal(a.severity, "critical");
    assert.equal(a.data?.assetIndex, 2);
  });
  it("env: defaults; custom; garbage and warn > critical fall back to defaults with one error each (never throws)", () => {
    const errs: string[] = [];
    assert.deepEqual(lpCertThresholdsFromEnv({}, (l) => errs.push(l)), { warnPct: 25, criticalPct: 50 });
    assert.deepEqual(lpCertThresholdsFromEnv({ ALERT_VAULT_LP_CRANK_WARN_PCT: "10", ALERT_VAULT_LP_CRANK_CRITICAL_PCT: "40" }, (l) => errs.push(l)), { warnPct: 10, criticalPct: 40 });
    assert.equal(errs.length, 0);
    assert.deepEqual(lpCertThresholdsFromEnv({ ALERT_VAULT_LP_CRANK_WARN_PCT: "abc" }, (l) => errs.push(l)), { warnPct: 25, criticalPct: 50 });
    assert.deepEqual(lpCertThresholdsFromEnv({ ALERT_VAULT_LP_CRANK_CRITICAL_PCT: "100" }, (l) => errs.push(l)), { warnPct: 25, criticalPct: 50 });
    assert.deepEqual(lpCertThresholdsFromEnv({ ALERT_VAULT_LP_CRANK_WARN_PCT: "60", ALERT_VAULT_LP_CRANK_CRITICAL_PCT: "40" }, (l) => errs.push(l)), { warnPct: 25, criticalPct: 50 });
    assert.equal(errs.length, 3);
  });
});

// ── bytes ────────────────────────────────────────────────────────────────────

const LP = key(901);
const MARKET = key(900);

/** A variant-B band market (E 600, Pmax 9,000) with the band words of asset 0 set. */
function bandMarket(o: { epoch: bigint; anchorSlot: bigint; pinSince?: bigint; currentSlot: bigint; lifecycle?: number }): Uint8Array {
  const b = Buffer.from(v22MarketBytes({ band: true, currentSlot: o.currentSlot, lifecycle: o.lifecycle, pinSince: o.pinSince }));
  const e = engineSlotBase(L, 0);
  b.writeBigUInt64LE(o.epoch, e + V22_ASSET_BAND_OFF.epoch);
  b.writeBigUInt64LE(o.anchorSlot, e + V22_ASSET_BAND_OFF.anchorSlot);
  return new Uint8Array(b);
}

/** The vault LP portfolio: one long leg on asset 0 with `band_epoch_snap` = snap. */
function lpPortfolio(snap: bigint): Uint8Array {
  const b = Buffer.from(portfolioBytes({ owner: key(8), capital: 1_000n, legs: [{ side: 0, basis: 5n }] }));
  const G = LAYOUT_V22.portfolio;
  const off = G.leg.bandEpochSnap;
  assert.ok(off !== null, "variant-B legs carry band_epoch_snap");
  b.writeBigUInt64LE(snap, G.legsOff + off);
  return new Uint8Array(b);
}

describe("lp-cert-liveness: decode from market + LP portfolio bytes", () => {
  it("reads E / Pmax / epoch / anchor / pin and the LP leg's band_epoch_snap", () => {
    const [a] = readLpCertAssets(bandMarket({ epoch: 7n, anchorSlot: 10_000n, pinSince: 10_650n, currentSlot: 11_000n }), L, [0], lpPortfolio(6n));
    assert.equal(a.maxEpochSlots, 600n);
    assert.equal(a.maxPinSlots, 9_000n);
    assert.equal(a.epoch, 7n);
    assert.equal(a.anchorSlot, 10_000n);
    assert.equal(a.pinSinceSlot, 10_650n);
    assert.equal(a.lpLegEpochSnap, 6n);
    assert.equal(a.lifecycle, 2);
    // the config words come from the documented offsets
    const raw = bandMarket({ epoch: 1n, anchorSlot: 1n, currentSlot: 2n });
    assert.equal(Buffer.from(raw).readBigUInt64LE(L.groupOff + V22_CONFIG_OFF.bandMaxEpochSlots), 600n);
  });
  it("an LP with no leg on the asset decodes as null (not counted); an asset beyond the account is skipped", () => {
    const flat = portfolioBytes({ owner: key(8), capital: 1_000n, legs: [] });
    const [a] = readLpCertAssets(bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 11_000n }), L, [0, 5], flat);
    assert.equal(a.lpLegEpochSnap, null);
    assert.equal(readLpCertAssets(bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 11_000n }), L, [0, 5], flat).length, 1);
  });
});

// ── V22Loop wiring ───────────────────────────────────────────────────────────

/** A mutable fake chain for the loop: the market and LP bytes and the read slot can change between ticks. */
function chain(init: { market: Uint8Array; lp: Uint8Array | null; slot: number }) {
  const st = { ...init, failLp: false };
  const acct = (d: Uint8Array | null) => (d ? { data: Buffer.from(d), owner: key(1), lamports: 1, executable: false } : null);
  const conn = {
    async getMultipleAccountsInfoAndContext() {
      return { context: { slot: st.slot }, value: [acct(st.market), acct(registryBytes({ bound: true, ext: true, bond: false })), acct(vaultLpStateBytes(LP))] };
    },
    async getAccountInfo(pk: { toBase58(): string }) {
      if (pk.toBase58() !== LP.toBase58()) return null;
      if (st.failLp) throw new Error("fetch failed https://x.helius-rpc.com/?api-key=SECRET123");
      return acct(st.lp);
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
    lpCertThresholds: { ...DEFAULT_LP_CERT_THRESHOLDS },
    now: () => now.t,
    log: () => {},
  });
  const alerts = () => errs.filter((l) => l.startsWith("[ALERT]") && l.includes("vault-lp-crank-stale"));
  const resolved = () => lines.filter((l) => l.startsWith("[ALERT-RESOLVED]") && l.includes("vault-lp-crank-stale"));
  return { loop, alerts, resolved, errs };
}

describe("lp-cert-liveness: V22Loop fires, escalates and clears through the shared sink", () => {
  it("uncertified LP: silent below 25%, WARN at 25%, CRITICAL at 50%, RESOLVED once the LP is certified", async () => {
    const now = { t: 1_000_000 };
    const c = chain({ market: bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 11_000n }), lp: lpPortfolio(6n), slot: 11_000 });
    const h = loopOn(c, now);

    await h.loop.tick(); // 1,000 stale slots (10%)
    assert.equal(h.alerts().length, 0);

    c.st.slot = 12_400; // 2,400 = 25%
    c.st.market = bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 12_400n });
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.alerts().length, 1);
    assert.match(h.alerts()[0], /"severity":"warn"/);
    assert.match(h.alerts()[0], /"kind":"vault-lp-crank-stale"/);

    c.st.slot = 14_800; // 4,800 = 50%
    c.st.market = bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 14_800n });
    now.t += 20_000; // well inside the 15-min cooldown of the WARN
    await h.loop.tick();
    assert.equal(h.alerts().length, 2, "the escalation pages AT ONCE, not after the WARN's cooldown");
    assert.match(h.alerts()[1], /"severity":"critical"/);
    assert.equal(h.resolved().length, 0, "escalating does not resolve the WARN");
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.alerts().length, 2, "no repeat inside the cooldown");
    const health = h.loop.healthFields() as { markets: Record<string, { vaultLpCert?: { level: string; staleSlots: string } }> };
    assert.equal(health.markets[MARKET.toBase58()].vaultLpCert?.level, "critical");
    assert.equal(health.markets[MARKET.toBase58()].vaultLpCert?.staleSlots, "4800");

    // a flaky LP read must neither resolve nor raise anything
    c.st.failLp = true;
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.resolved().length, 0, "a failed read keeps the alert active");

    // the LP is cranked: its leg is certified in epoch 7
    c.st.failLp = false;
    c.st.lp = lpPortfolio(7n);
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.resolved().length, 2, "both the warn and the critical record resolve");
    assert.ok(!h.errs.some((l) => l.includes("SECRET123")), "RPC key never logged");
  });

  it("NEGATIVE CONTROL: healthy cranks (LP certified every epoch while the anchor advances) never alert", async () => {
    const now = { t: 1_000_000 };
    const c = chain({ market: bandMarket({ epoch: 1n, anchorSlot: 10_000n, currentSlot: 10_050n }), lp: lpPortfolio(1n), slot: 10_050 });
    const h = loopOn(c, now);
    // 60 ticks over 36,000 slots (well past 3 full horizons): each epoch ~600 slots, the LP is certified a few slots in
    for (let i = 0; i < 60; i++) {
      const epoch = BigInt(1 + i);
      const anchor = 10_000n + BigInt(i) * 600n;
      const slot = Number(anchor) + 50;
      c.st.slot = slot;
      c.st.market = bandMarket({ epoch, anchorSlot: anchor, currentSlot: BigInt(slot) });
      c.st.lp = lpPortfolio(epoch);
      now.t += 20_000;
      await h.loop.tick();
    }
    assert.equal(h.alerts().length, 0);
    assert.equal(h.resolved().length, 0);
    // and the same chain with the LP left one epoch behind for the same span DOES alert (the control is not vacuous)
    const c2 = chain({ market: bandMarket({ epoch: 2n, anchorSlot: 10_000n, currentSlot: 15_000n }), lp: lpPortfolio(1n), slot: 15_000 });
    const h2 = loopOn(c2, now);
    await h2.loop.tick();
    assert.equal(h2.alerts().length, 2, "5,000 / 9,600 = 52%: warn record + critical");
  });

  it("not a band market, or a Resolved one: no LP read result is ever alerted", async () => {
    const now = { t: 1 };
    const plain = chain({ market: v22MarketBytes({ currentSlot: 50_000n }), lp: lpPortfolio(0n), slot: 50_000 });
    const h = loopOn(plain, now);
    await h.loop.tick();
    assert.equal(h.alerts().length, 0);
    const resolvedMkt = chain({ market: bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 30_000n, lifecycle: 4 }), lp: lpPortfolio(6n), slot: 30_000 });
    const h2 = loopOn(resolvedMkt, now);
    await h2.loop.tick();
    assert.equal(h2.alerts().length, 0);
  });

  it("the scope name is stable (dashboards / dedupe keys)", () => {
    assert.equal(LP_CERT_ALERT_SCOPE, "v22-vault-lp-cert");
  });

  it("de-escalation CRITICAL -> WARN resolves only the critical record; the WARN stays active", async () => {
    const now = { t: 5_000_000 };
    const c = chain({ market: bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 15_000n }), lp: lpPortfolio(6n), slot: 15_000 });
    const h = loopOn(c, now);
    await h.loop.tick();
    assert.equal(h.alerts().length, 2); // warn record + critical
    // the anchor advanced (another epoch) and the LP is again uncertified, now at 30%
    c.st.market = bandMarket({ epoch: 8n, anchorSlot: 12_120n, currentSlot: 15_000n });
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.resolved().length, 1);
    assert.match(h.resolved()[0], /"severity":"critical"/);
  });
});

// ── coverage: fallback, lifecycle, clamps, ordering, decode edges ─────────────

describe("lp-cert-liveness: engine-floor fallback (band_rent.rs:83 E >= 150, :86 Pmax >= 8 E)", () => {
  it("pins the fallback constants to the engine floors", () => {
    assert.equal(FALLBACK_BAND_MAX_EPOCH_SLOTS, 150n);
    assert.equal(FALLBACK_BAND_MIN_PIN_EPOCHS, 8n);
  });
  it("both words 0: E = 150, Pmax = 8 * 150 = 1,200, horizon 1,350, source fallback", () => {
    const s = lpCertStalenessOf(asset({ maxEpochSlots: 0n, maxPinSlots: 0n }), 10_100n);
    assert.ok(s);
    assert.equal(s.horizonSlots, 1_350n);
    assert.equal(s.deadlineSlot, 11_350n);
    assert.equal(s.horizonSource, "fallback-engine-floor");
  });
  it("only Pmax reads 0: keeps the on-chain E (600) and derives Pmax = 8 * 600; still flagged fallback", () => {
    const s = lpCertStalenessOf(asset({ maxPinSlots: 0n }), 10_100n);
    assert.ok(s);
    assert.equal(s.horizonSlots, 600n + 4_800n);
    assert.equal(s.horizonSource, "fallback-engine-floor");
  });
  it("only E reads 0: E falls back to 150 and the on-chain Pmax (9,000) is kept; flagged fallback", () => {
    const s = lpCertStalenessOf(asset({ maxEpochSlots: 0n }), 10_100n);
    assert.ok(s);
    assert.equal(s.horizonSlots, 150n + 9_000n);
    assert.equal(s.horizonSource, "fallback-engine-floor");
  });
  it("the fallback is called out in the alert message; on-chain is not", () => {
    const fb = lpCertStalenessOf(asset({ maxEpochSlots: 0n, maxPinSlots: 0n }), 10_700n);
    assert.ok(fb);
    const [a] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 10_700n, assets: [fb] }, T);
    assert.match(a.message, /engine-floor fallback/);
    assert.equal(a.data?.horizonSource, "fallback-engine-floor");
    const oc = lpCertStalenessOf(asset(), 20_000n);
    assert.ok(oc);
    const [b] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 20_000n, assets: [oc] }, T);
    assert.doesNotMatch(b.message, /fallback/);
  });
});

describe("lp-cert-liveness: lifecycle split", () => {
  it("Active (2) and DrainOnly (3) apply; every other lifecycle is null", () => {
    for (const lc of [0, 1, 4, 5, 255]) assert.equal(lpCertStalenessOf(asset({ lifecycle: lc }), 20_000n), null, `lifecycle ${lc}`);
    for (const lc of [2, 3]) assert.ok(lpCertStalenessOf(asset({ lifecycle: lc }), 20_000n), `lifecycle ${lc}`);
  });
  it("Active and DrainOnly produce identical staleness", () => {
    assert.deepEqual(lpCertStalenessOf(asset({ lifecycle: 2 }), 12_000n), lpCertStalenessOf(asset({ lifecycle: 3 }), 12_000n));
  });
});

describe("lp-cert-liveness: clamps and ordering", () => {
  it("now at or before the anchor: staleSlots 0 (level ok) and the deadline is clamped at 0 remaining after expiry", () => {
    const before = lpCertStalenessOf(asset(), 9_000n);
    assert.ok(before);
    assert.equal(before.staleSlots, 0n);
    assert.equal(lpCertLevelOf(before, T), "ok");
    const at = lpCertStalenessOf(asset(), 10_000n);
    assert.ok(at);
    assert.equal(at.staleSlots, 0n);
    const past = lpCertStalenessOf(asset(), 30_000n);
    assert.ok(past);
    assert.equal(past.remainingSlots, 0n);
  });
  it("degenerate deadline at or before the anchor: horizon clamps to 1 slot", () => {
    // pin stamped before the anchor with a tiny Pmax drives deadline <= anchor
    const s = lpCertStalenessOf(asset({ anchorSlot: 10_000n, pinSinceSlot: 5n, maxPinSlots: 1n }), 10_010n);
    assert.ok(s);
    assert.equal(s.horizonSlots, 1n);
    assert.equal(lpCertLevelOf(s, T), "critical");
    const [a] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 10_010n, assets: [s] }, T);
    assert.equal(a.severity, "critical");
  });
  it("custom thresholds are honoured", () => {
    const s = lpCertStalenessOf(asset(), 10_000n + 1_000n);
    assert.ok(s);
    assert.equal(lpCertLevelOf(s, { warnPct: 10, criticalPct: 90 }), "warn");
    assert.equal(lpCertLevelOf(s, { warnPct: 5, criticalPct: 10 }), "critical");
  });
  it("evaluate: all assets ok -> no alert; warn asset is not displaced by a later ok asset", () => {
    const ok = lpCertStalenessOf(asset({ assetIndex: 3, lpLegEpochSnap: 7n }), 12_500n);
    const warn = lpCertStalenessOf(asset({ assetIndex: 4 }), 12_500n);
    assert.ok(ok && warn);
    assert.deepEqual(evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 12_500n, assets: [ok] }, T), []);
    assert.deepEqual(evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 12_500n, assets: [] }, T), []);
    const [a] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 12_500n, assets: [warn, ok] }, T);
    assert.equal(a.data?.assetIndex, 4);
  });
  it("evaluate: a warn asset after a critical one never replaces it", () => {
    const crit = lpCertStalenessOf(asset({ assetIndex: 1, anchorSlot: 7_000n }), 12_500n);
    // short horizon (E 600 + Pmax 3,400 = 4,000): 37% used -> warn, yet only 2,500 slots left (< the critical asset's 4,100)
    const warn = lpCertStalenessOf(asset({ assetIndex: 2, anchorSlot: 11_000n, maxPinSlots: 3_400n }), 12_500n);
    assert.ok(crit && warn);
    assert.ok(warn.remainingSlots < crit.remainingSlots);
    const [a] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 12_500n, assets: [crit, warn] }, T);
    assert.equal(a.severity, "critical");
    assert.equal(a.data?.assetIndex, 1);
  });
  it("evaluate: among equal levels the fewest remaining slots wins, in either input order", () => {
    // both warn (2,900 stale of 9,600 / 9,100); asset 6 has an edge pin -> nearer deadline
    const late = lpCertStalenessOf(asset({ assetIndex: 5, anchorSlot: 10_000n }), 12_900n);
    const near = lpCertStalenessOf(asset({ assetIndex: 6, pinSinceSlot: 10_100n }), 12_900n);
    assert.ok(late && near);
    assert.ok(near.remainingSlots < late.remainingSlots);
    for (const assets of [[late, near], [near, late]]) {
      const [a] = evaluateVaultLpCrankStaleness({ label: "B", market: "M", terminal: false, nowSlot: 12_900n, assets }, T);
      assert.equal(a.data?.assetIndex, 6);
    }
  });
});

describe("lp-cert-liveness: env thresholds, extra edges", () => {
  it("whitespace-only and non-integer values; boundaries 1 and 99 accepted, 0 rejected", () => {
    const errs: string[] = [];
    const f = (e: Record<string, string>) => lpCertThresholdsFromEnv(e, (l) => errs.push(l));
    assert.deepEqual(f({ ALERT_VAULT_LP_CRANK_WARN_PCT: "   " }), { warnPct: 25, criticalPct: 50 });
    assert.equal(errs.length, 0);
    assert.deepEqual(f({ ALERT_VAULT_LP_CRANK_WARN_PCT: "1", ALERT_VAULT_LP_CRANK_CRITICAL_PCT: "99" }), { warnPct: 1, criticalPct: 99 });
    assert.deepEqual(f({ ALERT_VAULT_LP_CRANK_WARN_PCT: "0" }), { warnPct: 25, criticalPct: 50 });
    assert.deepEqual(f({ ALERT_VAULT_LP_CRANK_WARN_PCT: "12.5" }), { warnPct: 25, criticalPct: 50 });
    assert.equal(errs.length, 2);
    assert.deepEqual(f({ ALERT_VAULT_LP_CRANK_WARN_PCT: "30", ALERT_VAULT_LP_CRANK_CRITICAL_PCT: "30" }), { warnPct: 30, criticalPct: 30 });
  });
  it("default logger is console.error", (t) => {
    const calls: unknown[] = [];
    t.mock.method(console, "error", (m: unknown) => calls.push(m));
    assert.deepEqual(lpCertThresholdsFromEnv({ ALERT_VAULT_LP_CRANK_WARN_PCT: "zz" }), { warnPct: 25, criticalPct: 50 });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0]), /ALERT_VAULT_LP_CRANK_WARN_PCT="zz"/);
  });
});

describe("lp-cert-liveness: decode edges", () => {
  const mk = () => bandMarket({ epoch: 7n, anchorSlot: 10_000n, currentSlot: 11_000n });
  it("takes the smallest band_epoch_snap across the LP's active legs on the asset; other-asset and inactive legs are ignored", () => {
    const G = LAYOUT_V22.portfolio;
    const off = G.leg.bandEpochSnap;
    assert.ok(off !== null);
    const b = Buffer.from(
      portfolioBytes({
        owner: key(8),
        capital: 1_000n,
        legs: [
          { side: 0, basis: 5n },
          { side: 1, basis: 5n },
          { side: 0, basis: 5n, assetIndex: 3 },
          { side: 0, basis: 5n },
        ],
      }),
    );
    const snaps = [5n, 6n, 1n, 2n];
    snaps.forEach((s, i) => b.writeBigUInt64LE(s, G.legsOff + i * G.legStride + off));
    // leg 3 (snap 2, asset 0) made inactive: must be ignored
    b[G.legsOff + 3 * G.legStride + G.leg.active] = 0;
    const [a] = readLpCertAssets(mk(), L, [0], new Uint8Array(b));
    assert.equal(a.lpLegEpochSnap, 5n);
    // order independence: smaller snap first then larger
    snaps.splice(0, 2, 6n, 5n);
    snaps.forEach((s, i) => b.writeBigUInt64LE(s, G.legsOff + i * G.legStride + off));
    assert.equal(readLpCertAssets(mk(), L, [0], new Uint8Array(b))[0].lpLegEpochSnap, 5n);
  });
  it("an unparseable LP portfolio throws (caller keeps the last known state)", () => {
    assert.throws(() => readLpCertAssets(mk(), L, [0], new Uint8Array(8)));
  });
});
