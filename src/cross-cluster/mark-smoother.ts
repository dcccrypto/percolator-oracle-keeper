/**
 * cross-cluster/mark-smoother.ts — robust AuthMark from noisy spot readings.
 *
 * WHY THIS EXISTS (2026-07-31, the CATE LP drain — part 2)
 * --------------------------------------------------------
 * The slot watermark (price-reader.ts) removed stale-RPC flapping — and the
 * two-level ±1.6% oscillation on CATE SURVIVED it. Direct mainnet sampling at
 * strictly increasing slots proved the pool itself oscillates: the token was
 * being bot-churned (25 swaps/second; +0.66% moves within 4 slots), with
 * round-trips flipping the spot between two levels for runs of 30–60s.
 *
 * Publishing raw instantaneous spot as the settlement mark feeds that
 * oscillation straight into the engine, which ratchets it into permanent LP
 * losses (losses realize in full; gains for an underwater account are
 * support-gated to zero). Real bot churn is normal for a trending memecoin,
 * so the mark — not the market — has to absorb it.
 *
 * THE ESTIMATOR: per-pool median over a trailing time window (default 90s at
 * the keeper's ~7s cadence ≈ 12 samples).
 *   - A ping-pong where one level holds a majority of the window: the median
 *     sits ON the majority level and never flips.
 *   - A perfectly balanced ping-pong: the median sits between the two levels —
 *     which IS the fair price of a round-tripping pool.
 *   - A genuine sustained move: the median follows with ~half-window lag
 *     (~45s), which the engine's own 4 bps/slot absorption clamp makes
 *     irrelevant.
 *   - An EWMA was rejected: it never fully rejects the transient level (every
 *     excursion drags the mean), and it is not robust to a single wild
 *     outlier. The median ignores both until they hold a majority.
 *
 * Cold start / gaps: below `minSamples` readings in the window the latest raw
 * price passes through unchanged — a freshly listed market prices immediately,
 * and a long outage (window fully evicted) re-primes the same way.
 */

interface Sample {
  t: number;
  px: bigint;
}

export interface MarkSmootherOptions {
  /** Trailing window the median is computed over (ms). */
  windowMs?: number;
  /** Below this many samples in the window, pass the raw price through. */
  minSamples?: number;
}

/**
 * 180s, not 90s: live measurement after the first deploy (2026-07-31) showed
 * CATE's churn runs stretch to 50–70s, so a 90s window still let the median's
 * majority flip about once a minute (half-gap steps of ~36 units). A window
 * must comfortably exceed 2× the longest churn run to pin the majority level;
 * 180s fully suppresses runs up to ~90s. The cost — genuine regime shifts
 * surface with ~90s lag — is immaterial: the engine only absorbs 4 bps/slot,
 * so a 160 bps move takes minutes to settle in regardless.
 */
const DEFAULT_WINDOW_MS = 180_000;
const DEFAULT_MIN_SAMPLES = 3;
/** Hard per-pool cap so a misbehaving caller cannot grow memory unbounded. */
const MAX_SAMPLES_PER_POOL = 64;

export interface MarkSmoother {
  /**
   * Record `priceE6` for `poolAddress` at `nowMs` and return the smoothed
   * mark to publish this cycle.
   */
  smooth(poolAddress: string, priceE6: bigint, nowMs: number): bigint;
  /** Drop every window (tests / registry rebuilds). */
  reset(): void;
}

/** Median of a non-empty list; even lengths average the two middles. */
function medianE6(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

export function createMarkSmoother(opts: MarkSmootherOptions = {}): MarkSmoother {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const windows = new Map<string, Sample[]>();

  return {
    smooth(poolAddress: string, priceE6: bigint, nowMs: number): bigint {
      let win = windows.get(poolAddress);
      if (!win) {
        win = [];
        windows.set(poolAddress, win);
      }
      win.push({ t: nowMs, px: priceE6 });
      // Evict by age, then by count (oldest first — the array is append-only
      // in time order; a caller stepping time backwards just evicts nothing).
      const cutoff = nowMs - windowMs;
      let firstLive = 0;
      while (firstLive < win.length && win[firstLive].t < cutoff) firstLive++;
      if (firstLive > 0) win.splice(0, firstLive);
      if (win.length > MAX_SAMPLES_PER_POOL) win.splice(0, win.length - MAX_SAMPLES_PER_POOL);

      if (win.length < minSamples) return priceE6;
      // Compute over an EVEN count (drop the single oldest sample when odd):
      // an odd-count median flips by parity under a balanced two-level
      // ping-pong (7:6 → level A, then 6:7 → level B every push) — the exact
      // oscillation this module exists to remove. An even count averages the
      // two middles: majority churn still pins to the majority level, and
      // balanced churn yields the stable midpoint (the fair price of a pool a
      // bot round-trips symmetrically).
      // (A single-sample window has nothing older to drop — use it as-is.)
      const usable = win.length % 2 === 0 || win.length === 1 ? win : win.slice(1);
      return medianE6(usable.map((s) => s.px));
    },
    reset(): void {
      windows.clear();
    },
  };
}
