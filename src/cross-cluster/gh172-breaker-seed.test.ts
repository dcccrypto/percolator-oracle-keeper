/**
 * GH#172 — the cross-cluster circuit breaker's cold-start baseline.
 *
 * `crossClusterCircuitBreakerStates` lives in memory, so after every restart every market's
 * `lastPrice` is 0 and `checkCircuitBreaker` takes its "First price — always accept" branch: the
 * first push of every market is bounded by nothing. Closed issue #33 was exactly that defect. Its
 * fix was a secondary-source cross-check inside `pushAndCrank`; that function left the tree in the
 * cross-cluster rewrite and the cross-check went with it. What survives is a REPLICA of the
 * decision in `security-fixes.test.ts` (`firstPushCheck`, defined inside the test), which keeps
 * passing because it reimplements the logic rather than importing it — so the suite reports #33 as
 * covered while production has no corroboration at all.
 *
 * The fix seeds the baseline from the asset's last PUSHED mark on chain, which costs no extra RPC
 * (`recordPushDeadline` already receives the market bytes) and uses the value `mark-smoother.ts`
 * itself calls "stale but TRUSTED".
 *
 * These tests avoid the trap that makes a seeding test worthless: asserting only that an outlier is
 * rejected would pass for unrelated reasons. The second test therefore asserts BOTH arms — seeded
 * rejects, unseeded accepts — so the unseeded arm is a live demonstration of the defect and the
 * pair cannot both hold unless the seed is what changed the outcome.
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getOnChainMarkE6, getOnChainTokenPriceUsd, recordOnChainMarks, resetOnChainMarks } from "./push-deadline.ts";
import { PROFILE_LOT_EXP_OFF } from "./auth-mark-pusher.ts";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { checkCircuitBreaker, type CircuitBreakerState } from "../circuit-breaker.ts";
import {
  getCrossClusterCircuitBreakerState,
  resetCrossClusterCircuitBreakerStates,
} from "./keeper-loop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A REAL deployed v2.2 market account, read from devnet
 * (`FRVP35ujCY5bX4k5e5BWwpsJsiGaBeLZ6K3VckJNemEz`, wrapper `6kpg2wi7…`, 4059 bytes).
 *
 * Chosen because its asset 0 is one of only three live markets where the pushed target and the
 * engine's walked mark DIFFER — 31.000000 vs 39.744000 — which is what makes the first test
 * discriminate the offset. A decode that read `effectivePrice` (offset 25) instead of
 * `raw_oracle_target_price` (offset 17) would return 39_744_000n and fail.
 */
function liveMarketBytes(): Uint8Array {
  const b64 = readFileSync(join(HERE, "__fixtures__", "gh172-market-v22-frvp.b64"), "utf8").trim();
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const MARKET = "FRVP35ujCY5bX4k5e5BWwpsJsiGaBeLZ6K3VckJNemEz";
const EXPECTED_PUSHED_MARK_E6 = 31_000_000n;
const WALKED_MARK_E6 = 39_744_000n;

describe("GH#172 on-chain mark decode (real deployed account)", () => {
  beforeEach(() => resetOnChainMarks());

  it("decodes the asset's last PUSHED mark, not the engine's walked mark", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const got = getOnChainMarkE6(MARKET, 0);
    assert.equal(got, EXPECTED_PUSHED_MARK_E6);
    assert.notEqual(
      got,
      WALKED_MARK_E6,
      "reading effectivePrice (offset 25) instead of raw_oracle_target_price (offset 17)",
    );
  });

  it("leaves a unit unseeded when no market read has happened for it", () => {
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
    recordOnChainMarks(MARKET, liveMarketBytes());
    assert.equal(getOnChainMarkE6("SomeOtherMarket1111111111111111111111111111", 0), null);
    assert.equal(getOnChainMarkE6(MARKET, 3), null, "an asset slot this market does not have");
  });

  it("never throws on an account it cannot decode", () => {
    recordOnChainMarks(MARKET, new Uint8Array(8));
    recordOnChainMarks(MARKET, new Uint8Array(0));
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
  });
});

describe("GH#172 a seeded baseline bounds the first push; an unseeded one does not", () => {
  const CFG = { maxMovePct: 10, confirmTrips: 2, sustainedRelocationMs: 60_000 };

  function state(lastPrice: number): CircuitBreakerState {
    // Shape copied from keeper-loop.ts's fresh-state construction.
    return {
      symbol: "TEST",
      lastPrice,
      circuitBreakerTrips: 0,
      cbTripPrice: 0,
      cbConsecutiveTrips: 0,
    };
  }

  it("UNSEEDED (lastPrice 0) accepts a 10x outlier — this is the defect", () => {
    const s = state(0);
    const accepted = checkCircuitBreaker(s, 1_000, CFG);
    assert.equal(accepted, 1_000, "the breaker's first-price branch accepts anything");
  });

  it("SEEDED from the on-chain mark refuses the same outlier", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const seedE6 = getOnChainMarkE6(MARKET, 0);
    assert.notEqual(seedE6, null);
    const seedUsd = Number(seedE6) / 1_000_000; // 31.00
    const s = state(seedUsd);
    const accepted = checkCircuitBreaker(s, seedUsd * 10, CFG);
    assert.notEqual(
      accepted,
      seedUsd * 10,
      "a 10x move from the last published mark must not pass the breaker",
    );
  });

  it("SEEDED still passes a move inside the band, so the seed does not brick pushes", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const seedUsd = Number(getOnChainMarkE6(MARKET, 0)) / 1_000_000;
    const nudged = seedUsd * 1.01; // 1% — well inside maxMovePct 10
    const s = state(seedUsd);
    assert.equal(checkCircuitBreaker(s, nudged, CFG), nudged);
  });
});

describe("GH#172 the seeding WIRING, not just the decode", () => {
  beforeEach(() => {
    resetOnChainMarks();
    resetCrossClusterCircuitBreakerStates();
  });

  it("a fresh breaker state is seeded from the unit's on-chain mark", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const st = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    assert.equal(st.lastPrice, 0.00031, "seeded from raw_oracle_target_price 31.000000 per lot at lot_exp 5 = 0.00031 per token");
  });

  it("a fresh state is UNSEEDED when the market has not been read — behaviour is unchanged", () => {
    const st = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    assert.equal(st.lastPrice, 0, "deliberate fail-open: withholding would brick an unread market");
  });

  it("a fresh state is UNSEEDED when no seed argument is passed at all", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const st = getCrossClusterCircuitBreakerState(MARKET, "TEST");
    assert.equal(st.lastPrice, 0);
  });

  it("an existing state is never re-seeded (a live baseline is not overwritten)", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const first = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    first.lastPrice = 42; // as a landed push would leave it
    const again = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    assert.equal(again.lastPrice, 42, "the seed must apply only on creation");
  });
});

describe("GH#172 the seed is per TOKEN: the on-chain mark is per lot (token price x 10^lot_exp)", () => {
  beforeEach(() => { resetOnChainMarks(); resetCrossClusterCircuitBreakerStates(); });

  it("a lot_exp 3 market seeds the breaker at mark / 10^3, not at the per-lot mark", () => {
    const b = liveMarketBytes();
    const g = selectMarketGroupOffset(b);
    assert.equal(g.ok, true);
    if (!g.ok) return;
    const off = assetSlotOffset(g, 0) + PROFILE_LOT_EXP_OFF;
    assert.equal(b[off], 5, "the live fixture is a lot_exp 5 market (its per-lot mark 31 is a per-token 0.00031)");
    b[off] = 3;
    recordOnChainMarks(MARKET, b);
    assert.equal(getOnChainMarkE6(MARKET, 0), EXPECTED_PUSHED_MARK_E6, "the cached mark is the per-lot value as read");
    assert.equal(getOnChainTokenPriceUsd(MARKET, 0), 0.031);
    const st = getCrossClusterCircuitBreakerState(MARKET, "T", { marketAddress: MARKET, assetIndex: 0 });
    assert.equal(st.lastPrice, 0.031, "a per-token push of ~0.031 must not trip against a per-lot 31 baseline");
  });

  it("an unreadable lot_exp leaves the unit unseeded (fail-open, never a wrongly scaled baseline)", () => {
    const b = liveMarketBytes();
    const g = selectMarketGroupOffset(b);
    if (!g.ok) throw new Error("fixture");
    b[assetSlotOffset(g, 0) + PROFILE_LOT_EXP_OFF] = 200; // > LOT_EXP_MAX
    recordOnChainMarks(MARKET, b);
    assert.equal(getOnChainTokenPriceUsd(MARKET, 0), null);
  });
});
