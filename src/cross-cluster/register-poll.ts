/**
 * cross-cluster/register-poll.ts
 *
 * Outbound registration-poll loop.
 *
 * The keeper runs on a NAT'd host and can only make OUTBOUND calls — the (stateless,
 * serverless) Vercel frontend can never reach it directly. So market registration is
 * inverted: the frontend's create-market wizard persists new markets to a Vercel Blob
 * store and exposes them at GET /api/playground/registered-markets
 * (percolator-launch/app/app/api/playground/registered-markets/route.ts); this loop
 * polls that endpoint outbound on its own interval and adds any market this keeper
 * doesn't already know about.
 *
 * v17 has no on-chain feed_id, so the market↔pool binding (poolAddress + dexType)
 * lives ONLY in the polled payload — there is no other way for this keeper to learn
 * which mainnet pool prices a wizard-created devnet market.
 *
 * Resilience: mirrors the pattern used throughout cross-cluster.ts — a single bad
 * fetch, a malformed entry, or a registry-save failure is logged and isolated; this
 * loop must never throw out of its own scope (the caller does `void
 * startRegisterPollLoop(...).catch(...)` as a last line of defense, same as the
 * recovery-cranker).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { saveRegistry } from "./registry.ts";
import { fetchActiveMarkets, type FetchActiveConfig } from "./db-markets.ts";
import type { Registry, MarketEntry, DexType } from "./registry.ts";

const VALID_DEX_TYPES: ReadonlySet<string> = new Set([
  "raydium-clmm",
  "meteora-dlmm",
  "pumpswap",
]);

const DEFAULT_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface RegisterPollConfig {
  /** Supabase read config — the market list's single source of truth. */
  db?: FetchActiveConfig;
  /** Legacy blob endpoint. Unused since the DB cutover; kept for log context. */
  sourceUrl?: string;
  /** Path to persist registry.json after any addition. */
  registryPath: string;
  /** Milliseconds between polls (default 30_000). */
  intervalMs?: number;
  /**
   * Devnet connection for the on-chain owner filter. If both `connection` and
   * `expectedOwner` are set, a market is only admitted when its on-chain owner
   * equals `expectedOwner`. Omit both to disable the filter (legacy behavior).
   */
  connection?: Connection;
  /**
   * Only admit markets whose on-chain owner == this program (the current wrapper).
   * The blob store still holds retired-wrapper markets; admitting one poisons the
   * atomic PushAuthMark batch with IncorrectProgramId (the whole batch reverts).
   */
  expectedOwner?: PublicKey;
}

/** Loosely-typed shape of one entry from GET /api/playground/registered-markets. */
interface RemoteMarket {
  slabAddress?: unknown;
  marketAddress?: unknown;
  poolAddress?: unknown;
  dexType?: unknown;
  symbol?: unknown;
  label?: unknown;
  collateral?: unknown;
}

function isValidPubkey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function remoteMarketAddress(remote: RemoteMarket): string | null {
  const marketAddress =
    typeof remote.marketAddress === "string" ? remote.marketAddress : remote.slabAddress;
  return isValidPubkey(marketAddress) ? marketAddress : null;
}

/**
 * Validate and normalize one remote market entry into an addMarket()-ready
 * MarketEntry. Returns null (never throws) if the entry fails validation.
 */
function toMarketEntry(remote: RemoteMarket): Omit<MarketEntry, "registeredAt"> | null {
  const marketAddress = remoteMarketAddress(remote);
  if (!marketAddress) return null;

  if (!isValidPubkey(remote.poolAddress)) return null;
  const poolAddress = remote.poolAddress;

  if (typeof remote.dexType !== "string" || !VALID_DEX_TYPES.has(remote.dexType)) return null;
  const dexType = remote.dexType as DexType;

  const symbol = typeof remote.symbol === "string" ? remote.symbol : undefined;
  const collateral = typeof remote.collateral === "string" ? remote.collateral : undefined;
  const label =
    typeof remote.label === "string" && remote.label.length > 0
      ? remote.label
      : `${symbol ?? `${marketAddress.slice(0, 8)}…`} — ${dexType}`;

  return {
    label,
    marketAddress,
    poolAddress,
    dexType,
    assetIndex: 0,
    symbol,
    collateral,
  };
}

/**
 * Poll `config.sourceUrl` once and add any not-yet-known market to `registry`.
 * Never throws — every failure mode (fetch, parse, per-entry validation, save) is
 * caught and logged so one bad cycle can't take the loop down.
 *
 * Returns the number of markets added this cycle.
 */
/**
 * Consecutive successful queries a market must be ABSENT from before it is
 * dropped. One odd-but-successful result must not be able to retire the board.
 */
export const ABSENCE_THRESHOLD = 3;

/** True when the upstream row now describes a DIFFERENT binding than the local
 *  copy. Only the fields the price path actually reads are compared. */
function entryDiffers(local: MarketEntry, next: MarketEntry): boolean {
  return (
    local.poolAddress !== next.poolAddress ||
    local.dexType !== next.dexType ||
    local.symbol !== next.symbol ||
    local.collateral !== next.collateral
  );
}

/** Consecutive-absence counts, persisted across polls for the whole process. */
const absenceCounts = new Map<string, number>();

/**
 * Reconcile the local registry against the desired set.
 *
 * WHY: this function used to not exist, and registration was append-only. A
 * market removed upstream kept being priced from the local copy forever —
 * observed 2026-07-29, the feed served 1 market while registry.json held 3 and
 * all 3 were pushed every ~7s, two of them blocklisted in both repos. Retiring
 * a market required hand-editing registry.json on the keeper host.
 *
 * `desired` is authoritative. CALLERS MUST NOT pass the result of a FAILED
 * query — see fetchActiveMarkets' null contract. An empty `desired` from a
 * SUCCESSFUL query legitimately means "retire everything", and this will do
 * exactly that, which is why the absence threshold exists as a second guard.
 *
 * Pure and synchronous so the dangerous half of the loop is directly testable.
 */
export function reconcileMarkets(
  registry: Pick<Registry, "markets">,
  desired: readonly MarketEntry[],
  absences: Map<string, number>,
  threshold: number = ABSENCE_THRESHOLD,
): { added: string[]; removed: string[]; updated: string[] } {
  const desiredByAddr = new Map(desired.map((m) => [m.marketAddress, m]));
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  for (const [addr, entry] of desiredByAddr) {
    // Present this cycle — any accumulated absence is stale.
    absences.delete(addr);
    const idx = registry.markets.findIndex((m) => m.marketAddress === addr);
    if (idx === -1) {
      registry.markets.push(entry);
      added.push(addr);
    } else if (entryDiffers(registry.markets[idx], entry)) {
      // The binding CHANGED upstream. Without this the local copy kept the old
      // pool forever, so a market re-registered against a corrected pool would
      // go on being priced from the wrong one — silently, since it is present
      // in `desired` and so never even accrues an absence.
      registry.markets[idx] = entry;
      updated.push(addr);
    }
  }

  for (const local of [...registry.markets]) {
    if (desiredByAddr.has(local.marketAddress)) continue;
    const n = (absences.get(local.marketAddress) ?? 0) + 1;
    absences.set(local.marketAddress, n);
    if (n >= threshold) {
      registry.markets = registry.markets.filter(
        (m) => m.marketAddress !== local.marketAddress,
      );
      absences.delete(local.marketAddress);
      removed.push(local.marketAddress);
    }
  }

  return { added, removed, updated };
}

/**
 * One registration poll. Exported so the Realtime stream can trigger a poll the
 * instant a market row changes (see registration-stream.ts) — the stream is the
 * wake-up, this stays the single path that actually admits a market.
 */
let pollRunning = false;
let pollRerunQueued = false;
let pollChain: Promise<number> = Promise.resolve(0);

/**
 * One registration poll — SERIALIZED.
 *
 * Two independent callers invoke this: the periodic loop, and the Supabase
 * Realtime stream, which fires on ANY `markets` row change (the indexer writes
 * to that table constantly, so overlap is routine rather than theoretical).
 * Running two concurrently corrupts the registry, because reconcileMarkets
 * read-modify-writes it:
 *   - both see the market missing before either pushes -> DUPLICATE entry, and a
 *     duplicate in the atomic PushAuthMark batch reverts the whole transaction;
 *   - both increment the same absence counter -> the 3-strike guard trips in
 *     ~1.5 rounds, which is precisely the premature retirement it exists to stop.
 *
 * A call arriving mid-poll queues exactly ONE follow-up rather than being
 * dropped, so a Realtime event that lands during a poll still gets acted on and
 * the ~ms pickup is preserved.
 */
export function pollOnce(registry: Registry, config: RegisterPollConfig): Promise<number> {
  if (pollRunning) {
    pollRerunQueued = true;
    return pollChain;
  }
  pollChain = (async () => {
    pollRunning = true;
    try {
      let n = await runPollOnce(registry, config);
      while (pollRerunQueued) {
        pollRerunQueued = false;
        n = await runPollOnce(registry, config);
      }
      return n;
    } finally {
      pollRunning = false;
    }
  })();
  return pollChain;
}

async function runPollOnce(registry: Registry, config: RegisterPollConfig): Promise<number> {
  // SOURCE OF TRUTH: the `markets` table, filtered to keeper_status='active'.
  // This used to GET the Vercel blob. The row already carried everything needed
  // and the keeper was already subscribed to Realtime on that table, so the blob
  // was a second store the notification pointed away from.
  if (!config.db) {
    console.warn("[register-poll] no db config — cannot resolve the market list");
    return 0;
  }

  const desired = await fetchActiveMarkets(config.db);
  if (desired === null) {
    // The query FAILED. Reconciling against "nothing" here would retire every
    // market, so change nothing and try again next cycle.
    return 0;
  }

  // Owner filter (2026-07-23): only price markets owned by the current wrapper.
  // A retired-wrapper market in the push batch reverts the WHOLE atomic tx with
  // IncorrectProgramId. Batched into one RPC call, and if that call fails we
  // abort the entire reconcile rather than act on partial information — an
  // unverified market must never be added, and a verified one must never be
  // dropped just because we could not check it.
  let admitted = desired;
  if (config.connection && config.expectedOwner && desired.length > 0) {
    try {
      // Chunked: getMultipleAccountsInfo rejects more than 100 keys, and a
      // throw here aborts the whole cycle — so past 100 active markets the
      // registry would freeze permanently rather than degrade.
      const infos: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[] = [];
      for (let i = 0; i < desired.length; i += 100) {
        infos.push(
          ...(await config.connection.getMultipleAccountsInfo(
            desired.slice(i, i + 100).map((m) => new PublicKey(m.marketAddress)),
            "confirmed",
          )),
        );
      }
      admitted = desired.filter((m, i) => {
        const owner = infos[i]?.owner ?? null;
        if (!owner) {
          console.warn(`[register-poll] ${m.marketAddress.slice(0, 8)}… not found on-chain — not admitted`);
          return false;
        }
        if (!owner.equals(config.expectedOwner!)) {
          console.log(
            `[register-poll] skipping ${m.marketAddress.slice(0, 8)}… — owner ${owner
              .toBase58()
              .slice(0, 8)}… != current wrapper ${config.expectedOwner!.toBase58().slice(0, 8)}… (retired-wrapper market)`,
          );
          return false;
        }
        return true;
      });
    } catch (err) {
      console.warn(
        `[register-poll] owner check failed — registry left unchanged this cycle: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  const { added, removed, updated } = reconcileMarkets(registry, admitted, absenceCounts, ABSENCE_THRESHOLD);

  for (const a of added) console.log(`[register-poll] added ${a}`);
  for (const r of removed) console.log(`[register-poll] retired ${r} (absent from ${ABSENCE_THRESHOLD} consecutive queries)`);
  for (const u of updated) console.log(`[register-poll] updated binding for ${u}`);

  if (added.length > 0 || removed.length > 0 || updated.length > 0) {
    try {
      saveRegistry(registry, config.registryPath);
    } catch (err) {
      console.error(
        `[register-poll] saveRegistry(${config.registryPath}) failed — the change is in ` +
          `memory for this session but was NOT persisted: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return added.length;
}

/**
 * Start the registration-poll loop. Runs indefinitely on its own interval,
 * independent of the oracle-push and recovery-crank loops.
 *
 * `registry` is mutated in place (via addMarket) — the SAME object reference must be
 * the one passed to startKeeperLoop / startRecoveryCrankLoop so a market added here
 * is visible to both loops on their very next cycle (both iterate `registry.markets`
 * fresh each cycle, not a snapshot taken at startup).
 *
 * Call this WITHOUT awaiting it: `void startRegisterPollLoop(...).catch(...)`.
 */
export async function startRegisterPollLoop(
  registry: Registry,
  config: RegisterPollConfig,
): Promise<void> {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  console.log(
    `[register-poll] starting: source=supabase(markets.keeper_status=active) ` +
      `interval=${intervalMs}ms registry=${config.registryPath} absenceThreshold=${ABSENCE_THRESHOLD}`,
  );

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  while (!stopping) {
    const cycleStart = Date.now();
    try {
      await pollOnce(registry, config);
    } catch (err) {
      // Defense in depth: pollOnce already isolates every failure mode internally,
      // but never let an unexpected throw kill this loop.
      console.error(
        `[register-poll] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const elapsed = Date.now() - cycleStart;
    const remaining = intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
  console.log("[register-poll] stopped.");
}
