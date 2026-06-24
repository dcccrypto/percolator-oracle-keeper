/**
 * Shared environment-variable parsing utilities.
 *
 * Kept in a standalone module so unit tests can import the pure helper
 * without triggering the oracle keeper's module-level side-effects
 * (RPC connection, keypair load, etc.).
 */

/**
 * Parse a safety-critical numeric environment variable.
 *
 * If the variable is unset or empty the fallback is used.
 * If the resulting value is not a finite positive number the process throws
 * immediately — a NaN/Infinity/zero/negative value would silently disable
 * guards (e.g. circuit breaker always-false when MAX_PRICE_MOVE_PCT is NaN).
 *
 * @param max - Optional exclusive upper bound. Throws if value >= max.
 *   Useful for percentage guards where >=100 would disable the guard entirely
 *   (e.g. MAX_PRICE_MOVE_PCT=100 means "accept everything" — #44 fix).
 */
export function parsePositiveNumberEnv(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  const value = raw == null || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a finite positive number (got: ${JSON.stringify(raw)})`,
    );
  }
  if (max !== undefined && value >= max) {
    throw new Error(
      `${name} must be less than ${max} (got: ${value}) — a value ≥ ${max} would disable the guard`,
    );
  }
  return value;
}

/**
 * Validate that PROGRAM_ID is set when the oracle keeper is running in
 * Supabase-only discovery mode (no deployment file, no DEPLOYMENT_JSON).
 *
 * Supabase discovery surfaces slab addresses, oracle modes, and pool addresses
 * but does NOT supply a program id.  The keeper uses `programId` as a fallback
 * when building instructions before a slab's on-chain owner has been cached.
 * Without it, `new PublicKey(undefined)` throws the opaque "_bn" error from
 * inside @solana/web3.js — crashing the service after it has already logged
 * that Supabase-only mode is active (issue #29).
 *
 * @param programIdEnv - value of process.env.PROGRAM_ID (pass explicitly so
 *   the function is a pure helper that tests can drive without touching the
 *   real process.env).
 * @throws Error with a clear diagnostic message when the id is absent.
 */
export function requireProgramIdForSupabaseMode(
  programIdEnv: string | undefined,
): void {
  if (!programIdEnv || programIdEnv.trim() === "") {
    throw new Error(
      "PROGRAM_ID is required for Supabase-only discovery mode (no deployment file present). " +
      "Set PROGRAM_ID to your deployed program's public key, or provide a deployment file / DEPLOYMENT_JSON.",
    );
  }
}
