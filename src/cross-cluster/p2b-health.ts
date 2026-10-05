/**
 * cross-cluster/p2b-health.ts
 *
 * The hook through which the v2.1 layer adds fields to the keeper's /health payload.
 *
 * ADDITIVE ONLY: `p2bHealthFields()` returns `{}` unless a provider is installed and reports the
 * P2b program as supported, so on today's programs the /health body is byte-identical to before.
 * Every value the provider returns must be JSON-safe (bigints already stringified).
 */
export type P2bHealthProvider = () => Record<string, unknown> | null;

let provider: P2bHealthProvider | null = null;

export function setP2bHealthProvider(p: P2bHealthProvider | null): void {
  provider = p;
}

/** Extra /health fields; `{}` when the v2.1 layer is off. Never throws. */
export function p2bHealthFields(): Record<string, unknown> {
  try {
    return provider?.() ?? {};
  } catch {
    return {};
  }
}
