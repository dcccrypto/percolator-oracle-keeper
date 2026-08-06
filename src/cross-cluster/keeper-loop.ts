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
import { createMarkSmoother } from "./mark-smoother.ts";
import { checkCircuitBreaker } from "../circuit-breaker.ts";
import type { CircuitBreakerState } from "../circuit-breaker.ts";
import { pushAuthMarkBatch, fetchOracleAuthority, getQuarantinedMarkets } from "./auth-mark-pusher.ts";

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
  /**
   * D2a: max milliseconds to wait for a single runCycle() before giving up
   * on it and starting the next cycle anyway. Defaults to 10_000 if unset.
   * See the `Promise.race` in the main loop below for why this exists.
   */
  cycleTimeoutMs?: number;
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
  /** D2a: cycles that hit the cycleTimeoutMs watchdog (runCycle never resolved in time). */
  timeoutCount: number;
  stats: Map<string, MarketStat>;
  /**
   * Pricing-outage visibility (2026-07-31 audit). A total mainnet-read
   * failure used to be the LEAST visible failure in the service: the cycle
   * logged and returned, per-market stats untouched, /health green, while
   * every market stayed tradeable against a frozen AuthMark. These fields
   * make that state impossible to miss.
   */
  lastSuccessfulPushAt: number | null;
  consecutiveBatchReadFailures: number;
  lastBatchReadError: string | null;
}

/**
 * Health status for the pricing pipeline, separated from the handler so it
 * is testable as a pure function. "stalled-pricing" means: markets are
 * registered, and either the batch read has failed many times running or no
 * push has landed for PUSH_STALL_MS — the frozen-mark condition.
 */
export const PUSH_STALL_MS = 120_000;
export const BATCH_FAILURE_ALERT_THRESHOLD = 5;
export function pricingHealthStatus(
  state: Pick<
    LoopState,
    "lastSuccessfulPushAt" | "consecutiveBatchReadFailures" | "startedAt"
  >,
  marketCount: number,
  nowMs: number,
): "ok" | "stalled-pricing" {
  if (marketCount === 0) return "ok"; // empty board: nothing CAN push
  if (state.consecutiveBatchReadFailures >= BATCH_FAILURE_ALERT_THRESHOLD) {
    return "stalled-pricing";
  }
  // Never pushed since boot counts from process start — a keeper that comes
  // up broken must not read "ok" forever just because the field is null.
  const last = state.lastSuccessfulPushAt ?? state.startedAt;
  return nowMs - last > PUSH_STALL_MS ? "stalled-pricing" : "ok";
}

// ── Health server ─────────────────────────────────────────────────────────────

function makeHealthHandler(state: LoopState, config: LoopConfig, registry: Registry) {
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
    // A quarantined market reverted its push 3 cycles running, so the pusher
    // stopped batching it to keep it from freezing everyone else's price.
    //
    // Reported in the BODY, deliberately still HTTP 200: railway.toml
    // health-gates deploys on this path and the Dockerfile HEALTHCHECK runs
    // `curl -sf`, which fails on 5xx. A 503 here would restart the keeper — and
    // since quarantine is in-memory, the restart clears it, the bad market gets
    // re-batched, takes 3 strikes, and 503s again: a restart loop that breaks
    // pricing for every market to report a problem with one. The service is
    // genuinely healthy in this state (it is doing exactly what it should);
    // it is the MARKET that is degraded, so alert on the field, not the code.
    const quarantinedMarkets = getQuarantinedMarkets();
    // stalled-pricing outranks degraded-markets: a frozen mark on EVERY
    // market (free-option risk against the LPs for the whole outage) is the
    // condition the 2026-07-31 audit found completely invisible here.
    const pricingStatus = pricingHealthStatus(state, registry.markets.length, Date.now());
    const payload = JSON.stringify({
      status:
        pricingStatus !== "ok"
          ? pricingStatus
          : quarantinedMarkets.length > 0
            ? "degraded-markets"
            : "ok",
      lastSuccessfulPushAgo:
        state.lastSuccessfulPushAt !== null
          ? `${Math.floor((Date.now() - state.lastSuccessfulPushAt) / 1000)}s`
          : null,
      consecutiveBatchReadFailures: state.consecutiveBatchReadFailures,
      lastBatchReadError: state.lastBatchReadError,
      quarantinedMarkets,
      uptimeSec,
      cycleCount: state.cycleCount,
      timeoutCount: state.timeoutCount,
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
/**
 * Audit fix (2026-07-31): these latches used to hold until process restart —
 * a market whose oracle_authority was later FIXED on-chain stayed unpushable
 * forever. Re-verify everything every 30 minutes; a wrongly-latched market
 * self-heals within that horizon, and the cost is one authority read per
 * market per half hour.
 */
const AUTHORITY_RECHECK_MS = 30 * 60_000;
let lastAuthorityRecheckAt = Date.now();
function maybeResetAuthorityLatches(): void {
  if (Date.now() - lastAuthorityRecheckAt < AUTHORITY_RECHECK_MS) return;
  lastAuthorityRecheckAt = Date.now();
  if (authorityChecked.size > 0 || notPushable.size > 0) {
    console.log(
      `[loop] periodic authority re-check: clearing ${authorityChecked.size} checked / ` +
        `${notPushable.size} not-pushable latches`,
    );
  }
  authorityChecked.clear();
  notPushable.clear();
}

/**
 * Robust AuthMark: per-pool median over a trailing window, so bot round-trips
 * on a hot pool (two-level ±1–2% churn — what drained the CATE LP) never
 * reach the engine as oscillation. See mark-smoother.ts for the full story.
 */
const markSmoother = createMarkSmoother();

function parseCrossClusterPositiveNumberEnv(
  name: string,
  fallback: number,
  maxExclusive?: number,
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  if (maxExclusive !== undefined && value >= maxExclusive) {
    throw new Error(`${name} must be less than ${maxExclusive}`);
  }
  return value;
}

function parseCrossClusterPositiveIntegerEnv(name: string, fallback: number): number {
  const value = parseCrossClusterPositiveNumberEnv(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const CROSS_CLUSTER_MAX_MOVE_PCT = parseCrossClusterPositiveNumberEnv(
  "CROSS_CLUSTER_MAX_MOVE_PCT",
  10,
  100,
);
const CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS = parseCrossClusterPositiveIntegerEnv(
  "CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS",
  3,
);

const crossClusterCircuitBreakerStates = new Map<string, CircuitBreakerState>();

function getCrossClusterCircuitBreakerState(
  marketAddress: string,
  label: string,
): CircuitBreakerState {
  let state = crossClusterCircuitBreakerStates.get(marketAddress);
  if (!state) {
    state = {
      symbol: label,
      lastPrice: 0,
      circuitBreakerTrips: 0,
      cbTripPrice: 0,
      cbConsecutiveTrips: 0,
    };
    crossClusterCircuitBreakerStates.set(marketAddress, state);
  }
  return state;
}

function priceE6ToUsdNumber(priceE6: bigint): number {
  return Number(priceE6) / 1_000_000;
}

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

  // ── 1. Oracle-authority check (only pushable markets go in a batch) ─────────
  // "One-time" per 30-minute window — see maybeResetAuthorityLatches.
  maybeResetAuthorityLatches();
  const unchecked = registry.markets.filter((m) => !authorityChecked.has(m.marketAddress));
  if (unchecked.length > 0) {
    await Promise.all(
      unchecked.map(async (m) => {
        let auth;
        try {
          auth = await fetchOracleAuthority(devnetConn, m.marketAddress, m.assetIndex);
        } catch (err) {
          // COULD NOT READ (RPC blip) — do NOT mark checked, do NOT blacklist.
          // Leaving it unchecked means we retry on the next cycle. Previously a
          // transient null here latched the market into `notPushable` FOREVER
          // (the set is module-level and never cleared), so a single rate-limit
          // burst at boot could take markets offline permanently while /health
          // still reported "ok".
          const s = state.stats.get(m.marketAddress)!;
          s.lastErrorMsg = `authority check failed (will retry): ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
          return;
        }
        authorityChecked.add(m.marketAddress);
        // Only a SUCCESSFULLY READ, genuinely different authority is permanent.
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
    prices = await readAllPoolPricesE6(
      mainnetConn,
      registry.markets,
      decimalsCache,
      // SOL/USD reference for WSOL-quoted (pumpswap) pools when no SOL/USDC
      // market is registered — see the param's doc comment.
      process.env.SOL_USD_REFERENCE_POOL,
    );
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    state.consecutiveBatchReadFailures++;
    state.lastBatchReadError = msg;
    console.error(
      `[loop] batch pool read error (${state.consecutiveBatchReadFailures} consecutive) — ${msg}`,
    );
    return;
  }
  state.consecutiveBatchReadFailures = 0;
  state.lastBatchReadError = null;

  // ── 3. Build the pushable set for this cycle ────────────────────────────────
  const pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }> = [];
  const smoothNowMs = Date.now();
  // Smooth once per POOL per cycle, not once per market: N markets sharing a
  // pool would insert N identical samples per cycle, silently shrinking the
  // smoother's time window by N× against its MAX_SAMPLES cap (3 sharers cut
  // the 180s window to ~149s — undoing the widening that was deployed
  // precisely because 90s was insufficient).
  const smoothedThisCycle = new Map<string, bigint | null>();
  for (const entry of registry.markets) {
    if (notPushable.has(entry.marketAddress)) continue;
    const rawPriceE6 = prices.get(entry.poolAddress);
    const stat = state.stats.get(entry.marketAddress)!;
    if (rawPriceE6 === undefined || rawPriceE6 <= 0n) {
      stat.totalErrors++;
      stat.lastErrorMsg = "no pool price this cycle";
      continue;
    }
    // The mark that settles trades is the SMOOTHED price, never raw spot.
    let priceE6 = smoothedThisCycle.get(entry.poolAddress);
    if (priceE6 === undefined) {
      priceE6 = markSmoother.smooth(entry.poolAddress, rawPriceE6, smoothNowMs);
      smoothedThisCycle.set(entry.poolAddress, priceE6);
    }
    if (priceE6 === null) {
      stat.totalErrors++;
      stat.lastErrorMsg = "mark smoother re-priming — withholding push until minSamples";
      continue;
    }

    const circuitBreakerState = getCrossClusterCircuitBreakerState(
      entry.marketAddress,
      entry.label,
    );
    const priceUsd = priceE6ToUsdNumber(priceE6);
    const allowed = checkCircuitBreaker(circuitBreakerState, priceUsd, {
      maxMovePct: CROSS_CLUSTER_MAX_MOVE_PCT,
      confirmTrips: CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS,
      log: (msg) => console.warn(`[loop] ${msg}`),
    });
    if (!allowed) {
      stat.totalErrors++;
      stat.lastErrorMsg =
        `circuit breaker blocked mark move at ${priceUsd.toFixed(6)}`;
      continue;
    }
    circuitBreakerState.lastPrice = priceUsd;

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
    // Record PER MARKET, not per batch. This loop used to stamp every market in
    // `pushes` as freshly pushed whenever the batch reported success — so a
    // market that was dropped (reverting or quarantined) still showed a fresh
    // lastPushAt and a rising totalPushes on /health. That made a frozen price
    // look healthy, which is how a stuck market goes unnoticed for days.
    const pushedSet = new Set(res.pushedMarkets);
    for (const p of pushes) {
      const stat = state.stats.get(p.marketAddress)!;
      stat.authorityMismatch = false;
      if (config.dryRun) {
        stat.lastSig = "DRY_RUN";
      } else if (pushedSet.has(p.marketAddress) && res.signature) {
        stat.totalPushes++;
        stat.lastPushAt = stamp;
        stat.lastSig = res.signature;
      } else {
        stat.totalErrors++;
        stat.lastErrorMsg = "dropped from batch (reverted in preflight or quarantined)";
      }
    }
    if (res.pushed && res.signature) {
      state.lastSuccessfulPushAt = stamp;
      console.log(`[loop] batched push × ${res.count}: sig=${res.signature.slice(0, 16)}…`);
    } else if (config.dryRun && pushes.length > 0) {
      // Dry-run "pushes" count as liveness — the pipeline produced prices.
      state.lastSuccessfulPushAt = stamp;
    }
    if (res.skippedMarkets.length > 0) {
      console.warn(
        `[loop] ${res.skippedMarkets.length} market(s) NOT priced this cycle: ` +
          res.skippedMarkets.map((m) => m.slice(0, 8) + "…").join(", "),
      );
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

// ── D2a: hang detection ───────────────────────────────────────────────────────

const DEFAULT_CYCLE_TIMEOUT_MS = 10_000;

/** Sentinel error thrown when a cycle is abandoned by the watchdog timeout. */
class CycleTimeoutError extends Error {}

/**
 * Rejects after `ms` with a CycleTimeoutError. Racing this against runCycle()
 * means a black-holed RPC socket (a request that never resolves and never
 * rejects — the failure mode `withRpcRetry`/try-catch can't help with,
 * because there's no error to catch) can no longer stall the main loop
 * forever. This is best-effort: web3.js's Connection methods don't accept an
 * AbortSignal, so the abandoned runCycle() call isn't actually cancelled —
 * it keeps running in the background and its result (or error) is discarded
 * when it eventually settles. What this DOES guarantee is that the loop's
 * `lastCycleAt` keeps advancing and a new cycle gets a chance to run, so the
 * keeper can't go fully silent because of one wedged RPC call. Full
 * cancellation + an external process-level watchdog are D2b/D3 (deferred).
 */
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new CycleTimeoutError(`runCycle exceeded ${ms}ms`)), ms);
  });
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
  const cycleTimeoutMs = config.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS;

  // Initialise per-market stats
  const state: LoopState = {
    startedAt: Date.now(),
    lastCycleAt: null,
    cycleCount: 0,
    timeoutCount: 0,
    lastSuccessfulPushAt: null,
    consecutiveBatchReadFailures: 0,
    lastBatchReadError: null,
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
  const server = http.createServer(makeHealthHandler(state, config, registry));
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
      // D2a: race the cycle against a timeout so a black-holed RPC call can't
      // stall the loop silently forever — see timeoutAfter()'s doc comment
      // for exactly what this does and does not guarantee.
      await Promise.race([
        runCycle(mainnetConn, devnetConn, keeper, registry, decimalsCache, state, config),
        timeoutAfter(cycleTimeoutMs),
      ]);
    } catch (err) {
      if (err instanceof CycleTimeoutError) {
        state.timeoutCount++;
        console.error(
          `[keeper][ALERT] Cycle ${state.cycleCount} TIMED OUT after ${cycleTimeoutMs}ms — moving on to the` +
            ` next cycle so the loop doesn't stall. (timeoutCount=${state.timeoutCount}; the abandoned` +
            ` in-flight call may still complete in the background and will be discarded.)`,
        );
      } else {
        console.error(
          `[keeper] Unexpected cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    state.lastCycleAt = Date.now();
    const elapsed = Date.now() - cycleStart;
    const remaining = config.intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
}
