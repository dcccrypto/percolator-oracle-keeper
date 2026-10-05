/**
 * The v2.1 loop (p2b-loop.ts): a strict no-op while the gate says "unsupported", and with the gate
 * on, one shared snapshot read per tick feeding wind-down / allocate / hedged-lockout / Earn gap,
 * with alerts reconciled through the existing sink.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveLpBackingLedger } from "@percolatorct/sdk";
import { P2bLoop, p2bLoopConfigFromEnv } from "./p2b-loop.ts";
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
