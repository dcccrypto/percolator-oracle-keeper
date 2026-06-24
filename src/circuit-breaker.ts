/**
 * Circuit-breaker logic for the oracle keeper.
 *
 * Kept in a standalone module so unit tests can import the pure helpers
 * without triggering the oracle keeper's module-level side-effects
 * (RPC connection, keypair load, etc.).
 *
 * Issue #30 fix: a genuine, sustained price relocation (the same new level
 * arriving on CONFIRM_TRIPS successive push cycles) is accepted and
 * re-baselined rather than wedging the market permanently until restart.
 */

/** Subset of MarketStats fields that the circuit-breaker needs to read/write. */
export interface CircuitBreakerState {
  symbol: string;
  lastPrice: number;
  circuitBreakerTrips: number;
  /** Price at the first trip in the current consecutive-trip run. */
  cbTripPrice: number;
  /** How many consecutive trips have occurred near cbTripPrice. */
  cbConsecutiveTrips: number;
}

export interface CircuitBreakerConfig {
  /** Reject moves larger than this percentage (e.g. 10 = 10%). */
  maxMovePct: number;
  /**
   * Number of consecutive trips at a consistent new price level before the
   * breaker re-baselines (accepting the relocation).  Must be ≥ 1.
   */
  confirmTrips: number;
  /** Optional log sink — defaults to console.log. */
  log?: (msg: string) => void;
}

/**
 * Returns true if the price should be accepted for an on-chain push,
 * false if it should be blocked.
 *
 * Mutates `state` to track trip counts and to re-baseline lastPrice when a
 * sustained relocation is confirmed.
 *
 * Relocation recovery (issue #30):
 *   A one-off spike is blocked every time it arrives (the next push at the
 *   normal level resets cbConsecutiveTrips, so the spike can never accumulate
 *   to confirmTrips).  A genuine, sustained relocation — where the same
 *   approximate new price keeps arriving on successive push cycles without
 *   itself varying by more than maxMovePct — is accepted after confirmTrips
 *   consecutive trips and lastPrice is re-baselined so subsequent pushes at
 *   that new level are no longer blocked.
 */
export function checkCircuitBreaker(
  state: CircuitBreakerState,
  newPrice: number,
  cfg: CircuitBreakerConfig,
): boolean {
  const emit = cfg.log ?? console.log;

  if (state.lastPrice === 0) return true; // First price — always accept.

  const movePct =
    Math.abs((newPrice - state.lastPrice) / state.lastPrice) * 100;

  if (movePct <= cfg.maxMovePct) {
    // Within threshold — reset the consecutive-trip counter and accept.
    state.cbConsecutiveTrips = 0;
    state.cbTripPrice = 0;
    return true;
  }

  // Price exceeds the breaker threshold.
  state.circuitBreakerTrips++;

  // Determine whether this trip clusters near the ongoing run.
  const tripPriceConsistent =
    state.cbTripPrice > 0 &&
    Math.abs((newPrice - state.cbTripPrice) / state.cbTripPrice) * 100 <=
      cfg.maxMovePct;

  if (tripPriceConsistent) {
    // Same approximate level — advance the run.
    state.cbConsecutiveTrips++;
  } else {
    // Different level (or first trip in run) — start a new run.
    state.cbConsecutiveTrips = 1;
    state.cbTripPrice = newPrice;
  }

  if (state.cbConsecutiveTrips >= cfg.confirmTrips) {
    // Sustained relocation confirmed: re-baseline and accept.
    emit(
      `🟡 ${state.symbol}: Circuit breaker relocation confirmed after ` +
        `${state.cbConsecutiveTrips} trips — re-baselining ` +
        `${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} ` +
        `(${movePct.toFixed(1)}% move)`,
    );
    state.lastPrice = newPrice;
    state.cbConsecutiveTrips = 0;
    state.cbTripPrice = 0;
    return true;
  }

  // Not yet confirmed — block this push.
  emit(
    `🔴 ${state.symbol}: Circuit breaker! ` +
      `${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} ` +
      `(${movePct.toFixed(1)}% > ${cfg.maxMovePct}%) ` +
      `[${state.cbConsecutiveTrips}/${cfg.confirmTrips} confirmation trips]`,
  );
  return false;
}
