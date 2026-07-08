/**
 * cross-cluster/keeper-loop.ts
 *
 * Production keeper loop: reads mainnet DEX pool prices and pushes them to
 * the corresponding devnet markets via PushAuthMark.
 *
 * Each cycle:
 *   1. For every market in the registry, read the mainnet pool price.
 *      Pool prices are deduplicated: if two markets share a pool, the pool
 *      is fetched only once per cycle.
 *   2. Push (or dry-run) PushAuthMark to the devnet market.
 *   3. Errors are isolated per-market — one bad pool or push does not
 *      abort the rest of the cycle.
 *
 * Health endpoint:
 *   GET /health  →  JSON with per-market stats and service-level counters.
 *   Suitable for Railway / Render health checks.
 */
import http from "http";
import { Connection, Keypair } from "@solana/web3.js";
import type { Registry } from "./registry.ts";
import type { DecimalsCache } from "./price-reader.ts";
import { readAllPoolPricesE6 } from "./price-reader.ts";
import { pushAuthMarkBatch, fetchOracleAuthority } from "./auth-mark-pusher.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoopConfig {
  /** Milliseconds between cycle starts. */
  intervalMs: number;
  /** HTTP health server port. */
  healthPort: number;
  /** Health server bind address (e.g. "0.0.0.0"). */
  healthBind: string;
  /** If true, build instructions and log them but do not send. */
  dryRun: boolean;
}

interface MarketStat {
  label: string;
  marketAddress: string;
  poolAddress: string;
  dexType: string;
  lastPriceE6: bigint;
  /** Unix ms of last push (live or dry-run). */
  lastPushAt: number | null;
  lastSig: string | null;
  totalPushes: number;
  totalErrors: number;
  lastErrorMsg: string | null;
  /** True if the last attempt found oracle_authority != keeper. */
  authorityMismatch: boolean;
}

interface LoopState {
  startedAt: number;
  lastCycleAt: number | null;
  cycleCount: number;
  stats: Map<string, MarketStat>;
}

// ── Health server ─────────────────────────────────────────────────────────────

function makeHealthHandler(state: LoopState, config: LoopConfig) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404);
      res.end();
      return;
    }
    const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
    const markets: Record<string, object> = {};
    for (const [addr, stat] of state.stats) {
      markets[addr] = {
        label: stat.label,
        lastPriceUsd:
          stat.lastPriceE6 > 0n
            ? (Number(stat.lastPriceE6) / 1e6).toFixed(4)
            : null,
        lastPriceE6: stat.lastPriceE6.toString(),
        lastPushAgo:
          stat.lastPushAt !== null
            ? `${Math.floor((Date.now() - stat.lastPushAt) / 1000)}s`
            : null,
        totalPushes: stat.totalPushes,
        totalErrors: stat.totalErrors,
        authorityMismatch: stat.authorityMismatch,
        lastError: stat.lastErrorMsg,
      };
    }
    const payload = JSON.stringify({
      status: "ok",
      uptimeSec,
      cycleCount: state.cycleCount,
      lastCycleAgo:
        state.lastCycleAt !== null
          ? `${Math.floor((Date.now() - state.lastCycleAt) / 1000)}s`
          : null,
      dryRun: config.dryRun,
      intervalMs: config.intervalMs,
      markets,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  };
}

// ── Single cycle ──────────────────────────────────────────────────────────────

// One-time oracle-authority check cache (keeper == oracle_authority?). A
// batched tx is atomic, so we only ever include known-pushable markets.
const authorityChecked = new Set<string>();
const notPushable = new Set<string>();
// Blockhash cache — a fresh one is valid ~60-90s; refetch every 15s so each
// cycle doesn't pay a getLatestBlockhash round-trip.
let cachedBlockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
let cachedBlockhashAt = 0;

/**
 * FAST cycle: ONE getMultipleAccounts to read every mainnet DEX pool, ONE
 * batched PushAuthMark tx for all pushable markets, fired WITHOUT awaiting
 * confirmation. ~3 RPC calls per cycle (was ~25), so the on-chain AuthMark can
 * refresh near per-slot. Price source is unchanged — the mainnet DEX pools.
 */
async function runCycle(
  mainnetConn: Connection,
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  decimalsCache: DecimalsCache,
  state: LoopState,
  config: LoopConfig,
): Promise<void> {
  // Ensure stat entries exist.
  for (const entry of registry.markets) {
    if (!state.stats.has(entry.marketAddress)) {
      state.stats.set(entry.marketAddress, {
        label: entry.label,
        marketAddress: entry.marketAddress,
        poolAddress: entry.poolAddress,
        dexType: entry.dexType,
        lastPriceE6: 0n,
        lastPushAt: null,
        lastSig: null,
        totalPushes: 0,
        totalErrors: 0,
        lastErrorMsg: null,
        authorityMismatch: false,
      });
    }
  }

  // ── 1. One-time oracle-authority check (only pushable markets go in a batch) ─
  const unchecked = registry.markets.filter((m) => !authorityChecked.has(m.marketAddress));
  if (unchecked.length > 0) {
    await Promise.all(
      unchecked.map(async (m) => {
        const auth = await fetchOracleAuthority(devnetConn, m.marketAddress, m.assetIndex);
        authorityChecked.add(m.marketAddress);
        const ok = auth !== null && auth.equals(keeper.publicKey);
        if (!ok) {
          notPushable.add(m.marketAddress);
          const s = state.stats.get(m.marketAddress)!;
          s.authorityMismatch = true;
          s.lastErrorMsg = "oracle_authority != keeper — market not pushable";
          console.warn(`[loop] ${m.label}: not pushable (oracle_authority != keeper)`);
        }
      }),
    );
  }

  // ── 2. Read ALL pool prices in ONE getMultipleAccounts (DEX-pool source) ────
  let prices: Map<string, bigint>;
  try {
    prices = await readAllPoolPricesE6(mainnetConn, registry.markets, decimalsCache);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    console.error(`[loop] batch pool read error — ${msg}`);
    return;
  }

  // ── 3. Build the pushable set for this cycle ────────────────────────────────
  const pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }> = [];
  for (const entry of registry.markets) {
    if (notPushable.has(entry.marketAddress)) continue;
    const priceE6 = prices.get(entry.poolAddress);
    const stat = state.stats.get(entry.marketAddress)!;
    if (priceE6 === undefined || priceE6 <= 0n) {
      stat.totalErrors++;
      stat.lastErrorMsg = "no pool price this cycle";
      continue;
    }
    stat.lastPriceE6 = priceE6;
    pushes.push({ marketAddress: entry.marketAddress, assetIndex: entry.assetIndex, priceE6 });
  }
  if (pushes.length === 0) return;

  // ── 4. One slot + one (cached) blockhash for the whole batch ────────────────
  const nowSlot = BigInt(await devnetConn.getSlot("processed"));
  const now = Date.now();
  if (!cachedBlockhash || now - cachedBlockhashAt > 15_000) {
    cachedBlockhash = await devnetConn.getLatestBlockhash("processed");
    cachedBlockhashAt = now;
  }

  // ── 5. One batched PushAuthMark tx, fire-and-forget ─────────────────────────
  try {
    const res = await pushAuthMarkBatch(devnetConn, keeper, pushes, nowSlot, cachedBlockhash, config.dryRun);
    const stamp = Date.now();
    for (const p of pushes) {
      const stat = state.stats.get(p.marketAddress)!;
      stat.authorityMismatch = false;
      if (config.dryRun) {
        stat.lastSig = "DRY_RUN";
      } else if (res.pushed && res.signature) {
        stat.totalPushes++;
        stat.lastPushAt = stamp;
        stat.lastSig = res.signature;
      }
    }
    if (res.pushed && res.signature) {
      console.log(`[loop] batched push × ${res.count}: sig=${res.signature.slice(0, 16)}…`);
    }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    console.error(`[loop] batch push error — ${msg}`);
    if (/blockhash/i.test(msg)) cachedBlockhash = null; // force refresh next cycle
    for (const p of pushes) {
      const s = state.stats.get(p.marketAddress)!;
      s.totalErrors++;
      s.lastErrorMsg = msg;
    }
  }
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

/**
 * Start the cross-cluster keeper loop.
 *
 * Runs indefinitely. Handles SIGINT/SIGTERM for graceful shutdown.
 * The health server is started before the first cycle begins.
 */
export async function startKeeperLoop(
  mainnetConn: Connection,
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  config: LoopConfig,
): Promise<void> {
  // Initialise per-market stats
  const state: LoopState = {
    startedAt: Date.now(),
    lastCycleAt: null,
    cycleCount: 0,
    stats: new Map(
      registry.markets.map((m) => [
        m.marketAddress,
        {
          label: m.label,
          marketAddress: m.marketAddress,
          poolAddress: m.poolAddress,
          dexType: m.dexType,
          lastPriceE6: 0n,
          lastPushAt: null,
          lastSig: null,
          totalPushes: 0,
          totalErrors: 0,
          lastErrorMsg: null,
          authorityMismatch: false,
        } satisfies MarketStat,
      ]),
    ),
  };

  const decimalsCache: DecimalsCache = new Map();

  // Health server
  const server = http.createServer(makeHealthHandler(state, config));
  server.listen(config.healthPort, config.healthBind, () => {
    console.log(
      `[keeper] Health: http://${config.healthBind}:${config.healthPort}/health`,
    );
  });

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("[keeper] SIGINT/SIGTERM — shutting down…");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const mode = config.dryRun ? "DRY-RUN" : "LIVE";
  console.log(
    `[keeper] Cross-cluster keeper (${mode}):` +
      ` ${registry.markets.length} markets, interval=${config.intervalMs}ms`,
  );

  // Main loop
  while (!stopping) {
    const cycleStart = Date.now();
    state.cycleCount++;
    console.log(
      `\n[keeper] === Cycle ${state.cycleCount} ${new Date().toISOString()} ===`,
    );

    try {
      await runCycle(
        mainnetConn,
        devnetConn,
        keeper,
        registry,
        decimalsCache,
        state,
        config,
      );
    } catch (err) {
      console.error(
        `[keeper] Unexpected cycle error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    state.lastCycleAt = Date.now();
    const elapsed = Date.now() - cycleStart;
    const remaining = config.intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
}
