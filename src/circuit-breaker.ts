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
  /**
   * #82 — anchor for the cumulative-drift bound: the baseline this market was at
   * when the current drift window opened, and when that window opened.
   * Zero/absent means "no window open yet"; the next re-baseline opens one.
   */
  cbDriftAnchorPrice?: number;
  cbDriftAnchorAt?: number;
}

export interface CircuitBreakerConfig {
  /** Reject moves larger than this percentage (e.g. 10 = 10%). */
  maxMovePct: number;
  /**
   * Number of consecutive trips at a consistent new price level before the
   * breaker re-baselines (accepting the relocation).  Must be ≥ 1.
   */
  confirmTrips: number;
  /**
   * #82 — maximum CUMULATIVE drift, as a percentage of the anchor price, that
   * confirmed relocations may accumulate inside `driftWindowMs`.
   *
   * `maxMovePct` bounds a single step. It does not bound a sequence of steps:
   * an attacker who holds a manipulated price for `confirmTrips` cycles earns a
   * re-baseline, and can then repeat from the new baseline indefinitely. Each
   * step is legal; the walk is not bounded at all.
   *
   * This is a RATE limit, deliberately, not a hard ceiling. A genuine sustained
   * repricing still completes — it just takes more than one window. A hard
   * ceiling would re-introduce the permanent wedge that #30 fixed.
   *
   * Defaults to 3 × maxMovePct. That number is a policy choice, not a derived
   * one: it should be set from observed volatility on the markets you list.
   */
  maxCumulativeMovePct?: number;
  /** Rolling window for the cumulative bound. Defaults to one hour. */
  driftWindowMs?: number;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number;
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
    // Within threshold — accept.
    //
    // #76: the reset below is load-bearing and must NOT be removed. It is what
    // makes this module's documented invariant hold: "the next push at the
    // normal level resets cbConsecutiveTrips, so the spike can never accumulate
    // to confirmTrips". Deleting it would let an intermittent spike confirm.
    //
    // But a price IDENTICAL to the baseline is not a new observation — it is a
    // republish of what we already had. Treating it as evidence that the market
    // has returned to the old level lets a caller that re-pushes a last-known
    // price silently clear a legitimate relocation run, so a genuine repricing
    // can never reach confirmTrips and the market wedges: exactly the failure
    // #30 fixed. The live cross-cluster path skips rather than re-pushing stale,
    // so this is latent there — it is guarded here because this module is shared
    // and the trap would fire on someone else's ordinary future change.
    if (newPrice !== state.lastPrice) {
      state.cbConsecutiveTrips = 0;
      state.cbTripPrice = 0;
    }
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
    // #82 — a confirmed relocation is necessary but not sufficient. Bound the
    // cumulative drift these re-baselines may accumulate inside a window.
    const nowMs = (cfg.now ?? Date.now)();
    const windowMs = cfg.driftWindowMs ?? 3_600_000;
    const maxCumulative = cfg.maxCumulativeMovePct ?? cfg.maxMovePct * 3;

    const windowOpen =
      state.cbDriftAnchorPrice != null &&
      state.cbDriftAnchorPrice > 0 &&
      state.cbDriftAnchorAt != null &&
      nowMs - state.cbDriftAnchorAt < windowMs;

    if (!windowOpen) {
      // Open a fresh window anchored at the baseline we are moving away from.
      state.cbDriftAnchorPrice = state.lastPrice;
      state.cbDriftAnchorAt = nowMs;
    }

    const anchor = state.cbDriftAnchorPrice as number;
    const cumulativePct = Math.abs((newPrice - anchor) / anchor) * 100;

    if (cumulativePct > maxCumulative) {
      // Refuse the re-baseline. The single step is legal; the walk is not.
      // Deliberately does NOT reset the trip run: the relocation may well be
      // genuine, and once the window rolls over it will confirm on its own.
      emit(
        `🛑 ${state.symbol}: Circuit breaker CUMULATIVE bound — refusing to ` +
          `re-baseline ${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)}. ` +
          `Drift from anchor ${anchor.toFixed(2)} would be ` +
          `${cumulativePct.toFixed(1)}% > ${maxCumulative}% within ` +
          `${Math.round(windowMs / 1000)}s. A sustained walk cannot re-baseline ` +
          `past this bound one legal step at a time.`,
      );
      return false;
    }

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
