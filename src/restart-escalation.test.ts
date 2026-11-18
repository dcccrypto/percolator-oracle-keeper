import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alertText, readHealth, recordAlertFailure, recordLaunch, restartConfig, restartHealth } from "./restart-escalation.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-")), "r.json");
const MIN = 60_000;

test("N launches within the window escalate; the alert is due once per window", () => {
  const p = tmp();
  let t = 1_000_000;
  const res = [];
  for (let i = 0; i < 6; i++) res.push(recordLaunch(p, (t += 60_000), 5, 15 * MIN));
  assert.deepEqual(res.map((r) => r.health.escalated), [false, false, false, false, true, true]);
  assert.deepEqual(res.map((r) => r.alertDue), [false, false, false, false, true, false]);
  assert.match(alertText(res[5].health, "keeper"), /restarted 6x in 15min/);
});

test("old launches fall out of the window (a slow restart cadence never escalates)", () => {
  const p = tmp();
  let t = 0;
  for (let i = 0; i < 20; i++) assert.equal(recordLaunch(p, (t += 5 * MIN), 5, 15 * MIN).health.escalated, false);
});

test("readHealth does not mutate; restartHealth is null without a path; config from env", () => {
  const p = tmp();
  recordLaunch(p, 1000, 2, 15 * MIN);
  const before = fs.readFileSync(p, "utf8");
  assert.equal(readHealth(p, 2000, 2, 15 * MIN).launchesInWindow, 1);
  assert.equal(fs.readFileSync(p, "utf8"), before);
  assert.equal(restartHealth({}), null);
  assert.deepEqual(restartConfig({ KEEPER_HEALTH_FILE: "/x/h.json", KEEPER_RESTART_ALERT_N: "3" }), { path: "/x/h.json.restarts.json", threshold: 3, windowMs: 15 * MIN });
});

test("a corrupt file or unwritable path never throws", () => {
  const p = tmp();
  fs.writeFileSync(p, "{not json");
  assert.equal(recordLaunch(p, 1, 5, MIN).health.launchesInWindow, 1);
  assert.doesNotThrow(() => recordLaunch("/nonexistent-dir/x.json", 1, 5, MIN));
});

test("a failed webhook delivery does not burn the alert window; retries are capped", async () => {
  const { MAX_ALERT_RETRIES, recordAlertFailure } = await import("./restart-escalation.ts");
  const p = tmp();
  let t = 0;
  for (let i = 0; i < 4; i++) recordLaunch(p, (t += MIN), 5, 15 * MIN);
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, true);
  assert.equal(recordAlertFailure(p), true); // delivery failed -> stamp rolled back
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, true); // retried on next launch
  for (let i = 0; i < MAX_ALERT_RETRIES - 1; i++) recordAlertFailure(p);
  // cap reached: stamp stays, a dead endpoint is not retried again this window
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, false);
});

test("future-stamped launches (clock stepped back / copied log) do not escalate or give negative ago", () => {
  const p = tmp();
  const now = 10_000_000;
  fs.writeFileSync(p, JSON.stringify({ launches: Array.from({ length: 6 }, (_, i) => now + 3_600_000 + i) }));
  const h = readHealth(p, now, 5, 15 * MIN);
  assert.equal(h.escalated, false);
  assert.equal(h.launchesInWindow, 0);
  assert.equal(h.lastLaunchAgoSec, null);
  const r = recordLaunch(p, now, 5, 15 * MIN);
  assert.equal(r.health.launchesInWindow, 1);
  assert.equal(r.alertDue, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")).launches, [now]);
});

test("readHealth survives a huge un-pruned launches array (no RangeError from Math.max spread)", () => {
  const p = tmp();
  const now = 10_000_000;
  fs.writeFileSync(p, JSON.stringify({ launches: new Array(300_000).fill(now - 1000) }));
  const h = readHealth(p, now, 5, 15 * MIN);
  assert.equal(h.launchesInWindow, 300_000);
  assert.equal(h.lastLaunchAgoSec, 1);
});

test("recordLaunch prunes expired launches from the file", () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ launches: [1, 2, 3] }));
  recordLaunch(p, 100 * MIN, 5, 15 * MIN);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")).launches, [100 * MIN]);
});

test("recordAlertFailure on a missing or corrupt log does not throw and keeps retry semantics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  assert.equal(recordAlertFailure(path.join(dir, "missing.json"), 5), true);
  assert.equal(recordAlertFailure(path.join(dir, "nodir", "x.json"), 5), true);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.equal(recordAlertFailure(bad, 5), true);
  assert.equal(JSON.parse(fs.readFileSync(bad, "utf8")).alertFails, 1);
});
