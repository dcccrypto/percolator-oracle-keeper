/**
 * Hedged-lockout alert (p2b-hedged-lockout.ts): the truth table, the vault LP's effective
 * position, and the monitor over real v18 portfolio bytes. Reasoning: percolator-prog #524
 * `sec3_hedged_lockout_of_both_sides` (both users' crowds closed by capacity while the LP is flat).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import {
  ASSET_GROWTH_LEN,
  DEPTH_EVER,
  DEPTH_PREV_REAL,
  DEPTH_SOURCE,
  KAPPA_TABLE_BPS,
  LAMBDA_DEPTH_TABLE_BPS,
  conservativeEquity,
  curveLagU64,
  curveU64,
  decodeAssetBandStateV22,
  decodeAssetGrowthRecordV19,
  decodeAssetGrowthV19,
  decodeBandConfigV22,
  growthCeilingView,
  nCapG8Q,
  nCapQ,
  parsePortfolioV17,
} from "@percolatorct/sdk";
import type { AssetGrowthV19 } from "@percolatorct/sdk";
import {
  DEFAULT_HEDGED_LOCKOUT_THRESHOLDS,
  evaluateHedgedLockout,
  evaluateHedgedLockouts,
  g8NCapQ,
  hedgedLockoutPlacement,
  hedgedLockoutThresholdsFromEnv,
  vaultLpEffectivePositionQ,
} from "./p2b-hedged-lockout.ts";
import type { HedgedLockoutInput } from "./p2b-hedged-lockout.ts";
import { isV18MarketHeader } from "./adl-state.ts";
import { ADL_ONE, engineBase, fakeConn, fx, patchedMarket, registryBytes, snapshot, vaultLpStateBytes } from "./p2b-test-helpers.ts";
import { readU64 } from "./p2b-markets.ts";

const T = DEFAULT_HEDGED_LOCKOUT_THRESHOLDS;
const N = 1_000_000_000n; // N_cap with C_m = 1e9 atoms, lambda 1x, price 1.0
const growth = (lambdaBps = 10_000): AssetGrowthV19 => decodeAssetGrowthV19(patchedMarket({ growthLambdaBps: lambdaBps }), 0)!;

/** users long / short as fractions of N_cap in bps, LP net in bps of N_cap (positive = long). */
function input(o: { uLong: number; uShort: number; lp?: number; g?: AssetGrowthV19 | null; cM?: bigint; price?: bigint }): HedgedLockoutInput {
  const lpQ = (BigInt(o.lp ?? 0) * N) / 10_000n;
  const usersL = (BigInt(o.uLong) * N) / 10_000n;
  const usersS = (BigInt(o.uShort) * N) / 10_000n;
  // engine OI includes the vault LP's own leg on its side
  return {
    growth: o.g === undefined ? growth() : o.g,
    cM: o.cM ?? N,
    priceE6: o.price ?? 1_000_000n,
    oiEffLongQ: usersL + (lpQ > 0n ? lpQ : 0n),
    oiEffShortQ: usersS + (lpQ < 0n ? -lpQ : 0n),
    lpEffQ: lpQ,
  };
}

describe("hedged lockout: truth table", () => {
  it("N_cap sanity: C_m 1e9, lambda 1x, price 1.0 -> N_cap 1e9", () => {
    const v = evaluateHedgedLockout(input({ uLong: 9500, uShort: 9500 }), T);
    assert.equal(v.nCapQ, N);
  });

  const rows: Array<[string, Parameters<typeof input>[0], "alert" | "ok" | "no-growth" | "no-capacity" | "r3-unsupported"]> = [
    ["both sides 95%, LP flat -> ALERT", { uLong: 9500, uShort: 9500 }, "alert"],
    ["both sides exactly 90.00%, LP flat -> ALERT (inclusive)", { uLong: 9000, uShort: 9000 }, "alert"],
    ["both sides 89.99% -> no alert", { uLong: 8999, uShort: 8999 }, "ok"],
    ["only the long side full -> no alert (normal crowd-side-full)", { uLong: 9900, uShort: 5000 }, "ok"],
    ["only the short side full -> no alert", { uLong: 5000, uShort: 9900 }, "ok"],
    ["both full but the LP carries 10% net long -> no alert (the LP is absorbing the imbalance)", { uLong: 9500, uShort: 9500, lp: 1000 }, "ok"],
    ["both full but the LP carries 10% net short -> no alert", { uLong: 9500, uShort: 9500, lp: -1000 }, "ok"],
    ["LP exactly at the flat threshold (3.00%) -> ALERT (inclusive)", { uLong: 9500, uShort: 9500, lp: 300 }, "alert"],
    ["LP just over the flat threshold (3.01%) -> no alert", { uLong: 9500, uShort: 9500, lp: 301 }, "ok"],
    ["LP slightly short (-2%), both full -> ALERT", { uLong: 9500, uShort: 9500, lp: -200 }, "alert"],
    ["no growth block -> no-op, whatever the OI", { uLong: 9900, uShort: 9900, g: null }, "no-growth"],
    ["zero C_m -> no capacity, no alert", { uLong: 9900, uShort: 9900, cM: 0n }, "no-capacity"],
    ["zero price -> no capacity, no alert", { uLong: 9900, uShort: 9900, price: 0n }, "no-capacity"],
    ["empty market -> no alert", { uLong: 0, uShort: 0 }, "ok"],
  ];
  for (const [name, i, expected] of rows) {
    it(name, () => {
      assert.equal(evaluateHedgedLockout(input(i), T).status, expected);
    });
  }

  it("users OI excludes the LP's own leg: LP long 20% + engine OI long 115% => users long 95%", () => {
    const v = evaluateHedgedLockout({ ...input({ uLong: 9500, uShort: 9500 }), oiEffLongQ: (11500n * N) / 10_000n, lpEffQ: (2000n * N) / 10_000n }, { ...T, flatBps: 5000 });
    assert.equal(v.utilLongBps, 9500n);
    assert.equal(v.lpNetBps, 2000n);
  });

  it("thresholds are tunable", () => {
    const i = input({ uLong: 8200, uShort: 8200 });
    assert.equal(evaluateHedgedLockout(i, T).status, "ok");
    assert.equal(evaluateHedgedLockout(i, { utilBps: 8000, flatBps: 300 }).status, "alert");
  });

  it("env: defaults 9000 / 300, overrides, garbage rejected", () => {
    assert.deepEqual(hedgedLockoutThresholdsFromEnv({}), { utilBps: 9000, flatBps: 300 });
    assert.deepEqual(hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "8500", HEDGED_LOCKOUT_FLAT_BPS: "100" }), { utilBps: 8500, flatBps: 100 });
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "abc" }), /HEDGED_LOCKOUT_UTIL_BPS/);
  });
});

describe("vaultLpEffectivePositionQ (real v18 LP portfolios)", () => {
  it("CATE LP: long 6,400,773,782 at a_basis = ONE, A_long = ONE -> +6,400,773,782", () => {
    const p = parsePortfolioV17(new Uint8Array(fx("cate-lp-portfolio-v18")));
    assert.equal(vaultLpEffectivePositionQ(p, 0, { aLong: ADL_ONE, aShort: ADL_ONE }), 6_400_773_782n);
  });
  it("ANSEM LP: short -16,511,677,058 -> negative; ADL scales it by A_short / a_basis (floor)", () => {
    const p = parsePortfolioV17(new Uint8Array(fx("ansem-lp-portfolio-v18")));
    assert.equal(vaultLpEffectivePositionQ(p, 0, { aLong: ADL_ONE, aShort: ADL_ONE }), -16_511_677_058n);
    const a = 861_700_000_000_000n;
    assert.equal(vaultLpEffectivePositionQ(p, 0, { aLong: ADL_ONE, aShort: a }), -((16_511_677_058n * a) / ADL_ONE));
  });
  it("no leg on the asset -> 0", () => {
    const p = parsePortfolioV17(new Uint8Array(fx("cate-lp-portfolio-v18")));
    assert.equal(vaultLpEffectivePositionQ(p, 5, { aLong: ADL_ONE, aShort: ADL_ONE }), 0n);
  });
});

describe("R3 (controller) growth records: fail closed", () => {
  const r3 = (flags: number): AssetGrowthV19 => decodeAssetGrowthV19(patchedMarket({ growthLambdaBps: 10_000, growthFlags: flags }), 0)!;
  it("legacy fixture (flags 0) is r3Layout=false and keeps alerting", () => {
    const g = r3(0);
    assert.equal(g.r3Layout, false);
    assert.equal(evaluateHedgedLockout(input({ uLong: 9500, uShort: 9500, g }), T).status, "alert");
  });
  for (const flags of [1, 3]) {
    it(`flags ${flags}: r3Layout=true -> r3-unsupported, no capacity figure, no alert even with both crowds full and the LP flat`, () => {
      const g = r3(flags);
      assert.equal(g.r3Layout, true);
      const v = evaluateHedgedLockout(input({ uLong: 9900, uShort: 9900, g }), T);
      assert.equal(v.status, "r3-unsupported");
      assert.equal(v.nCapQ, null);
      assert.equal(v.utilLongBps, null);
    });
  }
  it("monitor: an R3 market yields a record, no alert, and one warn line per market", async () => {
    const lp = Keypair.generate().publicKey;
    const m = patchedMarket({ effectivePriceE6: 1_000n, growthLambdaBps: 10_000, growthFlags: 3, oiEffLong: 2_000_000_000_000n, oiEffShort: 2_000_000_000_000n });
    const s = snapshot({ label: "R3MKT", marketData: m, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    const c = fakeConn({ accounts: new Map([[lp.toBase58(), new Uint8Array(fx("cate-lp-portfolio-v18"))]]) });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    try {
      const r1 = await evaluateHedgedLockouts(c.conn as never, [s], T);
      await evaluateHedgedLockouts(c.conn as never, [s], T);
      assert.deepEqual(r1.alerts, []);
      assert.equal(r1.records[0].verdict.status, "r3-unsupported");
    } finally { console.warn = orig; }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /R3MKT.*controller \(R3\) growth record.*SKIPPED/);
  });
});

const live = JSON.parse(readFileSync(new URL("./__fixtures__/v22-live-accounts-2026-10-17.json", import.meta.url), "utf8")) as { accounts: { symbol: string; slab: string }[] };

describe("v2.2 slabs", () => {
  it("every live v2.2 market (2026-10-17 fixture) is placed through the detected layout: band_bps and effective price equal the SDK's v2.2 decoders", () => {
    assert.equal(live.accounts.length, 13);
    for (const a of live.accounts) {
      const d = new Uint8Array(Buffer.from(a.slab, "base64"));
      assert.equal(isV18MarketHeader(d), false, a.symbol);
      const p = hedgedLockoutPlacement(d, 0, 4242);
      assert.ok(p !== null && p.v22 !== undefined, a.symbol);
      assert.equal(p.v22.bandBps, decodeBandConfigV22(d).bandBps, `${a.symbol} band_bps`);
      assert.equal(p.v22.nowSlot, 4242n);
      assert.equal(readU64(d, p.assetStateOff + 25), decodeAssetBandStateV22(d, 0).effectivePrice, `${a.symbol} effective price`);
    }
  });
  it("a v2.1 market keeps the fixed v2.1 offset and no v22 state (growth-1 N_cap, R3 fails closed)", () => {
    const d = patchedMarket({});
    const p = hedgedLockoutPlacement(d, 0, 1);
    assert.ok(p !== null);
    assert.equal(p.v22, undefined);
    assert.equal(p.assetStateOff, engineBase(0));
  });
  it("not a market / too short: null (never evaluated, never thrown)", () => {
    assert.equal(hedgedLockoutPlacement(new Uint8Array(64), 0, 1), null);
  });
});

/** A controller-written (flags 0x03) growth record: DEX depth $venue fresh at slot 990, thresholds / leverage defaults, band clamp. */
function controllerRecord(o: { venueUsd: bigint; lambdaBps?: number; th?: [number, number, number] }): AssetGrowthV19 {
  const M = 1_000_000n;
  const b = new Uint8Array(ASSET_GROWTH_LEN);
  const v = new DataView(b.buffer);
  b[39] = 0x03; // R3 layout + volatility data
  v.setUint32(16, o.lambdaBps ?? 30_000, true);
  v.setUint16(20, 500, true); // launch 5x
  v.setUint16(22, 2_000, true); // L_tier 20x
  v.setUint16(24, 500, true); // stored ceiling
  v.setUint16(28, 3_445, true); // r_gap = G(band 1000): clamp enforced
  b[38] = 1;
  b[44] = DEPTH_SOURCE.OnChainPool | DEPTH_EVER | DEPTH_PREV_REAL;
  v.setBigUint64(56, o.venueUsd * M, true);
  v.setBigUint64(64, 990n, true);
  v.setBigUint64(72, o.venueUsd * M, true);
  v.setBigUint64(80, o.venueUsd * M, true);
  v.setBigUint64(88, 990n, true);
  b[46] = 7; // 6 decimals
  (o.th ?? [0, 0, 0]).forEach((x, i) => v.setUint32(96 + 4 * i, x, true));
  return decodeAssetGrowthRecordV19(b)!;
}

describe("G8 N_cap on the contlev3 curve (v2.2 controller markets, wrapper 21b8ccfd: κ / λ_depth LAG, review M-1)", () => {
  const M = 1_000_000n;
  const BAND = 1_000;
  const NOW = 1_000n;
  // venue $40k (on-chain pool), LP C_m $100k at stored lambda 3x: book depth $100k, tier = min(venue 1, book 2) = 1.
  // Dials = min over (venue, book) of the LAGGING curve: kappa = lag(40k) = 0.6695 (from 0.5 at T1 toward 1.0 at T2),
  // lambda_depth = 1x (the lag curve holds 1x until T2). N_cap = min(C_m * min(3x, 1x), kappa * $40k) = $26.78k at price 1.0.
  const g = controllerRecord({ venueUsd: 40_000n });
  const cM = 100_000n * M;
  it("g8NCapQ = the program's n_cap_g8_q_dials at the lagging dials (kappa 0.6695, lambda_depth 1x at $40k)", () => {
    const n = g8NCapQ(g, BAND, NOW, cM, 1_000_000n);
    assert.equal(n, 26_780_000_000n);
    const view = growthCeilingView(g, BAND, NOW, cM, 0, undefined, { rc23Caps: false });
    assert.equal(view.tier, 1);
    assert.deepEqual(view.dials, { lSignalX100: 669, kappaBps: 6_695, lambdaDepthBps: 10_000 });
    assert.equal(curveLagU64(40_000n * M, view.thresholdsE6, KAPPA_TABLE_BPS), 6_695n);
    assert.equal(curveLagU64(40_000n * M, view.thresholdsE6, LAMBDA_DEPTH_TABLE_BPS), 10_000n);
  });
  it("NEGATIVE CONTROLS: growth-1 nCapQ(lambda) overstates it 11.2x; the round-2 step and 3198539a's leading-curve dials overstate it 1.49x", () => {
    assert.equal(nCapQ(cM, 30_000, 1_000_000n), 300_000_000_000n);
    const view = growthCeilingView(g, BAND, NOW, cM, 0, undefined, { rc23Caps: false });
    const step = nCapG8Q({ clamp: true, cM, lambdaBps: 30_000, tier: view.tier, capDepth: view.capDepthE6, priceE6: 1_000_000n });
    assert.equal(step, 40_000_000_000n);
    // 3198539a: κ / λ_depth on the LEADING curve (kappa 1.0, lambda_depth 1.339x at $40k)
    const th = view.thresholdsE6;
    const lead = (t: readonly [bigint, bigint, bigint, bigint]): number => {
      const a = curveU64(40_000n * M, th, t);
      const b = curveU64(100_000n * M, th, t);
      return Number(a < b ? a : b);
    };
    const old = nCapG8Q({ clamp: true, cM, lambdaBps: 30_000, tier: view.tier, capDepth: view.capDepthE6, priceE6: 1_000_000n, dials: { kappaBps: lead(KAPPA_TABLE_BPS), lambdaDepthBps: lead(LAMBDA_DEPTH_TABLE_BPS) } });
    assert.deepEqual([lead(KAPPA_TABLE_BPS), lead(LAMBDA_DEPTH_TABLE_BPS)], [10_000, 13_390]);
    assert.equal(old, 40_000_000_000n);
    const n = g8NCapQ(g, BAND, NOW, cM, 1_000_000n)!;
    assert.ok(n < step && n < old, "the lagging N_cap is never looser than the step (M-1)");
  });
  it("with v22 state a controller record is evaluated (never r3-unsupported): users at 25k each side = 93.35% of the lagging N_cap, LP flat -> ALERT", () => {
    const users = 25_000_000_000n;
    const v = evaluateHedgedLockout({ growth: g, cM, priceE6: 1_000_000n, oiEffLongQ: users, oiEffShortQ: users, lpEffQ: 0n, v22: { bandBps: BAND, nowSlot: NOW } }, T);
    assert.equal(v.status, "alert");
    assert.equal(v.nCapQ, 26_780_000_000n);
    assert.equal(v.utilLongBps, 9_335n);
    // the same OI under growth-1 lambda N_cap would read 8.33%: no alert (the blind spot this closes)
    const blind = evaluateHedgedLockout({ growth: { ...g, r3Layout: false }, cM, priceE6: 1_000_000n, oiEffLongQ: users, oiEffShortQ: users, lpEffQ: 0n }, T);
    assert.equal(blind.status, "ok");
    assert.equal(blind.utilLongBps, 833n);
    // and without v22 state the controller record still fails closed
    assert.equal(evaluateHedgedLockout({ growth: g, cM, priceE6: 1_000_000n, oiEffLongQ: users, oiEffShortQ: users, lpEffQ: 0n }, T).status, "r3-unsupported");
  });
  it("off the clamp (band 0) the G8 N_cap is exactly growth-1 nCapQ(lambda)", () => {
    assert.equal(g8NCapQ(g, 0, NOW, cM, 1_000_000n), nCapQ(cM, 30_000, 1_000_000n));
  });
  it("monitor over a REAL v2.2 band market (CHILLHOUSE-T bytes) + a real v2.2 LP portfolio: reached, N_cap = g8NCapQ, not the lambda one", async () => {
    const a = live.accounts.find((x) => x.symbol === "CHILLHOUSE-T")!;
    const m = new Uint8Array(Buffer.from(a.slab, "base64"));
    const rec = decodeAssetGrowthV19(m, 0)!;
    const slot = Number(rec.depthSlot) + 1;
    const lp = Keypair.generate().publicKey;
    const lpBytes = new Uint8Array(fx("k6-2xhs-lp-6w14eZR3-v22"));
    const s = snapshot({ label: "CHILLHOUSE-T", marketData: m, slot, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    const c = fakeConn({ accounts: new Map([[lp.toBase58(), lpBytes]]) });
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.equal(r.records.length, 1);
    const pf = parsePortfolioV17(lpBytes);
    const cMReal = conservativeEquity(pf.capital, pf.pnl, pf.feeCredits);
    const price = decodeAssetBandStateV22(m, 0).effectivePrice;
    const want = g8NCapQ(rec, decodeBandConfigV22(m).bandBps, BigInt(slot), cMReal, price);
    assert.equal(r.records[0].verdict.nCapQ, want);
    assert.notEqual(want, nCapQ(cMReal, rec.lambdaBps, price));
  });
});

describe("monitor over snapshots", () => {
  const PRICE = 1_000n; // e6: 0.001 -> N_cap = 1e12 for the CATE LP's C_m (1e9)
  const NCAP = 1_000_000_000_000n;
  const lpBytes = new Uint8Array(fx("cate-lp-portfolio-v18")); // long 6,400,773,782 (0.64% of N_cap: flat)

  function world(o: { growth?: boolean; bound?: boolean; uLong?: bigint; uShort?: bigint }) {
    const lp = Keypair.generate().publicKey;
    const lpQ = 6_400_773_782n;
    const m = patchedMarket({
      effectivePriceE6: PRICE,
      growthLambdaBps: o.growth === false ? undefined : 10_000,
      oiEffLong: (o.uLong ?? (NCAP * 95n) / 100n) + lpQ,
      oiEffShort: o.uShort ?? (NCAP * 95n) / 100n,
    });
    const s = snapshot({ label: "CATE", marketData: m, registryData: registryBytes({ bound: o.bound !== false }), vaultLpData: vaultLpStateBytes({ lp }) });
    const c = fakeConn({ accounts: new Map([[lp.toBase58(), lpBytes]]) });
    return { s, c };
  }

  it("both crowds at 95% of N_cap with the LP at 0.64%: ALERT with the numbers", async () => {
    const { s, c } = world({});
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.equal(r.alerts.length, 1);
    const a = r.alerts[0];
    assert.equal(a.kind, "hedged-lockout");
    assert.equal(a.subject, "CATE");
    assert.equal(a.severity, "warn");
    assert.deepEqual([a.data?.utilLongBps, a.data?.utilShortBps, a.data?.lpNetBps], [9500, 9500, 64]);
    assert.equal(a.data?.nCapQ, NCAP.toString());
    assert.equal(r.records[0].verdict.status, "alert");
  });

  it("one side at 50%: no alert (record still says ok)", async () => {
    const { s, c } = world({ uShort: NCAP / 2n });
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.equal(r.alerts.length, 0);
    assert.equal(r.records[0].verdict.status, "ok");
  });

  it("no growth block: NO-OP, and not even an LP read (today's programs)", async () => {
    const { s, c } = world({ growth: false });
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.deepEqual(r, { alerts: [], records: [] });
    assert.equal(c.calls.length, 0);
    assert.equal(c.calls.length, 0);
  });

  it("an unbound market is skipped", async () => {
    const { s, c } = world({ bound: false });
    assert.deepEqual((await evaluateHedgedLockouts(c.conn as never, [s], T)).alerts, []);
    assert.equal(c.calls.length, 0);
  });

  it("an unreadable LP portfolio is skipped, never thrown", async () => {
    const { s } = world({});
    const c = fakeConn({ accounts: new Map() });
    assert.deepEqual((await evaluateHedgedLockouts(c.conn as never, [s], T)).alerts, []);
  });

  it("a market account that is not a market at all does not throw", async () => {
    const lp = Keypair.generate().publicKey;
    const s = snapshot({ marketData: new Uint8Array(50), registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    assert.deepEqual(await evaluateHedgedLockouts(fakeConn().conn as never, [s], T), { alerts: [], records: [] });
  });

  it("decodeAssetGrowthV19 is null on today's real v18 market bytes (the no-op precondition)", () => {
    for (const f of ["sol-market-v18", "ansem-market-v18", "jup-market-v18", "cate-market-v18"]) {
      assert.equal(decodeAssetGrowthV19(new Uint8Array(fx(f)), 0), null, f);
    }
  });
});

describe("coverage of remaining branches (decision + reason asserted)", () => {
  it("env: blank / whitespace falls back to the default; out-of-range, fractional and flat-bound errors are rejected with the variable name", () => {
    assert.deepEqual(hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "  ", HEDGED_LOCKOUT_FLAT_BPS: "" }), { utilBps: 9000, flatBps: 300 });
    assert.deepEqual(hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_FLAT_BPS: "0" }), { utilBps: 9000, flatBps: 0 });
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "0" }), /HEDGED_LOCKOUT_UTIL_BPS="0" must be an integer in \[1, 20000\]/);
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "20001" }), /UTIL_BPS/);
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_FLAT_BPS: "10001" }), /HEDGED_LOCKOUT_FLAT_BPS/);
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_FLAT_BPS: "1.5" }), /FLAT_BPS/);
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_FLAT_BPS: "-1" }), /FLAT_BPS/);
  });

  it("verdict: no-capacity carries a null N_cap figure and no per-side numbers", () => {
    const v = evaluateHedgedLockout(input({ uLong: 9900, uShort: 9900, cM: 0n }), T);
    assert.equal(v.status, "no-capacity");
    assert.equal(v.utilLongBps, null);
    assert.equal(v.lpNetBps, null);
  });

  it("v22 path with zero capacity (C_m 0): no-capacity, not alert", () => {
    const g = decodeAssetGrowthV19(patchedMarket({ growthLambdaBps: 10_000 }), 0)!;
    const v = evaluateHedgedLockout({ growth: g, cM: 0n, priceE6: 1_000_000n, oiEffLongQ: N, oiEffShortQ: N, lpEffQ: 0n, v22: { bandBps: 0, nowSlot: 1n } }, T);
    assert.equal(v.status, "no-capacity");
  });

  it("vaultLpEffectivePositionQ: inactive legs and other assets ignored; aBasis 0 uses |basis|; short leg is negative", () => {
    const legs = [
      { active: false, assetIndex: 0, basisPosQ: 5n, side: 0, aBasis: 1n },
      { active: true, assetIndex: 1, basisPosQ: 7n, side: 0, aBasis: 1n },
      { active: true, assetIndex: 0, basisPosQ: -40n, side: 1, aBasis: 0n },
      { active: true, assetIndex: 0, basisPosQ: 10n, side: 0, aBasis: 4n },
    ] as never;
    // short: eff = 40 (aBasis 0 -> abs), net -40; long: 10 * 8 / 4 = 20
    assert.equal(vaultLpEffectivePositionQ({ legs }, 0, { aLong: 8n, aShort: 3n }), -20n);
  });

  it("placement: a v2.2 layout with data truncated before the band field is null; a huge band_bps saturates", () => {
    const d = new Uint8Array(Buffer.from(live.accounts[0].slab, "base64"));
    assert.equal(hedgedLockoutPlacement(d.slice(0, 200), 0, 1), null);
    const full = hedgedLockoutPlacement(d, 0, 1);
    assert.ok(full !== null && full.v22 !== undefined);
    const big = d.slice();
    // locate band_bps via the decoder: write u64 max at the same offset by diffing placements
    const bandOff = (() => {
      for (let o = 0; o + 8 <= big.length; o++) {
        let m = true;
        const want = BigInt(full.v22!.bandBps);
        let x = 0n;
        for (let k = 7; k >= 0; k--) x = (x << 8n) | BigInt(big[o + k]);
        if (x !== want) m = false;
        if (m && decodeBandConfigV22(Object.assign(big.slice(), {})).bandBps === full.v22!.bandBps) {
          const t = big.slice();
          new DataView(t.buffer).setBigUint64(o, 1n << 40n, true);
          const p = hedgedLockoutPlacement(t, 0, 1);
          if (p?.v22?.bandBps === Number.MAX_SAFE_INTEGER) return o;
        }
      }
      return -1;
    })();
    assert.ok(bandOff >= 0, "found the band_bps field and saturated it");
  });

  it("placement: a known v2.1 layout whose header kind is not a market (so not the v18 fast path) is refused, version < 19", () => {
    const d = patchedMarket({}).slice();
    d[10] = 0; // header kind byte
    assert.equal(isV18MarketHeader(d), false);
    assert.equal(hedgedLockoutPlacement(d, 0, 1), null);
  });

  it("placement: a known v2.2 layout but an asset index past the slot table (engine slot beyond the account) is null", () => {
    const d = new Uint8Array(Buffer.from(live.accounts[0].slab, "base64"));
    assert.ok(hedgedLockoutPlacement(d, 0, 1) !== null);
    assert.equal(hedgedLockoutPlacement(d, 1_000, 1), null);
  });

  it("monitor: an asset index past the slot table makes the growth decode throw; swallowed, no record", async () => {
    const lp = Keypair.generate().publicKey;
    const d = new Uint8Array(Buffer.from(live.accounts[0].slab, "base64"));
    const s = snapshot({ marketData: d, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    s.ref.assetIndex = 1_000;
    assert.deepEqual(await evaluateHedgedLockouts(fakeConn().conn as never, [s], T), { alerts: [], records: [] });
  });

  it("monitor: growth decodes but placement is refused (known v2.1 layout, non-market kind byte) -> no record, no RPC, no alert", async () => {
    const lp = Keypair.generate().publicKey;
    const m = patchedMarket({ effectivePriceE6: 1_000n, growthLambdaBps: 10_000 }).slice();
    m[10] = 0;
    const s = snapshot({ marketData: m, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    const c = fakeConn({ accounts: new Map([[lp.toBase58(), new Uint8Array(fx("cate-lp-portfolio-v18"))]]) });
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.deepEqual(r, { alerts: [], records: [] });
    assert.equal(c.calls.length, 0);
  });

  it("monitor: vault LP missing -> skipped; market data missing -> skipped; throwing RPC -> skipped without throwing", async () => {
    const lp = Keypair.generate().publicKey;
    const m = patchedMarket({ effectivePriceE6: 1_000n, growthLambdaBps: 10_000 });
    const noLp = snapshot({ marketData: m, registryData: registryBytes({ bound: true }), vaultLpData: null });
    assert.deepEqual(await evaluateHedgedLockouts(fakeConn().conn as never, [noLp], T), { alerts: [], records: [] });
    const noData = snapshot({ marketData: null, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    assert.deepEqual(await evaluateHedgedLockouts(fakeConn().conn as never, [noData], T), { alerts: [], records: [] });
    const s = snapshot({ marketData: m, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    const boom = { getAccountInfo: async () => { throw new Error("rpc down"); } };
    assert.deepEqual(await evaluateHedgedLockouts(boom as never, [s], T), { alerts: [], records: [] });
  });

  it("monitor: v2.2 market whose layout is unknown after growth decodes -> skipped", async () => {
    const lp = Keypair.generate().publicKey;
    const d = new Uint8Array(Buffer.from(live.accounts[0].slab, "base64")).slice(0, 300);
    const s = snapshot({ marketData: d, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    assert.deepEqual(await evaluateHedgedLockouts(fakeConn().conn as never, [s], T), { alerts: [], records: [] });
  });

  it("alert builder: null verdict numbers render '?' / null in the message and data; thresholds are echoed", async () => {
    const { hedgedLockoutAlert } = await import("./p2b-hedged-lockout.ts");
    const a = hedgedLockoutAlert("MKT", "LBL", { status: "alert", nCapQ: null, usersLongQ: null, usersShortQ: null, utilLongBps: null, utilShortBps: null, lpNetBps: null }, { utilBps: 8500, flatBps: 150 });
    assert.equal(a.kind, "hedged-lockout");
    assert.equal(a.subject, "LBL");
    assert.match(a.message, /users long \?, users short \?/);
    assert.match(a.message, /threshold 85%/);
    assert.match(a.message, /\|net\| \? of N_cap, flat <= 1.5%/);
    assert.deepEqual(a.data, { market: "MKT", utilLongBps: null, utilShortBps: null, lpNetBps: null, nCapQ: null });
    const b = hedgedLockoutAlert("M", "L", { status: "alert", nCapQ: 100n, usersLongQ: 1n, usersShortQ: 1n, utilLongBps: 9550n, utilShortBps: 9000n, lpNetBps: 25n }, T);
    assert.match(b.message, /users long 95.5%, users short 90%/);
    assert.deepEqual(b.data, { market: "M", utilLongBps: 9550, utilShortBps: 9000, lpNetBps: 25, nCapQ: "100" });
  });
});
