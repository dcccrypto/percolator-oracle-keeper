/**
 * Unit coverage for crank-liveness.ts: constructor validation (GH#165), default clock, the default onStall,
 * start()/stop timer, env parsing edges, and boundary clocks (t=0, exactly at limit, clock going backwards).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createCrankLiveness,
  crankLivenessOptsFromEnv,
  DEFAULT_LIVENESS_INTERVALS,
  DEFAULT_LIVENESS_MIN_SILENCE_MS,
} from "./crank-liveness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("crank-liveness units", () => {
  it("rejects a NaN / zero / negative / infinite intervalMs instead of silently disabling the watchdog", () => {
    for (const bad of [NaN, 0, -5, Infinity, -Infinity]) {
      assert.throws(() => createCrankLiveness({ intervalMs: bad }), /intervalMs must be a finite positive number/);
    }
  });

  it("defaults: 2 intervals, 120 s floor, real clock", () => {
    assert.equal(DEFAULT_LIVENESS_INTERVALS, 2);
    assert.equal(DEFAULT_LIVENESS_MIN_SILENCE_MS, 120_000);
    const lv = createCrankLiveness({ intervalMs: 10_000 });
    assert.equal(lv.limitMs(), 120_000); // max(2*10s, 120s)
    const s = lv.silentMs();
    assert.ok(s >= 0 && s < 1_000, `fresh watchdog silence is ~0 on the real clock (got ${s})`);
    lv.beat();
    assert.equal(lv.check(), false);
    assert.equal(createCrankLiveness({ intervalMs: 100_000 }).limitMs(), 200_000); // intervals dominate the floor
  });

  it("boundary: clock at 0, exactly at limit is fine, limit+1 stalls", () => {
    let t = 0;
    const calls: Array<[number, number]> = [];
    const lv = createCrankLiveness({ intervalMs: 10, intervals: 2, minSilenceMs: 5, now: () => t, onStall: (s, l) => calls.push([s, l]) });
    assert.equal(lv.limitMs(), 20);
    t = 20;
    assert.equal(lv.check(), false, "silence == limit is not a stall");
    t = 21;
    assert.equal(lv.check(), true);
    assert.deepEqual(calls, [[21, 20]]);
    t = 1_000;
    assert.equal(lv.check(), false, "fires once");
    assert.equal(calls.length, 1);
  });

  it("LIVENESS: a clock stepped backwards must not make a hung loop look never-overdue", () => {
    let t = 1_000_000;
    let fired = 0;
    const lv = createCrankLiveness({ intervalMs: 10, intervals: 2, minSilenceMs: 5, now: () => t, onStall: () => fired++ });
    lv.beat(); // last = 1_000_000
    t = 0; // NTP step back 1000 s; the loop is now hung
    assert.equal(lv.check(), false); // silence is unknowable at this instant
    assert.ok(lv.silentMs() >= 0, "silence is never negative");
    t = 21; // 21 ms after the step, > limit(20)
    assert.equal(lv.check(), true, "stall detected one limit after the step, not 1000 s later");
    assert.equal(fired, 1);
  });

  it("disabled watchdog: limit null, check never fires, start is a no-op stop", () => {
    let t = 0;
    let fired = 0;
    const lv = createCrankLiveness({ intervalMs: 10, intervals: 0, now: () => t, onStall: () => fired++ });
    assert.equal(lv.limitMs(), null);
    t = 1e12;
    assert.equal(lv.check(), false);
    const stop = lv.start();
    assert.equal(stop(), undefined);
    assert.equal(fired, 0);
  });

  it("start(): the timer calls check() and the stop function cancels it", async () => {
    let t = 0;
    let fired = 0;
    const lv = createCrankLiveness({ intervalMs: 1, intervals: 1, minSilenceMs: 1, now: () => t, onStall: () => fired++ });
    const stop = lv.start();
    t = 1_000; // far past the 1 ms limit
    await sleep(1_200); // the poll period is clamped to >= 1 s
    assert.equal(fired, 1);
    stop();
    const lv2 = createCrankLiveness({ intervalMs: 1, intervals: 1, minSilenceMs: 1, now: () => t, onStall: () => fired++ });
    const stop2 = lv2.start();
    stop2();
    t = 5_000;
    await sleep(1_200);
    assert.equal(fired, 1, "a stopped watchdog never fires");
  });

  it("start() poll period is capped at 10 s for a large limit (no timer fires early)", () => {
    const lv = createCrankLiveness({ intervalMs: 600_000, now: () => 0, onStall: () => assert.fail("must not fire") });
    const stop = lv.start();
    stop();
  });

  it("default onStall logs an alert and exits 1 (process.exit stubbed)", async () => {
    const exit = mock.method(process, "exit", (() => undefined) as never);
    const err = mock.method(console, "error", () => undefined);
    try {
      let t = 0;
      const lv = createCrankLiveness({ intervalMs: 10, intervals: 2, minSilenceMs: 1, now: () => t });
      t = 21;
      assert.equal(lv.check(), true);
      assert.equal(err.mock.callCount(), 1);
      assert.match(String(err.mock.calls[0].arguments[0]), /CRANK LOOP SILENT .*limit 0s .*2 intervals/);
      await sleep(400);
      assert.equal(exit.mock.callCount(), 1);
      assert.deepEqual(exit.mock.calls[0].arguments, [1]);
    } finally {
      exit.mock.restore();
      err.mock.restore();
    }
  });

  it("env: whitespace is the default; fractional / negative / zero-floor throw; intervals=0 allowed", () => {
    assert.deepEqual(crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "  ", CRANK_LIVENESS_MIN_SILENCE_MS: "" }, 5_000), {
      intervalMs: 5_000,
      intervals: 2,
      minSilenceMs: 120_000,
    });
    assert.equal(crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "0" }, 1).intervals, 0);
    assert.equal(crankLivenessOptsFromEnv({ CRANK_LIVENESS_MIN_SILENCE_MS: "7" }, 1).minSilenceMs, 7);
    assert.throws(() => crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "1.5" }, 1), /non-negative integer/);
    assert.throws(() => crankLivenessOptsFromEnv({ CRANK_LIVENESS_INTERVALS: "-1" }, 1), /non-negative integer/);
    assert.throws(() => crankLivenessOptsFromEnv({ CRANK_LIVENESS_MIN_SILENCE_MS: "0" }, 1), /positive integer/);
    assert.throws(() => crankLivenessOptsFromEnv({ CRANK_LIVENESS_MIN_SILENCE_MS: "abc" }, 1), /positive integer/);
  });
});
