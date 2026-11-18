/** Branch coverage for fee-jobs.ts: waiting streaks, severity defaults, optional fields, non-Error throws. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  FeeJobFailureTracker,
  FEE_JOB_FAILURE_ALERT_AFTER,
  FEE_JOB_WAITING_ALERT_AFTER,
  runFeeJobSweep,
  summarizeSweep,
} from "./fee-jobs.ts";
import type { FeeJob, FeeJobSweepResult } from "./fee-jobs.ts";

const ctx = { conn: {} as never, keeper: Keypair.generate(), dryRun: false };
const mk = (over: Partial<FeeJobSweepResult> = {}): FeeJobSweepResult => ({
  job: "j", done: [], nothing: 0, skipped: [], blocked: [], failed: [], events: [], ...over,
});
const waitingOf = (...ms: string[]) => ms.map((m) => ({ market: m, label: `${m}/USDC`, reason: "OracleStale" }));
const failedOf = (...ms: string[]) => ms.map((m) => ({ market: m, label: `${m}/USDC`, error: "rpc" }));

describe("runFeeJobSweep edge cases", () => {
  it("stringifies non-Error throws, collects waiting, fills event subject from label", async () => {
    const job: FeeJob = {
      name: "j",
      async run(_c, m) {
        if (m.marketAddress === "A") throw "plain string";
        if (m.marketAddress === "B") return { kind: "waiting", reason: "stale" };
        return {
          kind: "nothing",
          events: [
            { kind: "fee-leg-blocked", severity: "warn", subject: "", message: "m" },
            { kind: "fee-leg-blocked", severity: "warn", subject: "own", message: "m" },
          ],
        };
      },
    };
    const mkts = ["A", "B", "C"].map((x) => ({ marketAddress: x, label: `${x}/USDC` }));
    const r = await runFeeJobSweep(job, ctx, mkts);
    assert.equal(r.failed[0].error, "plain string");
    assert.deepEqual(r.waiting, [{ market: "B", label: "B/USDC", reason: "stale" }]);
    assert.deepEqual(r.events.map((e) => e.subject), ["C/USDC", "own"]);
  });
  it("handles an empty market list", async () => {
    const r = await runFeeJobSweep({ name: "j", run: async () => ({ kind: "nothing" }) }, ctx, []);
    assert.deepEqual(summarizeSweep(r), { done: 0, nothing: 0, skipped: 0, blocked: 0, waiting: 0, failed: 0 });
  });
});

describe("FeeJobFailureTracker", () => {
  it("alerts waiting only at the threshold, and a clear resets the streak", () => {
    const t = new FeeJobFailureTracker();
    for (let i = 1; i < FEE_JOB_WAITING_ALERT_AFTER; i++) assert.equal(t.alertsFor(mk({ waiting: waitingOf("A") })).length, 0);
    const a = t.alertsFor(mk({ waiting: waitingOf("A") }));
    assert.equal(a.length, 1);
    assert.equal(a[0].severity, "warn");
    assert.equal(a[0].data?.waitingStreak, FEE_JOB_WAITING_ALERT_AFTER);
    assert.equal(t.alertsFor(mk()).length, 0); // cleared (waiting undefined)
    assert.equal(t.alertsFor(mk({ waiting: waitingOf("A") })).length, 0); // restarts from 1
  });
  it("keeps waiting streaks of other jobs and markets when sweeping", () => {
    const t = new FeeJobFailureTracker();
    for (let i = 0; i < FEE_JOB_WAITING_ALERT_AFTER - 1; i++) {
      t.alertsFor(mk({ job: "other", waiting: waitingOf("A") }));
      t.alertsFor(mk({ job: "j", waiting: waitingOf("A", "B") }));
    }
    // job j: B drops out; A continues and hits threshold. other's streak untouched.
    const a = t.alertsFor(mk({ job: "j", waiting: waitingOf("A") }));
    assert.equal(a.length, 1);
    const o = t.alertsFor(mk({ job: "other", waiting: waitingOf("A") }));
    assert.equal(o.length, 1);
    assert.equal(o[0].data?.waitingStreak, FEE_JOB_WAITING_ALERT_AFTER);
  });
  it("failure streak resets when the market recovers but not for other jobs", () => {
    const t = new FeeJobFailureTracker();
    for (let i = 0; i < FEE_JOB_FAILURE_ALERT_AFTER - 1; i++) {
      t.alertsFor(mk({ job: "other", failed: failedOf("A") }));
      t.alertsFor(mk({ failed: failedOf("A") }));
    }
    t.alertsFor(mk()); // j recovers
    assert.equal(t.alertsFor(mk({ failed: failedOf("A") })).length, 0);
    const o = t.alertsFor(mk({ job: "other", failed: failedOf("A") }));
    assert.equal(o.length, 1);
    assert.match(o[0].message, /failed 3x/);
  });
  it("blocked severity: explicit, critical kinds, and default warn", () => {
    const t = new FeeJobFailureTracker();
    const b = (alertKind?: never | string, severity?: string) =>
      ({ market: "M", label: "M/USDC", reason: "r", alertKind, severity }) as never;
    const al = t.alertsFor(mk({
      blocked: [
        b(),
        b("terminal-budget-unbooked"),
        b("terminal-recovery-blocked-portfolios"),
        b("terminal-budget-unbooked", "info"),
      ],
    }));
    assert.deepEqual(al.map((a) => a.severity), ["warn", "critical", "critical", "info"]);
    assert.equal(al[0].kind, "fee-leg-blocked");
    assert.equal(al[1].kind, "terminal-budget-unbooked");
  });
});
