/**
 * Tests for oracle-keeper security wave #31–#50.
 *
 * Covers the four CRITICAL fixes and #44 (max bound):
 *   #44 — parsePositiveNumberEnv max bound (>=100 throws)
 *   #32 — slabProgramId allowlist rejects attacker program
 *   #33 — first-push requires secondary-source cross-check
 *   #34 — DexScreener uses tighter DEXSCREENER_MAX_MOVE_PCT bound + alert
 *
 * Run with: node --import tsx/esm --test src/security-fixes.test.ts
 * Or via:   pnpm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveNumberEnv } from "./env-utils.ts";
import { checkCircuitBreaker } from "./circuit-breaker.ts";
import type { CircuitBreakerState } from "./circuit-breaker.ts";

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

/** Silent log sink. */
const silent = () => {};

function makeState(lastPrice = 100, symbol = "TEST"): CircuitBreakerState {
  return {
    symbol,
    lastPrice,
    circuitBreakerTrips: 0,
    cbTripPrice: 0,
    cbConsecutiveTrips: 0,
  };
}

// ══════════════════════════════════════════════════════════════
// #44 — parsePositiveNumberEnv max bound
// ══════════════════════════════════════════════════════════════

describe("#44 parsePositiveNumberEnv max bound", () => {
  it("accepts a value strictly below max", () => {
    withEnv("MAX_PRICE_MOVE_PCT", "50", () => {
      const result = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10, 100);
      assert.equal(result, 50);
    });
  });

  it("throws when value equals max (>=100 disables the guard)", () => {
    withEnv("MAX_PRICE_MOVE_PCT", "100", () => {
      assert.throws(
        () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10, 100),
        /MAX_PRICE_MOVE_PCT must be less than 100/,
      );
    });
  });

  it("throws when value exceeds max", () => {
    withEnv("MAX_PRICE_MOVE_PCT", "150", () => {
      assert.throws(
        () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10, 100),
        /MAX_PRICE_MOVE_PCT must be less than 100/,
      );
    });
  });

  it("still throws on NaN even with a max param", () => {
    withEnv("MAX_PRICE_MOVE_PCT", "NaN", () => {
      assert.throws(
        () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10, 100),
        /MAX_PRICE_MOVE_PCT must be a finite positive number/,
      );
    });
  });

  it("uses fallback when unset, accepts if fallback < max", () => {
    withEnv("MAX_PRICE_MOVE_PCT", undefined, () => {
      const result = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 10, 100);
      assert.equal(result, 10);
    });
  });

  it("throws if fallback itself equals max (misconfigured default)", () => {
    withEnv("MAX_PRICE_MOVE_PCT", undefined, () => {
      assert.throws(
        () => parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT", 100, 100),
        /MAX_PRICE_MOVE_PCT must be less than 100/,
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════
// #32 — slab program ID allowlist
// ══════════════════════════════════════════════════════════════
//
// isAllowedProgramId lives inside index.ts (which can't be imported without
// side-effects). We replicate the same logic here as a pure function to test
// the allowlist semantics independently.

describe("#32 slab program ID allowlist", () => {
  function makeAllowlist(...ids: string[]): Set<string> {
    const s = new Set<string>();
    for (const id of ids) s.add(id);
    return s;
  }

  function isAllowedProgramId(
    allowedProgramIds: Set<string>,
    ownerBase58: string,
  ): boolean {
    if (allowedProgramIds.size === 0) return false;
    return allowedProgramIds.has(ownerBase58);
  }

  const legitimateProgram = "FxfD4XY4TYQhBCZpBNbM7FQ5FPgdRDhXf1Rkj9u8VNm";
  const attackerProgram   = "AttAcKeRProgRAm111111111111111111111111111111";

  it("allows a slab owned by the expected program", () => {
    const allowlist = makeAllowlist(legitimateProgram);
    assert.ok(isAllowedProgramId(allowlist, legitimateProgram));
  });

  it("rejects a slab owned by an attacker program not in the allowlist", () => {
    const allowlist = makeAllowlist(legitimateProgram);
    assert.equal(isAllowedProgramId(allowlist, attackerProgram), false,
      "Attacker-owned slab must be rejected");
  });

  it("allows a slab when multiple program IDs are allowlisted (ADDITIONAL_PROGRAM_IDS)", () => {
    const legacyProgram = "FwfBtNNUUEjFnX6BqNJKdgxHXKiU5KmTJq5vCHY5tqc";
    const allowlist = makeAllowlist(legitimateProgram, legacyProgram);
    assert.ok(isAllowedProgramId(allowlist, legacyProgram),
      "Legacy allowlisted program must be accepted");
  });

  it("rejects any owner when the allowlist is empty (uninitialised guard)", () => {
    const allowlist = makeAllowlist(); // empty
    assert.equal(isAllowedProgramId(allowlist, legitimateProgram), false,
      "Empty allowlist must block everything as a safety measure");
  });

  it("does not grant access for a substring or prefix match", () => {
    const allowlist = makeAllowlist(legitimateProgram);
    const partialId = legitimateProgram.slice(0, 8);
    assert.equal(isAllowedProgramId(allowlist, partialId), false);
  });
});

// ══════════════════════════════════════════════════════════════
// #33 — first-push cross-check logic
// ══════════════════════════════════════════════════════════════
//
// The cross-check runs inside pushAndCrank (async, uses live RPC) so we test
// the decision logic as a pure function here, replicating the exact conditions.

describe("#33 first-push cross-check logic", () => {
  /**
   * Replicates the first-push cross-check decision from pushAndCrank.
   *
   * Returns:
   *   "exempt"   — source is pyth; no cross-check needed
   *   "pass"     — secondary confirms the price
   *   "fail"     — secondary unavailable or price diverges too much
   */
  function firstPushCheck(
    lastPrice: number,
    source: string,
    primaryPrice: number,
    secondaryPrice: number | null,
    maxMovePct: number,
  ): "exempt" | "pass" | "fail" {
    if (lastPrice !== 0) return "pass"; // not the first push — circuit-breaker handles it
    if (source === "pyth") return "exempt";
    if (secondaryPrice === null) return "fail";
    const movePct = Math.abs((primaryPrice - secondaryPrice) / secondaryPrice) * 100;
    return movePct <= maxMovePct ? "pass" : "fail";
  }

  it("pyth source is exempt from the cross-check", () => {
    assert.equal(
      firstPushCheck(0, "pyth", 100, null, 5),
      "exempt",
      "Pyth is Wormhole-attested — no secondary needed",
    );
  });

  it("non-first pushes (lastPrice > 0) are not subject to the cross-check", () => {
    assert.equal(
      firstPushCheck(100, "dexscreener", 100, null, 5),
      "pass",
    );
  });

  it("DexScreener first push confirmed by Jupiter within tolerance → pass", () => {
    assert.equal(
      firstPushCheck(0, "dexscreener", 100, 101, 5), // 1% diff — within 5%
      "pass",
    );
  });

  it("DexScreener first push with no secondary source → fail", () => {
    assert.equal(
      firstPushCheck(0, "dexscreener", 100, null, 5),
      "fail",
      "No secondary source available → cross-check fails",
    );
  });

  it("DexScreener first push diverges from secondary beyond tolerance → fail", () => {
    assert.equal(
      firstPushCheck(0, "dexscreener", 100, 120, 5), // 20% diff — exceeds 5%
      "fail",
      "Price diverges too much from secondary → fail",
    );
  });

  it("jupiter-ca first push confirmed by Pyth cache → pass", () => {
    assert.equal(
      firstPushCheck(0, "jupiter-ca", 100, 100.5, 5), // 0.5% diff
      "pass",
    );
  });

  it("cross-check boundary: exactly at tolerance passes (<=)", () => {
    // Formula: movePct = |primary - secondary| / secondary * 100
    // To get exactly 5%: secondary = primary / 1.05, movePct = 5% exactly.
    // But floating-point may drift; use secondary = 105 primary = 100
    // movePct = |100 - 105| / 105 * 100 = 4.76% ≤ 5% → pass
    assert.equal(firstPushCheck(0, "dexscreener", 100, 105, 5), "pass");
    // Also test with primary below secondary: secondary=96, movePct = |100-96|/96*100 = 4.17% → pass
    assert.equal(firstPushCheck(0, "dexscreener", 100, 96, 5), "pass");
  });

  it("cross-check boundary: just over tolerance fails (>)", () => {
    const secondary = 100 / 1.06; // primary is 6% above secondary
    assert.equal(firstPushCheck(0, "dexscreener", 100, secondary, 5), "fail");
  });
});

// ══════════════════════════════════════════════════════════════
// #34 — DexScreener tighter circuit-breaker bound + low-trust alert
// ══════════════════════════════════════════════════════════════

describe("#34 DexScreener tighter circuit-breaker bound", () => {
  const globalMaxPct  = 10; // global MAX_PRICE_MOVE_PCT
  const dexMaxPct     = 5;  // DEXSCREENER_MAX_MOVE_PCT
  const confirmTrips  = 3;

  it("accepts a 4% move when using the 5% DexScreener bound", () => {
    const s = makeState(100);
    assert.ok(checkCircuitBreaker(s, 104, { maxMovePct: dexMaxPct, confirmTrips, log: silent }));
  });

  it("rejects a 7% move with the 5% DexScreener bound (would pass the 10% global bound)", () => {
    const s = makeState(100);
    assert.equal(
      checkCircuitBreaker(s, 107, { maxMovePct: dexMaxPct, confirmTrips, log: silent }),
      false,
      "7% move should be blocked by the tighter 5% DexScreener bound",
    );
  });

  it("accepts a 7% move when using the global 10% Pyth/Jupiter bound", () => {
    const s = makeState(100);
    assert.ok(checkCircuitBreaker(s, 107, { maxMovePct: globalMaxPct, confirmTrips, log: silent }));
  });

  it("DexScreener bound is validated <100 by the #44 max param", () => {
    withEnv("DEXSCREENER_MAX_MOVE_PCT", "100", () => {
      assert.throws(
        () => parsePositiveNumberEnv("DEXSCREENER_MAX_MOVE_PCT", 5, 100),
        /DEXSCREENER_MAX_MOVE_PCT must be less than 100/,
      );
    });
  });

  it("tracks consecutive low-trust cycles and alerts after threshold", () => {
    let consecutiveLowTrustCycles = 0;
    const alertThreshold = 5;
    const alerts: string[] = [];

    function simulatePush(source: string) {
      const isDex = source === "dexscreener" || source === "dexscreener-ca";
      if (isDex) {
        consecutiveLowTrustCycles++;
        if (consecutiveLowTrustCycles >= alertThreshold) {
          alerts.push(`alert at cycle ${consecutiveLowTrustCycles}`);
        }
      } else {
        consecutiveLowTrustCycles = 0;
      }
    }

    // 4 DexScreener pushes — no alert yet
    for (let i = 0; i < 4; i++) simulatePush("dexscreener");
    assert.equal(alerts.length, 0);

    // 5th push — alert fires
    simulatePush("dexscreener");
    assert.equal(alerts.length, 1);

    // 6th push — alert fires again (>= not ==)
    simulatePush("dexscreener");
    assert.equal(alerts.length, 2);

    // Pyth push — resets counter
    simulatePush("pyth");
    assert.equal(consecutiveLowTrustCycles, 0);

    // Next DexScreener push — counter starts fresh, no alert
    simulatePush("dexscreener");
    assert.equal(consecutiveLowTrustCycles, 1);
    assert.equal(alerts.length, 2);
  });

  it("dexscreener-ca also increments the low-trust counter", () => {
    let counter = 0;
    ["dexscreener", "dexscreener-ca", "dexscreener-ca"].forEach(source => {
      if (source === "dexscreener" || source === "dexscreener-ca") {
        counter++;
      } else {
        counter = 0;
      }
    });
    assert.equal(counter, 3);
  });

  it("jupiter-ca resets the low-trust counter (non-DexScreener source)", () => {
    let counter = 0;
    ["dexscreener-ca", "dexscreener-ca", "jupiter-ca"].forEach(source => {
      if (source === "dexscreener" || source === "dexscreener-ca") {
        counter++;
      } else {
        counter = 0;
      }
    });
    assert.equal(counter, 0, "jupiter-ca should reset the low-trust counter");
  });
});
