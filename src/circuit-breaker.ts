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

/** One observation of the published mark: `price` was in force at time `at`. */
export interface MarkObservation {
  readonly price: number;
  readonly at: number;
}

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
   * #82 / #125 — the trailing-window extremes of the PUBLISHED mark, as two
   * monotonic deques of (price, last time that price was in force):
   *   - `cbWindowMax`: prices strictly decreasing front→back; the front is the
   *     highest mark in force at any time in the trailing window.
   *   - `cbWindowMin`: prices strictly increasing front→back; the front is the
   *     lowest.
   * An entry that a later, more extreme observation dominates can never be the
   * window max/min again and is dropped, so both stay short in practice.
   *
   * Arrays are never mutated in place — every update assigns a fresh array — so
   * a shallow copy of the state is a complete, independent copy.
   */
  cbWindowMax?: readonly MarkObservation[];
  cbWindowMin?: readonly MarkObservation[];
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
   * #82 / #125 — maximum TOTAL movement of the published mark inside any
   * trailing `driftWindowMs`, as a percentage.
   *
   * `maxMovePct` bounds a single step. It does not bound a sequence of steps:
   * an attacker who holds a manipulated price for `confirmTrips` cycles earns a
   * re-baseline, and can then repeat from the new baseline; and a walk of
   * sub-`maxMovePct` steps never trips at all.
   *
   * The bound: every published price p at time t satisfies, for every mark m
   * that was in force at any time in [t − driftWindowMs, t],
   *     m × (1 − maxCumulativeMovePct/100) ≤ p ≤ m × (1 + maxCumulativeMovePct/100).
   * It applies to in-threshold steps and confirmed relocations alike, and the
   * window slides with every check, so there is no boundary to straddle.
   *
   * This is a RATE limit, deliberately, not a hard ceiling. A genuine sustained
   * repricing still completes — it just takes more than one window. A hard
   * ceiling would re-introduce the permanent wedge that #30 fixed.
   *
   * Defaults to 3 × maxMovePct. That number is a policy choice, not a derived
   * one: it should be set from observed volatility on the markets you list.
   */
  maxCumulativeMovePct?: number;
  /** Trailing window for the cumulative bound. Defaults to one hour. */
  driftWindowMs?: number;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional log sink — defaults to console.log. */
  log?: (msg: string) => void;
}

const DEFAULT_DRIFT_WINDOW_MS = 3_600_000;

function lastAt(dq: readonly MarkObservation[] | undefined): number {
  return dq && dq.length > 0 ? dq[dq.length - 1].at : Number.NEGATIVE_INFINITY;
}

function pushDominating(
  dq: readonly MarkObservation[] | undefined,
  obs: MarkObservation,
  dominates: (newer: number, older: number) => boolean,
): MarkObservation[] {
  const out = dq ? dq.slice() : [];
  while (out.length > 0 && dominates(obs.price, out[out.length - 1].price)) out.pop();
  out.push(obs);
  return out;
}

/**
 * #125 — record that `price` was the mark in force at `atMs`.
 *
 * The breaker calls this itself for `lastPrice` on every check. The keeper loop
 * also calls it when a push lands, for the mark being replaced (it was in force
 * until that moment) and for the new one. Timestamps never go backwards: an
 * out-of-order `atMs` is lifted to the newest recorded time, which only keeps an
 * observation in the window longer (the conservative direction).
 */
export function recordMarkInForce(
  state: CircuitBreakerState,
  price: number,
  atMs: number,
): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const at = Math.max(atMs, lastAt(state.cbWindowMax), lastAt(state.cbWindowMin));
  const obs: MarkObservation = { price, at };
  state.cbWindowMax = pushDominating(state.cbWindowMax, obs, (n, o) => n >= o);
  state.cbWindowMin = pushDominating(state.cbWindowMin, obs, (n, o) => n <= o);
}

/** Drop observations that left the trailing window. `at` exactly at the cutoff stays in. */
function pruneWindow(state: CircuitBreakerState, nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs;
  const prune = (dq: readonly MarkObservation[] | undefined) => {
    if (!dq) return dq;
    let i = 0;
    while (i < dq.length && dq[i].at < cutoff) i++;
    return i === 0 ? dq : dq.slice(i);
  };
  state.cbWindowMax = prune(state.cbWindowMax);
  state.cbWindowMin = prune(state.cbWindowMin);
}

/**
 * The band a price published now must fall in: [max × (1 − B), min × (1 + B)]
 * over every mark in force during the trailing window. Also returns when the
 * binding extreme on each side leaves the window (for the log line).
 */
export function markWindowBand(
  state: CircuitBreakerState,
  maxCumulativePct: number,
  windowMs: number,
): { lo: number; hi: number; hiFreesAt: number; loFreesAt: number } | null {
  const max = state.cbWindowMax?.[0];
  const min = state.cbWindowMin?.[0];
  if (!max || !min) return null;
  const b = maxCumulativePct / 100;
  return {
    lo: max.price * (1 - b),
    hi: min.price * (1 + b),
    hiFreesAt: min.at + windowMs,
    loFreesAt: max.at + windowMs,
  };
}

/**
 * Where `newPrice` may go given the band [lo, hi]:
 *   - `inside` — newPrice is in the band (edges inclusive): publish it as-is.
 *   - `edge`   — outside, but the band edge is strictly between the current
 *                baseline and newPrice: advance to the edge.
 *   - `spent`  — outside, and the baseline is already at (or past) the edge:
 *                nothing can be published in that direction until the binding
 *                extreme leaves the window.
 */
function bandTarget(
  lastPrice: number,
  newPrice: number,
  lo: number,
  hi: number,
): { kind: "inside" } | { kind: "edge"; edge: number } | { kind: "spent"; edge: number } {
  if (newPrice >= lo && newPrice <= hi) return { kind: "inside" };
  const up = newPrice > hi;
  const edge = up ? hi : lo;
  // Only a move TOWARD newPrice counts as progress; never pull the baseline
  // backwards (unreachable through this module, but state can be injected).
  const progress = up
    ? edge > lastPrice && edge < newPrice
    : edge < lastPrice && edge > newPrice;
  return progress ? { kind: "edge", edge } : { kind: "spent", edge };
}

/**
 * Returns the price to publish, or `null` if nothing should be published.
 *
 * The returned price is `newPrice` itself except when the cumulative bound
 * applies (see below), in which case it is the band edge. A caller MUST publish
 * the returned value, never `newPrice`, and must not read the result as a
 * boolean "publish newPrice" signal.
 *
 * Mutates `state` to track trip counts, to record the mark in force in the
 * trailing window, and to re-baseline lastPrice when a sustained relocation is
 * confirmed (to the returned price). An in-threshold acceptance does not touch
 * lastPrice — the caller advances it once the returned price is actually
 * published.
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
 * Cumulative bound as a ROLLING rate limit (#82, #116, #125):
 *   Every check first records `lastPrice` as "in force now", then computes the
 *   band [max × (1 − B), min × (1 + B)] over every mark in force during the
 *   trailing `driftWindowMs`. NOTHING is published outside it — neither a
 *   confirmed relocation nor an in-threshold step. A price beyond the band is
 *   advanced to the band edge; once the baseline sits at the edge nothing more
 *   is published in that direction until the binding extreme ages out.
 *
 *   #116 made the bound a rate limit (publish the edge, don't refuse forever),
 *   but it only existed inside a FIXED window that a confirmed relocation
 *   opened. #125 showed three ways past it: (1) sub-maxMovePct creep never
 *   confirms, so never opened a window (1%/cycle walked 100 → ~15,000 in an
 *   hour); (2) a move straddling a window boundary got the old window's edge
 *   and then a fresh budget from the new anchor (1.69× in ~63 min); (3) pulses
 *   timed at each boundary during a crash re-spent a fresh budget per window
 *   and pushed the mark ABOVE the pre-crash price while the pool sat at 10%.
 *   A band over the trailing window of published marks has no window to open
 *   and no boundary to straddle.
 *
 *   Publishing the clamped edge rather than holding the old mark is deliberate.
 *   For a genuine move the edge is strictly between the old mark and the real
 *   price, so the published mark is strictly less wrong than holding. For a
 *   manipulated move the edge is exactly the displacement the bound allows per
 *   trailing window, and a relocation still needs the full confirmTrips run of
 *   consecutive, mutually consistent trips first — a spike that reverts before
 *   confirming moves nothing.
 */
export function checkCircuitBreaker(
  state: CircuitBreakerState,
  newPrice: number,
  cfg: CircuitBreakerConfig,
): number | null {
  const emit = cfg.log ?? console.log;

  if (state.lastPrice === 0) return newPrice; // First price — always accept.

  const nowMs = (cfg.now ?? Date.now)();
  const windowMs = cfg.driftWindowMs ?? DEFAULT_DRIFT_WINDOW_MS;
  const maxCumulative = cfg.maxCumulativeMovePct ?? cfg.maxMovePct * 3;

  // #125 — the current baseline is the mark in force right now. Recording it on
  // EVERY check (not only when it was first published) is what makes the window
  // measure "was in force at any time in the trailing window", so a mark that
  // was held for an hour stays binding until an hour after it was replaced.
  pruneWindow(state, nowMs, windowMs);
  recordMarkInForce(state, state.lastPrice, nowMs);
  const band = markWindowBand(state, maxCumulative, windowMs);
  if (!band) return null; // unreachable: lastPrice was just recorded. Fail closed.
  const retryInS = (up: boolean) =>
    Math.max(0, Math.round(((up ? band.hiFreesAt : band.loFreesAt) - nowMs) / 1000));

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

    // #125 — in-threshold steps are bounded by the same trailing band. Before,
    // they were bounded only inside a window a confirmed relocation had opened,
    // so a walk of sub-maxMovePct steps was not bounded at all.
    const t = bandTarget(state.lastPrice, newPrice, band.lo, band.hi);
    if (t.kind === "edge") return t.edge;
    if (t.kind === "spent") {
      emit(
        `🛑 ${state.symbol}: Circuit breaker CUMULATIVE bound — holding ` +
          `${state.lastPrice.toFixed(2)} (price ${newPrice.toFixed(2)}, trailing ` +
          `band ${band.lo.toFixed(2)}–${band.hi.toFixed(2)} = ±${maxCumulative}% ` +
          `over ${Math.round(windowMs / 1000)}s); next step in ~` +
          `${retryInS(newPrice > band.hi)}s.`,
      );
      return null;
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
    // #82 — a confirmed relocation is necessary but not sufficient: it must
    // also fit the trailing band.
    const t = bandTarget(state.lastPrice, newPrice, band.lo, band.hi);
    const up = newPrice > state.lastPrice;

    if (t.kind === "spent") {
      // The band is exhausted in this direction. Deliberately does NOT reset
      // the trip run: the relocation is still being observed, and it resumes on
      // the first confirmed trip after the binding extreme leaves the window.
      emit(
        `🛑 ${state.symbol}: Circuit breaker CUMULATIVE bound — holding ` +
          `${state.lastPrice.toFixed(2)} (target ${newPrice.toFixed(2)}); ` +
          `trailing band ${band.lo.toFixed(2)}–${band.hi.toFixed(2)} ` +
          `(±${maxCumulative}% over ${Math.round(windowMs / 1000)}s) is spent, ` +
          `next step in ~${retryInS(up)}s.`,
      );
      return null;
    }

    let accepted = newPrice;
    if (t.kind === "edge") {
      // #116 — advance to the band edge instead of refusing forever.
      emit(
        `🟠 ${state.symbol}: Circuit breaker CUMULATIVE bound — rate-limiting ` +
          `relocation ${state.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} ` +
          `to the band edge ${t.edge.toFixed(2)} (trailing band ` +
          `${band.lo.toFixed(2)}–${band.hi.toFixed(2)}, ±${maxCumulative}%). ` +
          `Next step in ~${retryInS(up)}s.`,
      );
      accepted = t.edge;
    } else {
      // Sustained relocation confirmed inside the band: re-baseline and accept.
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
