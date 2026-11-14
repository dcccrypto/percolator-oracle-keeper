/**
 * The v2.1 loop (p2b-loop.ts): a strict no-op while the gate says "unsupported", and with the gate
 * on, one shared snapshot read per tick feeding wind-down / allocate / hedged-lockout / Earn gap,
 * with alerts reconciled through the existing sink.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveLpBackingLedger } from "@percolatorct/sdk";
import { DEFAULT_P2B_LOOP_CONFIG, P2bLoop, p2bLoopConfigFromEnv, startP2bLoop } from "./p2b-loop.ts";
import { DEFAULT_P2B_GATE_CONFIG, P2bFeatureGate, makeTag103Probe } from "./p2b-feature.ts";
import type { P2bProbeResult } from "./p2b-feature.ts";
import { DEFAULT_ALLOCATE_CONFIG, VaultLpAllocator } from "./p2b-allocate.ts";
import { AdlWindDownRunner, DEFAULT_WIND_DOWN_CONFIG } from "./p2b-wind-down.ts";
import { EarnGapMonitor, DEFAULT_EARN_GAP_CONFIG } from "./p2b-earn-gap.ts";
import { DEFAULT_HEDGED_LOCKOUT_THRESHOLDS } from "./p2b-hedged-lockout.ts";
import type { Alert } from "./alerting.ts";
import { KEEPER, PROGRAM, deriveLpVaultRegistry, deriveVaultLpState, fakeConn, fx, patchedMarket, registryBytes, vaultLpStateBytes } from "./p2b-test-helpers.ts";

const LOOP_CFG = { tickMs: 20_000, hedgedIntervalMs: 30_000, minKeeperBalanceLamports: 50_000_000, balanceCheckIntervalMs: 30_000, healthEveryTicks: 15 };

function sinkSpy() {
  const reconciles: Array<{ scope: string; alerts: Alert[] }> = [];
  const healths: string[] = [];
  return {
    reconciles,
    healths,
    sink: {
      async reconcile(scope: string, active: Alert[]) { reconciles.push({ scope, alerts: active }); return []; },
      health(scope: string) { healths.push(scope); },
    },
  };
}

function build(o: { gate: P2bProbeResult | "mode-off"; markets: Array<{ marketAddress: string; label: string; assetIndex: number }>; accounts?: Map<string, Uint8Array>; now?: () => number }) {
  const c = fakeConn({ accounts: o.accounts ?? new Map() });
  const spy = sinkSpy();
  let probes = 0;
  const gate = new P2bFeatureGate(
    { ...DEFAULT_P2B_GATE_CONFIG, mode: o.gate === "mode-off" ? "off" : "auto" },
    async () => { probes++; return o.gate === "mode-off" ? "unknown" : o.gate; },
  );
  const loop: P2bLoop = new P2bLoop(LOOP_CFG, {
    conn: c.conn as never,
    keeper: KEEPER,
    programId: PROGRAM,
    registry: { markets: o.markets as never },
    gate,
    sink: spy.sink as never,
    allocator: new VaultLpAllocator({ ...DEFAULT_ALLOCATE_CONFIG }, { programId: PROGRAM, conn: c.conn as never, keeper: KEEPER, walletLow: () => loop.walletLow(), now: o.now, rand: () => 0, log: () => undefined }),
    windDown: new AdlWindDownRunner({ ...DEFAULT_WIND_DOWN_CONFIG }, { programId: PROGRAM, conn: c.conn as never, keeper: KEEPER, fetchHolders: async () => [], mintDecimals: async () => 6, log: () => undefined }),
    earnGap: new EarnGapMonitor(DEFAULT_EARN_GAP_CONFIG, PROGRAM, o.now, () => undefined),
    hedged: DEFAULT_HEDGED_LOCKOUT_THRESHOLDS,
    now: o.now,
  });
  return { loop, c, spy, probes: () => probes, gate };
}

const market = (label: string) => ({ marketAddress: Keypair.generate().publicKey.toBase58(), label, assetIndex: 0 });

describe("strict no-op while the program predates P2b", () => {
  for (const g of ["unsupported", "unknown", "no-candidate", "mode-off"] as const) {
    it(`gate says ${g}: the tick makes ZERO RPC calls, sends nothing, and /health gets no new fields`, async () => {
      const ms = [market("SOL"), market("JUP")];
      const w = build({ gate: g, markets: ms });
      const s = await w.loop.tick();
      assert.equal(s.active, false);
      assert.equal(w.c.calls.length, 0, "no balance read, no snapshot read, nothing");
      assert.equal(w.spy.reconciles.length, 0);
      assert.deepEqual(w.loop.healthFields(), {});
    });
  }

  it("with a real probe over today's program (InvalidInstructionData): the footprint is the probe alone, once per TTL", async () => {
    const m = market("SOL");
    const mk = Keypair.generate().publicKey;
    const accounts = new Map<string, Uint8Array>([
      [deriveLpVaultRegistry(PROGRAM, mk)[0].toBase58(), registryBytes({ bound: true })],
      [deriveVaultLpState(PROGRAM, mk).toBase58(), vaultLpStateBytes({ lp: Keypair.generate().publicKey })],
    ]);
    const c = fakeConn({ accounts, sims: [{ err: { InstructionError: [1, "InvalidInstructionData"] } }] });
    const gate = new P2bFeatureGate(DEFAULT_P2B_GATE_CONFIG, makeTag103Probe({ conn: c.conn as never, keeper: KEEPER, programId: PROGRAM, markets: () => [{ marketAddress: mk.toBase58() }] }), () => 5_000, () => undefined);
    const spy = sinkSpy();
    const loop = new P2bLoop(LOOP_CFG, {
      conn: c.conn as never, keeper: KEEPER, programId: PROGRAM, registry: { markets: [m] as never }, gate, sink: spy.sink as never,
      allocator: new VaultLpAllocator(DEFAULT_ALLOCATE_CONFIG, { programId: PROGRAM, conn: c.conn as never, keeper: KEEPER, log: () => undefined }),
      windDown: new AdlWindDownRunner(DEFAULT_WIND_DOWN_CONFIG, { programId: PROGRAM, conn: c.conn as never, keeper: KEEPER, fetchHolders: async () => [], mintDecimals: async () => 6 }),
      earnGap: new EarnGapMonitor(DEFAULT_EARN_GAP_CONFIG, PROGRAM), hedged: DEFAULT_HEDGED_LOCKOUT_THRESHOLDS, now: () => 5_000,
    });
    for (let i = 0; i < 5; i++) await loop.tick();
    assert.deepEqual(c.calls.map((x) => x.fn), ["getMultipleAccountsInfo", "getLatestBlockhash", "simulateTransaction"], "one batched read + one simulation, then silence");
    assert.equal(c.sent.length, 0);
    assert.equal(c.count("sendRawTransaction"), 0);
    assert.deepEqual(loop.healthFields(), {});
  });
});

describe("with the gate on", () => {
  function world() {
    // bound market (allocate), non-bound Earn vault (gap), close-only market (wind-down arm needs holders: none here)
    const bound = market("BOUND");
    const earn = market("EARN");
    const accounts = new Map<string, Uint8Array>();
    const put = (m: { marketAddress: string }, reg: Uint8Array | null, state: Uint8Array | null, mkt: Uint8Array) => {
      const k = new PublicKey(m.marketAddress);
      accounts.set(k.toBase58(), mkt);
      if (reg) accounts.set(deriveLpVaultRegistry(PROGRAM, k)[0].toBase58(), reg);
      if (state) accounts.set(deriveVaultLpState(PROGRAM, k).toBase58(), state);
      return k;
    };
    put(bound, registryBytes({ bound: true }), vaultLpStateBytes({ lp: Keypair.generate().publicKey }), patchedMarket());
    const ek = put(earn, registryBytes({ bound: false, domain: 0, feeShareBps: 1000 }), null, new Uint8Array(fx("sol-market-v18")));
    // a ledger for the earn vault so the monitor has something to price
    accounts.set(deriveLpBackingLedger(PROGRAM, ek, 0)[0].toBase58(), new Uint8Array(0));
    return { bound, earn, accounts };
  }

  it("ONE batched snapshot read feeds every task; an Earn vault with a real fixture market reports a record", async () => {
    const w0 = world();
    const w = build({ gate: "supported", markets: [w0.bound, w0.earn], accounts: w0.accounts });
    const s = await w.loop.tick();
    assert.equal(s.active, true);
    assert.equal(s.snapshots, 2);
    assert.equal(w.c.count("getMultipleAccountsInfoAndContext") >= 1, true);
    // allocator saw both markets (first sight: staggered, not-due) -- no send, no simulate yet
    assert.equal(w.c.count("simulateTransaction"), 0);
    assert.equal(w.c.sent.length, 0);
    assert.deepEqual(w.spy.reconciles.map((r) => r.scope).sort(), ["p2b:allocate", "p2b:earn-gap", "p2b:hedged-lockout"]);
    const h = w.loop.healthFields() as { earnVaults: unknown[]; p2b: { gate: { supported: boolean } } };
    assert.equal(h.p2b.gate.supported, true);
    assert.equal(h.earnVaults.length, 1, "only the NON-bound vault with a registry");
  });

  it("an empty registry costs nothing beyond the gate", async () => {
    const w = build({ gate: "supported", markets: [] });
    const s = await w.loop.tick();
    assert.equal(s.markets, 0);
    assert.equal(w.c.calls.length, 0);
  });

  it("the wallet guard reads the balance on its own cadence and pauses sends when low (RPC failure keeps the verdict)", async () => {
    let now = 1_000_000;
    const w0 = world();
    const w = build({ gate: "supported", markets: [w0.bound], accounts: w0.accounts, now: () => now });
    w.c.conn.getBalance = (async () => 1_000) as never;
    await w.loop.tick();
    assert.equal(w.loop.walletLow(), true);
    w.c.conn.getBalance = (async () => { throw new Error("rpc"); }) as never;
    now += 60_000;
    await w.loop.tick();
    assert.equal(w.loop.walletLow(), true, "a failed read never clears 'low'");
    w.c.conn.getBalance = (async () => 5_000_000_000) as never;
    now += 60_000;
    await w.loop.tick();
    assert.equal(w.loop.walletLow(), false);
  });

  it("a failing read never throws out of the tick", async () => {
    const w0 = world();
    const w = build({ gate: "supported", markets: [w0.bound], accounts: w0.accounts });
    w.c.conn.getMultipleAccountsInfoAndContext = (async () => { throw new Error("429"); }) as never;
    const s = await w.loop.tick();
    assert.equal(s.snapshots, 0);
  });
});

describe("p2bLoopConfigFromEnv", () => {
  it("defaults and garbage", () => {
    const c = p2bLoopConfigFromEnv({}, 5, 6);
    assert.deepEqual([c.tickMs, c.hedgedIntervalMs, c.minKeeperBalanceLamports, c.balanceCheckIntervalMs], [20_000, 30_000, 5, 6]);
    assert.throws(() => p2bLoopConfigFromEnv({ P2B_TICK_MS: "10" }, 5, 6), /P2B_TICK_MS/);
  });
});

describe("p2bLoopConfigFromEnv overrides and bounds", () => {
  it("honours valid overrides, treats blank as unset, and rejects non-integers and out-of-range values naming the variable", () => {
    const c = p2bLoopConfigFromEnv({ P2B_TICK_MS: "5000", HEDGED_LOCKOUT_INTERVAL_MS: "45000" }, 1, 2);
    assert.deepEqual([c.tickMs, c.hedgedIntervalMs, c.healthEveryTicks], [5_000, 45_000, DEFAULT_P2B_LOOP_CONFIG.healthEveryTicks]);
    const blank = p2bLoopConfigFromEnv({ P2B_TICK_MS: "   ", HEDGED_LOCKOUT_INTERVAL_MS: "" }, 1, 2);
    assert.deepEqual([blank.tickMs, blank.hedgedIntervalMs], [20_000, 30_000]);
    const edge = p2bLoopConfigFromEnv({ P2B_TICK_MS: "1000", HEDGED_LOCKOUT_INTERVAL_MS: "86400000" }, 1, 2);
    assert.deepEqual([edge.tickMs, edge.hedgedIntervalMs], [1_000, 86_400_000]);
    assert.throws(() => p2bLoopConfigFromEnv({ P2B_TICK_MS: "999" }, 1, 2), /P2B_TICK_MS="999"/);
    assert.throws(() => p2bLoopConfigFromEnv({ P2B_TICK_MS: "86400001" }, 1, 2), /P2B_TICK_MS/);
    assert.throws(() => p2bLoopConfigFromEnv({ HEDGED_LOCKOUT_INTERVAL_MS: "1500.5" }, 1, 2), /HEDGED_LOCKOUT_INTERVAL_MS/);
    assert.throws(() => p2bLoopConfigFromEnv({ HEDGED_LOCKOUT_INTERVAL_MS: "abc" }, 1, 2), /HEDGED_LOCKOUT_INTERVAL_MS/);
  });
});

describe("P2bLoop tick details", () => {
  const withLogs = async <T>(fn: () => Promise<T>) => {
    const logs: string[] = [];
    const [ow, ol, oe] = [console.warn, console.log, console.error];
    console.warn = (...a: unknown[]) => { logs.push(`warn:${a.join(" ")}`); };
    console.log = (...a: unknown[]) => { logs.push(`log:${a.join(" ")}`); };
    console.error = (...a: unknown[]) => { logs.push(`error:${a.join(" ")}`); };
    try { return { result: await fn(), logs }; } finally { [console.warn, console.log, console.error] = [ow, ol, oe]; }
  };

  it("logs the wallet edges exactly once: went-low pauses 103/104, recovered resumes them", async () => {
    let now = 1_000_000;
    const w = build({ gate: "supported", markets: [market("A")], now: () => now });
    w.c.conn.getBalance = (async () => 1_000) as never;
    const low = await withLogs(() => w.loop.tick());
    assert.equal(low.logs.filter((l) => l.startsWith("warn:[p2b] keeper wallet low")).length, 1);
    assert.match(low.logs.join("\n"), /sends paused/);
    now += 60_000;
    const still = await withLogs(() => w.loop.tick());
    assert.equal(still.logs.filter((l) => l.includes("keeper wallet")).length, 0, "no edge, no log");
    w.c.conn.getBalance = (async () => 5_000_000_000) as never;
    now += 60_000;
    const up = await withLogs(() => w.loop.tick());
    assert.equal(up.logs.filter((l) => l.startsWith("log:[p2b] keeper wallet recovered")).length, 1);
    assert.match(up.logs.join("\n"), /sends resumed/);
  });

  it("emits the p2b health line on tick 1 and every healthEveryTicks after, not in between", async () => {
    const w = build({ gate: "supported", markets: [market("A")] });
    const healthsAfter = async () => { await w.loop.tick(); return w.spy.healths.length; };
    assert.equal(await healthsAfter(), 1, "tick 1");
    for (let i = 2; i <= 15; i++) assert.equal(await healthsAfter(), 1, `tick ${i}`);
    assert.equal(await healthsAfter(), 2, "tick 16 = 1 mod 15");
    assert.deepEqual([...new Set(w.spy.healths)], ["p2b"]);
  });

  it("hedged-lockout runs on its own interval, not every tick", async () => {
    let now = 5_000_000;
    const w = build({ gate: "supported", markets: [market("A")], now: () => now });
    assert.equal((await w.loop.tick()).hedgedEvaluated, true, "first tick: lastHedgedAt=0, so due");
    now += 10_000;
    assert.equal((await w.loop.tick()).hedgedEvaluated, false, "10s < 30s");
    now += 20_000;
    assert.equal((await w.loop.tick()).hedgedEvaluated, true, "30s elapsed");
  });

  it("a non-Error thrown inside the tick is stringified into the error log and the tick still returns a summary", async () => {
    const w = build({ gate: "supported", markets: [market("A")] });
    w.spy.sink.reconcile = (async () => { throw "plain string failure"; }) as never;
    const { result, logs } = await withLogs(() => w.loop.tick());
    assert.equal(result.active, true);
    assert.deepEqual(logs.filter((l) => l.startsWith("error:")), ["error:[p2b] tick error — plain string failure"]);
  });

  it("a long Error message is truncated to 160 chars in the log", async () => {
    const w = build({ gate: "supported", markets: [market("A")] });
    w.spy.sink.reconcile = (async () => { throw new Error("x".repeat(500)); }) as never;
    const { logs: all } = await withLogs(() => w.loop.tick());
    const logs = all.filter((l) => l.startsWith("error:"));
    assert.equal(logs.length, 1);
    assert.equal(logs[0], `error:[p2b] tick error — ${"x".repeat(160)}`);
  });

  it("a throwing gate never escapes the tick and leaves the summary inactive", async () => {
    const w = build({ gate: "supported", markets: [market("A")] });
    w.gate.ensure = (async () => { throw new Error("probe exploded"); }) as never;
    const { result, logs } = await withLogs(() => w.loop.tick());
    assert.equal(result.active, false);
    assert.match(logs.join("\n"), /probe exploded/);
  });

  it("healthFields is {} while unsupported and, once supported, exposes wallet + counters with no hedged rows before the first evaluation", async () => {
    const off = build({ gate: "mode-off", markets: [market("A")] });
    await off.loop.tick();
    assert.deepEqual(off.loop.healthFields(), {});
    const on = build({ gate: "supported", markets: [market("A")] });
    const before = on.loop.healthFields() as { p2b: { hedgedLockout: unknown[]; walletLow: boolean } };
    assert.deepEqual(before, {});
    await on.loop.tick();
    const f = on.loop.healthFields() as { earnVaults: unknown[]; p2b: { hedgedLockout: unknown[]; walletLow: boolean; allocate: unknown; windDown: unknown } };
    assert.deepEqual(f.earnVaults, []);
    assert.equal(f.p2b.walletLow, false);
    assert.ok(Array.isArray(f.p2b.hedgedLockout));
    assert.ok(f.p2b.allocate && f.p2b.windDown);
  });
});

describe("startP2bLoop", () => {
  it("ticks, then exits cleanly once SIGTERM is delivered (no extra tick after the stop flag), and logs its tick cadence", async () => {
    const before = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") };
    const logs: string[] = [];
    const ol = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    const w = build({ gate: "mode-off", markets: [market("A")] });
    let ticks = 0;
    const realTick = w.loop.tick.bind(w.loop);
    w.loop.tick = (async () => { ticks++; return realTick(); }) as never;
    try {
      const done = startP2bLoop(w.loop, { tickMs: 1_000 });
      process.emit("SIGTERM");
      await done;
    } finally {
      console.log = ol;
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        for (const l of process.listeners(sig)) if (!(before[sig === "SIGINT" ? "int" : "term"]).includes(l)) process.removeListener(sig, l);
      }
    }
    assert.equal(ticks, 1, "exactly one pass: the stop flag was already set when the sleep ended");
    assert.match(logs[0], /\[p2b\] loop starting: tick=1000ms/);
  });

  it("SIGINT also stops it", async () => {
    const before = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") };
    const ol = console.log;
    console.log = () => undefined;
    const w = build({ gate: "mode-off", markets: [] });
    try {
      const done = startP2bLoop(w.loop, { tickMs: 1_000 });
      process.emit("SIGINT");
      await done;
    } finally {
      console.log = ol;
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        for (const l of process.listeners(sig)) if (!(before[sig === "SIGINT" ? "int" : "term"]).includes(l)) process.removeListener(sig, l);
      }
    }
  });
});
