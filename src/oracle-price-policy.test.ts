import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchIndependentFirstPushSecondary,
  isStaticPythFirstPushExempt,
  resetPriceBaselineForIdentityChange,
  resolvePricingIdentity,
  selectIndependentFirstPushSecondary,
  shouldInvalidatePriceBaselineForMainnetCaChange,
  validateFirstPushSecondary,
} from "./oracle-price-policy.ts";

const SLAB = "11111111111111111111111111111111";
const MAINNET_CA = "So11111111111111111111111111111111111111112";

const STATIC_SYMBOLS = new Set(["SOL", "BTC"]);

describe("price identity routing", () => {
  it("routes dynamic markets strictly by mainnet CA", () => {
    const mappings = new Map([[SLAB, MAINNET_CA]]);

    assert.deepEqual(
      resolvePricingIdentity(
        {
          symbol: "UNKNOWN-DYNAMIC-SYMBOL",
          slab: SLAB,
          isDynamic: true,
        },
        mappings,
        STATIC_SYMBOLS,
      ),
      {
        kind: "dynamic-ca",
        key: MAINNET_CA,
      },
    );
  });

  it("normalizes whitespace around a mapped dynamic CA", () => {
    const mappings = new Map([
      [SLAB, `  ${MAINNET_CA}\n`],
    ]);

    assert.deepEqual(
      resolvePricingIdentity(
        {
          symbol: "IGNORED",
          slab: SLAB,
          isDynamic: true,
        },
        mappings,
        STATIC_SYMBOLS,
      ),
      {
        kind: "dynamic-ca",
        key: MAINNET_CA,
      },
    );
  });

  it("fails closed when a dynamic market has no CA mapping", () => {
    assert.equal(
      resolvePricingIdentity(
        {
          symbol: "SOL",
          slab: SLAB,
          isDynamic: true,
        },
        new Map(),
        STATIC_SYMBOLS,
      ),
      null,
    );
  });

  it("routes static markets strictly by allowlisted symbol", () => {
    const staleCaMapping = new Map([[SLAB, MAINNET_CA]]);

    assert.deepEqual(
      resolvePricingIdentity(
        {
          symbol: "sol",
          slab: SLAB,
          isDynamic: false,
        },
        staleCaMapping,
        STATIC_SYMBOLS,
      ),
      {
        kind: "static-symbol",
        key: "SOL",
      },
    );
  });

  it("rejects an unknown static symbol even when a stale CA mapping exists", () => {
    const staleCaMapping = new Map([[SLAB, MAINNET_CA]]);

    assert.equal(
      resolvePricingIdentity(
        {
          symbol: "NOT-ALLOWLISTED",
          slab: SLAB,
          isDynamic: false,
        },
        staleCaMapping,
        STATIC_SYMBOLS,
      ),
      null,
    );
  });
});

describe("independent first-push source policy", () => {
  it("keeps Pyth exemption limited to static-symbol markets", () => {
    assert.equal(
      isStaticPythFirstPushExempt("static-symbol", "pyth"),
      true,
    );

    assert.equal(
      isStaticPythFirstPushExempt("dynamic-ca", "pyth"),
      false,
    );
  });

  it("selects a different static provider", () => {
    assert.equal(
      selectIndependentFirstPushSecondary(
        "static-symbol",
        "jupiter",
      ),
      "dexscreener",
    );

    assert.equal(
      selectIndependentFirstPushSecondary(
        "static-symbol",
        "dexscreener",
      ),
      "jupiter",
    );
  });

  it("selects a different CA provider", () => {
    assert.equal(
      selectIndependentFirstPushSecondary(
        "dynamic-ca",
        "jupiter-ca",
      ),
      "dexscreener-ca",
    );

    assert.equal(
      selectIndependentFirstPushSecondary(
        "dynamic-ca",
        "dexscreener-ca",
      ),
      "jupiter-ca",
    );
  });

  it("rejects Jupiter confirming itself", () => {
    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "jupiter",
        100,
        100,
        5,
      ),
      false,
    );
  });

  it("rejects identity-mode crossover during confirmation", () => {
    assert.equal(
      validateFirstPushSecondary(
        "dynamic-ca",
        "jupiter-ca",
        "dexscreener",
        100,
        100,
        5,
      ),
      false,
    );
  });

  it("accepts an independent static source within tolerance", () => {
    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "dexscreener",
        105,
        100,
        5,
      ),
      true,
    );
  });

  it("accepts an independent CA source within tolerance", () => {
    assert.equal(
      validateFirstPushSecondary(
        "dynamic-ca",
        "jupiter-ca",
        "dexscreener-ca",
        101,
        100,
        5,
      ),
      true,
    );
  });

  it("rejects a price just beyond the tolerance boundary", () => {
    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "dexscreener",
        105.0001,
        100,
        5,
      ),
      false,
    );
  });

  it("rejects unavailable or invalid prices", () => {
    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "dexscreener",
        100,
        null,
        5,
      ),
      false,
    );

    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "dexscreener",
        Number.NaN,
        100,
        5,
      ),
      false,
    );

    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "dexscreener",
        100,
        0,
        5,
      ),
      false,
    );
  });

  it("rejects an invalid tolerance that could disable the guard", () => {
    assert.equal(
      validateFirstPushSecondary(
        "static-symbol",
        "jupiter",
        "dexscreener",
        100,
        100,
        100,
      ),
      false,
    );
  });
});

describe("independent secondary reader orchestration", () => {
  it("never calls Jupiter again when Jupiter is the static primary", async () => {
    let jupiterCalls = 0;
    let dexScreenerCalls = 0;

    const result =
      await fetchIndependentFirstPushSecondary(
        {
          kind: "static-symbol",
          key: "SOL",
        },
        "jupiter",
        {
          jupiter: async () => {
            jupiterCalls++;
            return 999;
          },
          dexscreener: async (identityKey) => {
            dexScreenerCalls++;
            assert.equal(identityKey, "SOL");
            return 100;
          },
        },
      );

    assert.deepEqual(result, {
      source: "dexscreener",
      price: 100,
    });

    assert.equal(jupiterCalls, 0);
    assert.equal(dexScreenerCalls, 1);
  });

  it("confirms a dynamic Jupiter-CA price through DexScreener using the same CA", async () => {
    let jupiterCaCalls = 0;
    let dexScreenerCaCalls = 0;
    let receivedIdentity: string | null = null;

    const result =
      await fetchIndependentFirstPushSecondary(
        {
          kind: "dynamic-ca",
          key: MAINNET_CA,
        },
        "jupiter-ca",
        {
          "jupiter-ca": async () => {
            jupiterCaCalls++;
            return 999;
          },
          "dexscreener-ca": async (identityKey) => {
            dexScreenerCaCalls++;
            receivedIdentity = identityKey;
            return 1.23;
          },
        },
      );

    assert.deepEqual(result, {
      source: "dexscreener-ca",
      price: 1.23,
    });

    assert.equal(jupiterCaCalls, 0);
    assert.equal(dexScreenerCaCalls, 1);
    assert.equal(receivedIdentity, MAINNET_CA);
  });

  it("fails closed when the selected independent reader rejects", async () => {
    const result =
      await fetchIndependentFirstPushSecondary(
        {
          kind: "static-symbol",
          key: "SOL",
        },
        "jupiter",
        {
          dexscreener: async () => {
            throw new Error("provider failure");
          },
        },
      );

    assert.equal(result, null);
  });

  it("fails closed when the required independent reader is unavailable", async () => {
    let primaryCalls = 0;

    const result =
      await fetchIndependentFirstPushSecondary(
        {
          kind: "static-symbol",
          key: "BTC",
        },
        "jupiter",
        {
          jupiter: async () => {
            primaryCalls++;
            return 100;
          },
        },
      );

    assert.equal(result, null);
    assert.equal(primaryCalls, 0);
  });
});

describe("CA-change baseline scope", () => {
  it("invalidates dynamic baselines but preserves static baselines", () => {
    assert.equal(
      shouldInvalidatePriceBaselineForMainnetCaChange(true),
      true,
    );

    assert.equal(
      shouldInvalidatePriceBaselineForMainnetCaChange(false),
      false,
    );

    assert.equal(
      shouldInvalidatePriceBaselineForMainnetCaChange(undefined),
      false,
    );
  });
});

describe("identity-change baseline invalidation", () => {
  it("clears price and circuit-breaker state without clearing lifetime counters", () => {
    const state = {
      lastPrice: 123,
      lastPushAt: 1_000,
      lastFreshPriceAt: 900,
      lastPushSig: "signature",
      source: "jupiter-ca",
      cbTripPrice: 150,
      cbConsecutiveTrips: 2,
      consecutiveLowTrustCycles: 4,

      totalPushes: 50,
      totalErrors: 7,
    };

    resetPriceBaselineForIdentityChange(state);

    assert.equal(state.lastPrice, 0);
    assert.equal(state.lastPushAt, 0);
    assert.equal(state.lastFreshPriceAt, 0);
    assert.equal(state.lastPushSig, "");
    assert.equal(state.source, "");
    assert.equal(state.cbTripPrice, 0);
    assert.equal(state.cbConsecutiveTrips, 0);
    assert.equal(state.consecutiveLowTrustCycles, 0);

    assert.equal(state.totalPushes, 50);
    assert.equal(state.totalErrors, 7);
  });
});
