import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { holdPushes, isPushHeld, releasePushes, pruneCrankRefreshHealth, resetRefreshCoordination, MAX_PUSH_HOLD_MS } from "./refresh-coordination.ts";

beforeEach(() => resetRefreshCoordination());

test("lead 1: a non-finite ms never produces a hold that cannot expire", () => {
  for (const bad of [NaN, undefined as unknown as number, Infinity * 0]) {
    resetRefreshCoordination();
    holdPushes("m", bad, 1_000);
    // far in the future, and well past MAX_PUSH_HOLD_MS: must not be held
    assert.equal(isPushHeld("m", 1_000 + MAX_PUSH_HOLD_MS + 1), false, `ms=${bad}`);
  }
});

test("lead 1: Infinity is capped, negative is no hold", () => {
  holdPushes("m", Infinity, 0);
  assert.equal(isPushHeld("m", MAX_PUSH_HOLD_MS - 1), true);
  assert.equal(isPushHeld("m", MAX_PUSH_HOLD_MS), false);
  holdPushes("n", -5, 0);
  assert.equal(isPushHeld("n", 0), false);
});

test("lead 2: a second hold replaces (not max-merges) the first", () => {
  holdPushes("m", 10_000, 0);
  holdPushes("m", 2_000, 0);
  // documents current behaviour: the later call wins, even when shorter
  assert.equal(isPushHeld("m", 3_000), false);
});

test("lead 3: expiry is fixed at set time; a clock step back only extends by the step", () => {
  holdPushes("m", 5_000, 100_000);
  // clock stepped back 60s: still "held" until the wall clock catches up. Bounded, no code path re-extends it.
  assert.equal(isPushHeld("m", 40_000), true);
  // a hold made at the stepped-back clock is capped relative to that clock
  holdPushes("k", 10 * 60_000, 40_000);
  assert.equal(isPushHeld("k", 40_000 + MAX_PUSH_HOLD_MS), false);
});

test("release and prune drop holds", () => {
  holdPushes("a", 5_000, 0);
  holdPushes("b", 5_000, 0);
  releasePushes("a");
  assert.equal(isPushHeld("a", 1), false);
  assert.deepEqual(pruneCrankRefreshHealth(new Set()), ["b"]);
  assert.equal(isPushHeld("b", 1), false);
});
