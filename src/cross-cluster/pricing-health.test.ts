/**
 * pricingHealthStatus — the audit's "silent frozen-mark" alarm.
 *
 * The condition it exists for: markets registered + pricing produced nothing
 * for minutes = every market tradeable against a frozen AuthMark (free-option
 * risk against the LPs), previously with /health reading "ok" throughout.
 * Exact-boundary tests so threshold drift is loud.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/pricing-health.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pricingHealthStatus,
  PUSH_STALL_MS,
  BATCH_FAILURE_ALERT_THRESHOLD,
} from "./keeper-loop.ts";

const NOW = 10_000_000;

function state(over: Partial<Parameters<typeof pricingHealthStatus>[0]> = {}) {
  return {
    startedAt: NOW - 1_000_000,
    lastSuccessfulPushAt: NOW - 5_000,
    consecutiveBatchReadFailures: 0,
    ...over,
  };
}

describe("pricingHealthStatus", () => {
  it("healthy: recent push, no failures", () => {
    assert.equal(pricingHealthStatus(state(), 2, NOW), "ok");
  });

  it("empty board is ok — nothing CAN push", () => {
    assert.equal(
      pricingHealthStatus(state({ lastSuccessfulPushAt: null, consecutiveBatchReadFailures: 99 }), 0, NOW),
      "ok",
    );
  });

  it("flips at exactly the consecutive-failure threshold", () => {
    assert.equal(
      pricingHealthStatus(state({ consecutiveBatchReadFailures: BATCH_FAILURE_ALERT_THRESHOLD - 1 }), 2, NOW),
      "ok",
    );
    assert.equal(
      pricingHealthStatus(state({ consecutiveBatchReadFailures: BATCH_FAILURE_ALERT_THRESHOLD }), 2, NOW),
      "stalled-pricing",
    );
  });

  it("flips at exactly the push-stall horizon", () => {
    assert.equal(
      pricingHealthStatus(state({ lastSuccessfulPushAt: NOW - PUSH_STALL_MS }), 2, NOW),
      "ok",
    );
    assert.equal(
      pricingHealthStatus(state({ lastSuccessfulPushAt: NOW - PUSH_STALL_MS - 1 }), 2, NOW),
      "stalled-pricing",
    );
  });

  it("a keeper that NEVER pushed stalls from process start, not never", () => {
    // lastSuccessfulPushAt null must fall back to startedAt — otherwise a
    // keeper that boots broken reads "ok" forever.
    assert.equal(
      pricingHealthStatus(
        state({ lastSuccessfulPushAt: null, startedAt: NOW - PUSH_STALL_MS - 1 }),
        2,
        NOW,
      ),
      "stalled-pricing",
    );
    assert.equal(
      pricingHealthStatus(state({ lastSuccessfulPushAt: null, startedAt: NOW - 10_000 }), 2, NOW),
      "ok",
    );
  });
});
