/**
 * Coverage gaps in crank-liveness.ts: the default onStall (log + scheduled exit), start()/stop,
 * the disabled start(), and the intervalMs validation.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createCrankLiveness } from "./crank-liveness.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("crank liveness gaps", () => {
  it("default onStall logs an ALERT and schedules process.exit(1) once", () => {
    const c = clock();
    const errs: string[] = [];
    const exits: unknown[] = [];
    const errMock = mock.method(console, "error", (...a: unknown[]) => void errs.push(String(a[0])));
    const exitMock = mock.method(process, "exit", ((code?: number) => void exits.push(code)) as never);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const l = createCrankLiveness({ intervalMs: 1000, intervals: 2, minSilenceMs: 1, now: c.now });
      c.advance(5000);
      assert.equal(l.check(), true);
      assert.equal(l.check(), false, "fires once");
      assert.equal(errs.length, 1);
      assert.match(errs[0]!, /CRANK LOOP SILENT for 5s \(limit 2s = 2 intervals\)/);
      assert.deepEqual(exits, [], "exit is deferred 250 ms so the line flushes");
      mock.timers.tick(250);
      assert.deepEqual(exits, [1]);
    } finally {
      mock.timers.reset();
      errMock.mock.restore();
      exitMock.mock.restore();
    }
  });

  it("start() runs periodic checks and the returned stop function halts them", () => {
    const c = clock();
    const stalls: number[] = [];
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const l = createCrankLiveness({ intervalMs: 1000, intervals: 2, minSilenceMs: 4000, now: c.now, onStall: (s) => stalls.push(s) });
      const stop = l.start();
      mock.timers.tick(1000);
      assert.deepEqual(stalls, []);
      c.advance(10_000);
      mock.timers.tick(1000);
      assert.equal(stalls.length, 1, "watchdog timer detected the stall");
      stop();
      assert.equal(typeof stop, "function");
    } finally {
      mock.timers.reset();
    }
  });

  it("stop() before the next tick prevents the check", () => {
    const c = clock();
    const stalls: number[] = [];
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const l = createCrankLiveness({ intervalMs: 1000, intervals: 2, minSilenceMs: 1, now: c.now, onStall: (s) => stalls.push(s) });
      const stop = l.start();
      stop();
      c.advance(60_000);
      mock.timers.tick(20_000);
      assert.deepEqual(stalls, []);
    } finally {
      mock.timers.reset();
    }
  });

  it("disabled watchdog: start() returns a no-op stop, limitMs is null", () => {
    const l = createCrankLiveness({ intervalMs: 1000, intervals: 0 });
    assert.equal(l.limitMs(), null);
    const stop = l.start();
    assert.equal(stop(), undefined);
  });

  it("rejects NaN, zero, negative and infinite intervalMs", () => {
    for (const bad of [NaN, 0, -5, Infinity]) {
      assert.throws(() => createCrankLiveness({ intervalMs: bad }), /intervalMs must be a finite positive number/);
    }
  });
});
