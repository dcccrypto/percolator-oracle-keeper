/** The shared fee-job loop: classification, isolation, alerting. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { FeeJobFailureTracker, FEE_JOB_FAILURE_ALERT_AFTER, FEE_JOB_WAITING_ALERT_AFTER, runFeeJobSweep, summarizeSweep } from "./fee-jobs.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";

const ctx = { conn: {} as never, keeper: Keypair.generate(), dryRun: false };
const markets = ["A", "B", "C", "D", "E", "F"].map((x) => ({ marketAddress: x, label: `${x}/USDC` }));
const outcomes: Record<string, FeeJobOutcome | "throw"> = {
  A: { kind: "done", detail: "moved 5" },
  B: { kind: "nothing" },
  C: { kind: "skipped", reason: "no vault" },
  D: { kind: "blocked", reason: "Custom(56) not bound" },
  E: { kind: "failed", error: "rpc 429" },
  F: "throw",
};
const job: FeeJob = {
  name: "test-job",
  async run(_c, m) {
    const o = outcomes[m.marketAddress];
    if (o === "throw") throw new Error("kaboom");
    return o;
  },
};

describe("runFeeJobSweep", () => {
  it("buckets every outcome; a throwing job is a failure, not a crash", async () => {
    const r = await runFeeJobSweep(job, ctx, markets, 2);
    assert.deepEqual(summarizeSweep(r), { done: 1, nothing: 1, skipped: 1, blocked: 1, waiting: 0, failed: 2 });
    assert.ok(r.failed.some((f) => f.market === "F" && /kaboom/.test(f.error)));
  });
  it("bounds concurrency", async () => {
    let inflight = 0; let peak = 0;
    const slow: FeeJob = { name: "slow", async run() { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return { kind: "nothing" }; } };
    await runFeeJobSweep(slow, ctx, markets, 3);
    assert.equal(peak, 3);
  });
});

describe("FeeJobFailureTracker", () => {
  it("blocked legs alert every sweep (deduped by the sink); failures only after a streak", async () => {
    const t = new FeeJobFailureTracker();
    const r = await runFeeJobSweep(job, ctx, markets);
    for (let i = 1; i < FEE_JOB_FAILURE_ALERT_AFTER; i++) {
      const a = t.alertsFor(r);
      assert.deepEqual(a.map((x) => x.kind), ["fee-leg-blocked"], `sweep ${i}`);
    }
    const a = t.alertsFor(r);
    assert.deepEqual(a.map((x) => x.kind).sort(), ["fee-job-failed", "fee-job-failed", "fee-leg-blocked"]);
    const clean = { ...r, failed: [] };
    t.alertsFor(clean);
    assert.deepEqual(t.alertsFor(r).map((x) => x.kind), ["fee-leg-blocked"], "streak reset after a clean sweep");
  });
});

describe("runFeeJobSweep edge outcomes", () => {
  const one = [{ marketAddress: "M", label: "M/USDC" }];
  it("waiting outcomes are bucketed; a non-Error throw becomes its string; event subject falls back to the label", async () => {
    const waiter: FeeJob = { name: "w", async run() { return { kind: "waiting", reason: "OracleStale", events: [{ kind: "x", severity: "info", subject: "", message: "m" } as never] }; } };
    const r = await runFeeJobSweep(waiter, ctx, one);
    assert.deepEqual(r.waiting, [{ market: "M", label: "M/USDC", reason: "OracleStale" }]);
    assert.equal(r.events[0].subject, "M/USDC");
    const thrower: FeeJob = { name: "t", async run() { throw "plain string"; } };
    const r2 = await runFeeJobSweep(thrower, ctx, one);
    assert.equal(r2.failed[0].error, "plain string");
  });
  it("waiting alerts only after FEE_JOB_WAITING_ALERT_AFTER sweeps; a sweep without waiting resets; no `waiting` field is tolerated", async () => {
    const waiter: FeeJob = { name: "w", async run() { return { kind: "waiting", reason: "stale" }; } };
    const r = await runFeeJobSweep(waiter, ctx, one);
    const t = new FeeJobFailureTracker();
    for (let i = 1; i < FEE_JOB_WAITING_ALERT_AFTER; i++) assert.deepEqual(t.alertsFor(r), []);
    const a = t.alertsFor(r);
    assert.equal(a.length, 1);
    assert.match(a[0].message, /still waiting after 6 consecutive/);
    const { waiting: _w, ...noWaiting } = r;
    assert.deepEqual(t.alertsFor(noWaiting as never), []);
    assert.deepEqual(t.alertsFor(r), [], "streak restarted");
    assert.equal(summarizeSweep(noWaiting as never).waiting, 0);
  });
  it("blocked severity: explicit wins, terminal kinds are critical, default warn", () => {
    const base = { job: "j", done: [], nothing: 0, skipped: [], failed: [], events: [] };
    const t = new FeeJobFailureTracker();
    const a = t.alertsFor({
      ...base,
      blocked: [
        { market: "1", label: "1", reason: "r", alertKind: "terminal-budget-unbooked" },
        { market: "2", label: "2", reason: "r", alertKind: "terminal-recovery-blocked-portfolios" },
        { market: "3", label: "3", reason: "r", alertKind: "terminal-budget-unbooked", severity: "warn" },
        { market: "4", label: "4", reason: "r" },
      ],
    } as never);
    assert.deepEqual(a.map((x) => x.severity), ["critical", "critical", "warn", "warn"]);
  });
});
