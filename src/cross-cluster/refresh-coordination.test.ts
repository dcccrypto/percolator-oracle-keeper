import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  holdPushes,
  isPushHeld,
  pruneCrankRefreshHealth,
  releasePushes,
  resetRefreshCoordination,
  MAX_PUSH_HOLD_MS,
} from "./refresh-coordination.ts";

beforeEach(() => resetRefreshCoordination());

test("finite hold expires at its deadline", () => {
  holdPushes("m", 5_000, 1_000);
  assert.equal(isPushHeld("m", 5_999), true);
  assert.equal(isPushHeld("m", 6_000), false);
});

test("hold is capped at MAX_PUSH_HOLD_MS", () => {
  holdPushes("m", 10 * 60_000, 0);
  assert.equal(isPushHeld("m", MAX_PUSH_HOLD_MS), false);
});

test("NaN ms does not hold pushes forever", () => {
  holdPushes("m", NaN, 1_000);
  assert.equal(isPushHeld("m", 1_000 + MAX_PUSH_HOLD_MS), false);
});

test("undefined ms does not hold pushes forever", () => {
  holdPushes("m", undefined as unknown as number, 1_000);
  assert.equal(isPushHeld("m", 1_000 + MAX_PUSH_HOLD_MS), false);
});

test("Infinity ms is capped", () => {
  holdPushes("m", Infinity, 0);
  assert.equal(isPushHeld("m", MAX_PUSH_HOLD_MS), false);
});

test("NaN nowMs at hold time does not hold forever", () => {
  holdPushes("m", 5_000, NaN);
  assert.equal(isPushHeld("m", 100_000), false);
});

test("clock stepped backwards after hold: read caps the hold at now+MAX", () => {
  holdPushes("m", 12_000, 1_000_000); // until 1_012_000
  // wall clock jumps back an hour; without a read-side cap this holds for ~1h
  assert.equal(isPushHeld("m", 1_000_000 - 3_600_000), false);
});

test("release and prune drop holds of departed markets", () => {
  holdPushes("a", 5_000, 0);
  holdPushes("b", 5_000, 0);
  releasePushes("a");
  assert.equal(isPushHeld("a", 1), false);
  assert.deepEqual(pruneCrankRefreshHealth(new Set()), ["b"]);
  assert.equal(isPushHeld("b", 1), false);
});
