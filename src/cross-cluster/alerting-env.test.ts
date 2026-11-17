/**
 * Coverage: thresholdsFromEnv — every ALERT_* override, blank/whitespace fallback, and the
 * rejection paths (non-integer, zero, NaN). Pure; no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, thresholdsFromEnv } from "./alerting.ts";
import type { AlertThresholds } from "./alerting.ts";

const ENV_TO_KEY: Record<string, keyof AlertThresholds> = {
  ALERT_SLOT_LAG_WARN: "slotLagWarn",
  ALERT_SLOT_LAG_CRITICAL: "slotLagCritical",
  ALERT_CRANK_REVERTS: "crankConsecutiveReverts",
  ALERT_ZERO_PUSH_CYCLES: "zeroPushCycles",
  ALERT_LAPSED_BUCKET_CYCLES: "lapsedBucketCycles",
  ALERT_BANKRUPT_CYCLES: "bankruptCycles",
  ALERT_COOLDOWN_MS: "cooldownMs",
  ALERT_ADL_REDUCE_ONLY_CRITICAL_SLOTS: "adlReduceOnlyCriticalSlots",
  ALERT_LOSS_STALE_CYCLES: "lossStaleCycles",
  ALERT_LOSS_STALE_PROLONGED_MS: "lossStaleProlongedMs",
  ALERT_MARKET_NO_PUSH_CYCLES: "marketNoPushCycles",
  ALERT_MARK_LAG_MS: "markLagMs",
  ALERT_MARK_LAG_PCT: "markLagPct",
  ALERT_SOURCE_FROZEN_MS: "sourceFrozenMs",
  ALERT_SOURCE_DEAD_MS: "sourceDeadMs",
  ALERT_DEPTH_ABSENT_MS: "depthAbsentMs",
  ALERT_BAND_PIN_EXPIRY_SLOTS: "bandPinExpirySlots",
};

describe("thresholdsFromEnv overrides", () => {
  it("maps every ALERT_* variable onto its own threshold field", () => {
    // Distinct large values (critical >= warn holds); each lands only in its own key.
    const env: Record<string, string> = {};
    let n = 1000;
    for (const name of Object.keys(ENV_TO_KEY)) env[name] = String(n++);
    const t = thresholdsFromEnv(env);
    let expected = 1000;
    for (const name of Object.keys(ENV_TO_KEY)) {
      assert.equal(t[ENV_TO_KEY[name]], expected++, name);
    }
    assert.equal(Object.keys(ENV_TO_KEY).length, Object.keys(DEFAULT_THRESHOLDS).length, "a new threshold needs an env mapping + test");
  });

  it("each variable alone changes only its own field", () => {
    for (const [name, key] of Object.entries(ENV_TO_KEY)) {
      // 100_000 keeps slotLagCritical >= slotLagWarn only for critical; set warn low-safe below.
      const value = key === "slotLagWarn" ? "7" : "100000";
      const t = thresholdsFromEnv({ [name]: value });
      for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof AlertThresholds)[]) {
        assert.equal(t[k], k === key ? Number(value) : DEFAULT_THRESHOLDS[k], `${name} -> ${k}`);
      }
    }
  });

  it("blank / whitespace-only values fall back to the default", () => {
    const t = thresholdsFromEnv({ ALERT_COOLDOWN_MS: "", ALERT_MARK_LAG_MS: "   ", ALERT_DEPTH_ABSENT_MS: undefined });
    assert.deepEqual(t, DEFAULT_THRESHOLDS);
  });

  it("rejects zero, fractions, NaN and Infinity, naming the variable", () => {
    for (const bad of ["0", "1.5", "abc", "Infinity", "-3"]) {
      assert.throws(() => thresholdsFromEnv({ ALERT_BAND_PIN_EXPIRY_SLOTS: bad }), /ALERT_BAND_PIN_EXPIRY_SLOTS=.* must be a positive integer/, bad);
    }
  });

  it("accepts critical == warn", () => {
    const t = thresholdsFromEnv({ ALERT_SLOT_LAG_WARN: "400", ALERT_SLOT_LAG_CRITICAL: "400" });
    assert.equal(t.slotLagWarn, 400);
    assert.equal(t.slotLagCritical, 400);
  });
});
