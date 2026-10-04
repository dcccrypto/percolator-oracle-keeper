/**
 * Page on a loss-stale that lasts: Percolator spent 3 h 32 m loss-stale on 10-02 and 329 sample-minutes after the
 * f661072 fix (audit 2026-10-04, locks-halts §4b), while the app told users "this clears within seconds". The
 * cycle-count alert is cadence-dependent; this one is wall-clock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, evaluateCrankHealth, freshStreaks, thresholdsFromEnv } from "./alerting.ts";
import type { CrankHealthSample, CrankHealthStreaks } from "./alerting.ts";

const T = DEFAULT_THRESHOLDS;
const MIN = 60_000;
const sample = (p: Partial<CrankHealthSample> = {}): CrankHealthSample => ({
  label: "Percolator",
  market: "9EPm8nB8",
  chainSlot: 1_000_000n,
  engineSlot: 999_960n,
  crankOk: true,
  crankReverted: false,
  totalOk: 10,
  totalReverts: 0,
  consecutiveReverts: 0,
  lastRevertCode: null,
  lapsedBuckets: 0,
  bankruptFound: 0,
  bankruptLiquidated: 0,
  staleLong: 3,
  staleShort: 0,
  positioned: 13,
  overflow: 0,
  lossStaleCycles: 1,
  ...p,
});

/** Run one cycle per `stepMs` for `cycles` cycles, all ending loss-stale; returns the last evaluation. */
function run(cycles: number, stepMs: number, start = 0) {
  let streaks: CrankHealthStreaks = freshStreaks();
  let last = { active: [] as ReturnType<typeof evaluateCrankHealth>["active"], streaks };
  for (let i = 0; i < cycles; i++) {
    last = evaluateCrankHealth(sample({ lossStaleCycles: i + 1 }), streaks, T, start + i * stepMs);
    streaks = last.streaks;
  }
  return last;
}

describe("loss-stale-prolonged", () => {
  it("default threshold is 5 minutes", () => {
    assert.equal(T.lossStaleProlongedMs, 5 * MIN);
  });

  it("stays quiet through 5 minutes of continuous loss-stale", () => {
    const r = run(16, 20_000); // 0..300 s inclusive: exactly 5 min, not MORE than 5 min
    assert.equal(r.active.some((a) => a.kind === "loss-stale-prolonged"), false);
  });

  it("fires critical once it is longer than 5 minutes, with the facts an operator needs", () => {
    const r = run(17, 20_000); // 320 s
    const a = r.active.find((x) => x.kind === "loss-stale-prolonged");
    assert.ok(a, "alert active");
    assert.equal(a.severity, "critical");
    assert.equal(a.subject, "Percolator");
    assert.match(a.message, /LOSS-STALE for > 5 min/);
    assert.match(a.message, /NOT clearing on its own/);
    assert.equal(a.data?.lossStaleMinutes, 5);
    assert.equal(a.data?.positioned, 13);
  });

  it("a clean cycle ends the episode and the clock restarts", () => {
    let streaks = run(20, 20_000).streaks; // 380 s loss-stale
    const clean = evaluateCrankHealth(sample({ lossStaleCycles: 0, staleLong: 0 }), streaks, T, 400_000);
    assert.equal(clean.active.some((a) => a.kind === "loss-stale-prolonged"), false);
    assert.equal(clean.streaks.lossStaleSince, null);
    streaks = clean.streaks;
    const again = evaluateCrankHealth(sample({ lossStaleCycles: 1 }), streaks, T, 420_000);
    assert.equal(again.active.some((a) => a.kind === "loss-stale-prolonged"), false, "a new episode starts from zero");
    assert.equal(again.streaks.lossStaleSince, 420_000);
  });

  it("is independent of the cycle-count alert: fires on a slow cadence before many cycles pass", () => {
    const r = run(4, 2 * MIN); // 4 cycles, 6 min
    assert.ok(r.active.some((a) => a.kind === "loss-stale-prolonged"));
  });

  it("env override, and garbage throws", () => {
    assert.equal(thresholdsFromEnv({ ALERT_LOSS_STALE_PROLONGED_MS: "60000" }).lossStaleProlongedMs, 60_000);
    assert.throws(() => thresholdsFromEnv({ ALERT_LOSS_STALE_PROLONGED_MS: "five" }), /ALERT_LOSS_STALE_PROLONGED_MS/);
  });
});
