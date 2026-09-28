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

/** The open #82 drift window, or null when none is open at `nowMs`. */
function openDriftWindow(
  state: CircuitBreakerState,
  nowMs: number,
  windowMs: number,
): { anchor: number; openedAt: number } | null {
  if (
    state.cbDriftAnchorPrice != null &&
    state.cbDriftAnchorPrice > 0 &&
    state.cbDriftAnchorAt != null &&
    nowMs - state.cbDriftAnchorAt < windowMs
  ) {
    return { anchor: state.cbDriftAnchorPrice, openedAt: state.cbDriftAnchorAt };
  }
  return null;
}

/**
 * Where `newPrice` may go inside a window anchored at `anchor`:
 *   - `inside`   — within anchor ± maxCumulative: publish newPrice as-is.
 *   - `edge`     — outside, but the bound edge is strictly between the current
 *                  baseline and newPrice: advance to the edge.
 *   - `spent`    — outside, and the baseline is already at (or past) the edge:
 *                  this window has nothing left to give.
 */
function boundTarget(
  lastPrice: number,
  newPrice: number,
  anchor: number,
  maxCumulative: number,
): { kind: "inside" } | { kind: "edge"; edge: number } | { kind: "spent"; edge: number } {
  const cumulativePct = Math.abs((newPrice - anchor) / anchor) * 100;
  if (cumulativePct <= maxCumulative) return { kind: "inside" };
  const up = newPrice > anchor;
  const edge = anchor * (1 + (up ? 1 : -1) * (maxCumulative / 100));
  // Only a move TOWARD newPrice counts as progress; never pull the baseline
  // backwards (in-threshold steps taken before the window opened can leave it
  // beyond the edge).
  const progress = up
    ? edge > lastPrice && edge < newPrice
    : edge < lastPrice && edge > newPrice;
  return progress ? { kind: "edge", edge } : { kind: "spent", edge };
}

/**
 * Returns the price to publish, or `null` if nothing should be published.
 *
 * The returned price is `newPrice` itself except when the #82 cumulative bound
 * applies (see below), in which case it is the bound edge. A caller MUST publish
 * the returned value, never `newPrice`, and must not read the result as a
 * boolean "publish newPrice" signal.
 *
 * Mutates `state` to track trip counts, to open the #82 drift window, and to
 * re-baseline lastPrice when a sustained relocation is confirmed (to the
 * returned price). An in-threshold acceptance does not touch lastPrice — the
 * caller advances it once the returned price is actually published.
 *
 * Relocation recovery (issue #30):
 *   A one-off spike is blocked every time it arrives (the next push at the
 *   normal level resets cbConsecutiveTrips, so the spike can never accumulate
 *   to confirmTrips).  A genuine, sustained relocation — where the same
 *   approximate new price keeps arriving on successive push cycles without
 *   itself varying by more than maxMovePct — is accepted after confirmTrips
 *   consecutive trips and lastPrice is re-baselined so subsequent pushes at
 *   that new level are no longer blocked.
 *
 * Cumulative bound as a RATE limit (#82, #116):
 *   A confirmed relocation opens a drift window (anchor = the baseline it moved
 *   away from). While the window is open, NOTHING is published outside
 *   anchor ± maxCumulativeMovePct — neither a confirmed relocation nor an
 *   in-threshold step. A price beyond the bound is advanced to the bound edge,
 *   anchor × (1 ± maxCumulativeMovePct); once the baseline sits at the edge the
 *   rest of the window publishes nothing further in that direction. The next
 *   confirmed relocation after the window expires re-anchors at the (advanced)
 *   baseline, so a held +100% move converges over a few windows
 *   (553 → 719 → 935 → 1108) instead of being refused forever.
 *
 *   It used to refuse without advancing lastPrice. Every new window then
 *   re-anchored at the same stale lastPrice and measured the same >bound
 *   distance, so any held move larger than the bound was refused on every
 *   window, permanently — the wedge #30 fixed, reintroduced by #82 (SOLCAT
 *   +50%, KARDASHEV +67–100% sat frozen for hours on 2026-09-28).
 *
 *   Publishing the clamped edge rather than holding the old mark is deliberate.
 *   For a genuine move the edge is strictly between the old mark and the real
 *   price, so the published mark is strictly less wrong than holding. For a
 *   manipulated move the edge is exactly the displacement the bound already
 *   allowed per window, and it still needs the full confirmTrips run of
 *   consecutive, mutually consistent trips first — a spike that reverts before
 *   confirming moves nothing.
 *
 *   Not covered (unchanged): a walk made only of in-threshold steps never
 *   confirms a relocation, so it never opens a window.
 */
export function checkCircuitBreaker(
  state: CircuitBreakerState,
  newPrice: number,
  cfg: CircuitBreakerConfig,
): number | null {
  const emit = cfg.log ?? console.log;

  if (state.lastPrice === 0) return newPrice; // First price — always accept.

  const nowMs = (cfg.now ?? Date.now)();
  const windowMs = cfg.driftWindowMs ?? 3_600_000;
  const maxCumulative = cfg.maxCumulativeMovePct ?? cfg.maxMovePct * 3;
  const retryInS = (openedAt: number) =>
    Math.max(0, Math.round((openedAt + windowMs - nowMs) / 1000));

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

    // #116 — inside an open window an in-threshold step is bounded too.
    // Otherwise a relocation clamped to the edge could step a further
    // maxMovePct past it immediately, and the bound would be edge + one step.
    const w = openDriftWindow(state, nowMs, windowMs);
    if (w) {
      const t = boundTarget(state.lastPrice, newPrice, w.anchor, maxCumulative);
      if (t.kind === "edge") return t.edge;
      if (t.kind === "spent") {
        emit(
          `🛑 ${state.symbol}: Circuit breaker CUMULATIVE bound — holding ` +
            `${state.lastPrice.toFixed(2)} (price ${newPrice.toFixed(2)}, edge ` +
            `${t.edge.toFixed(2)} from anchor ${w.anchor.toFixed(2)} ± ` +
            `${maxCumulative}%); next step in ~${retryInS(w.openedAt)}s.`,
        );
        return null;
      }
    }
    return newPrice;
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
    let w = openDriftWindow(state, nowMs, windowMs);
    if (!w) {
      // Open a fresh window anchored at the baseline we are moving away from.
      state.cbDriftAnchorPrice = state.lastPrice;
      state.cbDriftAnchorAt = nowMs;
      w = { anchor: state.lastPrice, openedAt: nowMs };
    }

    const t = boundTarget(state.lastPrice, newPrice, w.anchor, maxCumulative);
    const cumulativePct = Math.abs((newPrice - w.anchor) / w.anchor) * 100;

    if (t.kind === "spent") {
      // This window's budget in this direction is used up. Deliberately does
      // NOT reset the trip run: the relocation is still being observed, and it
      // resumes on the first confirmed trip after the window rolls.
      emit(
        `🛑 ${state.symbol}: Circuit breaker CUMULATIVE bound — holding ` +
          `${state.lastPrice.toFixed(2)} (target ${newPrice.toFixed(2)}). ` +
          `Drift from anchor ${w.anchor.toFixed(2)} would be ` +
          `${cumulativePct.toFixed(1)}% > ${maxCumulative}%; this window's ` +
          `budget is spent, next step in ~${retryInS(w.openedAt)}s.`,
      );
      return null;
    }

    let accepted = newPrice;
    if (t.kind === "edge") {
      // #116 — advance to the bound edge instead of refusing forever.
      emit(
        `🟠 ${state.symbol}: Circuit breaker CUMULATIVE bound — rate-limiting ` +
          `relocation ${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} ` +
          `to the bound edge ${t.edge.toFixed(2)} (anchor ${w.anchor.toFixed(2)} ` +
          `± ${maxCumulative}%; target is ${cumulativePct.toFixed(1)}% away). ` +
          `Next step in ~${retryInS(w.openedAt)}s.`,
      );
      accepted = t.edge;
    } else {
      // Sustained relocation confirmed inside the bound: re-baseline and accept.
      emit(
        `🟡 ${state.symbol}: Circuit breaker relocation confirmed after ` +
          `${state.cbConsecutiveTrips} trips — re-baselining ` +
          `${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} ` +
          `(${movePct.toFixed(1)}% move)`,
      );
    }
    state.lastPrice = accepted;
    state.cbConsecutiveTrips = 0;
    state.cbTripPrice = 0;
    return accepted;
  }

  // Not yet confirmed — block this push.
  emit(
    `🔴 ${state.symbol}: Circuit breaker! ` +
      `${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} ` +
      `(${movePct.toFixed(1)}% > ${cfg.maxMovePct}%) ` +
      `[${state.cbConsecutiveTrips}/${cfg.confirmTrips} confirmation trips]`,
  );
  return null;
}
