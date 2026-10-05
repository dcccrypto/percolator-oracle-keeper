/**
 * cross-cluster/lock-codes.ts
 *
 * Wrapper error codes the keeper classifies, with the P2b split of Custom(21).
 *
 * percolator-prog #525 (E7) splits what used to be `EngineLockActive` (Custom 21) into three
 * distinct codes, in a reserved block so concurrent appends cannot shift them:
 *
 *   120 EngineAdlReduceOnly            was 21  (asset is ADL reduce-only: opens refused)
 *   121 EngineLossStale                was 21  (risk-increasing trade on a loss-stale asset)
 *   122 EarnExitWouldUnderBackClaims   was 21  (tag 77 only: exit would under-back open claims)
 *
 * Internal pot moves that share the checks keep 21, and every other 21 (market not Live, cooldown,
 * ...) is unchanged. So any keeper logic that meant "this is the lock / stale family" must accept
 * all four codes to behave identically on the new program, and it still behaves identically on
 * today's program, where 120..122 never occur.
 *
 * Also the new Earn / wind-down codes the P2b keeper features branch on.
 */

/** `PercolatorError::EngineLockActive`. */
export const ENGINE_LOCK_ACTIVE = 21;
/** P2b E7 (#525): ADL reduce-only. */
export const ENGINE_ADL_REDUCE_ONLY = 120;
/** P2b E7 (#525): loss-stale risk-increasing trade. */
export const ENGINE_LOSS_STALE = 121;
/** P2b E7 (#525): Earn exit (tag 77) would under-back open claims. */
export const EARN_EXIT_WOULD_UNDER_BACK_CLAIMS = 122;

/** The codes that all read "the lock / loss-stale / ADL family" (21 before the split). */
export const LOCK_FAMILY_CODES: ReadonlyArray<number> = Object.freeze([
  ENGINE_LOCK_ACTIVE,
  ENGINE_ADL_REDUCE_ONLY,
  ENGINE_LOSS_STALE,
  EARN_EXIT_WOULD_UNDER_BACK_CLAIMS,
]);

/** True for 21 and for the three codes that were 21 before P2b E7. `null` is never in the family. */
export function isLockFamilyCode(code: number | null | undefined): boolean {
  return code !== null && code !== undefined && LOCK_FAMILY_CODES.includes(code);
}

/** Tag 103 refused: no room right now (senior draw, impaired, insolvent, junior < 5%, not Live, no room). Skip, never page. */
export const VAULT_LP_ALLOCATE_REFUSED = 100;

// Tag 104 (AdlWindDown) refusals the keeper classifies as "skip this cycle".
/** EngineStale-adjacent: lagging / pending mark (wrapper `reject_exposed_target_effective_lag_view` ...). */
export const WIND_DOWN_LOCK_ACTIVE = 21;
/** EngineProvenanceMismatch: the (portfolio_id, position_epoch) binding is stale. */
export const WIND_DOWN_STALE_BINDING = 16;
/** OracleStale: the pushed mark is older than ADL_WIND_DOWN_MAX_MARK_AGE_SLOTS. */
export const WIND_DOWN_ORACLE_STALE = 27;
/** EngineNonProgress: not in ADL reduce-only any more (e.g. after a reset). */
export const WIND_DOWN_NON_PROGRESS = 22;
