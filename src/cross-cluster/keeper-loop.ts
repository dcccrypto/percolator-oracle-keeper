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
import { readPoolPriceE6 } from "./price-reader.ts";
import { pushAuthMark } from "./auth-mark-pusher.ts";

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

async function runCycle(
  mainnetConn: Connection,
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  decimalsCache: DecimalsCache,
  state: LoopState,
  config: LoopConfig,
): Promise<void> {
  // Pool price cache for this cycle: avoid duplicate mainnet fetches when
  // multiple markets share the same pool.
  const poolPriceCache = new Map<string, bigint>();

  for (const entry of registry.markets) {
    // Ensure stat entry exists (handles hot-reload of registry if supported later)
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
    const stat = state.stats.get(entry.marketAddress)!;

    // ── 1. Read pool price ─────────────────────────────────────────────────
    let priceE6: bigint;
    if (poolPriceCache.has(entry.poolAddress)) {
      priceE6 = poolPriceCache.get(entry.poolAddress)!;
    } else {
      try {
        const result = await readPoolPriceE6(mainnetConn, entry, decimalsCache);
        if (result.skipped) {
          console.log(
            `[loop] ${entry.label}: pool skip — ${result.skipReason}`,
          );
          stat.totalErrors++;
          stat.lastErrorMsg = result.skipReason ?? "pool skipped";
          continue;
        }
        priceE6 = result.priceE6;
        poolPriceCache.set(entry.poolAddress, priceE6);
        console.log(
          `[loop] ${entry.label}: ${result.source}` +
            ` priceE6=${priceE6} ($${(Number(priceE6) / 1e6).toFixed(4)})`,
        );
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(
          0,
          140,
        );
        console.error(`[loop] ${entry.label}: pool read error — ${msg}`);
        stat.totalErrors++;
        stat.lastErrorMsg = msg;
        continue;
      }
    }

    // ── 2. Push to devnet market ───────────────────────────────────────────
    try {
      const result = await pushAuthMark(
        devnetConn,
        keeper,
        entry.marketAddress,
        entry.assetIndex,
        priceE6,
        config.dryRun,
      );

      if (result.authorityMismatch) {
        stat.authorityMismatch = true;
        stat.lastErrorMsg = "oracle_authority != keeper — market not pushable";
        continue;
      }

      stat.lastPriceE6 = priceE6;
      stat.authorityMismatch = false;
      stat.totalPushes++;
      stat.lastPushAt = Date.now();

      if (result.pushed && result.signature) {
        stat.lastSig = result.signature;
        console.log(
          `[loop] ${entry.label}: sig=${result.signature.slice(0, 16)}…`,
        );
      } else if (result.dryRun) {
        stat.lastSig = "DRY_RUN";
      }
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(
        0,
        140,
      );
      console.error(`[loop] ${entry.label}: push error — ${msg}`);
      stat.totalErrors++;
      stat.lastErrorMsg = msg;
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
