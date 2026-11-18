import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHealth, recordLaunch } from "./restart-escalation.ts";
import { shouldRecordLaunch } from "./restart-launch-gate.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rg-")), "r.json");

/** Mirrors the boot block in cross-cluster.ts: read health at `now`, record only if the gate says so. */
function boot(p: string, now: number, threshold: number, windowMs: number): { recorded: boolean; alertDue: boolean } {
  const h = readHealth(p, now, threshold, windowMs);
  if (!shouldRecordLaunch(h.lastLaunchAgoSec)) return { recorded: false, alertDue: false };
  return { recorded: true, alertDue: recordLaunch(p, now, threshold, windowMs).alertDue };
}

test("clock stepped back 1 h: keeper-only crash loop is still recorded and pages", () => {
  const p = tmp();
  const T = 100 * HOUR;
  const win = 15 * MIN;
  assert.equal(boot(p, T, 3, win).recorded, true);
  const back = T - HOUR; // stored launch is now "in the future"
  const res = [0, 1, 2, 3, 4].map((i) => boot(p, back + i * 3 * MIN, 3, win));
  assert.ok(res.some((r) => r.recorded), "launches after a backwards step must be recorded");
  assert.ok(res.some((r) => r.alertDue), "a crash loop after a backwards step must alert");
});

test("lastLaunchAgoSec is never negative after a backwards step", () => {
  const p = tmp();
  recordLaunch(p, 100 * HOUR, 5, 15 * MIN);
  const h = readHealth(p, 99 * HOUR, 5, 15 * MIN);
  assert.equal(h.launchesInWindow, 1); // still counted toward escalation
  assert.equal(h.lastLaunchAgoSec, null);
});

test("clock stepped back: preflight + keeper launches 5 min apart are each counted once (no false alert)", () => {
  const p = tmp();
  const win = 15 * MIN;
  recordLaunch(p, 100 * HOUR, 5, win); // before the step
  let t = 99 * HOUR; // clock stepped back 1 h
  const alerts: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    t += 5 * MIN;
    alerts.push(recordLaunch(p, t, 5, win).alertDue); // preflight records unconditionally
    t += 1000;
    const b = boot(p, t, 5, win); // keeper boot 1 s later must see the preflight's launch and skip
    assert.equal(b.recorded, false);
  }
  // 1 stale future stamp + 3 real launches (none double counted): 4 < threshold 5
  assert.equal(readHealth(p, t, 5, win).launchesInWindow, 4);
  assert.ok(!alerts.some(Boolean));
});
