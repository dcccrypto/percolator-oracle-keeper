const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type MainnetCaSnapshotRejectReason =
  | "query-failed"
  | "invalid-row"
  | "conflicting-duplicate";

export interface MainnetCaReconcileResult {
  /**
   * True only when the supplied rows represent a complete, valid snapshot
   * that is safe to atomically apply.
   */
  applied: boolean;

  /**
   * The next complete snapshot. When applied=false, this is a copy of the
   * current snapshot so callers cannot accidentally clear a valid cache.
   */
  next: ReadonlyMap<string, string>;

  added: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  removed: ReadonlySet<string>;

  invalidRows: number;
  reason?: MainnetCaSnapshotRejectReason;
}

/**
 * Create an empty reconciliation diff.
 */
function emptyDiff(): {
  added: Set<string>;
  changed: Set<string>;
  removed: Set<string>;
} {
  return {
    added: new Set<string>(),
    changed: new Set<string>(),
    removed: new Set<string>(),
  };
}

/**
 * Build a rejected reconciliation result that preserves current state.
 */
function preserveCurrent(
  current: ReadonlyMap<string, string>,
  reason: MainnetCaSnapshotRejectReason,
  invalidRows = 0,
): MainnetCaReconcileResult {
  return {
    applied: false,
    next: new Map(current),
    ...emptyDiff(),
    invalidRows,
    reason,
  };
}

/**
 * Narrow an unknown Supabase row to a non-null record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Trim and validate a base58-formatted Solana address.
 *
 * This is the single normalization rule used by registry ingestion, pricing
 * identity resolution, and provider URL construction.
 */
export function normalizeSolanaAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (!SOLANA_ADDRESS_RE.test(normalized)) return null;

  return normalized;
}

/**
 * Reconcile a complete Supabase markets snapshot against the keeper cache.
 *
 * Semantics:
 * - rows === null: query failed; preserve the current mapping.
 * - rows === []: successful empty snapshot; remove all current mappings.
 * - malformed row: reject the entire snapshot and preserve current state.
 * - duplicate slab with conflicting CAs: reject the entire snapshot.
 *
 * Rejecting an invalid partial snapshot prevents a malformed response from
 * atomically deleting otherwise-valid identities.
 */
export function reconcileMainnetCaMappings(
  current: ReadonlyMap<string, string>,
  rows: readonly unknown[] | null,
): MainnetCaReconcileResult {
  if (rows === null) {
    return preserveCurrent(current, "query-failed");
  }

  const next = new Map<string, string>();
  let invalidRows = 0;
  let hasConflictingDuplicate = false;

  for (const row of rows) {
    if (!isRecord(row)) {
      invalidRows++;
      continue;
    }

    const slab = normalizeSolanaAddress(row.slab_address);
    const mainnetCa = normalizeSolanaAddress(row.mainnet_ca);

    if (!slab || !mainnetCa) {
      invalidRows++;
      continue;
    }

    const existing = next.get(slab);
    if (existing !== undefined && existing !== mainnetCa) {
      hasConflictingDuplicate = true;
      continue;
    }

    next.set(slab, mainnetCa);
  }

  if (hasConflictingDuplicate) {
    return preserveCurrent(
      current,
      "conflicting-duplicate",
      invalidRows,
    );
  }

  if (invalidRows > 0) {
    return preserveCurrent(current, "invalid-row", invalidRows);
  }

  const added = new Set<string>();
  const changed = new Set<string>();
  const removed = new Set<string>();

  for (const [slab, previousCa] of current) {
    const nextCa = next.get(slab);

    if (nextCa === undefined) {
      removed.add(slab);
    } else if (nextCa !== previousCa) {
      changed.add(slab);
    }
  }

  for (const slab of next.keys()) {
    if (!current.has(slab)) {
      added.add(slab);
    }
  }

  return {
    applied: true,
    next,
    added,
    changed,
    removed,
    invalidRows: 0,
  };
}

/**
 * Apply a previously validated snapshot atomically.
 *
 * The target is untouched when result.applied=false.
 */
export function applyMainnetCaSnapshot(
  target: Map<string, string>,
  result: MainnetCaReconcileResult,
): boolean {
  if (!result.applied) return false;

  target.clear();

  for (const [slab, mainnetCa] of result.next) {
    target.set(slab, mainnetCa);
  }

  return true;
}
