/**
 * V22Loop error / skip paths (coverage). The happy paths live in the sibling suites (lone-lp-fallback, d1-watch, depth-capacity, ...);
 * this file pins what each read-only check, reconcile, job and helper does when an RPC read throws, an account is missing or a
 * precondition is not met: state is kept (never cleared or raised by a bad read), the failure is logged redacted, nothing throws out.
 * Private methods are reached through bracket access (the same way lifecycle.test.ts reaches forceFeesFor).
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { Alert } from "../alerting.ts";
import { V22Loop, livenessRepairsFor, startV22Loop, vaultLpCounterpartyFor } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { setLoneLpCrankSuppressor, setProtectiveTrigger, setSweepDelegate, setBondFeeDelegated } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { markV22Market, resetKnownV22Markets } from "./settle-pairing.ts";
import { resetPairingStats } from "./sweep.ts";
import { resetJobCounters } from "./exec.ts";
import { resetRefreshCoordination } from "../refresh-coordination.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { fakeLoopConn, key, registryBytes, v22Ctx, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const MARKET = key(900);
const LP = key(901);
const ENTRY = { marketAddress: MARKET.toBase58(), label: "T/V22" };

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
  resetRefreshCoordination();
});
afterEach(() => {
  setSweepDelegate(null);
  setLoneLpCrankSuppressor(null);
  setBondFeeDelegated(false);
  setProtectiveTrigger(null);
  setV22HealthProvider(null);
  resetKnownV22Markets();
  mock.timers.reset();
});

function mkLoop(env: Record<string, string>, conn: unknown, o: { lines?: string[]; sink?: { reconcile: (scope: string, a: Alert[]) => Promise<unknown> }; dryRun?: boolean; now?: () => number; markets?: unknown[] } = {}) {
  return new V22Loop({
    conn: conn as never,
    keeper: Keypair.generate(),
    programId: WRAPPER_PROGRAM_ID,
    markets: () => (o.markets ?? [ENTRY]) as never,
    flags: v22FlagsFromEnv({ KEEPER_V22: "on", ...env }),
    dryRun: o.dryRun ?? false,
    alertSink: o.sink as never,
    now: o.now,
    log: (l) => o.lines?.push(l),
  });
}

const alert = (severity: "warn" | "critical"): Alert => ({ kind: "x", severity, subject: "s", message: "m" }) as unknown as Alert;
const rtOf = (loop: V22Loop, addr = MARKET.toBase58()) => loop["rtFor"](addr);

describe("pure helpers", () => {
  it("vaultLpCounterpartyFor: null unless flag, bound, a state LP, and the state LP is the round's LP", () => {
    assert.equal(vaultLpCounterpartyFor(false, true, LP, LP), null);
    assert.equal(vaultLpCounterpartyFor(true, false, LP, LP), null);
    assert.equal(vaultLpCounterpartyFor(true, true, null, LP), null);
    assert.equal(vaultLpCounterpartyFor(true, true, key(5), LP), null);
    assert.equal(vaultLpCounterpartyFor(true, true, LP, LP)?.toBase58(), LP.toBase58());
  });

  it("livenessRepairsFor: a slot that does not decode plans nothing and does not throw", () => {
    assert.deepEqual(livenessRepairsFor({ data: new Uint8Array(8), readSlot: 10, slots: 2 }), []);
  });
});

describe("checkLpCert", () => {
  it("non-band market clears its alerts and view", async () => {
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn);
    const r = rtOf(loop);
    r.lpCertAlerts = [alert("warn")];
    await loop["checkLpCert"](v22Ctx({ band: false }), r);
    assert.deepEqual(r.lpCertAlerts, []);
    assert.equal(r.lastLpCert, null);
  });

  it("a missing LP account keeps the previous state (no raise, no resolve)", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), lpAccount: null });
    const loop = mkLoop({}, f.conn);
    const r = rtOf(loop);
    r.lpCertAlerts = [alert("critical")];
    await loop["checkLpCert"](v22Ctx({ band: true }), r);
    assert.equal(r.lpCertAlerts.length, 1);
  });

  it("an RPC error keeps the previous state and logs a redacted line", async () => {
    const lines: string[] = [];
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }) });
    Object.assign(f.conn, {
      async getAccountInfo() {
        throw new Error("fetch failed https://x.helius-rpc.com/?api-key=SECRET123");
      },
    });
    const loop = mkLoop({}, f.conn, { lines });
    const r = rtOf(loop);
    r.lpCertAlerts = [alert("warn")];
    await loop["checkLpCert"](v22Ctx({ band: true }), r);
    assert.equal(r.lpCertAlerts.length, 1);
    assert.ok(lines.some((l) => l.includes("LP certification read failed (alert state kept)")));
    assert.ok(!lines.join("\n").includes("SECRET123"));
  });

  it("a readable but non-portfolio LP account is evaluated without throwing", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), lpAccount: new Uint8Array(64) });
    const lines: string[] = [];
    const loop = mkLoop({}, f.conn, { lines });
    const r = rtOf(loop);
    await loop["checkLpCert"](v22Ctx({ band: true }), r);
    assert.deepEqual(r.lpCertAlerts, []);
  });
});

describe("checkAdlCloseOnly", () => {
  it("non-band market resets the tracker and clears alerts / view", () => {
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn);
    const r = rtOf(loop);
    r.adlAlerts = [alert("warn")];
    loop["checkAdlCloseOnly"](v22Ctx({ band: false }), r);
    assert.deepEqual(r.adlAlerts, []);
    assert.equal(r.lastAdl, null);
  });

  it("an undecodable market keeps the previous state", () => {
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn);
    const r = rtOf(loop);
    const good = v22Ctx({ band: true });
    r.adlAlerts = [alert("warn")];
    loop["checkAdlCloseOnly"]({ ...good, data: new Uint8Array(4) } as never, r);
    assert.equal(r.adlAlerts.length, 1);
  });

  it("a read that throws keeps the previous state and logs", () => {
    const lines: string[] = [];
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn, { lines });
    const r = rtOf(loop);
    const good = v22Ctx({ band: true });
    let reads = 0;
    const ctx = Object.create(good, {
      data: {
        get() {
          // the terminal check reads once; the decode inside the try reads again
          if (++reads > 1) throw new Error("boom https://x.helius-rpc.com/?api-key=SECRET123");
          return good.data;
        },
      },
    });
    r.adlAlerts = [alert("warn")];
    loop["checkAdlCloseOnly"](ctx, r);
    assert.equal(r.adlAlerts.length, 1);
    assert.ok(lines.some((l) => l.includes("close-only read failed (alert state kept)")));
    assert.ok(!lines.join("\n").includes("SECRET123"));
  });
});

describe("checkDepthCapacity", () => {
  it("non-band market clears alerts and the view", () => {
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn);
    const r = rtOf(loop);
    r.depthAlerts = [alert("warn")];
    r.lastDepth = [];
    loop["checkDepthCapacity"](v22Ctx({ band: false }), r, null);
    assert.deepEqual(r.depthAlerts, []);
    assert.equal(r.lastDepth, null);
  });

  it("an oversized band (> u32) is clamped, assets the account does not carry are skipped", () => {
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn);
    const r = rtOf(loop);
    const good = v22Ctx({ band: true });
    const ctx = Object.create(good, { band: { value: { ...good.band, bandBps: 0x1_0000_0000n } } });
    loop["checkDepthCapacity"](ctx, r, "pumpswap");
    assert.ok(Array.isArray(r.lastDepth), "depth reading recorded (was null before)");
  });

  it("a read that throws keeps the previous state and logs", () => {
    const lines: string[] = [];
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn, { lines });
    const r = rtOf(loop);
    const good = v22Ctx({ band: true });
    const ctx = Object.create(good, {
      band: {
        get() {
          throw new Error("band read failed");
        },
      },
    });
    r.depthAlerts = [alert("critical")];
    loop["checkDepthCapacity"](ctx, r, null);
    assert.equal(r.depthAlerts.length, 1);
    assert.ok(lines.some((l) => l.includes("depth-capacity read failed (alert state kept)")));
  });
});

describe("reconcile*: warn / critical split and delivery failure", () => {
  it("each reconcile logs a redacted line when the sink throws, and never throws out", async () => {
    const lines: string[] = [];
    const sink = {
      async reconcile() {
        throw new Error("sink down https://x.helius-rpc.com/?api-key=SECRET123");
      },
    };
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn, { lines, sink });
    await loop["reconcileDepthCapacity"]();
    await loop["reconcileAdlD1"]();
    await loop["reconcileLpCert"]();
    assert.ok(lines.some((l) => l.includes("[v22][depth] alert delivery failed")));
    assert.ok(lines.some((l) => l.includes("[v22][d1] alert delivery failed")));
    assert.ok(lines.some((l) => l.includes("[v22][lp-cert] alert delivery failed")));
    assert.ok(!lines.join("\n").includes("SECRET123"));
  });

  it("warn-scope carries every alert as warn; critical-scope only the critical ones", async () => {
    const calls: Array<{ scope: string; sev: string[] }> = [];
    const sink = {
      async reconcile(scope: string, a: Alert[]) {
        calls.push({ scope, sev: a.map((x) => x.severity) });
        return [];
      },
    };
    const loop = mkLoop({}, fakeLoopConn({ market: v22MarketBytes() }).conn, { sink });
    const r = rtOf(loop);
    r.depthAlerts = [alert("warn"), alert("critical")];
    r.lpCertAlerts = [alert("critical")];
    await loop["reconcileDepthCapacity"]();
    await loop["reconcileLpCert"]();
    const byScope = (s: string) => calls.find((c) => c.scope.endsWith(s) && c.scope.includes("depth"))?.sev;
    assert.deepEqual(byScope(":warn"), ["warn", "warn"]);
    assert.deepEqual(byScope(":critical"), ["critical"]);
    const lp = calls.filter((c) => !c.scope.includes("depth"));
    assert.deepEqual(lp.find((c) => c.scope.endsWith(":warn"))?.sev, ["warn"]);
    assert.deepEqual(lp.find((c) => c.scope.endsWith(":critical"))?.sev, ["critical"]);
  });
});

describe("forceFeesFor", () => {
  it("not in flight, no bond: runs the legacy 78 and the stake-fee pusher and reports both (dry-run, nothing sent)", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }) });
    const loop = mkLoop({ KEEPER_V22_WARN_BAND_FEES: "on" }, f.conn, { dryRun: true });
    const out = await loop["forceFeesFor"](v22Ctx({ band: true, bond: false }));
    assert.match(out, /78 /);
    assert.match(out, /87\+12 /);
    assert.equal(f.sent.length, 0);
  });

  it("bond market with the bond fee flag: goes through the v2.2 bond path (78(bond))", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), registry: registryBytes({ bound: true, ext: true, bond: true }), vaultLpState: vaultLpStateBytes(LP), lpAccount: null });
    const loop = mkLoop({ KEEPER_V22_WARN_BAND_FEES: "on", KEEPER_V22_FEE_CRANK_BOND: "on" }, f.conn, { dryRun: true });
    const out = await loop["forceFeesFor"](v22Ctx({ band: true, bond: true }));
    assert.match(out, /78\(bond\) /);
  });
});

describe("tick: job branches and the per-market error guard", () => {
  const ALL = { KEEPER_V22_G9: "on", KEEPER_V22_STAKE_SYNC: "on", KEEPER_V22_STAKE_COMMIT_TARGET: "on", KEEPER_V22_EARN_EXIT: "on", KEEPER_V22_ADL_WIND_DOWN: "on", KEEPER_V22_DUST_SWEEP: "on", KEEPER_V22_HOLDING_RENT: "on", KEEPER_V22_FEE_CRANK_BOND: "on" };

  it("a failing job read is caught per market, logged redacted, and the tick still completes", async () => {
    const lines: string[] = [];
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true, rent: true }), registry: registryBytes({ bound: true, ext: true, bond: true }), vaultLpState: vaultLpStateBytes(LP), lpAccount: null });
    let reads = 0;
    Object.assign(f.conn, {
      async getAccountInfo() {
        reads++;
        throw new Error("rpc 500 https://x.helius-rpc.com/?api-key=SECRET123");
        return null;
      },
    });
    const loop = mkLoop(ALL, f.conn, { lines, dryRun: true, sink: { reconcile: async () => [] } });
    await loop.tick();
    assert.ok(lines.some((l) => l.includes("T/V22: tick error:")));
    assert.ok(!lines.join("\n").includes("SECRET123"));
    assert.equal((loop.healthFields() as { ticks: number }).ticks, 1);
  });

  it("every job flag on with empty chain accounts: each job reports its state on /health, nothing throws", async () => {
    const lines: string[] = [];
    let t = 1_000_000;
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true, rent: true }), registry: registryBytes({ bound: true, ext: true, bond: true }), vaultLpState: vaultLpStateBytes(LP), lpAccount: null });
    const loop = mkLoop(ALL, f.conn, { lines, dryRun: true, now: () => t, sink: { reconcile: async () => [] } });
    await loop.tick();
    t += 60_000;
    await loop.tick();
    const h = loop.healthFields() as { ticks: number; markets: Record<string, Record<string, unknown>> };
    assert.equal(h.ticks, 2);
    const m = h.markets[MARKET.toBase58()];
    assert.equal(m.layout, "v2.2-b");
    assert.ok("g9" in m, `expected g9 on /health, got ${Object.keys(m).join(",")}`);
  });

  it("an unreadable (RPC) market read does not stop the other markets and is not v2.2-noted", async () => {
    const lines: string[] = [];
    const f = fakeLoopConn({ market: v22MarketBytes(), throwOnRead: true });
    const loop = mkLoop({}, f.conn, { lines, sink: { reconcile: async () => [] } });
    await loop.tick();
    const h = loop.healthFields() as { ticks: number };
    assert.equal(h.ticks, 1);
    assert.ok(!lines.join("\n").includes("SECRET123"));
  });

  it("a market in flight skips the jobs (read-only checks still ran)", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), registry: registryBytes({ bound: true, ext: true, bond: true }), vaultLpState: vaultLpStateBytes(LP) });
    const loop = mkLoop(ALL, f.conn, { dryRun: true, sink: { reconcile: async () => [] } });
    rtOf(loop).sweepInflight = true;
    await loop.tick();
    assert.equal(f.sent.length + f.sims.length, 0);
    assert.equal(rtOf(loop).lastG9, null);
  });
});

describe("protectiveRound guards", () => {
  it("unknown market, or a market never seen as v2.2, does nothing", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes() });
    const loop = mkLoop({}, f.conn);
    await loop["protectiveRound"]("nope");
    await loop["protectiveRound"](MARKET.toBase58()); // not marked v2.2
    assert.equal(f.sims.length + f.sent.length, 0);
    assert.equal(rtOf(loop).lastProtectiveAtMs, 0);
  });

  it("an unreadable market load returns after stamping the 5 s guard; a call inside 5 s returns early", async () => {
    markV22Market(MARKET.toBase58());
    const f = fakeLoopConn({ market: v22MarketBytes(), throwOnRead: true });
    let t = 100_000;
    const loop = mkLoop({}, f.conn, { now: () => t });
    await loop["protectiveRound"](MARKET.toBase58());
    assert.equal(rtOf(loop).lastProtectiveAtMs, 100_000);
    t += 1_000;
    await loop["protectiveRound"](MARKET.toBase58());
    assert.equal(rtOf(loop).lastProtectiveAtMs, 100_000);
  });

  it("no signal and nothing outstanding: no round", async () => {
    markV22Market(MARKET.toBase58());
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(LP, 0n) });
    const lines: string[] = [];
    const loop = mkLoop({}, f.conn, { lines });
    await loop["protectiveRound"](MARKET.toBase58());
    assert.ok(!lines.some((l) => l.includes("[v22][protect]")));
  });

  it("senior draw outstanding runs a protective round; a round that settles the LP resets the backoff", async () => {
    markV22Market(MARKET.toBase58());
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(LP, 5n), lpAccount: null });
    const lines: string[] = [];
    let t = 1_000_000;
    const loop = mkLoop({ KEEPER_V22_SWEEP: "on" }, f.conn, { lines, now: () => t });
    await loop["protectiveRound"](MARKET.toBase58());
    const r = rtOf(loop);
    assert.ok(lines.some((l) => l.includes("senior draw outstanding")));
    assert.equal(r.protectiveFailures, 0);
    assert.equal(r.nextProtectiveAtMs, 0);
  });

  it("a protective round that does not settle the LP backs off 5 s x 2^n (cap 120 s) and blocks the next call", async () => {
    markV22Market(MARKET.toBase58());
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(LP, 5n), lpAccount: null });
    const lines: string[] = [];
    let t = 1_000_000;
    const loop = mkLoop({ KEEPER_V22_SWEEP: "on" }, f.conn, { lines, now: () => t });
    let rounds = 0;
    loop["runRoundFor"] = async () => (rounds++, true); // declines to settle: lastRound never records a protective settle
    await loop["protectiveRound"](MARKET.toBase58());
    const r = rtOf(loop);
    assert.equal(r.protectiveFailures, 1);
    assert.equal(r.nextProtectiveAtMs, 1_000_000 + 10_000);
    t += 6_000; // inside the backoff
    await loop["protectiveRound"](MARKET.toBase58());
    assert.equal(rounds, 1);
    r.protectiveFailures = 10;
    t += 60_000;
    r.lastOutstandingRoundAtMs = 0;
    await loop["protectiveRound"](MARKET.toBase58());
    assert.equal(rounds, 2);
    assert.equal(r.nextProtectiveAtMs, t + 120_000);
  });
});

describe("runRoundFor / publishHealth / catch-up edges", () => {
  it("a round already in flight returns true without reading", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes() });
    const loop = mkLoop({}, f.conn);
    rtOf(loop).sweepInflight = true;
    assert.equal(await loop["runRoundFor"](f.conn as never, ENTRY, false), true);
    assert.equal(f.sims.length, 0);
  });

  it("an unreadable market declines (false) and clears the in-flight flag", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes(), throwOnRead: true });
    const loop = mkLoop({}, f.conn);
    assert.equal(await loop["runRoundFor"](f.conn as never, ENTRY, false), false);
    assert.equal(rtOf(loop).sweepInflight, false);
  });

  it("a non-Active/DrainOnly asset declines without sending", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true, lifecycle: 5 }), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(LP) });
    const loop = mkLoop({ KEEPER_V22_SWEEP: "on" }, f.conn);
    assert.equal(await loop["runRoundFor"](f.conn as never, ENTRY, false), false);
    assert.equal(f.sent.length, 0);
  });

  it("no vault LP portfolio on chain: logs and leaves the cycle to the legacy fallback", async () => {
    const lines: string[] = [];
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: null, portfolios: [] });
    const loop = mkLoop({ KEEPER_V22_SWEEP: "on" }, f.conn, { lines });
    assert.equal(await loop["runRoundFor"](f.conn as never, ENTRY, false), false);
    assert.ok(lines.some((l) => l.includes("no vault LP portfolio or the positioned set is unreadable")));
  });

  it("publishHealth keeps the pre-read when the post-round read throws", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes({ band: true }) });
    Object.assign(f.conn, {
      async getAccountInfo() {
        throw new Error("rpc down");
      },
    });
    const loop = mkLoop({}, f.conn);
    const ctx = v22Ctx({ band: true });
    const r = rtOf(loop);
    const positioned = { all: [], counterparties: [], lp: null, flatAnchor: null } as never;
    const res = { missing: [{ why: "refused" }, { why: "current" }], abandoned: "x" } as never;
    await loop["publishHealth"](ctx, r, positioned, res);
    assert.equal(r.lossStaleCycles, 0);
  });

  it("multiAssetCatchup: a throwing one-crank measurement falls back to the static estimate and the tx still goes", async () => {
    const lines: string[] = [];
    let calls = 0;
    const f = fakeLoopConn({
      market: v22MarketBytes({ band: true }),
      simErr: () => {
        if (calls++ === 0) throw new Error("sim blew up");
        return null;
      },
    });
    const loop = mkLoop({}, f.conn, { lines });
    await loop["multiAssetCatchup"](v22Ctx({ band: true }), LP, 3);
    assert.ok(lines.some((l) => l.includes("[v22][catchup]")));
    assert.ok(calls >= 2, `fallback must still simulate (calls=${calls})`);
  });
});

describe("startV22Loop", () => {
  it("a crashing tick is logged and the loop keeps going on the interval", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: string) => void errs.push(String(s));
    let ticks = 0;
    const fake = {
      async tick() {
        ticks++;
        throw new Error("tick exploded");
      },
    } as unknown as V22Loop;
    try {
      void startV22Loop(fake, 50);
      for (let i = 0; i < 20 && ticks < 1; i++) await new Promise((r) => setImmediate(r));
      assert.equal(ticks, 1);
      await new Promise((r) => setImmediate(r)); // let the catch run and the interval timer be armed
      mock.timers.tick(50);
      for (let i = 0; i < 20 && ticks < 2; i++) await new Promise((r) => setImmediate(r));
      assert.equal(ticks, 2);
      assert.ok(errs.some((e) => e.includes("[v22] tick crashed: tick exploded")));
    } finally {
      console.error = orig;
    }
  });
});
