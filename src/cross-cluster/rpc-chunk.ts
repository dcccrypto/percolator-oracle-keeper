/**
 * Bounded-input wrapper for `getMultipleAccountsInfo`.
 *
 * The RPC rejects more than 100 keys per call and web3.js v1 does NOT chunk —
 * it issues exactly one request. Any call whose key array grows with the
 * registry is therefore a dated cliff (see the note on `getMultipleAccountsChunked`
 * in price-reader.ts for the earlier outage of this shape).
 */
import type { AccountInfo, Commitment, Connection, PublicKey } from "@solana/web3.js";

/** Solana's hard per-request key cap for getMultipleAccounts. */
export const MAX_ACCOUNTS_PER_RPC = 100;
/** Chunks in flight at once. Small: each chunk is one RPC and the push cycle shares the endpoint. */
export const DEFAULT_CHUNK_CONCURRENCY = 4;

export interface ChunkedAccountsResult {
  /**
   * One slot per input key, same order. `AccountInfo` = account exists, `null` = the RPC
   * says it does not exist, `undefined` = the chunk holding this key FAILED, so the
   * state is UNKNOWN. Callers must not treat `undefined` as "missing".
   */
  infos: Array<AccountInfo<Buffer> | null | undefined>;
  /** Number of chunks whose RPC call threw. */
  failedChunks: number;
  /** Number of keys covered by those chunks. */
  failedKeys: number;
  /** Total chunks issued. */
  totalChunks: number;
}

/**
 * Fetch `keys` in chunks of at most `chunkSize` (default 100), at most `concurrency`
 * chunks in flight, preserving input order. A chunk that throws is isolated: its
 * keys come back `undefined`, every other chunk is unaffected, and nothing throws.
 */
export async function getMultipleAccountsInfoChunked(
  conn: Pick<Connection, "getMultipleAccountsInfo">,
  keys: readonly PublicKey[],
  commitment: Commitment,
  opts: { chunkSize?: number; concurrency?: number } = {},
): Promise<ChunkedAccountsResult> {
  const chunkSize = Math.min(Math.max(1, opts.chunkSize ?? MAX_ACCOUNTS_PER_RPC), MAX_ACCOUNTS_PER_RPC);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CHUNK_CONCURRENCY);
  const infos: ChunkedAccountsResult["infos"] = new Array(keys.length).fill(undefined);
  const starts: number[] = [];
  for (let i = 0; i < keys.length; i += chunkSize) starts.push(i);

  let failedChunks = 0;
  let failedKeys = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < starts.length) {
      const start = starts[next++];
      const slice = keys.slice(start, start + chunkSize);
      try {
        const got = await conn.getMultipleAccountsInfo([...slice], commitment);
        if (got.length !== slice.length) throw new Error(`short read: ${got.length} of ${slice.length}`);
        for (let j = 0; j < got.length; j++) infos[start + j] = got[j];
      } catch {
        failedChunks++;
        failedKeys += slice.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
  return { infos, failedChunks, failedKeys, totalChunks: starts.length };
}
