/**
 * cross-cluster/refresh-coordination.ts
 *
 * Shared state between the recovery cranker and the push loop, kept in its own
 * module so neither imports the other.
 *
 * 1. Push holds. A no-observation refresh crank is accepted only while the
 *    market's latest pushed mark equals the mark the last accrual used; once a
 *    new PushAuthMark lands, a refresh returns Custom(22) until the next
 *    accrual (which re-stales the whole cohort again). When a market has more
 *    positioned portfolios than one transaction can refresh, the cranker sends
 *    the rest as follow-up transactions and holds that market's pushes until
 *    they land, so they share the accrual's price window. A hold always
 *    expires on its own (`untilMs`), so a cranker that dies mid-hold cannot
 *    freeze a market's price.
 *
 * 2. Per-market crank refresh health, written by the cranker every cycle and
 *    read by the /health handler.
 */

/** Longest a push hold may last, whatever the caller asks for. */
export const MAX_PUSH_HOLD_MS = 15_000;

const holds = new Map<string, number>();

/** Hold pushes for `market` for `ms` (capped at MAX_PUSH_HOLD_MS). */
export function holdPushes(market: string, ms: number, nowMs: number = Date.now()): void {
  holds.set(market, nowMs + Math.max(0, Math.min(ms, MAX_PUSH_HOLD_MS)));
}

export function releasePushes(market: string): void {
  holds.delete(market);
}

/** True while a hold for `market` is active. Expired holds are dropped. */
export function isPushHeld(market: string, nowMs: number = Date.now()): boolean {
  const until = holds.get(market);
  if (until === undefined) return false;
  if (nowMs >= until) {
    holds.delete(market);
    return false;
  }
  return true;
}

export interface CrankRefreshHealth {
  /** stale_account_count_long/short at this cycle's pre-crank read. */
  staleLong: number;
  staleShort: number;
  /** stale counts after this cycle's cranks (simulated post-state or a verification read); null = unknown. */
  postStaleLong: number | null;
  postStaleShort: number | null;
  /** Positioned portfolios this cycle tried to refresh. */
  positioned: number;
  /** Refreshes that did not fit the accrual transaction this cycle. */
  overflow: number;
  /** ... of which landed in follow-up transactions. */
  overflowRefreshed: number;
  /** Why the follow-up refreshes did not all land (null = they did, or there were none). */
  overflowError: string | null;
  /** Consecutive cycles the market ended loss-stale (stale count > 0 after our cranks). */
  lossStaleCycles: number;
  /** "loss-stale" once lossStaleCycles reaches the alert threshold. */
  status: "ok" | "loss-stale";
  updatedAt: number;
}

const refreshHealth = new Map<string, CrankRefreshHealth>();

export function setCrankRefreshHealth(market: string, h: CrankRefreshHealth): void {
  refreshHealth.set(market, h);
}

export function getCrankRefreshHealth(market: string): CrankRefreshHealth | undefined {
  return refreshHealth.get(market);
}

/** Test hook. */
export function resetRefreshCoordination(): void {
  holds.clear();
  refreshHealth.clear();
}
