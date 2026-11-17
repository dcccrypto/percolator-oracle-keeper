import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alertText, readHealth, recordLaunch, restartConfig, restartHealth } from "./restart-escalation.ts";

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
  for (let i = 0; i < MAX_ALERT_RETRIES - 1; i++) recordAlertFailure(p, t);
  // cap reached: stamp stays, a dead endpoint is not retried again this window
  assert.equal(recordLaunch(p, (t += MIN), 5, 15 * MIN).alertDue, false);
});

test("lead1: a launch stamped in the future (clock stepped back) does not keep the keeper escalated", () => {
  const p = tmp();
  const FAR = 10_000 * MIN;
  fs.writeFileSync(p, JSON.stringify({ launches: [FAR, FAR, FAR, FAR] }));
  // now is long before the stamps; a lone launch must not read as a 5-launch storm
  const r = recordLaunch(p, 1_000, 5, 15 * MIN);
  assert.equal(r.health.launchesInWindow, 1);
  assert.equal(r.health.escalated, false);
  fs.writeFileSync(p, JSON.stringify({ launches: [FAR, FAR, FAR, FAR, FAR] }));
  assert.equal(readHealth(p, 1_000, 5, 15 * MIN).escalated, false);
});

test("lead2: a future lastAlertAt does not suppress later alerts", () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ launches: [1, 2, 3, 4], lastAlertAt: 10_000 * MIN }));
  assert.equal(recordLaunch(p, 5, 5, 15 * MIN).alertDue, true);
});

test("lead3: env num() accepts hex/exponent/fractional values via Number() (same as every other parser on this base; documented, not changed)", () => {
  const c = (n: string) => restartConfig({ KEEPER_RESTART_ALERT_N: n }).threshold;
  assert.equal(c("0x10"), 16);
  assert.equal(c("1e1"), 10);
  assert.equal(c("2.5"), 2.5);
  assert.equal(c("0"), 5);
  assert.equal(c("abc"), 5);
});

test("lead4: a corrupt file is dropped and rewritten as a valid record (no throw)", () => {
  const p = tmp();
  fs.writeFileSync(p, "{not json");
  recordLaunch(p, 1, 5, MIN);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")).launches, [1]);
});
