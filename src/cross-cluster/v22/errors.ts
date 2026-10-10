/**
 * cross-cluster/v22/errors.ts
 *
 * Names for the v2.2 wrapper errors (100-124) and the stake v5 errors (33-45), so a refusal in a log reads
 * `PriceBandPinned(104)`, never a bare `Custom(104)`. The names come from the pinned SDK tables
 * (PERCOLATOR_ERRORS, STAKE_ERRORS_V5); the keeper holds only the CLASSIFICATION (which refusals are expected
 * states and which are failures).
 */
import { PERCOLATOR_ERRORS, STAKE_ERRORS_V5 } from "@percolatorct/sdk";
import { customCodeOf } from "../tx-confirm.ts";

export type ProgramKind = "wrapper" | "stake";

export function wrapperErrorName(code: number): string {
  return PERCOLATOR_ERRORS[code]?.name ?? "UnknownWrapperError";
}

export function stakeErrorName(code: number): string {
  return STAKE_ERRORS_V5[code]?.name ?? PERCOLATOR_ERRORS[code]?.name ?? "UnknownStakeError";
}

/** `PriceBandPinned(104)`; `Custom(999)` when the code has no name. */
export function formatProgramError(kind: ProgramKind, code: number | null): string {
  if (code === null) return "unclassified";
  const name = kind === "stake" ? STAKE_ERRORS_V5[code]?.name : PERCOLATOR_ERRORS[code]?.name;
  return name ? `${name}(${code})` : `Custom(${code})`;
}

/** The code of a simulation / send error value, or null. */
export function errorCodeOf(err: unknown): number | null {
  return customCodeOf(err);
}

/** The v2.2 wrapper error codes (100-124) and the stake v5 codes (33-45) the keeper maps to names. */
export const V22_WRAPPER_ERROR_RANGE = { from: 100, to: 124 } as const;
export const V22_STAKE_ERROR_RANGE = { from: 33, to: 45 } as const;

/**
 * Band-market refusals that are EXPECTED STATES, not failures (docs/v22-band-defaults-and-product-copy.md):
 *   104 PriceBandPinned                  closing on the favourable side while the mark catches up to the oracle
 *   111 PriceBandPositionCap             a full side (256 legs) refuses a new position
 *   112 PriceBandTooNarrow               the asset's price fell to the band floor: close-only
 *   113 PriceBandLegBelowMinNotional     a leg would end below the minimum notional
 * A keeper tx that meets one of these (a sweep refresh, a rent settle, a dust sweep) logs it as a state, counts it,
 * and does not alert or retry-spam.
 */
export const BAND_EXPECTED_CODES: ReadonlySet<number> = new Set([104, 111, 112, 113]);

export function isBandExpected(code: number | null): boolean {
  return code !== null && BAND_EXPECTED_CODES.has(code);
}

/** Stake 43 (nothing to sync) and 37 (cooldown) are quiet no-ops; 44 (readings diverged) is a refusal not to be retried. */
export const STAKE_SYNC_QUIET_CODES: ReadonlySet<number> = new Set([37, 43]);
export const STAKE_READINGS_DIVERGED = 44;
