import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePusherCadence } from "./pusher-cadence.ts";

class Exit extends Error {}
const run = (interval: string | undefined, window: string | undefined, dry = false) => {
  const saved = { i: process.env.CC_INTERVAL_MS, w: process.env.CC_MARK_WINDOW_MS };
  if (interval === undefined) delete process.env.CC_INTERVAL_MS; else process.env.CC_INTERVAL_MS = interval;
  if (window === undefined) delete process.env.CC_MARK_WINDOW_MS; else process.env.CC_MARK_WINDOW_MS = window;
  const errs: string[] = [];
  const die = (m: string): never => { errs.push(m); throw new Exit(m); };
  try {
    return { ok: resolvePusherCadence(dry, die, (() => { throw new Exit("exit"); }) as never, (l) => errs.push(l)), errs };
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    return { ok: null, errs };
  } finally {
    if (saved.i === undefined) delete process.env.CC_INTERVAL_MS; else process.env.CC_INTERVAL_MS = saved.i;
    if (saved.w === undefined) delete process.env.CC_MARK_WINDOW_MS; else process.env.CC_MARK_WINDOW_MS = saved.w;
  }
};

afterEach(() => { delete process.env.CC_INTERVAL_MS; delete process.env.CC_MARK_WINDOW_MS; });

describe("resolvePusherCadence", () => {
  it("defaults when unset", () => assert.deepEqual(run(undefined, undefined).ok, { intervalMs: 3000, windowMs: 15000 }));
  it("empty interval falls back to default (was NaN)", () => assert.deepEqual(run("", "").ok, { intervalMs: 3000, windowMs: 15000 }));
  it("3e3 is 3000, not 3", () => assert.equal(run("3e3", undefined).ok?.intervalMs, 3000));
  it("3 ms interval is rejected (was 'ok')", () => assert.equal(run("3", undefined).ok, null));
  it("1500ms suffix is rejected", () => assert.equal(run("1500ms", undefined).ok, null));
  it("garbage interval rejected even in dry run (was NaN timer)", () => assert.equal(run("abc", undefined, true).ok, null));
  it("0x10 window is tiny and rejected as never-publish", () => assert.equal(run(undefined, "0x10").ok, null));
  it("zero / negative rejected", () => {
    assert.equal(run("0", undefined).ok, null);
    assert.equal(run("-5", undefined).ok, null);
  });
  it("never-publish cadence fatals live, passes dry-run", () => {
    assert.equal(run("6000", undefined).ok, null);
    assert.deepEqual(run("6000", undefined, true).ok, { intervalMs: 6000, windowMs: 15000 });
  });
});
