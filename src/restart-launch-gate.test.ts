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

test("gate: null, >120 s and negative ages record; 0..120 s (preflight already counted) does not", () => {
  assert.equal(shouldRecordLaunch(null), true);
  assert.equal(shouldRecordLaunch(121), true);
  assert.equal(shouldRecordLaunch(120), false);
  assert.equal(shouldRecordLaunch(0), false);
  assert.equal(shouldRecordLaunch(-1), true);
  assert.equal(shouldRecordLaunch(-3600), true);
});

test("clock stepped back 1 h: a crash loop is still recorded and pages", () => {
  const p = tmp();
  const T = 100 * HOUR;
  const win = 15 * MIN;
  assert.equal(boot(p, T, 3, win).recorded, true); // launch recorded at T
  const back = T - HOUR; // wall clock steps back 1 h; stored launch is now "in the future"
  const res = [0, 1, 2, 3, 4].map((i) => boot(p, back + i * 10_000, 3, win));
  assert.ok(res.some((r) => r.recorded), "launches after a backwards step must be recorded");
  assert.ok(res.some((r) => r.alertDue), "a crash loop after a backwards step must alert");
});
