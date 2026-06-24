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
 */
export function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw == null || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a finite positive number (got: ${JSON.stringify(raw)})`,
    );
  }
  return value;
}
