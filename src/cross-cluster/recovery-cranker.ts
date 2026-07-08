/**
 * cross-cluster/recovery-cranker.ts
 *
 * Periodic maintenance crank: keeps each registry market's engine-side
 * accrual state (`asset.slot_last` / `header.current_slot`) from drifting
 * too far behind the live chain slot.
 *
 * Why this exists (root cause, verified on-chain 2026-07-06):
 *   The cross-cluster oracle loop (auth-mark-pusher.ts) only ever calls
 *   PushAuthMark, which updates the wrapper's oracle profile (mark_ewma_e6,
 *   oracle_target_price_e6, ...). It never touches the ENGINE's accrual
 *   state. `header.current_slot` only advances inside
 *   `accrue_asset_to_not_atomic`, which runs on a `PermissionlessCrank` or a
 *   trade/settle instruction — never on PushAuthMark.
 *
 *   Once ANY such instruction lands after a long gap, `header.current_slot`
 *   jumps to the live slot (uncapped), but `asset.slot_last` only advances by
 *   `max_accrual_dt_slots` (500 on these markets) per call. Until
 *   `asset.slot_last` catches back up, `asset_is_loss_stale()` reads true and
 *   every RISK-INCREASING trade (new opens / adding to a position) fails with
 *   `Custom(21)` (`PercolatorError::EngineLockActive`, mapped from the
 *   engine's `V16Error::LockActive` in `trade_preflight_risk_gate`).
 *   Risk-decreasing trades (closes) are not gated by this specific check, but
 *   the gap only ever grows while nothing cranks the market, so left alone a
 *   market eventually accumulates enough drift to affect other staleness
 *   gates too (`reject_exposed_target_effective_lag_view`, B-settlement
 *   chunks, etc). This loop prevents the drift from ever growing large by
 *   touching every market on a steady cadence.
 *
 * What it does:
 *   Every `intervalMs` (default 20s), fire one `PermissionlessCrank`
 *   (action=0=Refresh) per registry market, targeting that market's
 *   matcher-enabled ("LP vault") portfolio — any account whose stored
 *   `market` field matches the slab works for Refresh, but the LP portfolio
 *   is a stable, market-owned account that won't disappear if a user closes
 *   their position, so it's the safest fixed target.
 *
 * Deliberately separate from the oracle push loop:
 *   - Independent interval (crank only needs to run every ~10-30s; the
 *     oracle push runs every ~0.5-7s and must not be slowed down by this).
 *   - Independent errors — a crank failure never touches oracle-push state.
 *   - One instruction per transaction. Multiple Refresh crank instructions
 *     CANNOT be batched in a single tx: the first one's
 *     `accrue_asset_to_not_atomic` bumps `oracle_epoch`, which invalidates
 *     account health certs for any subsequent instruction in the same tx
 *     (`EngineStale` / Custom(19)). So unlike `pushAuthMarkBatch`, this sends
 *     one tx per market per cycle, fire-and-forget (no confirm await), same
 *     as the push loop's fire-and-forget style.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  encodePermissionlessCrank,
  CrankAction,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  PROGRAM_IDS_V17,
} from "@percolatorct/sdk";
import type { MarketEntry, Registry } from "./registry.ts";

const WRAPPER_PROGRAM_ID = new PublicKey(PROGRAM_IDS_V17.percolator);
const COMPUTE_UNIT_LIMIT = 250_000;

// ── v17 portfolio account discriminator (verified against live devnet data) ──
// Every v17 portfolio account starts with this 8-byte tag. The market pubkey
// the portfolio belongs to is stored at byte offset 16. A trailing
// PortfolioMatcherConfigV16 block (104 bytes) marks a portfolio as an
// LP-vault / matcher counterparty when its `enabled` u64 (at block offset 96)
// reads 1 — that's the stable, market-owned account this loop targets.
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF = 16;
const PORTFOLIO_MATCHER_CONFIG_LEN = 104;

export interface CrankLoopConfig {
  /** Milliseconds between crank cycle starts. */
  intervalMs: number;
  /** If true, build instructions and log them but do not send. */
  dryRun: boolean;
}

interface CrankMarketState {
  /** Cached LP-vault portfolio bound to this market (from registry.json's seed, or discovered via getProgramAccounts). */
  lpPortfolio: PublicKey | null;
  /**
   * D5: once true, the registry's seeded `lpPortfolio` has been tried and
   * rejected on-chain (e.g. AccountNotFound) — permanently fall through to
   * real getProgramAccounts discovery for this market instead of retrying
   * the same known-bad seeded address forever.
   */
  seedRejected: boolean;
  lastDiscoveryAttemptAt: number;
  /** Cranks that PREFLIGHTED CLEAN and were submitted (real progress). */
  totalCranks: number;
  /** Send/RPC failures (not on-chain reverts). */
  totalErrors: number;
  /** On-chain reverts caught by preflight (EngineStale/EngineLockActive/etc). */
  totalReverts: number;
  /** Consecutive reverts since the last clean crank — the drift early-warning signal. */
  consecutiveReverts: number;
  lastRevertCode: number | null;
  lastCrankAt: number | null;
  lastSig: string | null;
  lastErrorMsg: string | null;
}

function freshCrankMarketState(): CrankMarketState {
  return {
    lpPortfolio: null,
    seedRejected: false,
    lastDiscoveryAttemptAt: 0,
    totalCranks: 0,
    totalErrors: 0,
    totalReverts: 0,
    consecutiveReverts: 0,
    lastRevertCode: null,
    lastCrankAt: null,
    lastSig: null,
    lastErrorMsg: null,
  };
}

/**
 * How often to retry LP-portfolio discovery for a market with no seeded
 * `lpPortfolio` (registered live via register-poll, or a seeded market whose
 * seed was rejected — see `seedRejected` above).
 *
 * D5: was 5 * 60_000 (5 min) — LONGER than the ~190s engine accrue-staleness
 * cliff, so a single transient discovery miss right after boot was enough to
 * leave a market un-cranked long enough to die (root cause of the
 * SOL/JUP/TRUMP deaths). 20s keeps every retry well inside the cliff.
 */
const DISCOVERY_RETRY_MS = 20_000;

/** Consecutive reverts on one market before we escalate to a loud ALERT log. */
const REVERT_ALERT_THRESHOLD = 3;

/** Log a full per-market health summary every N cycles so the loop is never silently "healthy". */
const HEALTH_SUMMARY_EVERY_CYCLES = 30;

/** Parse a Solana "custom program error: 0xNN" (or {"Custom":NN}) code out of an error/sim result. */
function parseCustomErrorCode(errLike: unknown): number | null {
  const text =
    typeof errLike === "string"
      ? errLike
      : errLike instanceof Error
        ? errLike.message
        : JSON.stringify(errLike ?? "");
  const hex = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = text.match(/"Custom":\s*(\d+)/);
  return dec ? parseInt(dec[1], 10) : null;
}

/**
 * Run an RPC call with bounded exponential backoff on transient failures
 * (429 rate-limit, fetch/network/5xx). Prevents a rate-limit blip from throwing
 * an UNHANDLED rejection that crashes the whole keeper process — that was the
 * 2026-07-06 crash (`keeper-new.log`: an un-retried 429 in a fire-and-forget
 * send bubbled to Node's unhandledRejection and exited the process).
 */
async function withRpcRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /429|rate.?limit|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|50[234]/i.test(msg);
      if (!transient || attempt >= maxAttempts) throw err;
      const backoff = Math.min(4_000, 250 * 2 ** (attempt - 1));
      console.warn(`[cranker] ${label}: transient RPC error (attempt ${attempt}/${maxAttempts}) — ${msg.slice(0, 80)}; retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

function readMatcherEnabled(data: Buffer): boolean {
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN) return false;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN;
  // enabled: u64 LE at block offset 96
  const enabled = data.readBigUInt64LE(off + 96);
  return enabled === 1n;
}

/**
 * Find a matcher-enabled ("LP vault") portfolio bound to `market`. Returns
 * null if none exists yet (e.g. a brand-new market with no LP vault) — the
 * caller should skip cranking that market until discovery succeeds.
 */
async function findLpPortfolio(
  conn: Connection,
  market: PublicKey,
): Promise<PublicKey | null> {
  const accounts = await conn.getProgramAccounts(WRAPPER_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
      { memcmp: { offset: V17_PF_MARKET_OFF, bytes: market.toBase58() } },
    ],
  });
  for (const { pubkey, account } of accounts) {
    if (readMatcherEnabled(Buffer.from(account.data))) return pubkey;
  }
  return null;
}

function buildCrankIx(owner: PublicKey, market: PublicKey, portfolio: PublicKey): TransactionInstruction {
  const accountMetas = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
    owner,
    market,
    portfolio,
  });
  const data = encodePermissionlessCrank({
    action: CrankAction.FeeSweep, // 0 = Refresh (the only recovery-relevant action the wrapper exposes permissionlessly)
    assetIndex: 0,
    nowSlot: 0n, // program authenticates against Clock::get() regardless of this value
    closeQ: 0n,
    feeBps: 0n,
    recoveryReason: 0, // any nonzero value is rejected by the wrapper (InvalidInstruction) — must stay 0
  });
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: accountMetas,
    data: data as unknown as Buffer,
  });
}

async function crankOneMarket(
  devnetConn: Connection,
  keeper: Keypair,
  entry: Pick<MarketEntry, "marketAddress" | "label" | "lpPortfolio">,
  state: CrankMarketState,
  dryRun: boolean,
): Promise<void> {
  const marketAddress = entry.marketAddress;
  const label = entry.label;
  const market = new PublicKey(marketAddress);

  // ── D5: seeded fast path — use registry.json's known lpPortfolio directly,
  // no getProgramAccounts discovery at all. This is what makes crank-on-boot
  // (crankAllOnce, below) deterministic and fast for every seeded market.
  if (!state.lpPortfolio && entry.lpPortfolio && !state.seedRejected) {
    try {
      state.lpPortfolio = new PublicKey(entry.lpPortfolio);
      console.log(`[cranker] ${label}: using seeded LP portfolio ${state.lpPortfolio.toBase58()} (registry.json — no discovery needed)`);
    } catch {
      // Malformed registry data, not a runtime account problem — don't retry
      // parsing garbage every cycle, fall through to real discovery once.
      state.seedRejected = true;
      console.warn(`[cranker] ${label}: registry lpPortfolio "${entry.lpPortfolio}" is not a valid pubkey — falling back to discovery`);
    }
  }

  if (!state.lpPortfolio) {
    const now = Date.now();
    if (now - state.lastDiscoveryAttemptAt < DISCOVERY_RETRY_MS) return; // recently failed, don't hammer getProgramAccounts
    state.lastDiscoveryAttemptAt = now;
    try {
      state.lpPortfolio = await findLpPortfolio(devnetConn, market);
      if (!state.lpPortfolio) {
        console.warn(`[cranker] ${label}: no LP-vault portfolio found yet — skipping until one exists`);
        return;
      }
      console.log(`[cranker] ${label}: discovered LP portfolio ${state.lpPortfolio.toBase58()}`);
    } catch (err) {
      state.lastErrorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[cranker] ${label}: LP-portfolio discovery failed — ${state.lastErrorMsg}`);
      return;
    }
  }

  const ix = buildCrankIx(keeper.publicKey, market, state.lpPortfolio);

  if (dryRun) {
    console.log(`[cranker][DRY-RUN] Refresh crank market=${marketAddress.slice(0, 8)}… portfolio=${state.lpPortfolio.toBase58().slice(0, 8)}…`);
    return;
  }

  try {
    const bh = await withRpcRetry(label, () => devnetConn.getLatestBlockhash("processed"));
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    tx.add(ix);
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);

    // PREFLIGHT FIRST so a reverting crank is VISIBLE instead of being silently
    // counted as a success. This is the 2026-07-06 root cause: the old path sent
    // with skipPreflight:true fire-and-forget, so every EngineStale(19) /
    // EngineLockActive(21) revert was counted as `totalCranks++` and the loop
    // reported "healthy" while the markets drifted to an UNRECOVERABLE deep-stale
    // state. A crank that would revert must NOT be sent — and must be alerted on.
    // Legacy Transaction overload: it's already signed by the keeper with a fresh
    // blockhash, so a plain simulate reflects exactly what a real send would do.
    const sim = await withRpcRetry(label, () => devnetConn.simulateTransaction(tx));
    if (sim.value.err) {
      const code =
        parseCustomErrorCode(sim.value.err) ?? parseCustomErrorCode(sim.value.logs?.join("\n"));
      state.totalReverts++;
      state.consecutiveReverts++;
      state.lastRevertCode = code;
      state.lastErrorMsg = `revert ${code != null ? `Custom(${code})` : JSON.stringify(sim.value.err)}`;
      // 19=EngineStale, 21=EngineLockActive = the deep-stale signature. A fresh /
      // lightly-stale market cranks CLEAN (only a rotting one reverts every cycle),
      // so escalate loudly once it persists — that early warning is exactly what
      // was missing when these 4 markets drifted past the point of recovery.
      if (state.consecutiveReverts === 1 || state.consecutiveReverts % REVERT_ALERT_THRESHOLD === 0) {
        const tag = state.consecutiveReverts >= REVERT_ALERT_THRESHOLD ? "[cranker][ALERT]" : "[cranker][REVERT]";
        console.warn(
          `${tag} ${label}: crank ${state.lastErrorMsg} (${state.consecutiveReverts}× consecutive). ` +
            `Engine accrual is drifting toward an unrecoverable deep-stale state — investigate / re-seed if this persists.`,
        );
      }
      return;
    }

    // Clean preflight → submit (skipPreflight because we just simulated). Still
    // fire-and-forget on confirmation, like the push loop — a dropped tx just
    // retries next cycle, but we now KNOW it would have executed.
    const signature = await withRpcRetry(label, () =>
      devnetConn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 }),
    );
    state.totalCranks++;
    state.lastCrankAt = Date.now();
    state.lastSig = signature;
    state.lastErrorMsg = null;
    if (state.consecutiveReverts > 0) {
      console.log(
        `[cranker] ${label}: RECOVERED — crank landed clean after ${state.consecutiveReverts} revert(s). sig=${signature.slice(0, 12)}…`,
      );
    }
    state.consecutiveReverts = 0;
    state.lastRevertCode = null;
  } catch (err) {
    state.totalErrors++;
    state.lastErrorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[cranker] ${label}: crank send failed — ${state.lastErrorMsg.slice(0, 160)}`);
    // A stale-account error (e.g. LP portfolio closed) is worth rediscovering next attempt.
    if (/AccountNotFound|could not find account/i.test(state.lastErrorMsg)) {
      if (entry.lpPortfolio && state.lpPortfolio?.toBase58() === entry.lpPortfolio && !state.seedRejected) {
        // The registry's SEEDED lpPortfolio doesn't exist on-chain — permanently
        // stop retrying it and fall through to real discovery next cycle instead
        // of spinning on the same known-bad address forever.
        state.seedRejected = true;
        console.warn(`[cranker][ALERT] ${label}: seeded LP portfolio ${entry.lpPortfolio} not found on-chain — falling back to discovery`);
      }
      state.lpPortfolio = null;
    }
  }
}

/**
 * D1: Deterministic crank-on-boot. Cranks every SEEDED market (one with a
 * known `lpPortfolio` in registry.json) exactly once, using ONLY that seeded
 * address — no getProgramAccounts discovery calls — so this resolves in a
 * small, bounded number of RPC round-trips regardless of registry size.
 *
 * Call this AWAITED, before starting any of the recurring background loops.
 * It guarantees every seeded market gets a real crank attempt within a few
 * RPC calls of process boot, closing the exact gap that killed
 * SOL/JUP/TRUMP: previously the very first crank for a market came from the
 * recurring loop's own (fire-and-forget, un-awaited) first cycle, so a slow
 * boot or one bad discovery round-trip in that first cycle could leave a
 * market un-cranked with no guarantee of a fast retry.
 *
 * Markets with no seeded `lpPortfolio` (only ones registered live via
 * register-poll, whose payload has no lpPortfolio field) are skipped here —
 * they're picked up by startRecoveryCrankLoop's discovery fallback on its
 * normal cadence.
 */
export async function crankAllOnce(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  dryRun: boolean,
): Promise<void> {
  const seeded = registry.markets.filter((m) => !!m.lpPortfolio);
  if (seeded.length === 0) {
    console.log("[cranker][boot] no seeded (lpPortfolio-known) markets in registry.json — skipping crank-on-boot");
    return;
  }
  console.log(`[cranker][boot] cranking ${seeded.length} seeded market(s) once before starting the recurring loops…`);

  const results = await Promise.allSettled(
    seeded.map(async (m) => {
      const state = freshCrankMarketState();
      await crankOneMarket(devnetConn, keeper, m, state, dryRun);
      return { market: m, state };
    }),
  );

  let ok = 0;
  let notClean = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      const { market, state } = r.value;
      if (dryRun || state.lastSig) {
        ok++;
      } else {
        notClean++;
        if (state.lastErrorMsg) {
          console.warn(`[cranker][boot] ${market.label}: not clean this attempt — ${state.lastErrorMsg}`);
        }
      }
    } else {
      notClean++;
      console.error(`[cranker][boot] unexpected crank-on-boot failure: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }
  console.log(
    `[cranker][boot] crank-on-boot complete: ${ok} clean, ${notClean} not-clean` +
      `${notClean > 0 ? " (will keep retrying on the recurring crank loop)" : ""}.`,
  );
}

/**
 * Start the periodic recovery/maintenance crank loop. Runs indefinitely on
 * its own interval, completely independent of the oracle push loop — call
 * this WITHOUT awaiting it (`void startRecoveryCrankLoop(...)`) so it runs
 * concurrently with `startKeeperLoop`.
 */
export async function startRecoveryCrankLoop(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  config: CrankLoopConfig,
): Promise<void> {
  const states = new Map<string, CrankMarketState>(
    registry.markets.map((m) => [m.marketAddress, freshCrankMarketState()]),
  );

  console.log(
    `[cranker] Recovery crank loop starting: ${registry.markets.length} markets,` +
      ` interval=${config.intervalMs}ms, mode=${config.dryRun ? "DRY-RUN" : "LIVE"}`,
  );

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  let cycleCount = 0;
  while (!stopping) {
    const cycleStart = Date.now();
    // G8: crank every market in the cycle CONCURRENTLY instead of sequentially
    // (was a `for...await` loop — N markets meant N sequential RPC round-trips
    // per cycle, so cycle wall-time grew linearly with registry size). Each
    // market's errors are already fully isolated inside crankOneMarket / the
    // per-iteration try/catch below, so Promise.allSettled here is defense in
    // depth, not a correctness requirement — it just keeps cycle time flat.
    await Promise.allSettled(
      registry.markets.map(async (m) => {
        // Lazily track markets registered AFTER boot (added live by the register-poll
        // loop, or hot-reloaded — see registry-reload.ts). The states Map was seeded
        // only from the markets present at startup, so without this a newly-registered
        // market would hit `undefined` here and its crank would throw every cycle — it
        // would never un-stale and stay untradeable.
        let state = states.get(m.marketAddress);
        if (!state) {
          state = freshCrankMarketState();
          states.set(m.marketAddress, state);
          console.log(`[cranker] now tracking newly-registered market ${m.label} (${m.marketAddress.slice(0, 8)}…)`);
        }
        try {
          await crankOneMarket(devnetConn, keeper, m, state, config.dryRun);
        } catch (err) {
          // Defense in depth: crankOneMarket already isolates errors per-market,
          // but never let an unexpected throw kill the whole loop.
          console.error(`[cranker] ${m.label}: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    cycleCount++;
    if (cycleCount % HEALTH_SUMMARY_EVERY_CYCLES === 0) {
      const summary = registry.markets
        .map((m) => {
          const st = states.get(m.marketAddress)!;
          const flag = st.consecutiveReverts >= REVERT_ALERT_THRESHOLD ? "⚠STUCK" : st.consecutiveReverts > 0 ? "~drift" : "ok";
          return `${m.label}=${flag}(ok:${st.totalCranks} rev:${st.totalReverts}${st.consecutiveReverts ? ` cons:${st.consecutiveReverts}` : ""}${st.lastRevertCode != null ? ` last:${st.lastRevertCode}` : ""})`;
        })
        .join("  ");
      console.log(`[cranker][health] cycle ${cycleCount}: ${summary}`);
    }
    const elapsed = Date.now() - cycleStart;
    const remaining = config.intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
  console.log("[cranker] Recovery crank loop stopped.");
}
