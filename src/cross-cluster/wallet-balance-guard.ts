/**
 * Wallet-balance guard for the LIVE keeper.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `MIN_KEEPER_BALANCE_SOL` existed only in `src/index.ts`, which never executes.
 * So the running keeper — the one that actually signs and pays for every
 * PushAuthMark — had **no balance check of any kind**. The 2026-03-14 devops note
 * about a keeper wallet being "exhausted twice in one day" was written against the
 * dead path, which is why the guard it motivated never protected anything.
 *
 * Issue #71 reported that a sub-lamport threshold rounds to zero and disables the
 * guard. That specific defect was fixed by #95 (`parsePositiveLamportsFromSolEnv`).
 * The gap #71 *revealed* — that the live keeper has no guard at all — is what this
 * closes.
 *
 * WHAT IT DOES
 * ------------
 * Below the threshold, pushes are paused rather than attempted. A keeper that
 * cannot pay produces failing transactions, not fresh marks; pausing makes the
 * stall explicit (`/health` goes `stalled-pricing`) instead of burning the
 * remaining balance on transactions that revert.
 *
 * The logic here is deliberately pure so it can be tested without an RPC. The
 * caller owns the `getBalance` call and the clock.
 */

export interface WalletBalanceState {
  /** Last observed balance in lamports; null until the first successful read. */
  balanceLamports: number | null;
  /** Epoch ms of the last *attempted* refresh (success or failure). */
  lastCheckAt: number;
  /** Whether pushes are currently paused for insufficient balance. */
  low: boolean;
}

export function createWalletBalanceState(): WalletBalanceState {
  return { balanceLamports: null, lastCheckAt: 0, low: false };
}

/** True when the balance is stale enough to re-read. */
export function shouldRefreshBalance(
  state: WalletBalanceState,
  nowMs: number,
  intervalMs: number,
): boolean {
  return nowMs - state.lastCheckAt >= intervalMs;
}

export type BalanceTransition = "went-low" | "recovered" | null;

/**
 * Fold a fresh balance reading into the state.
 *
 * Returns the edge, not the level, so the caller logs once per transition rather
 * than once per cycle — a keeper that is low for an hour should say so twice
 * (down, then up), not 1,200 times.
 */
export function applyBalanceReading(
  state: WalletBalanceState,
  balanceLamports: number,
  minLamports: number,
  nowMs: number,
): BalanceTransition {
  const wasLow = state.low;
  state.balanceLamports = balanceLamports;
  state.lastCheckAt = nowMs;
  state.low = balanceLamports < minLamports;
  if (state.low && !wasLow) return "went-low";
  if (!state.low && wasLow) return "recovered";
  return null;
}

/**
 * Record a failed balance read.
 *
 * The previous `low` verdict is deliberately PRESERVED rather than cleared. An RPC
 * failure is not evidence of funds: clearing it would let a keeper resume pushing
 * into an empty wallet simply because it could not see the balance — failing open
 * on exactly the check whose job is to fail closed.
 */
export function recordBalanceReadFailure(
  state: WalletBalanceState,
  nowMs: number,
): void {
  state.lastCheckAt = nowMs;
}

/** Human-readable SOL for logs and /health. Null-safe. */
export function formatSol(lamports: number | null): string {
  return lamports == null ? "??" : (lamports / 1e9).toFixed(4);
}
