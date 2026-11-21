import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ALERT_RETRIES, alertText, readHealth, recordAlertFailure, recordLaunch, restartConfig, restartHealth } from "./restart-escalation.ts";

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
  const p = tmp();
  let t = 0;
  for (let i = 0; i < 4; i++) recordLaunch(p, (t += MIN), 5, 15 * MIN);
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, true);
  assert.equal(recordAlertFailure(p, t), true); // delivery failed -> stamp rolled back
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, true); // retried on next launch
  for (let i = 0; i < MAX_ALERT_RETRIES - 1; i++) recordAlertFailure(p, t);
  // cap reached: stamp stays, a dead endpoint is not retried again this window
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, false);
});

const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

test("window boundary: a launch exactly windowMs old is out, windowMs-1 is still in", () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ launches: [0, 1] }));
  const r = recordLaunch(p, 15 * MIN, 3, 15 * MIN); // t=0 is exactly 15min old -> dropped; t=1 kept
  assert.equal(r.health.launchesInWindow, 2);
  assert.equal(r.health.escalated, false);
  assert.equal(readHealth(p, 15 * MIN, 1, 15 * MIN).launchesInWindow, 2);
});

test("threshold boundary: threshold-1 launches do not escalate, threshold does", () => {
  const p = tmp();
  assert.equal(recordLaunch(p, 1, 2, MIN).health.escalated, false);
  const r = recordLaunch(p, 2, 2, MIN);
  assert.equal(r.health.escalated, true);
  assert.equal(r.alertDue, true);
});

test("alert window boundary: re-alert is due exactly windowMs after the last alert, not before", () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ launches: [100, 200], lastAlertAt: 1000 }));
  assert.equal(recordLaunch(p, 1000 + 15 * MIN - 1, 2, 15 * MIN).alertDue, false);
  assert.equal(recordLaunch(p, 1000 + 15 * MIN, 2, 15 * MIN).alertDue, true);
});

test("a new alert window resets the failed-delivery budget (rec.alertFails -> 0)", () => {
  const p = tmp();
  const now = 20 * MIN;
  fs.writeFileSync(p, JSON.stringify({ launches: [now - 2, now - 1], lastAlertAt: 0, alertFails: MAX_ALERT_RETRIES - 1 }));
  assert.equal(recordLaunch(p, now, 3, 15 * MIN).alertDue, true);
  assert.equal(read(p).alertFails, 0);
  assert.equal(recordAlertFailure(p, now), true); // fresh budget: retry allowed again
});

test("first-ever alert keeps an existing retry count (no lastAlertAt to expire)", () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ launches: [1], alertFails: 2 }));
  assert.equal(recordLaunch(p, 2, 2, MIN).alertDue, true);
  assert.equal(read(p).alertFails, 2);
});

test("counter file missing: first launch starts a fresh record and creates the file", () => {
  const p = tmp();
  assert.equal(fs.existsSync(p), false);
  const r = recordLaunch(p, 5000, 5, MIN);
  assert.equal(r.health.launchesInWindow, 1);
  assert.equal(r.health.lastLaunchAgoSec, 0);
  assert.deepEqual(read(p).launches, [5000]);
  const q = tmp();
  const h = readHealth(q, 5000, 5, MIN);
  assert.equal(h.launchesInWindow, 0);
  assert.equal(h.lastLaunchAgoSec, null);
  assert.equal(h.escalated, false);
});

test("corrupt state shapes: launches not an array, non-finite entries, JSON null, array root", () => {
  for (const body of ['{"launches":"x"}', '{"launches":[null,"a",5]}', "null", "[]", ""]) {
    const p = tmp();
    fs.writeFileSync(p, body);
    const r = recordLaunch(p, 10, 5, MIN);
    assert.equal(r.health.launchesInWindow, body === '{"launches":[null,"a",5]}' ? 2 : 1, body);
  }
  const p = tmp();
  fs.writeFileSync(p, '{"launches":[],"alertFails":"bad"}');
  assert.equal(recordAlertFailure(p, 1), true);
  assert.equal(read(p).alertFails, 1);
});

test("corrupt file does not hide a loop: later launches still escalate and alert", () => {
  const p = tmp();
  fs.writeFileSync(p, "\u0000garbage");
  const res = [1, 2, 3].map((t) => recordLaunch(p, t, 3, MIN));
  assert.equal(res[2].health.escalated, true);
  assert.equal(res[2].alertDue, true);
});

test("recordAlertFailure: unwritable path does not throw; missing file starts at 1", () => {
  assert.equal(recordAlertFailure("/nonexistent-dir/x.json", 1), true);
  const p = tmp();
  assert.equal(recordAlertFailure(p), true);
  assert.equal(read(p).alertFails, 1);
});

test("restartConfig: explicit path wins, invalid/zero/negative numbers fall back to defaults", () => {
  assert.deepEqual(restartConfig({ KEEPER_RESTART_LOG: " /a.json ", KEEPER_HEALTH_FILE: "/h" }), { path: "/a.json", threshold: 5, windowMs: 15 * MIN });
  assert.deepEqual(restartConfig({ KEEPER_RESTART_ALERT_N: "abc", KEEPER_RESTART_ALERT_WINDOW_MIN: "0" }), { path: null, threshold: 5, windowMs: 15 * MIN });
  assert.equal(restartConfig({ KEEPER_RESTART_ALERT_N: "-2" }).threshold, 5);
  assert.deepEqual(restartConfig({ KEEPER_RESTART_ALERT_N: "2", KEEPER_RESTART_ALERT_WINDOW_MIN: "1" }), { path: null, threshold: 2, windowMs: MIN });
  assert.equal(restartConfig({ KEEPER_HEALTH_FILE: "  " }).path, null);
});

test("restartHealth reads the configured file", () => {
  const p = tmp();
  recordLaunch(p, 1000, 1, MIN);
  assert.equal(restartHealth({ KEEPER_RESTART_LOG: p, KEEPER_RESTART_ALERT_N: "1" }, 2000)?.escalated, true);
});

test("clock step back: launches stamped in the 'future' still count, so a loop is not hidden", () => {
  const p = tmp();
  recordLaunch(p, 1_000_000, 3, 15 * MIN);
  recordLaunch(p, 1_000_001, 3, 15 * MIN);
  const r = recordLaunch(p, 500_000, 3, 15 * MIN); // wall clock stepped back ~8min
  assert.equal(r.health.escalated, true);
  assert.equal(r.alertDue, true);
});

test("clock step back after an alert must not mute the next window's alert", () => {
  const p = tmp();
  const T = 10 * 60 * MIN;
  for (const t of [T, T + 1, T + 2]) recordLaunch(p, t, 3, 15 * MIN); // alerts at T+2
  // clock jumps back one hour; the loop continues
  const back = T - 60 * MIN;
  const seen: boolean[] = [];
  for (let i = 0; i < 3; i++) seen.push(recordLaunch(p, back + i, 3, 15 * MIN).alertDue);
  assert.ok(seen.includes(true), "a crash loop after a backwards clock step must still page");
});

test("non-numeric lastAlertAt in a corrupt file must not suppress alerts forever", () => {
  for (const bad of ['"yesterday"', "null", '{"a":1}']) {
    const p = tmp();
    fs.writeFileSync(p, `{"launches":[1,2],"lastAlertAt":${bad}}`);
    assert.equal(recordLaunch(p, 3, 3, MIN).alertDue, true, bad);
  }
});
