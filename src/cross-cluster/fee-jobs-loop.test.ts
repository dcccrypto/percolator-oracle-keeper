/**
 * startFeeJobLoop: the periodic driver around the fee jobs (LP-fee crank, stake AccrueFees push).
 * Mocked clock (setTimeout only), mocked sink, no RPC. The loop stops through its own SIGINT/SIGTERM
 * handler, so each test removes the listeners it added.
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { startFeeJobLoop } from "./fee-jobs.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import type { Alert } from "./alerting.ts";

const ctx = { conn: {} as never, keeper: Keypair.generate(), dryRun: true };
const registry = {
  markets: [
    { marketAddress: "MA", label: "AAA/USDC" },
    { marketAddress: "MB", label: "BBB/USDC" },
  ],
} as never;

let logs: string[];
let errors: string[];
let sigintBefore: Function[];
let sigtermBefore: Function[];

beforeEach(() => {
  logs = [];
  errors = [];
  mock.method(console, "log", (...a: unknown[]) => { logs.push(a.join(" ")); });
  mock.method(console, "error", (...a: unknown[]) => { errors.push(a.join(" ")); });
  mock.timers.enable({ apis: ["setTimeout"] });
  sigintBefore = process.listeners("SIGINT");
  sigtermBefore = process.listeners("SIGTERM");
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const before = sig === "SIGINT" ? sigintBefore : sigtermBefore;
    for (const l of process.listeners(sig)) if (!before.includes(l)) process.removeListener(sig, l as never);
  }
});

/** Drive the mocked clock until the loop promise settles. */
async function drive(p: Promise<void>): Promise<void> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(1000);
  }
  assert.ok(done, "loop stopped");
  await p;
}

function makeSink(stopAfterCycles: number, opts: { healthThrowsOnce?: boolean } = {}) {
  const health: Array<{ key: string; data: Record<string, unknown> }> = [];
  const reconciled: Array<{ key: string; alerts: Alert[] }> = [];
  const fired: Array<{ key: string; alert: Alert }> = [];
  let healthThrew = false;
  const sink = {
    health(key: string, data: Record<string, unknown>) {
      if (opts.healthThrowsOnce && !healthThrew) { healthThrew = true; throw new Error("health sink exploded"); }
      health.push({ key, data });
    },
    async reconcile(key: string, alerts: Alert[]) {
      reconciled.push({ key, alerts });
      if (reconciled.length >= stopAfterCycles) process.emit("SIGTERM");
    },
    async fire(key: string, alert: Alert) { fired.push({ key, alert }); },
  };
  return { sink: sink as never, health, reconciled, fired };
}

const cfg = { intervalMs: 1000 };

describe("startFeeJobLoop", () => {
  it("announces the jobs and mode, logs moved fees, and reports health + reconciled alerts every cycle", async () => {
    const job: FeeJob = {
      name: "lp-fee",
      async run(_c, m): Promise<FeeJobOutcome> {
        return m.marketAddress === "MA"
          ? { kind: "done", detail: "moved 5 lamports", events: [{ kind: "fee-leg-blocked", severity: "warn", subject: "", message: "pda portfolio closed" } as Alert] }
          : { kind: "blocked", reason: "stake pool not bound" };
      },
    };
    const t = makeSink(1);
    await drive(startFeeJobLoop([job], ctx, registry, cfg, t.sink));

    assert.ok(logs.some((l) => /loop starting: jobs=\[lp-fee\] 2 markets, interval=1000ms, mode=DRY-RUN/.test(l)));
    assert.ok(logs.includes("[lp-fee] AAA/USDC: moved 5 lamports"));
    assert.ok(logs.some((l) => /\[lp-fee\] cycle 0: 1 moved, 0 nothing-to-do, 0 skipped, 1 blocked, 0 waiting, 0 failed$/.test(l)));

    assert.equal(t.health.length, 1);
    assert.equal(t.health[0].key, "fee-jobs:lp-fee");
    assert.deepEqual(t.health[0].data, {
      cycle: 0, done: 1, nothing: 0, skipped: 0, blocked: 1, waiting: 0, failed: 0,
      blockedMarkets: ["BBB/USDC"], waitingMarkets: [], failedMarkets: [],
    });
    assert.equal(t.reconciled[0].alerts.length, 1);
    assert.equal(t.reconciled[0].alerts[0].kind, "fee-leg-blocked");
    assert.match(t.reconciled[0].alerts[0].message, /stake pool not bound/);

    // The one-shot event goes out under the job's events key, with the market label filled in.
    assert.equal(t.fired.length, 1);
    assert.equal(t.fired[0].key, "fee-jobs:lp-fee:events");
    assert.equal(t.fired[0].alert.subject, "AAA/USDC");
  });

  it("stays quiet on a healthy no-op cycle, but still prints the summary every `summaryEveryCycles`", async () => {
    const job: FeeJob = { name: "stake-fee", async run() { return { kind: "nothing" }; } };
    const t = makeSink(3);
    await drive(startFeeJobLoop([job], ctx, registry, { intervalMs: 1000, summaryEveryCycles: 2 }, t.sink));

    const cycleLines = logs.filter((l) => /^\[stake-fee\] cycle \d+:/.test(l));
    assert.deepEqual(cycleLines.map((l) => l.match(/cycle (\d+)/)![1]), ["0", "2"], "cycle 1 is silent");
    assert.deepEqual(t.health.map((h) => h.data.cycle), [0, 1, 2], "health is still reported every cycle");
    assert.ok(t.reconciled.every((r) => r.alerts.length === 0));
  });

  it("includes failed and waiting detail in the summary and alerts a failure only after the streak", async () => {
    const job: FeeJob = {
      name: "lp-fee",
      async run(_c, m): Promise<FeeJobOutcome> {
        return m.marketAddress === "MA"
          ? { kind: "failed", error: "rpc timed out" }
          : { kind: "waiting", reason: "OracleStale, next push clears it" };
      },
    };
    const t = makeSink(3);
    await drive(startFeeJobLoop([job], ctx, registry, cfg, t.sink));

    const line = logs.find((l) => /cycle 0:/.test(l))!;
    assert.match(line, / — AAA\/USDC: rpc timed out/);
    assert.match(line, / — waiting: BBB\/USDC: OracleStale/);
    assert.deepEqual(t.reconciled.map((r) => r.alerts.length), [0, 0, 1], "3rd consecutive failure alerts");
    assert.equal(t.reconciled[2].alerts[0].kind, "fee-job-failed");
    assert.deepEqual(t.health[2].data.failedMarkets, ["AAA/USDC"]);
    assert.deepEqual(t.health[2].data.waitingMarkets, ["BBB/USDC"]);
  });

  it("runs each job in order with its own health key and failure tracker", async () => {
    const order: string[] = [];
    const a: FeeJob = { name: "a", async run(_c, m) { order.push(`a:${m.marketAddress}`); return { kind: "failed", error: "x" }; } };
    const b: FeeJob = { name: "b", async run(_c, m) { order.push(`b:${m.marketAddress}`); return { kind: "nothing" }; } };
    const t = makeSink(6);
    await drive(startFeeJobLoop([a, b], ctx, registry, cfg, t.sink));

    assert.deepEqual(order.slice(0, 4), ["a:MA", "a:MB", "b:MA", "b:MB"]);
    assert.deepEqual([...new Set(t.health.map((h) => h.key))].sort(), ["fee-jobs:a", "fee-jobs:b"]);
    // Only job `a` has a failure streak; `b` must never inherit it.
    const bAlerts = t.reconciled.filter((r) => r.key === "fee-jobs:b").flatMap((r) => r.alerts);
    assert.equal(bAlerts.length, 0);
    const aAlerts = t.reconciled.filter((r) => r.key === "fee-jobs:a").flatMap((r) => r.alerts);
    assert.equal(aAlerts.length, 2, "both of a's markets alert on the 3rd cycle");
  });

  it("a sink that throws costs one sweep, not the loop", async () => {
    const job: FeeJob = { name: "lp-fee", async run() { return { kind: "nothing" }; } };
    const t = makeSink(1, { healthThrowsOnce: true });
    await drive(startFeeJobLoop([job], ctx, registry, cfg, t.sink));

    assert.equal(errors.length, 1);
    assert.match(errors[0], /\[lp-fee\] sweep error — health sink exploded/);
    // The next cycle ran normally and reached reconcile (which stopped the loop).
    assert.equal(t.reconciled.length, 1);
    assert.equal(t.health.length, 1);
  });

  it("stringifies a non-Error throw from the sink", async () => {
    const job: FeeJob = { name: "lp-fee", async run() { return { kind: "nothing" }; } };
    let thrown = false;
    const sink = {
      health() { if (!thrown) { thrown = true; throw "plain string"; } },
      async reconcile() { process.emit("SIGINT"); },
      async fire() {},
    };
    await drive(startFeeJobLoop([job], ctx, registry, cfg, sink as never));
    assert.match(errors[0], /sweep error — plain string/);
  });

  it("paces cycles by the interval minus the sweep time, never below one second", async () => {
    const job: FeeJob = { name: "lp-fee", async run() { return { kind: "nothing" }; } };
    const t = makeSink(2);
    let p!: Promise<void>;
    p = startFeeJobLoop([job], ctx, registry, { intervalMs: 5000 }, t.sink);
    await new Promise((r) => setImmediate(r));
    assert.equal(t.reconciled.length, 1, "first cycle ran");
    mock.timers.tick(4000);
    await new Promise((r) => setImmediate(r));
    assert.equal(t.reconciled.length, 1, "interval (5s) has not elapsed after 4s");
    mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(t.reconciled.length, 2, "second cycle after the full interval");
    await drive(p);
  });
});
