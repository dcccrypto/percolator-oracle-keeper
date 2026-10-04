/**
 * K3 (2026-10-01 14:39-15:15Z): the crank loop hung for 35.5 min, pushes kept landing, /health stayed green and
 * nothing restarted it. The in-process watchdog exits non-zero once the loop is silent for > 2 intervals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  createCrankLiveness,
  crankLivenessOptsFromEnv,
  DEFAULT_LIVENESS_MIN_SILENCE_MS,
} from "./crank-liveness.ts";
import { AlertSink, DEFAULT_THRESHOLDS } from "./alerting.ts";
import { startRecoveryCrankLoop } from "./recovery-cranker.ts";
import type { Registry } from "./registry.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("crank liveness watchdog", () => {
  it("limit is the larger of N intervals and the floor", () => {
    const c = clock();
    assert.equal(createCrankLiveness({ intervalMs: 20_000, now: c.now }).limitMs(), DEFAULT_LIVENESS_MIN_SILENCE_MS); // 40 s < 120 s floor
    assert.equal(DEFAULT_LIVENESS_MIN_SILENCE_MS, 120_000);
    assert.equal(createCrankLiveness({ intervalMs: 70_000, now: c.now }).limitMs(), 140_000); // 2 intervals
    assert.equal(createCrankLiveness({ intervalMs: 20_000, intervals: 3, minSilenceMs: 1, now: c.now }).limitMs(), 60_000);
  });

  it("silence at the limit is fine; past it is a stall, reported once", () => {
    const c = clock();
    const calls: number[] = [];
    const l = createCrankLiveness({ intervalMs: 20_000, minSilenceMs: 1, now: c.now, onStall: (s) => calls.push(s) });
    c.advance(40_000);
    assert.equal(l.check(), false, "exactly 2 intervals is not yet a stall");
    c.advance(1);
    assert.equal(l.check(), true);
    assert.equal(l.check(), false, "fires once");
    assert.deepEqual(calls, [40_001]);
  });

  it("a beat resets the silence; steady beats never stall", () => {
    const c = clock();
    let stalled = 0;
    const l = createCrankLiveness({ intervalMs: 20_000, minSilenceMs: 1, now: c.now, onStall: () => stalled++ });
    for (let i = 0; i < 50; i++) {
      c.advance(30_000);
      l.beat();
      assert.equal(l.check(), false);
    }
    assert.equal(stalled, 0);
    assert.equal(l.silentMs(), 0);
  });

  it("the K3 shape: 35 min with no beat is a stall", () => {
    const c = clock();
    const l = createCrankLiveness({ intervalMs: 20_000, now: c.now, onStall: () => undefined });
    l.beat();
    c.advance(35.5 * 60_000);
    assert.equal(l.check(), true);
  });

  it("intervals=0 disables the watchdog", () => {
    const c = clock();
    const l = createCrankLiveness({ intervalMs: 20_000, intervals: 0, now: c.now, onStall: () => assert.fail("must not fire") });
    c.advance(10 * 3_600_000);
    assert.equal(l.check(), false);
    assert.equal(l.limitMs(), null);
    l.start()(); // no timer, no throw
  });

  it("env: defaults, overrides, and garbage throws (a typo must not silently disable it)", () => {
    assert.deepEqual(crankLivenessOptsFromEnv({}, 20_000), { intervalMs: 20_000, intervals: 2, minSilenceMs: 120_000 });
    assert.deepEqual(
      crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "3", CRANK_LIVENESS_MIN_SILENCE_MS: "90000" }, 20_000),
      { intervalMs: 20_000, intervals: 3, minSilenceMs: 90_000 },
    );
    assert.equal(crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "0" }, 20_000).intervals, 0);
    assert.throws(() => crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "two" }, 20_000), /CRANK_LIVENESS_INTERVALS/);
    assert.throws(() => crankLivenessOptsFromEnv({ CRANK_LIVENESS_MIN_SILENCE_MS: "0" }, 20_000), /CRANK_LIVENESS_MIN_SILENCE_MS/);
  });

  it("the real crank loop, with an RPC that never answers, trips the watchdog (negative control: a live loop does not)", async () => {
    // Every RPC method returns a promise that never settles: exactly the K3 hang.
    const hung = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as unknown as Connection;
    const registry: Registry = {
      version: 1,
      description: "t",
      markets: [
        {
          label: "HANG/USDC",
          marketAddress: Keypair.generate().publicKey.toBase58(),
          poolAddress: Keypair.generate().publicKey.toBase58(),
          dexType: "pumpswap",
          assetIndex: 0,
          registeredAt: Date.now(),
        },
      ],
    };
    const sink = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, log: () => undefined, logError: () => undefined });
    const stalled = new Promise<number>((resolve) => {
      const l = createCrankLiveness({ intervalMs: 50, intervals: 2, minSilenceMs: 1, onStall: (s) => resolve(s) });
      void startRecoveryCrankLoop(hung, Keypair.generate(), registry, { intervalMs: 50, dryRun: true }, sink, undefined, l);
    });
    const silent = await stalled;
    assert.ok(silent > 100, `stalled after ${silent} ms of silence (> 2 x 50 ms)`);
  });

  it("negative control: the same loop with an RPC that answers promptly never trips", async () => {
    const quiet = new Proxy({}, { get: () => () => Promise.resolve(null) }) as unknown as Connection;
    const registry: Registry = {
      version: 1,
      description: "t",
      markets: [
        {
          label: "LIVE/USDC",
          marketAddress: Keypair.generate().publicKey.toBase58(),
          poolAddress: Keypair.generate().publicKey.toBase58(),
          dexType: "pumpswap",
          assetIndex: 0,
          registeredAt: Date.now(),
        },
      ],
    };
    const sink = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, log: () => undefined, logError: () => undefined });
    let fired = 0;
    const l = createCrankLiveness({ intervalMs: 50, intervals: 2, minSilenceMs: 1, onStall: () => fired++ });
    void startRecoveryCrankLoop(quiet, Keypair.generate(), registry, { intervalMs: 50, dryRun: true }, sink, undefined, l);
    await new Promise((r) => setTimeout(r, 1_200)); // ~24 intervals
    assert.equal(fired, 0, "a loop that keeps settling must not be killed");
    assert.ok(l.silentMs() < 100, `still beating (silent ${l.silentMs()} ms)`);
    // The loop only stops on SIGTERM/SIGINT; deliver it to the listeners it registered so the test process can end.
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
  });

  it("a loop that THROWS stops its own watchdog: the supervisor's restarted loop is not killed by the dead one (review MEDIUM)", async () => {
    const quiet = new Proxy({}, { get: () => () => Promise.resolve(null) }) as unknown as Connection;
    const mk = (label: string): Registry => ({
      version: 1,
      description: "t",
      markets: [{ label, marketAddress: Keypair.generate().publicKey.toBase58(), poolAddress: Keypair.generate().publicKey.toBase58(), dexType: "pumpswap", assetIndex: 0, registeredAt: Date.now() }],
    });
    const good = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, log: () => undefined, logError: () => undefined });
    const bad = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, log: () => undefined, logError: () => undefined });
    bad.reconcile = async () => {
      throw new Error("boom");
    };
    let deadFired = 0;
    let healthyFired = 0;
    let controlFired = 0;
    const A = createCrankLiveness({ intervalMs: 50, intervals: 2, minSilenceMs: 1, onStall: () => deadFired++ });
    await startRecoveryCrankLoop(quiet, Keypair.generate(), mk("A"), { intervalMs: 50, dryRun: true }, bad, undefined, A).catch(() => undefined);
    // Negative control: a watchdog that is armed and never stopped DOES fire in this window, so the harness can see an orphan.
    const C = createCrankLiveness({ intervalMs: 50, intervals: 2, minSilenceMs: 1, onStall: () => controlFired++ });
    const stopC = C.start();
    // The supervisor restarts with a new watchdog.
    const B = createCrankLiveness({ intervalMs: 50, intervals: 2, minSilenceMs: 1, onStall: () => healthyFired++ });
    void startRecoveryCrankLoop(quiet, Keypair.generate(), mk("B"), { intervalMs: 50, dryRun: true }, good, undefined, B);
    await new Promise((r) => setTimeout(r, 1_500));
    stopC();
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(deadFired, 0, "the dead loop's watchdog was stopped with it");
    assert.equal(healthyFired, 0, "the restarted loop is healthy");
    assert.ok(controlFired > 0, "control: an unstopped watchdog would have fired");
  });
});
