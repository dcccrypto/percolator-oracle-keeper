import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { V22FlagError, v22FlagsFromEnv } from "./flags.ts";

// flag key -> reader of the parsed value (posInt = must be > 0, nonNegInt = >= 0)
const POS: Array<[string, (f: ReturnType<typeof v22FlagsFromEnv>) => number]> = [
  ["KEEPER_V22_TICK_MS", (f) => f.tickMs],
  ["KEEPER_V22_LIQUIDATE_PAD_BPS", (f) => f.liquidatePadBps],
  ["KEEPER_V22_LIQUIDATE_MAX_PER_TX", (f) => f.liquidateMaxPerTx],
  ["KEEPER_V22_RENT_CADENCE_SLOTS", (f) => f.rentCadenceSlots],
  ["KEEPER_V22_STAKE_SYNC_INTERVAL_MS", (f) => f.stakeSyncIntervalMs],
  ["KEEPER_V22_LP_MAX_UNSETTLED_MS", (f) => f.lpMaxUnsettledMs],
  ["KEEPER_V22_STALE_RESOLVE_MIN_OBS_MS", (f) => f.lifecycle.minObservationMs],
  ["KEEPER_V22_STALE_RESOLVE_MASS_THRESHOLD", (f) => f.lifecycle.massThreshold],
  ["KEEPER_V22_STALE_RESOLVE_MAX_PER_CYCLE", (f) => f.lifecycle.maxResolvesPerCycle],
  ["KEEPER_V22_STALE_RESOLVE_SOURCE_LOSS_MAX", (f) => f.lifecycle.sourceLossMax],
  ["KEEPER_V22_STALE_RESOLVE_GROUP_LOSS_PCT", (f) => f.lifecycle.groupLossPct],
  ["KEEPER_V22_STALE_RESOLVE_SOURCE_LOSS_PCT", (f) => f.lifecycle.sourceLossPct],
  ["KEEPER_V22_STALE_RESOLVE_RETRY_MS", (f) => f.lifecycle.resolveRetryMs],
  ["KEEPER_V22_LIFECYCLE_MAX_GAP_MS", (f) => f.lifecycle.maxGapMs],
  ["KEEPER_V22_NEVER_CONNECTED_GRACE_SLOTS", (f) => f.lifecycle.neverConnectedGraceSlots],
  ["KEEPER_V22_DEAD_INTEREST_DAYS", (f) => f.lifecycle.deadInterestDays],
  ["KEEPER_V22_WARN_BAND_FEE_SPACING_MS", (f) => f.lifecycle.warnBandFeeSpacingMs],
  ["KEEPER_V22_WARN_BAND_FEE_MAX_PER_TICK", (f) => f.lifecycle.warnBandFeeMaxPerTick],
];
const NONNEG: Array<[string, (f: ReturnType<typeof v22FlagsFromEnv>) => number]> = [
  ["KEEPER_V22_LIFECYCLE_DISCOVERY_MS", (f) => f.lifecycle.discoveryMs],
];

// Not plain decimal digits: the header says a bad value THROWS.
const ODD = ["1e3", "0x14", "0b11", "0o7", "12.0", "1_000", "+5", "1e0", "99999999999999999999", "9007199254740993", "1e21", "00012"];

function probe(key: string, read: (f: ReturnType<typeof v22FlagsFromEnv>) => number, raw: string): string {
  try {
    return String(read(v22FlagsFromEnv({ KEEPER_V22: "on", [key]: raw })));
  } catch (e) {
    if (e instanceof V22FlagError) return "THROWS";
    throw e;
  }
}

describe("v22 flags: integer flags are strict decimal", () => {
  it("prints the accepted-value table", () => {
    const rows: string[] = [];
    for (const [k, r] of [...POS, ...NONNEG]) for (const raw of ODD) rows.push(`${k} ${JSON.stringify(raw)} -> ${probe(k, r, raw)}`);
    if (process.env.PRINT_TABLE) console.log(rows.join("\n"));
  });

  for (const [k, r] of [...POS, ...NONNEG]) {
    it(`${k} rejects non-decimal / unsafe forms`, () => {
      for (const raw of ODD.filter((x) => x !== "00012" && x !== "1e0")) {
        // KEEPER_V22_*_PCT flags are additionally capped at 100 and always throw for big values anyway
        assert.equal(probe(k, r, raw), "THROWS", `${k}=${raw}`);
      }
      assert.equal(probe(k, r, "1e0"), "THROWS");
    });
    it(`${k} still accepts plain decimals and whitespace-padded values`, () => {
      assert.equal(probe(k, r, " 7 "), "7");
      assert.equal(probe(k, r, "42"), "42");
    });
  }
  for (const [k, r] of POS) it(`${k} rejects 0 and negatives`, () => {
    assert.equal(probe(k, r, "0"), "THROWS");
    assert.equal(probe(k, r, "-3"), "THROWS");
  });
  it("nonNeg flag accepts 0, rejects negatives", () => {
    const [k, r] = NONNEG[0];
    assert.equal(probe(k, r, "0"), "0");
    assert.equal(probe(k, r, "-1"), "THROWS");
  });
});
