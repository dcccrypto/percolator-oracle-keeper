/**
 * Unit tests for env-utils helpers.
 *
 * Covers:
 *   - parsePositiveNumberEnv (bounty finding #4 fix)
 *   - requireProgramIdForSupabaseMode (issue #29 fix)
 *
 * Run with: node --import tsx/esm --test src/env-validation.test.ts
 * Or via:   pnpm test
 *
 * Uses Node's built-in test runner (no extra deps — Node 20+ required,
 * which matches engines.node in package.json).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveNumberEnv, requireProgramIdForSupabaseMode } from "./env-utils.ts";

// ── helpers ──────────────────────────────────────────────────

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

// ── parsePositiveNumberEnv ────────────────────────────────────

describe("parsePositiveNumberEnv", () => {

  describe("valid inputs", () => {
    it("uses fallback when env var is unset", () => {
      withEnv("MAX_PRICE_MOVE_PCT", undefined, () => {
        const result = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10);
        assert.equal(result, 10);
      });
    });

    it("uses fallback when env var is empty string", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "", () => {
        const result = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10);
        assert.equal(result, 10);
      });
    });

    it("parses a valid integer value", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "15", () => {
        const result = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10);
        assert.equal(result, 15);
      });
    });

    it("parses a valid float value", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "2.5", () => {
        const result = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10);
        assert.equal(result, 2.5);
      });
    });

    it("uses fallback when env var is whitespace-only", () => {
      withEnv("PUSH_INTERVAL_MS", "   ", () => {
        const result = parsePositiveNumberEnv("PUSH_INTERVAL_MS", 3000);
        assert.equal(result, 3000);
      });
    });
  });

  describe("invalid inputs — must throw (circuit-breaker NaN bypass fix)", () => {
    it("throws on non-numeric string (e.g. 'abc')", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "abc", () => {
        assert.throws(
          () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10),
          /MAX_PRICE_MOVE_PCT must be a finite positive number/,
        );
      });
    });

    it("throws on 'NaN' literal", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "NaN", () => {
        assert.throws(
          () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10),
          /MAX_PRICE_MOVE_PCT must be a finite positive number/,
        );
      });
    });

    it("throws on 'Infinity' literal", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "Infinity", () => {
        assert.throws(
          () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10),
          /MAX_PRICE_MOVE_PCT must be a finite positive number/,
        );
      });
    });

    it("throws on zero (zero threshold disables the guard)", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "0", () => {
        assert.throws(
          () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10),
          /MAX_PRICE_MOVE_PCT must be a finite positive number/,
        );
      });
    });

    it("throws on negative number", () => {
      withEnv("MAX_PRICE_MOVE_PCT", "-5", () => {
        assert.throws(
          () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10),
          /MAX_PRICE_MOVE_PCT must be a finite positive number/,
        );
      });
    });

    it("throws on alphanumeric mix (e.g. '10abc')", () => {
      withEnv("PUSH_INTERVAL_MS", "10abc", () => {
        assert.throws(
          () => parsePositiveNumberEnv("PUSH_INTERVAL_MS", 3000),
          /PUSH_INTERVAL_MS must be a finite positive number/,
        );
      });
    });
  });

  describe("circuit-breaker behavior with valid threshold", () => {
    /**
     * Simulate the circuit-breaker comparison to confirm that with a valid
     * MAX_PRICE_MOVE_PCT=10, a 900% move would be rejected.
     *
     * We do not import checkCircuitBreaker (it's not exported) so we replicate
     * the comparison logic inline — this is the exact expression from index.ts:557.
     */
    it("rejects a 900% price move when breaker is configured with threshold 10", () => {
      const threshold = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10); // uses fallback = 10
      const lastPrice = 100;
      const newPrice = 1000; // +900%
      const movePct = Math.abs((newPrice - lastPrice) / lastPrice) * 100; // 900
      const rejected = movePct > threshold;
      assert.ok(rejected, `Expected 900% move to be rejected (movePct=${movePct}, threshold=${threshold})`);
    });

    it("accepts a small move within the threshold", () => {
      const threshold = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10);
      const lastPrice = 100;
      const newPrice = 105; // +5%
      const movePct = Math.abs((newPrice - lastPrice) / lastPrice) * 100; // 5
      const accepted = !(movePct > threshold);
      assert.ok(accepted, `Expected 5% move to be accepted (movePct=${movePct}, threshold=${threshold})`);
    });
  });
});

// ── requireProgramIdForSupabaseMode (issue #29 fix) ──────────────────────────

/**
 * These tests assert the fix for issue #29:
 *
 * In Supabase-only discovery mode (no deployment file, no DEPLOYMENT_JSON),
 * the keeper built a fallback deploy object using `process.env.PROGRAM_ID`.
 * When `PROGRAM_ID` was unset, `new PublicKey(undefined)` crashed the service
 * with the opaque "_bn" error from @solana/web3.js — AFTER logging that
 * Supabase-only mode was active.
 *
 * The fix (Option A): fail fast with a clear error before claiming
 * Supabase-only mode is available.  `requireProgramIdForSupabaseMode` is the
 * pure, testable helper that performs this check.
 */
describe("requireProgramIdForSupabaseMode (issue #29)", () => {

  describe("throws a clear error when PROGRAM_ID is absent", () => {
    it("throws when programId is undefined (env var unset)", () => {
      assert.throws(
        () => requireProgramIdForSupabaseMode(undefined),
        /PROGRAM_ID is required for Supabase-only discovery mode/,
      );
    });

    it("throws when programId is empty string", () => {
      assert.throws(
        () => requireProgramIdForSupabaseMode(""),
        /PROGRAM_ID is required for Supabase-only discovery mode/,
      );
    });

    it("throws when programId is whitespace-only", () => {
      assert.throws(
        () => requireProgramIdForSupabaseMode("   "),
        /PROGRAM_ID is required for Supabase-only discovery mode/,
      );
    });

    it("error message mentions the deployment file / DEPLOYMENT_JSON alternatives", () => {
      let caught: Error | undefined;
      try {
        requireProgramIdForSupabaseMode(undefined);
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught, "Expected an error to be thrown");
      assert.match(caught.message, /DEPLOYMENT_JSON/);
    });
  });

  describe("does NOT throw when PROGRAM_ID is present", () => {
    it("succeeds with a valid-looking base58 public key", () => {
      // Does not validate the key format — that is @solana/web3.js's job.
      // We only check that the guard does not block a non-empty value.
      assert.doesNotThrow(() =>
        requireProgramIdForSupabaseMode("FwfBtNNUUEjFnX6BqNJKdgxHXKiU5KmTJq5vCHY5tqc"),
      );
    });

    it("succeeds with any non-empty string (format validation is downstream)", () => {
      assert.doesNotThrow(() =>
        requireProgramIdForSupabaseMode("some-program-id"),
      );
    });
  });
});
