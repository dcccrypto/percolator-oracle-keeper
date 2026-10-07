/**
 * cross-cluster/layout-guard-metrics.ts
 *
 * Counters for the VERSION-keyed layout guard (market-layout.ts `detectLayout`). An account the keeper cannot
 * decode is a LOUD condition: it is counted here by reason, logged once per reason/version, and surfaced in
 * /health as `layoutGuard` (which also degrades `status` through the existing layoutProblemMarkets path).
 * There is no silent fallback to another layout's offsets.
 *
 * Reason codes are the SDK's `LayoutErrorCode` plus the keeper's own: NO_ROW_FOR_LENGTH (VERSION known, length
 * matches no row), AMBIGUOUS_ROW, ROW_DISAGREES_WITH_SDK (the pinned SDK table and the keeper row differ).
 */
export interface LayoutGuardSnapshot {
  refusals: number;
  byCode: Record<string, number>;
  /** VERSION -> refusals (the on-chain VERSION found in the account header). */
  byVersion: Record<string, number>;
  lastCode: string | null;
  lastVersion: number | null;
  lastAt: number | null;
}

const state = {
  refusals: 0,
  byCode: new Map<string, number>(),
  byVersion: new Map<number, number>(),
  logged: new Set<string>(),
  lastCode: null as string | null,
  lastVersion: null as number | null,
  lastAt: null as number | null,
};

/** Record one refusal. Logs ONCE per (code, version) at error level; never throws. */
export function noteLayoutGuardRefusal(code: string, version: number | null, now: () => number = Date.now): void {
  state.refusals++;
  state.byCode.set(code, (state.byCode.get(code) ?? 0) + 1);
  if (version !== null) state.byVersion.set(version, (state.byVersion.get(version) ?? 0) + 1);
  state.lastCode = code;
  state.lastVersion = version;
  state.lastAt = now();
  const key = `${code}|${version}`;
  if (!state.logged.has(key)) {
    state.logged.add(key);
    console.error(
      `[layout-guard] REFUSED a market account: ${code} (wrapper VERSION ${version ?? "unreadable"}). ` +
        "The keeper does not guess another layout's offsets; update market-layout.ts / the SDK pin. Counted in /health layoutGuard.",
    );
  }
}

export function layoutGuardSnapshot(): LayoutGuardSnapshot {
  return {
    refusals: state.refusals,
    byCode: Object.fromEntries(state.byCode),
    byVersion: Object.fromEntries([...state.byVersion].map(([k, v]) => [String(k), v])),
    lastCode: state.lastCode,
    lastVersion: state.lastVersion,
    lastAt: state.lastAt,
  };
}

/** Test hook. */
export function resetLayoutGuardMetrics(): void {
  state.refusals = 0;
  state.byCode.clear();
  state.byVersion.clear();
  state.logged.clear();
  state.lastCode = null;
  state.lastVersion = null;
  state.lastAt = null;
}
