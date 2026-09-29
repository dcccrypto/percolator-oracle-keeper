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
 *   per registry market, targeting that market's matcher-enabled ("LP
 *   vault") portfolio — any account whose stored `market` field matches the
 *   slab works, but the LP portfolio is a stable, market-owned account that
 *   won't disappear if a user closes their position, so it's the safest
 *   fixed target.
 *
 *   v16-migration wire (VERSION 18, integration `a9318945`, dcccrypto/
 *   percolator-prog @ `sync/integration-v16`): the old caller-chosen
 *   `action`/`assetIndex`/`recoveryReason` fields are GONE. The wrapper's
 *   handler (`handle_permissionless_crank_zero_copy`, v16_program.rs) no
 *   longer lets the caller pick an action at all — the engine's
 *   `AutoCrankPlanV16` selector does that internally. What the caller now
 *   supplies is a bounded set of `CrankObservationHint { asset_index,
 *   oracle_accounts }` — raw evidence hints naming which assets it has
 *   fresh price/funding evidence for, and how many trailing oracle
 *   AccountInfos (if any) that evidence occupies in the instruction's
 *   account list.
 *
 *   This loop sends exactly one hint, `{ assetIndex: 0, oracleAccounts: 0 }`
 *   — these are single-asset (asset_index 0) markets on AUTH_MARK oracle
 *   mode (the cross-cluster oracle loop only ever pushes PushAuthMark, see
 *   above), so `hybrid_effective_price_for_crank_view` takes its
 *   `profile_is_auth_mark` branch: the crank price comes straight from the
 *   wrapper's own committed `mark_ewma_e6` (set by the last PushAuthMark),
 *   with NO external oracle account reads at all — `oracle_accounts: 0` is
 *   therefore not an empty/placeholder hint, it is the CORRECT declared
 *   count for this asset's oracle mode, and matches
 *   `ACCOUNTS_PERMISSIONLESS_CRANK_BASE` (owner/market/portfolio only, no
 *   oracle tail). Sending the hint (rather than an empty `observations: []`)
 *   is what makes the engine actually walk this asset's per-hint
 *   oracle-reading loop and call `accrue_asset_to_not_atomic` for it — an
 *   empty observations array would still satisfy a market already in
 *   Recovery mode (mode==2 short-circuits before consuming any hint) but
 *   would do NO accrual work at all on a Live-mode market, defeating this
 *   loop's entire purpose. `nowSlot: 0n` remains correct: the wrapper
 *   authenticates against `Clock::get()` via `authenticated_slot_or_fallback`
 *   regardless of the caller-supplied value (only used as a fallback if the
 *   Clock sysvar read itself fails).
 *
 * Deliberately separate from the oracle push loop:
 *   - Independent interval (crank only needs to run every ~10-30s; the
 *     oracle push runs every ~0.5-7s and must not be slowed down by this).
 *   - Independent errors — a crank failure never touches oracle-push state.
 *   - One transaction per market per cycle, fire-and-forget (no confirm
 *     await), same as the push loop's style.
 *
 * Refreshing positioned portfolios (2026-09-28):
 *   The accrual crank above moves K/F, and every such move marks the whole
 *   positioned cohort stale (`stale_account_count_<side> =
 *   stored_pos_count_<side>`). Until each positioned portfolio is refreshed
 *   the market reads `loss_stale_active` and risk-increasing trades revert
 *   Custom(21). The accrual crank only refreshes the account it targets, so a
 *   market with any third-party position stayed loss-stale forever. Each cycle
 *   now sends, in ONE transaction:
 *     [bounded catch-up cranks if behind] -> accrue(LP, observation)
 *       -> refresh(p) with NO observation for every positioned portfolio p
 *          (non-LP first, LP last)
 *   The refreshes must share the accrual's slot: a no-observation crank is
 *   rejected (Custom(22)) while a mark/funding move is still pending. The
 *   transaction is simulated first; refreshes the engine rejects (e.g. a side
 *   the accrual did not re-stale selects NoAction -> Custom(22)) are pruned,
 *   and the simulated post-state confirms the market ends not loss-stale. See
 *   positioned-refresh.ts for the engine references. (The older note here
 *   that crank instructions cannot share a transaction predates the v18
 *   auto-crank planner; measured on devnet, the sequence above lands clean.)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  encodePermissionlessCrank,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  PROGRAM_IDS_V17,
  V17_PORTFOLIO_ACCOUNT_LEN,
  parsePortfolioV17,
} from "@percolatorct/sdk";
import type { CrankObservationHint } from "@percolatorct/sdk";
import type { MarketEntry, Registry } from "./registry.ts";
import {
  catchupAllowsRefresh,
  catchupCrankCount,
  isBankruptPortfolio,
  decodeMarketRefreshState,
  isAssetLossStale,
  marketHasPositions,
  parseInstructionError,
  planCrankTx,
  positionedSetMatchesMarket,
  selectPositionedPortfolios,
} from "./positioned-refresh.ts";
import type { CrankPlan, MarketRefreshState, PlannedCrank, PositionedPortfolio } from "./positioned-refresh.ts";
import { decodeLivenessState, describeRepair, planLivenessRepairs } from "./liveness-repair.ts";
import type { LivenessRepair } from "./liveness-repair.ts";

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
  /** Cached portfolios holding a position on asset 0 (refreshed after each accrual). */
  positioned: PositionedPortfolio[] | null;
  positionedFetchedAt: number;
  /** Set when a simulation still ended loss-stale: re-read the positioned set. */
  positionedDirty: boolean;
  /** Last refresh summary logged, so steady-state cycles stay quiet. */
  lastRefreshSummary: string | null;
  decodeWarned: boolean;
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
    positioned: null,
    positionedFetchedAt: 0,
    positionedDirty: false,
    lastRefreshSummary: null,
    decodeWarned: false,
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

/**
 * True iff `data` is a v18 portfolio account (exact `V17_PORTFOLIO_ACCOUNT_LEN`)
 * whose matcher config is enabled — i.e. the market's LP-vault / matcher
 * counterparty that the recovery crank must target.
 *
 * 2026-09-28 root cause of the 6-market engine-clock freeze: the old check
 * read a raw u64 `== 1` at `len - 104 + 96`. That is the v17 layout; v18
 * appends a 24-byte identity trailer after the matcher block AND packs the
 * matcher position epoch into the control word, so on a real LP portfolio it
 * read the wrong bytes (false), while a 240-byte kind-3 v18 account that
 * shares the magic + market prefix happens to end in `01 00..00` (true).
 * Discovery therefore picked that 240-byte account, every crank reverted
 * `InsufficientFundsForRent`, and no market's engine clock advanced from
 * 2026-09-25T02:02Z onward. Decode via the SDK instead of hand offsets, and
 * require the exact portfolio length.
 */
export function isLpVaultPortfolio(data: Uint8Array): boolean {
  if (data.length !== V17_PORTFOLIO_ACCOUNT_LEN) return false;
  try {
    return parsePortfolioV17(data).matcherEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Find a matcher-enabled ("LP vault") portfolio bound to `market`. Returns
 * null if none exists yet (e.g. a brand-new market with no LP vault) — the
 * caller should skip cranking that market until discovery succeeds.
 */
function fetchMarketPortfolios(conn: Connection, market: PublicKey) {
  return conn.getProgramAccounts(WRAPPER_PROGRAM_ID, {
    filters: [
      { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
      { memcmp: { offset: V17_PF_MARKET_OFF, bytes: market.toBase58() } },
    ],
  });
}

async function findLpPortfolio(
  conn: Connection,
  market: PublicKey,
): Promise<PublicKey | null> {
  const accounts = await fetchMarketPortfolios(conn, market);
  for (const { pubkey, account } of accounts) {
    if (isLpVaultPortfolio(account.data)) return pubkey;
  }
  return null;
}

// These are single-asset markets — every registry market's only engine
// asset lives at index 0 (matches the pre-migration wire's fixed
// `assetIndex: 0` field). See the module doc comment above for why the
// observation hint below is `{ assetIndex: CRANKED_ASSET_INDEX,
// oracleAccounts: 0 }` and not an empty `observations: []`.
const CRANKED_ASSET_INDEX = 0;

// Exported for testing (see recovery-cranker.test.ts): pins the exact
// PermissionlessCrank wire format this loop sends on every cycle.
export function buildCrankIx(owner: PublicKey, market: PublicKey, portfolio: PublicKey): TransactionInstruction {
  const accountMetas = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
    owner,
    market,
    portfolio,
  });
  // v16-migration wire (VERSION 18, a9318945): PermissionlessCrank no longer
  // takes action/assetIndex/recoveryReason — it takes now_slot plus a bounded
  // list of CrankObservationHint{asset_index, oracle_accounts}. See the
  // module doc comment for the full reasoning; in short, one hint naming
  // this market's only asset (index 0) with 0 oracle accounts (AUTH_MARK
  // mode reads the wrapper's own committed mark_ewma_e6, no external oracle
  // accounts needed or attached) is what makes the engine actually accrue
  // this asset forward on a Live-mode market — an empty observations array
  // would be a true no-op crank here, not a "safe default".
  const observations: CrankObservationHint[] = [
    { assetIndex: CRANKED_ASSET_INDEX, oracleAccounts: 0 },
  ];
  const data = encodePermissionlessCrank({
    nowSlot: 0n, // program authenticates against Clock::get() regardless of this value (authenticated_slot_or_fallback)
    observations,
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

  const lpPortfolio = state.lpPortfolio;

  try {
    // One read gives both the market state and the slot it was read at.
    const acct = await withRpcRetry(label, () => devnetConn.getAccountInfoAndContext(market, "processed"));
    if (!acct.value) throw new Error(`market ${marketAddress} could not find account`);
    let pre: MarketRefreshState | null = null;
    try {
      pre = decodeMarketRefreshState(acct.value.data);
    } catch (err) {
      // Unknown layout: fall back to the single accrual crank this loop always sent.
      if (!state.decodeWarned) {
        state.decodeWarned = true;
        console.warn(`[cranker] ${label}: market header decode failed (${err instanceof Error ? err.message : String(err)}) — sending accrual crank only`);
      }
    }
    const catchup = pre ? catchupCrankCount(BigInt(acct.context.slot) - pre.slotLast, pre.maxAccrualDtSlots) : 0;
    const targets = pre && marketHasPositions(pre) && catchupAllowsRefresh(catchup)
      ? await positionedPortfoliosFor(devnetConn, market, label, pre, state)
      : [];

    // Liveness repairs (lapsed Fresh backing bucket, side stuck in ResetPending):
    // states no crank can leave, which revert every crank Custom(19) or every
    // open Custom(21). Prepended to this cycle's transaction; see liveness-repair.ts.
    let repairs: LivenessRepair[] = [];
    try {
      repairs = planLivenessRepairs(decodeLivenessState(acct.value.data), BigInt(acct.context.slot));
    } catch {
      repairs = [];
    }

    // Bankrupt positioned portfolios found in a clean simulation's post-state;
    // they get a second crank (the engine's Liquidate step) in the same tx.
    let liquidateTargets: PublicKey[] = [];

    const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan =>
      planCrankTx({ owner: keeper.publicKey, market, lpPortfolio, catchup, refreshTargets: t, repairs, liquidateTargets });

    if (dryRun) {
      const plan = build(targets);
      console.log(
        `[cranker][DRY-RUN] ${label}: catchup=${catchup} accrue=${lpPortfolio.toBase58().slice(0, 8)}… ` +
          `refresh=[${plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58().slice(0, 8)).join(",")}]`,
      );
      return;
    }

    const bh = await withRpcRetry(label, () => devnetConn.getLatestBlockhash("processed"));
    const toTx = (plan: CrankPlan): Transaction => {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits }));
      for (const c of plan.cranks) tx.add(c.ix);
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = keeper.publicKey;
      tx.sign(keeper);
      return tx;
    };

    // PREFLIGHT FIRST so a reverting crank is VISIBLE instead of being silently
    // counted as a success (2026-07-06 root cause: skipPreflight fire-and-forget
    // counted every EngineStale(19)/EngineLockActive(21) revert as progress).
    // The simulation also prunes refreshes the engine would reject (Custom(22)
    // for a portfolio this accrual did not re-stale), and returns the market's
    // post-state so the loop can confirm the market ends not loss-stale.
    const simulate = async (plan: CrankPlan): Promise<SimOutcome> => {
      const tx = toTx(plan);
      const refreshed = plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58());
      const sim = await withRpcRetry(label, () =>
        devnetConn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
          sigVerify: false,
          commitment: "processed",
          accounts: { encoding: "base64", addresses: [marketAddress, ...refreshed] },
        }),
      );
      const accs = sim.value.accounts ?? [];
      const acc = accs[0];
      const portfolioData = new Map<string, Uint8Array>();
      refreshed.forEach((pk, i) => {
        const a = accs[i + 1];
        if (a) portfolioData.set(pk, Buffer.from(a.data[0], "base64"));
      });
      return {
        err: sim.value.err,
        logs: sim.value.logs ?? null,
        marketData: acc ? Buffer.from(acc.data[0], "base64") : null,
        portfolioData,
      };
    };
    const onOptionalRejected = (c: PlannedCrank) => {
      if (c.kind === "repair") repairs = repairs.filter((x) => x !== c.repair);
      if (c.kind === "liquidate") liquidateTargets = liquidateTargets.filter((x) => !x.equals(c.portfolio));
    };
    let resolved = await resolveCrankPlan(build, targets, simulate, onOptionalRejected);
    // Bankruptcy pass: a positioned account whose post-refresh equity is <= 0 is
    // re-planned with a second crank so the engine liquidates it this cycle.
    if (!resolved.sim.err && resolved.sim.portfolioData) {
      const bankrupt = [...resolved.sim.portfolioData.entries()]
        .filter(([, data]) => isBankruptPortfolio(data))
        .map(([pk]) => new PublicKey(pk));
      if (bankrupt.length > 0) {
        liquidateTargets = bankrupt;
        const remaining = targets.filter((t) => !resolved.pruned.some((p) => p.pubkey.equals(t.pubkey)));
        const withLiq = await resolveCrankPlan(build, remaining, simulate, onOptionalRejected);
        if (!withLiq.sim.err) {
          resolved = { ...withLiq, pruned: [...resolved.pruned, ...withLiq.pruned] };
        } else {
          liquidateTargets = [];
        }
      }
    }

    if (resolved.sim.err) {
      const code =
        parseCustomErrorCode(resolved.sim.err) ?? parseCustomErrorCode(resolved.sim.logs?.join("\n"));
      state.totalReverts++;
      state.consecutiveReverts++;
      state.lastRevertCode = code;
      state.lastErrorMsg = `revert ${code != null ? `Custom(${code})` : JSON.stringify(resolved.sim.err)}`;
      // 19=EngineStale, 21=EngineLockActive = the deep-stale signature. A fresh /
      // lightly-stale market cranks CLEAN (only a rotting one reverts every cycle),
      // so escalate loudly once it persists.
      if (state.consecutiveReverts === 1 || state.consecutiveReverts % REVERT_ALERT_THRESHOLD === 0) {
        const tag = state.consecutiveReverts >= REVERT_ALERT_THRESHOLD ? "[cranker][ALERT]" : "[cranker][REVERT]";
        console.warn(
          `${tag} ${label}: crank ${state.lastErrorMsg} (${state.consecutiveReverts}× consecutive). ` +
            `Engine accrual is drifting toward an unrecoverable deep-stale state — investigate / re-seed if this persists.`,
        );
      }
      return;
    }

    const plan = resolved.plan;
    const tx = toTx(plan);
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

    const liquidated = plan.cranks.filter((c) => c.kind === "liquidate").map((c) => c.portfolio.toBase58().slice(0, 8));
    if (liquidated.length > 0) {
      console.log(`[cranker] ${label}: bankrupt portfolio(s) liquidated: [${liquidated.join(", ")}] sig=${signature.slice(0, 12)}…`);
    }
    const landedRepairs = plan.cranks.filter((c) => c.kind === "repair" && c.repair).map((c) => describeRepair(c.repair!));
    if (landedRepairs.length > 0) {
      console.log(`[cranker] ${label}: liveness repair sent: ${landedRepairs.join(", ")} sig=${signature.slice(0, 12)}…`);
    }
    const rejectedRepairs = resolved.pruned.filter((p) => p.repair);
    if (rejectedRepairs.length > 0) {
      console.warn(
        `[cranker] ${label}: liveness repair rejected in simulation: ` +
          rejectedRepairs.map((p) => `${describeRepair(p.repair!)}:${p.code ?? "?"}`).join(", "),
      );
    }

    reportRefreshOutcome(label, pre, resolved, state);
    if (plan.overflow.length > 0) {
      console.warn(
        `[cranker][ALERT] ${label}: ${plan.overflow.length} positioned portfolio(s) did not fit one transaction and were not refreshed — ` +
          `the market stays loss-stale until they are (needs multi-tx same-slot refresh or an ALT).`,
      );
    }
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
      state.positioned = null;
    }
  }
}

/** Re-read the positioned set at most this often while it still matches the market. */
const POSITIONED_MAX_AGE_MS = 5 * 60_000;

/**
 * The market's positioned portfolios (active leg on asset 0), cached per
 * market. Re-read when the cached set's leg counts no longer match
 * `stored_pos_count_long/short` (a position opened or closed), when the last
 * simulation still ended loss-stale, or after POSITIONED_MAX_AGE_MS. Never
 * re-read more often than DISCOVERY_RETRY_MS.
 */
async function positionedPortfoliosFor(
  conn: Connection,
  market: PublicKey,
  label: string,
  pre: MarketRefreshState,
  state: CrankMarketState,
): Promise<PositionedPortfolio[]> {
  const now = Date.now();
  const cached = state.positioned;
  const stale =
    cached === null ||
    state.positionedDirty ||
    !positionedSetMatchesMarket(cached, pre) ||
    now - state.positionedFetchedAt > POSITIONED_MAX_AGE_MS;
  if (!stale || (cached !== null && now - state.positionedFetchedAt < DISCOVERY_RETRY_MS)) {
    return cached ?? [];
  }
  state.positionedFetchedAt = now;
  try {
    const accounts = await withRpcRetry(label, () => fetchMarketPortfolios(conn, market));
    const set = selectPositionedPortfolios(accounts.map((a) => ({ pubkey: a.pubkey, data: a.account.data })));
    const changed =
      cached === null ||
      cached.length !== set.length ||
      set.some((p) => !cached.some((c) => c.pubkey.equals(p.pubkey)));
    if (changed) {
      console.log(
        `[cranker] ${label}: ${set.length} positioned portfolio(s) to refresh after each accrual: ` +
          `[${set.map((p) => `${p.pubkey.toBase58().slice(0, 8)}${p.isLp ? "(LP)" : ""}`).join(", ")}]`,
      );
    }
    if (!positionedSetMatchesMarket(set, pre)) {
      console.warn(
        `[cranker] ${label}: positioned legs found (${set.reduce((n, p) => n + p.longLegs, 0)}L/${set.reduce((n, p) => n + p.shortLegs, 0)}S) ` +
          `!= market stored_pos_count (${pre.storedPosLong}L/${pre.storedPosShort}S) — refreshing what was found`,
      );
    }
    state.positioned = set;
    state.positionedDirty = false;
    return set;
  } catch (err) {
    console.warn(`[cranker] ${label}: positioned-portfolio discovery failed — ${err instanceof Error ? err.message : String(err)}`);
    return cached ?? [];
  }
}

function reportRefreshOutcome(
  label: string,
  pre: MarketRefreshState | null,
  resolved: ResolvedCrankPlan,
  state: CrankMarketState,
): void {
  const refreshed = resolved.plan.cranks.filter((c) => c.kind === "refresh").length;
  let post: MarketRefreshState | null = null;
  try {
    post = resolved.sim.marketData ? decodeMarketRefreshState(resolved.sim.marketData) : null;
  } catch {
    post = null;
  }
  const postStale = post ? isAssetLossStale(post) || post.lossStaleActive : null;
  const summary =
    `refreshed=${refreshed} pruned=${resolved.pruned.length}` +
    `${resolved.pruned.length ? ` [${resolved.pruned.map((p) => `${p.pubkey.toBase58().slice(0, 8)}:${p.code ?? "?"}`).join(",")}]` : ""}` +
    ` loss_stale ${pre ? Number(pre.lossStaleActive) : "?"}→${post ? Number(post.lossStaleActive) : "?"}`;
  if (postStale && pre && marketHasPositions(pre)) {
    // Something positioned was not refreshed: re-read the set next cycle.
    state.positionedDirty = true;
    if (state.lastRefreshSummary !== summary) {
      console.warn(`[cranker] ${label}: market still loss-stale after crank (${summary}) — re-discovering positioned portfolios`);
    }
  } else if (state.lastRefreshSummary !== summary && (refreshed > 0 || resolved.pruned.length > 0)) {
    console.log(`[cranker] ${label}: accrue + refresh ok (${summary})`);
  }
  state.lastRefreshSummary = summary;
}

export interface SimOutcome {
  err: unknown;
  logs: string[] | null;
  marketData: Uint8Array | null;
  /** Post-simulation data of each refreshed portfolio, keyed by base58. */
  portfolioData?: Map<string, Uint8Array>;
}

export interface ResolvedCrankPlan {
  plan: CrankPlan;
  sim: SimOutcome;
  /** Refreshes (and, with `repair` set, liveness repairs) dropped after a simulated rejection. */
  pruned: { pubkey: PublicKey; code: number | null; repair?: LivenessRepair }[];
}

/** Refreshes pruned one at a time before giving up on refreshing this cycle. */
export const MAX_REFRESH_PRUNES = 3;
/** Optional instructions (<= 2 expiries + 2 finalizes, plus liquidations) dropped before giving up. */
export const MAX_REPAIR_DROPS = 8;

/**
 * Simulate the plan and drop refreshes the engine rejects, one per
 * simulation, until the transaction simulates clean. A failure on a catch-up
 * or accrual crank is returned as-is for the revert path. After
 * MAX_REFRESH_PRUNES prunes every remaining refresh is dropped, so the cycle
 * degrades to the accrual-only crank this loop always sent (at most
 * MAX_REFRESH_PRUNES + 2 simulations).
 *
 * Instruction 0 of every crank transaction is the compute-budget ix, so
 * simulation index i maps to plan.cranks[i - 1].
 */
export async function resolveCrankPlan(
  build: (targets: ReadonlyArray<PositionedPortfolio>) => CrankPlan,
  targets: ReadonlyArray<PositionedPortfolio>,
  simulate: (plan: CrankPlan) => Promise<SimOutcome>,
  /**
   * Called when a liveness repair or a bankruptcy liquidate crank is the
   * rejected instruction. The caller must drop it from what `build` emits; the plan is then re-simulated without it,
   * so a repair the engine refuses can never block the ordinary crank.
   */
  onOptionalRejected?: (crank: PlannedCrank) => void,
): Promise<ResolvedCrankPlan> {
  let remaining = [...targets];
  const pruned: { pubkey: PublicKey; code: number | null; repair?: LivenessRepair }[] = [];
  let repairDrops = 0;
  for (;;) {
    const plan = build(remaining);
    const sim = await simulate(plan);
    if (!sim.err) return { plan, sim, pruned };
    const ie = parseInstructionError(sim.err);
    const crank = ie && ie.index >= 1 ? plan.cranks[ie.index - 1] : undefined;
    if (
      crank &&
      (crank.kind === "repair" || crank.kind === "liquidate") &&
      onOptionalRejected &&
      repairDrops < MAX_REPAIR_DROPS
    ) {
      repairDrops++;
      if (crank.kind === "repair") pruned.push({ pubkey: crank.portfolio, code: ie?.custom ?? null, repair: crank.repair });
      onOptionalRejected(crank);
      continue;
    }
    if (!crank || crank.kind !== "refresh") return { plan, sim, pruned };
    pruned.push({ pubkey: crank.portfolio, code: ie?.custom ?? null });
    remaining = remaining.filter((p) => !p.pubkey.equals(crank.portfolio));
    if (pruned.length >= MAX_REFRESH_PRUNES && remaining.length > 0) {
      for (const p of remaining) pruned.push({ pubkey: p.pubkey, code: null });
      remaining = [];
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
