import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationLedger } from "./lifecycle-ledger.ts";
import { v22FlagsFromEnv } from "./flags.ts";

const GAP = 1000;
function warm(l: ObservationLedger, t: number): void {
  l.noteTick(true, t);
  l.noteSourceCycle(true, t);
}

test("continuous window: boot, failure and gap each restart it", () => {
  const l = new ObservationLedger(GAP);
  assert.equal(l.continuousMs(0), 0);
  warm(l, 100);
  warm(l, 600);
  assert.equal(l.continuousMs(700), 600);
  l.noteTick(false, 800);
  assert.equal(l.continuousMs(850), 0);
  l.noteTick(true, 900);
  l.noteSourceCycle(true, 900);
  // gap > maxGap restarts the run
  warm(l, 5000);
  assert.equal(l.continuousSince(5000), 5000);
  // quiet loop is not observing now
  assert.equal(l.continuousMs(5000 + GAP + 1), 0);
});

test("sourceUnavailableMs counts only inside the window and resets on usable", () => {
  const l = new ObservationLedger(GAP);
  warm(l, 0);
  assert.equal(l.sourceUnavailableMs("m", 500), 500);
  l.recordSource("m", true, 400);
  assert.equal(l.sourceUnavailableMs("m", 500), 100);
  l.recordSource("m", false, 450);
  assert.equal(l.sourceUnavailableMs("m", 500), 100);
  assert.equal(l.sourceAgeMs("x", 1), Number.POSITIVE_INFINITY);
  assert.equal(l.lastUsableSourceAt("m"), 400);
  assert.equal(l.pushLandedSinceBoot("m"), false);
  l.recordPushLanded("m", 10);
  assert.equal(l.pushLandedSinceBoot("m"), true);
  assert.equal(l.snapshot(500).pushesLandedSinceBoot, 1);
});

// Lead 1: NaN/0/negative maxGapMs is accepted by the class but cannot reach it from config (flags.posInt rejects it).
test("lead 1: config parser rejects non-finite / zero / negative maxGapMs", () => {
  for (const bad of ["NaN", "0", "-5", "1.5", "abc"]) {
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIFECYCLE_MAX_GAP_MS: bad }), /KEEPER_V22_LIFECYCLE_MAX_GAP_MS/, bad);
  }
  assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on" }).lifecycle.maxGapMs, 120_000);
});

// Lead 2: a backwards clock step is fail-safe: the window only shrinks, and unavailable time never goes negative.
test("lead 2: backwards clock step never inflates observation time", () => {
  const l = new ObservationLedger(GAP);
  warm(l, 10_000);
  warm(l, 10_500);
  warm(l, 9_000); // clock stepped back 1.5 s
  assert.ok(l.continuousMs(9_100) <= 600);
  assert.ok(l.sourceUnavailableMs("m", 9_100) <= 1100);
  assert.ok(l.sourceUnavailableMs("m", 8_000) >= 0);
  assert.equal(l.continuousMs(8_000), 0);
});

// Lead 3: prune drops entries; a pruned market restarts from the window start (only matters if a caller is added).
test("lead 3: prune keeps only requested markets", () => {
  const l = new ObservationLedger(GAP);
  warm(l, 0);
  l.recordSource("a", true, 100);
  l.recordSource("b", true, 100);
  l.recordPushLanded("a", 100);
  l.recordPushLanded("b", 100);
  l.prune(new Set(["a"]));
  assert.equal(l.lastUsableSourceAt("a"), 100);
  assert.equal(l.lastUsableSourceAt("b"), null);
  assert.equal(l.pushLandedSinceBoot("b"), false);
  assert.equal(l.sourceUnavailableMs("b", 500), 500); // window start, not 400
});
