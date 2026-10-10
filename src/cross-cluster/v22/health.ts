/**
 * cross-cluster/v22/health.ts
 *
 * /health fields of the v2.2 layer. ADDITIVE ONLY: `v22HealthFields()` returns `{}` unless the layer was started
 * (`setV22HealthProvider`), so with every v2.2 flag off the /health body is byte-identical to before.
 */
export type V22HealthProvider = () => Record<string, unknown> | null;

let provider: V22HealthProvider | null = null;

export function setV22HealthProvider(p: V22HealthProvider | null): void {
  provider = p;
}

export function v22HealthFields(): Record<string, unknown> {
  try {
    const f = provider?.();
    return f ? { v22: f } : {};
  } catch {
    return {};
  }
}
