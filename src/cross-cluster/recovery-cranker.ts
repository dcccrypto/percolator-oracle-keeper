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
import type { Registry } from "./registry.ts";

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
  /** Cached LP-vault portfolio bound to this market (discovered via getProgramAccounts). */
  lpPortfolio: PublicKey | null;
  lastDiscoveryAttemptAt: number;
  totalCranks: number;
  totalErrors: number;
  lastCrankAt: number | null;
  lastSig: string | null;
  lastErrorMsg: string | null;
}

/** How often to retry LP-portfolio discovery for a market that doesn't have one yet. */
const DISCOVERY_RETRY_MS = 5 * 60_000;

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
  marketAddress: string,
  label: string,
  state: CrankMarketState,
  dryRun: boolean,
): Promise<void> {
  const market = new PublicKey(marketAddress);

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
    const bh = await devnetConn.getLatestBlockhash("processed");
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    tx.add(ix);
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);

    // Fire-and-forget: same style as pushAuthMarkBatch — skip preflight, don't
    // await confirmation. This is a maintenance crank, not a user-facing action;
    // one dropped tx just means we try again next cycle.
    const signature = await devnetConn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });
    state.totalCranks++;
    state.lastCrankAt = Date.now();
    state.lastSig = signature;
    state.lastErrorMsg = null;
  } catch (err) {
    state.totalErrors++;
    state.lastErrorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[cranker] ${label}: crank send failed — ${state.lastErrorMsg.slice(0, 160)}`);
    // A stale-account error (e.g. LP portfolio closed) is worth rediscovering next attempt.
    if (/AccountNotFound|could not find account/i.test(state.lastErrorMsg)) {
      state.lpPortfolio = null;
    }
  }
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
    registry.markets.map((m) => [
      m.marketAddress,
      {
        lpPortfolio: null,
        lastDiscoveryAttemptAt: 0,
        totalCranks: 0,
        totalErrors: 0,
        lastCrankAt: null,
        lastSig: null,
        lastErrorMsg: null,
      } satisfies CrankMarketState,
    ]),
  );

  console.log(
    `[cranker] Recovery crank loop starting: ${registry.markets.length} markets,` +
      ` interval=${config.intervalMs}ms, mode=${config.dryRun ? "DRY-RUN" : "LIVE"}`,
  );

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    const cycleStart = Date.now();
    for (const m of registry.markets) {
      const state = states.get(m.marketAddress)!;
      try {
        await crankOneMarket(devnetConn, keeper, m.marketAddress, m.label, state, config.dryRun);
      } catch (err) {
        // Defense in depth: crankOneMarket already isolates errors per-market,
        // but never let an unexpected throw kill the whole loop.
        console.error(`[cranker] ${m.label}: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const elapsed = Date.now() - cycleStart;
    const remaining = config.intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
  console.log("[cranker] Recovery crank loop stopped.");
}
