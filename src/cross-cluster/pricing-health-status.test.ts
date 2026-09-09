/**
 * Regression guard for #68 — /health must not report "ok" for a board that has
 * never successfully pushed.
 *
 * The fix exists (pricingHealthStatus returns "stalled-pricing"), but nothing
 * pinned it. That matters more than usual here: no commit message in this repo
 * references an issue number, so a silent regression would not be caught by
 * anything else either.
 *
 * The case the original report actually turned on is `neverPushed`: with
 * lastSuccessfulPushAt still null, a naive implementation reads "no stale push
 * recorded" as healthy, and a keeper that comes up broken reads ok forever.
 * Counting from startedAt is what closes that, so it is tested explicitly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pricingHealthStatus,
  PUSH_STALL_MS,
  BATCH_FAILURE_ALERT_THRESHOLD,
} from "./keeper-loop.ts";

const BOOT = 1_000_000;

function state(over: Partial<{
  lastSuccessfulPushAt: number | null;
  consecutiveBatchReadFailures: number;
  startedAt: number;
}> = {}) {
  return {
    lastSuccessfulPushAt: null,
    consecutiveBatchReadFailures: 0,
    startedAt: BOOT,
    ...over,
  };
}

describe("#68 pricingHealthStatus", () => {
  it("NEVER pushed since boot, past the stall window -> stalled-pricing", () => {
    assert.equal(
      pricingHealthStatus(state(), 3, BOOT + PUSH_STALL_MS + 1),
      "stalled-pricing",
      "a keeper that came up broken must not read ok forever just because the field is null",
    );
  });

  it("never pushed but still inside the window -> ok (a fresh boot is not broken)", () => {
    assert.equal(pricingHealthStatus(state(), 3, BOOT + PUSH_STALL_MS - 1), "ok");
  });

  it("a recent successful push -> ok", () => {
    const now = BOOT + 10 * PUSH_STALL_MS;
    assert.equal(
      pricingHealthStatus(state({ lastSuccessfulPushAt: now - 1 }), 3, now),
      "ok",
    );
  });

  it("a STALE successful push -> stalled-pricing", () => {
    const now = BOOT + 10 * PUSH_STALL_MS;
    assert.equal(
      pricingHealthStatus(
        state({ lastSuccessfulPushAt: now - PUSH_STALL_MS - 1 }),
        3,
        now,
      ),
      "stalled-pricing",
    );
  });

  it("an EMPTY board is ok — nothing can push, so nothing is stalled", () => {
    assert.equal(
      pricingHealthStatus(state(), 0, BOOT + 100 * PUSH_STALL_MS),
      "ok",
      "an empty registry must not alarm; there is nothing to push",
    );
  });

  it("sustained batch read failures -> stalled-pricing even with a fresh push", () => {
    const now = BOOT + 10 * PUSH_STALL_MS;
    assert.equal(
      pricingHealthStatus(
        state({
          lastSuccessfulPushAt: now - 1,
          consecutiveBatchReadFailures: BATCH_FAILURE_ALERT_THRESHOLD,
        }),
        3,
        now,
      ),
      "stalled-pricing",
      "a board that cannot READ prices is not healthy just because it pushed recently",
    );
  });

  it("failures below the threshold do not alarm", () => {
    const now = BOOT + 10 * PUSH_STALL_MS;
    assert.equal(
      pricingHealthStatus(
        state({
          lastSuccessfulPushAt: now - 1,
          consecutiveBatchReadFailures: BATCH_FAILURE_ALERT_THRESHOLD - 1,
        }),
        3,
        now,
      ),
      "ok",
    );
  });
});
