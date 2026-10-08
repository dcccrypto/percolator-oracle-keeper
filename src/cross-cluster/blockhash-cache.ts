/**
 * cross-cluster/blockhash-cache.ts — one shared `getLatestBlockhash` per commitment.
 *
 * Before this, the recovery cranker fetched a blockhash PER MARKET per cycle (two more per market
 * when a crank overflowed), and every fee job fetched its own, while the push loop already kept a
 * private 15 s cache. A blockhash is valid for ~150 blocks (60-90 s), so any holder of one at most
 * MAX_AGE_MS old signs a transaction that is just as valid as one signed with a fresh fetch.
 *
 * Concurrent callers that miss together (the cranker starts every market at once) share ONE in-flight
 * request. A failed fetch is not cached. `invalidate()` drops the entry (call it on a
 * BlockhashNotFound/expired error so the next caller refetches).
 */
import type { Commitment, Connection } from "@solana/web3.js";

export interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Same refresh interval the push loop has always used. Well inside the 60-90 s validity. */
export const BLOCKHASH_MAX_AGE_MS = 15_000;

interface Entry {
  value: CachedBlockhash;
  at: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<CachedBlockhash>>();

export async function getCachedBlockhash(
  conn: Pick<Connection, "getLatestBlockhash" | "rpcEndpoint">,
  commitment: Commitment,
  opts: { maxAgeMs?: number; now?: () => number } = {},
): Promise<CachedBlockhash> {
  const maxAge = opts.maxAgeMs ?? BLOCKHASH_MAX_AGE_MS;
  const now = (opts.now ?? Date.now)();
  const key = `${conn.rpcEndpoint}|${commitment}`;
  const hit = entries.get(key);
  if (hit && now - hit.at <= maxAge) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const v = await conn.getLatestBlockhash(commitment);
      const value = { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight };
      entries.set(key, { value, at: (opts.now ?? Date.now)() });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Drop the cached blockhash (all commitments of this endpoint). */
export function invalidateBlockhash(conn: Pick<Connection, "rpcEndpoint">): void {
  for (const k of [...entries.keys()]) if (k.startsWith(`${conn.rpcEndpoint}|`)) entries.delete(k);
}

/** Test hook. */
export function resetBlockhashCache(): void {
  entries.clear();
  inflight.clear();
}
