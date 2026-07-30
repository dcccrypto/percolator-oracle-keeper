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
import { addMarket, saveRegistry } from "./registry.ts";
import type { Registry, MarketEntry, DexType } from "./registry.ts";

const VALID_DEX_TYPES: ReadonlySet<string> = new Set([
  "raydium-clmm",
  "meteora-dlmm",
  "pumpswap",
]);

const DEFAULT_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface RegisterPollConfig {
  /** GET endpoint that returns { markets: RegisteredMarket[] } — the Vercel Blob store. */
  sourceUrl: string;
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
): { added: string[]; removed: string[] } {
  const desiredByAddr = new Map(desired.map((m) => [m.marketAddress, m]));
  const added: string[] = [];
  const removed: string[] = [];

  for (const [addr, entry] of desiredByAddr) {
    // Present this cycle — any accumulated absence is stale.
    absences.delete(addr);
    if (!registry.markets.some((m) => m.marketAddress === addr)) {
      registry.markets.push(entry);
      added.push(addr);
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

  return { added, removed };
}

/**
 * One registration poll. Exported so the Realtime stream can trigger a poll the
 * instant a market row changes (see registration-stream.ts) — the stream is the
 * wake-up, this stays the single path that actually admits a market.
 */
export async function pollOnce(registry: Registry, config: RegisterPollConfig): Promise<number> {
  let payload: unknown;
  try {
    const resp = await fetch(config.sourceUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[register-poll] GET ${config.sourceUrl} → HTTP ${resp.status}`);
      return 0;
    }
    payload = await resp.json();
  } catch (err) {
    console.warn(
      `[register-poll] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }

  const remoteMarkets = (payload as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(remoteMarkets)) {
    console.warn("[register-poll] response missing markets[] — skipping this cycle");
    return 0;
  }

  const known = new Set(registry.markets.map((m) => m.marketAddress));
  let added = 0;

  for (const raw of remoteMarkets) {
    if (typeof raw !== "object" || raw === null) continue;
    const remote = raw as RemoteMarket;

    const marketAddress = remoteMarketAddress(remote);
    if (!marketAddress || known.has(marketAddress)) continue;

    const entry = toMarketEntry(remote);
    if (!entry) {
      console.warn(
        `[register-poll] skipping invalid remote market ${marketAddress.slice(0, 8)}…: ` +
          `${JSON.stringify(raw).slice(0, 200)}`,
      );
      continue;
    }

    // Owner filter (2026-07-23): only admit markets owned by the current wrapper.
    // The blob store still lists retired-wrapper markets; one of those in the push
    // batch reverts the whole atomic tx with IncorrectProgramId. On RPC failure or
    // not-yet-found, skip this cycle (retried on the next poll) rather than admit.
    if (config.connection && config.expectedOwner) {
      let owner: PublicKey | null = null;
      try {
        const info = await config.connection.getAccountInfo(new PublicKey(marketAddress));
        owner = info?.owner ?? null;
      } catch (err) {
        console.warn(
          `[register-poll] owner check failed for ${marketAddress.slice(0, 8)}… — skipping this cycle: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!owner) {
        console.warn(`[register-poll] ${marketAddress.slice(0, 8)}… not found on-chain — skipping`);
        continue;
      }
      if (!owner.equals(config.expectedOwner)) {
        console.log(
          `[register-poll] skipping ${marketAddress.slice(0, 8)}… — owner ${owner
            .toBase58()
            .slice(0, 8)}… != current wrapper ${config.expectedOwner
            .toBase58()
            .slice(0, 8)}… (retired-wrapper market)`,
        );
        continue;
      }
    }

    const full = addMarket(registry, entry);
    known.add(full.marketAddress);
    added++;
    console.log(`[register-poll] added ${full.symbol ?? full.label} ${full.marketAddress}`);
  }

  if (added > 0) {
    try {
      saveRegistry(registry, config.registryPath);
    } catch (err) {
      console.error(
        `[register-poll] saveRegistry(${config.registryPath}) failed — new markets are in ` +
          `memory for this session but were NOT persisted: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return added;
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
    `[register-poll] starting: source=${config.sourceUrl} interval=${intervalMs}ms registry=${config.registryPath}`,
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
