const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PricingIdentityKind =
  | "static-symbol"
  | "dynamic-ca";

export type OraclePriceSource =
  | "pyth"
  | "jupiter"
  | "dexscreener"
  | "jupiter-ca"
  | "dexscreener-ca";

export interface PricingIdentity {
  kind: PricingIdentityKind;
  key: string;
}

export interface FirstPushSecondaryPrice {
  source: OraclePriceSource;
  price: number;
}

/**
 * Provider readers are injected so tests can prove that the primary provider
 * is never called again as its own "independent" confirmation source.
 */
export type FirstPushPriceReaders = Partial<
  Record<
    OraclePriceSource,
    (identityKey: string) => Promise<number | null>
  >
>;

export interface MarketIdentityInput {
  symbol: string;
  slab?: string;
  isDynamic?: boolean;
}

export interface MutablePriceBaseline {
  lastPrice: number;
  lastPushAt: number;
  lastFreshPriceAt: number;
  lastPushSig: string;
  source: string;
  cbTripPrice: number;
  cbConsecutiveTrips: number;
  consecutiveLowTrustCycles: number;
}

/**
 * Resolve the authoritative asset identity for price routing.
 *
 * Dynamic markets:
 * - require slab -> mainnet_ca mapping
 * - never fall back to symbol
 *
 * Static markets:
 * - require an explicitly allowlisted symbol
 * - completely ignore any stale slab -> CA mapping
 */
export function resolvePricingIdentity(
  market: MarketIdentityInput,
  slabToMainnetCa: ReadonlyMap<string, string>,
  allowedStaticSymbols: ReadonlySet<string>,
): PricingIdentity | null {
  if (market.isDynamic === true) {
    if (!market.slab) return null;

    const mainnetCa = slabToMainnetCa.get(market.slab);
    if (!mainnetCa || !SOLANA_ADDRESS_RE.test(mainnetCa)) {
      return null;
    }

    return {
      kind: "dynamic-ca",
      key: mainnetCa,
    };
  }

  const symbol = market.symbol.trim().toUpperCase();
  if (!symbol || !allowedStaticSymbols.has(symbol)) {
    return null;
  }

  return {
    kind: "static-symbol",
    key: symbol,
  };
}

export function isStaticPythFirstPushExempt(
  identityKind: PricingIdentityKind,
  source: string,
): boolean {
  return identityKind === "static-symbol" && source === "pyth";
}

/**
 * Select exactly one independent secondary source.
 *
 * The identity mode must stay unchanged:
 * - static primary -> static secondary
 * - CA primary -> CA secondary
 *
 * The provider must also change:
 * - Jupiter -> DexScreener
 * - DexScreener -> Jupiter
 */
export function selectIndependentFirstPushSecondary(
  identityKind: PricingIdentityKind,
  primarySource: string,
): OraclePriceSource | null {
  if (identityKind === "static-symbol") {
    if (primarySource === "jupiter") return "dexscreener";
    if (primarySource === "dexscreener") return "jupiter";
    return null;
  }

  if (primarySource === "jupiter-ca") return "dexscreener-ca";
  if (primarySource === "dexscreener-ca") return "jupiter-ca";

  return null;
}

/**
 * Fetch exactly one policy-approved independent secondary price.
 *
 * The selected reader receives the same authoritative identity key as the
 * primary path:
 *
 * - static-symbol -> normalized static symbol
 * - dynamic-ca    -> mainnet contract address
 */
export async function fetchIndependentFirstPushSecondary(
  identity: PricingIdentity,
  primarySource: string,
  readers: FirstPushPriceReaders,
): Promise<FirstPushSecondaryPrice | null> {
  const secondarySource =
    selectIndependentFirstPushSecondary(
      identity.kind,
      primarySource,
    );

  if (!secondarySource) return null;

  const reader = readers[secondarySource];
  if (!reader) return null;

  const price = await reader(identity.key);
  if (!isValidPrice(price)) return null;

  return {
    source: secondarySource,
    price,
  };
}

function isValidPrice(value: number | null): value is number {
  return (
    value !== null &&
    Number.isFinite(value) &&
    value > 0
  );
}

/**
 * Validate an actual first-push primary/secondary pair.
 *
 * This rejects:
 * - the same provider confirming itself
 * - static/CA identity-mode crossover
 * - an unexpected secondary provider
 * - unavailable, non-positive, or non-finite prices
 * - invalid tolerances
 */
export function validateFirstPushSecondary(
  identityKind: PricingIdentityKind,
  primarySource: string,
  secondarySource: string,
  primaryPrice: number,
  secondaryPrice: number | null,
  maxMovePct: number,
): boolean {
  const expectedSecondary = selectIndependentFirstPushSecondary(
    identityKind,
    primarySource,
  );

  if (
    expectedSecondary === null ||
    secondarySource !== expectedSecondary
  ) {
    return false;
  }

  if (
    !isValidPrice(primaryPrice) ||
    !isValidPrice(secondaryPrice) ||
    !Number.isFinite(maxMovePct) ||
    maxMovePct < 0 ||
    maxMovePct >= 100
  ) {
    return false;
  }

  const movePct =
    Math.abs((primaryPrice - secondaryPrice) / secondaryPrice) * 100;

  return movePct <= maxMovePct;
}

/**
 * Only dynamic markets derive their authoritative asset identity from
 * mainnet_ca. Static markets must be completely isolated from CA-cache changes.
 */
export function shouldInvalidatePriceBaselineForMainnetCaChange(
  isDynamic: boolean | undefined,
): boolean {
  return isDynamic === true;
}

/**
 * A CA change means a dynamic market may now represent a different asset.
 *
 * Any cached price or circuit-breaker baseline from the previous CA must not
 * survive into the new identity. Operational lifetime counters are intentionally
 * outside this interface and therefore remain untouched.
 */
export function resetPriceBaselineForIdentityChange(
  state: MutablePriceBaseline,
): void {
  state.lastPrice = 0;
  state.lastPushAt = 0;
  state.lastFreshPriceAt = 0;
  state.lastPushSig = "";
  state.source = "";
  state.cbTripPrice = 0;
  state.cbConsecutiveTrips = 0;
  state.consecutiveLowTrustCycles = 0;
}
