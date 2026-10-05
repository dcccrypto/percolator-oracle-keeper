/**
 * cross-cluster/tx-v1.ts — Solana v1 transactions (SIMD-0385 format, SIMD-0296 4,096-byte
 * limit) for the keeper, behind the `TX_V1` flag, with automatic fallback to legacy.
 *
 * The SDK (`@percolatorct/sdk`, src/runtime/txv1.ts) owns the wire encoder; this module is the
 * keeper's policy around it:
 *
 *   - `TX_V1=off|auto|on` (default `off`). `auto` uses v1 only while the cluster reports the
 *     v1 feature gate active (`detectTxV1Support`, cached per connection) and no v1 tx has been
 *     rejected for FORMAT reasons recently. `on` requires the cluster to REPORT v1 (a cluster
 *     that does not is a config error: no push that cycle, loud), but a runtime rejection never
 *     skips a push cycle: that cycle falls back to legacy, loudly, and the next cycle tries v1
 *     again (no suspension for `on`).
 *   - Fallback is ONLY for format rejections (the node/cluster could not take the bytes, so
 *     nothing was accepted and resending in legacy cannot double-send) and for v1 budget
 *     misconfiguration found in PREFLIGHT (compute or loaded-accounts limit too low — the tx was
 *     only simulated). A program error never triggers a fallback or a resend.
 *   - After a fallback, v1 is suspended for `TX_V1_RETRY_AFTER_REJECT_MS` so a node that cannot
 *     take v1 is not re-probed every 1.5 s cycle.
 *
 * Simulation goes through the Connection's own JSON-RPC transport (`_rpcRequest`) so the
 * keeper's configured headers (DEVNET_RPC_ORIGIN) apply, exactly like the legacy
 * `simulateTransaction`. Sending uses the unchanged `connection.sendRawTransaction`
 * (it only base64-encodes the bytes), so the dry-run hard stop in cross-cluster.ts still
 * blocks v1 sends at the connection (see {@link sendWire}).
 *
 * Format rejections are classified by JSON-RPC error CODE only (SDK `isTxV1FormatRejection`:
 * -32602 / -32015), never by message text: a transport error whose text merely mentions
 * "too large" after the node may already have accepted the tx must not cause a legacy resend.
 * web3.js 1.x drops the code when `sendRawTransaction` fails (it throws a SendTransactionError
 * with only the message), so {@link sendWire} recovers the node's `{error:{code}}` from the
 * same call and rethrows it as an SDK `V1RpcError`; {@link simulateWire} does the same for the
 * raw simulate reply.
 *
 * v1 differences the callers must respect:
 *   - No ComputeBudget instructions: the budget is in the config mask, so instruction index i in
 *     a v1 error is the caller's instruction i (legacy: i - 1). See `ixOffsetFor`.
 *   - Unset CU or loaded-accounts-data-size = 0 = the tx fails; both are always set here.
 */
import type { Connection, Keypair, PublicKey, SendOptions, TransactionInstruction } from "@solana/web3.js";
import {
  V1RpcError,
  compileV1Message,
  signV1Message,
  detectTxV1Support,
  parseTxV1Mode,
  isTxV1FormatRejection,
  TX_MAX_COMPUTE_UNITS,
  TX_MAX_LOADED_ACCOUNTS_DATA_BYTES,
  TX_V1_MIN_HEAP_BYTES,
  TX_V1_MAX_HEAP_BYTES,
  type TxV1Mode,
} from "@percolatorct/sdk";

/** Formats the keeper sends. */
export type KeeperTxFormat = "v1" | "legacy";

/** Agave's per-account overhead in the loaded-accounts-data-size accounting. */
export const LOADED_ACCOUNT_BASE_BYTES = 64;

export interface TxV1Settings {
  /** TX_V1. */
  mode: TxV1Mode;
  /**
   * TX_V1_PUSH_MAX_MARKETS: max PushAuthMark markets per v1 tx (default 16, about the legacy 13 so an
   * on-chain revert after a clean preflight costs a similar blast radius); 0 = all that fit
   * (bytes/accounts/CU/loaded size), allowed only explicitly.
   */
  pushMaxMarkets: number;
  /**
   * TX_V1_ISOLATION_MAX_SIMS: re-simulations per push cycle spent isolating reverting markets in v1
   * (every simulate after a chunk's first). When spent, the rest of that chunk waits for the next
   * cycle (not struck), so k bad markets cannot delay honest pushes by k round trips without bound.
   */
  isolationMaxSims: number;
  /** TX_V1_PUSH_CU_PER_MARKET: CU budgeted per PushAuthMark in a v1 tx (measured ~5.2k on devnet). */
  pushCuPerMarket: number;
  /** TX_V1_PUSH_CU_BASE: fixed CU added to every v1 push tx. */
  pushCuBase: number;
  /**
   * TX_V1_LOADED_ACCOUNTS_BYTES: absolute loaded-accounts-data-size limit for every v1 tx.
   * null = derived per tx: ceil(1.25 * (overhead + sum(slab bytes + 64))).
   */
  loadedAccountsBytes: number | null;
  /** TX_V1_LOADED_OVERHEAD_BYTES: the non-slab part of a push tx's loaded size (payer + wrapper program + programdata). */
  loadedOverheadBytes: number;
  /** TX_V1_HEAP_BYTES: heap request in v1 (0 = none, which matches the legacy keeper tx). */
  heapBytes: number;
  /** TX_V1_RETRY_AFTER_REJECT_MS: how long v1 stays suspended after a fallback. */
  retryAfterRejectMs: number;
  /**
   * TX_V1_CANARY_CYCLES (K-2): the first N v1 push cycles (and the first N after every landing
   * suspension) wait for `getSignatureStatuses` to show each v1 tx confirmed before the cycle
   * counts as OK. A v1 tx not seen within TX_V1_CANARY_TIMEOUT_MS suspends v1 and its markets are
   * re-pushed in legacy (after the status check proved it did not land). 0 = no canary.
   */
  canaryCycles: number;
  /** TX_V1_CANARY_TIMEOUT_MS: how long a canary cycle waits for its v1 txs to confirm. */
  canaryTimeoutMs: number;
}

/**
 * Measured on devnet 2026-10-05 against the live ETDLAdi wrapper (simulateTransaction of the
 * keeper's real batch, 48 markets): 248,480 CU = ~5,177 CU per push (13 markets: 67,416 = ~5,186).
 * 8,000 per push + 10,000 base is >= 1.5x the measurement at every batch size.
 */
export const DEFAULT_PUSH_CU_PER_MARKET = 8_000;
export const DEFAULT_PUSH_CU_BASE = 10_000;
/**
 * Non-slab loaded bytes of a push tx, measured on devnet: loadedAccountsDataSize 1,994,237 for one
 * market = keeper (0+64) + wrapper program account (36+64) + programdata (1,960,045+64) + one slab
 * (33,900+64). Overhead = 1,960,273; rounded up to 2,000,000 (room for a slightly larger program),
 * and LOADED_HEADROOM (1.25) applies on top: 48 markets -> limit 4,537,840 vs measured 3,590,545.
 */
export const DEFAULT_LOADED_OVERHEAD_BYTES = 2_000_000;
export const LOADED_HEADROOM = 1.25;

export const DEFAULT_TX_V1_SETTINGS: Readonly<TxV1Settings> = Object.freeze({
  mode: "off",
  pushMaxMarkets: 16,
  isolationMaxSims: 8,
  pushCuPerMarket: DEFAULT_PUSH_CU_PER_MARKET,
  pushCuBase: DEFAULT_PUSH_CU_BASE,
  loadedAccountsBytes: null,
  loadedOverheadBytes: DEFAULT_LOADED_OVERHEAD_BYTES,
  heapBytes: 0,
  retryAfterRejectMs: 10 * 60_000,
  canaryCycles: 5,
  canaryTimeoutMs: 10_000,
});

/**
 * /health `txV1.landing.stalled` (K-2): this many v1 txs sent since the last v1 tx was seen
 * landed OK. Steady state is a few in flight (status is read once a tx is >= 4 s old).
 */
export const V1_STALL_ALERT_TXS = 20;

function intEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name}="${raw}" must be an integer in [${min}, ${max}]`);
  }
  return n;
}

/**
 * Parse the TX_V1* env. A typo in TX_V1 itself fails boot (it must not silently pick a format);
 * numeric knobs are range-checked.
 */
export function parseTxV1Settings(env: Readonly<Record<string, string | undefined>>): TxV1Settings {
  const rawMode = env.TX_V1?.trim() ?? "";
  const mode = rawMode === "" ? DEFAULT_TX_V1_SETTINGS.mode : parseTxV1Mode(rawMode, "off");
  if (rawMode !== "" && !/^(auto|on|off|1|0|true|false)$/i.test(rawMode)) {
    throw new Error(`TX_V1="${rawMode}" must be one of off | auto | on`);
  }
  const heapBytes = intEnv(env, "TX_V1_HEAP_BYTES", DEFAULT_TX_V1_SETTINGS.heapBytes, 0, TX_V1_MAX_HEAP_BYTES);
  if (heapBytes !== 0 && (heapBytes % 1024 !== 0 || heapBytes < TX_V1_MIN_HEAP_BYTES)) {
    throw new Error(`TX_V1_HEAP_BYTES=${heapBytes} must be 0 or a multiple of 1024 in [${TX_V1_MIN_HEAP_BYTES}, ${TX_V1_MAX_HEAP_BYTES}]`);
  }
  const loadedRaw = env.TX_V1_LOADED_ACCOUNTS_BYTES?.trim();
  return {
    mode,
    pushMaxMarkets: intEnv(env, "TX_V1_PUSH_MAX_MARKETS", DEFAULT_TX_V1_SETTINGS.pushMaxMarkets, 0, 64),
    isolationMaxSims: intEnv(env, "TX_V1_ISOLATION_MAX_SIMS", DEFAULT_TX_V1_SETTINGS.isolationMaxSims, 1, 256),
    pushCuPerMarket: intEnv(env, "TX_V1_PUSH_CU_PER_MARKET", DEFAULT_PUSH_CU_PER_MARKET, 1_000, 200_000),
    pushCuBase: intEnv(env, "TX_V1_PUSH_CU_BASE", DEFAULT_PUSH_CU_BASE, 0, 200_000),
    loadedAccountsBytes:
      loadedRaw === undefined || loadedRaw === ""
        ? null
        : intEnv(env, "TX_V1_LOADED_ACCOUNTS_BYTES", 0, 1, TX_MAX_LOADED_ACCOUNTS_DATA_BYTES),
    loadedOverheadBytes: intEnv(env, "TX_V1_LOADED_OVERHEAD_BYTES", DEFAULT_LOADED_OVERHEAD_BYTES, 0, TX_MAX_LOADED_ACCOUNTS_DATA_BYTES),
    heapBytes,
    retryAfterRejectMs: intEnv(env, "TX_V1_RETRY_AFTER_REJECT_MS", DEFAULT_TX_V1_SETTINGS.retryAfterRejectMs, 0, 24 * 3_600_000),
    canaryCycles: intEnv(env, "TX_V1_CANARY_CYCLES", DEFAULT_TX_V1_SETTINGS.canaryCycles, 0, 1_000),
    canaryTimeoutMs: intEnv(env, "TX_V1_CANARY_TIMEOUT_MS", DEFAULT_TX_V1_SETTINGS.canaryTimeoutMs, 1, 60_000),
  };
}

let settings: TxV1Settings = { ...DEFAULT_TX_V1_SETTINGS };
/** v1 suspended until this time (ms) after a fallback (format/budget REJECTION; honoured by auto only). */
let suspendedUntilMs = 0;
/**
 * v1 suspended until this time (ms) on LANDING evidence (a landed v1 revert, an unlanded canary).
 * Honoured by auto AND on: the v1 txs are being sent but are not producing marks.
 */
let landingSuspendedUntilMs = 0;
let lastSuspendReason: string | null = null;

/** K-2 landing canary state (/health `txV1.canary`). */
const canary = {
  /** Canary cycles whose v1 txs all confirmed without error. */
  passed: 0,
  /** Canary cycles with a v1 tx that never showed up (each suspends v1). */
  failures: 0,
  lastResult: null as null | "confirmed" | "unlanded" | "reverted" | "inconclusive",
};
/** K-2 stall detector: v1TxsSent when a v1 tx was last seen landed OK. */
let v1SentAtLastLandedOk = 0;
let stallLogged = false;

/** Observability: /health `txV1` and the per-cycle log. */
export const txV1Stats = {
  /** Format the last push cycle started in (null before the first live cycle). */
  lastFormat: null as KeeperTxFormat | null,
  /** Push txs sent in the last cycle (send attempts, incl. isolation singles). */
  lastCycleTxs: 0,
  /** Legacy chunks the same push set would have needed (the pre-v1 tx count). */
  lastCycleBaselineTxs: 0,
  v1TxsSent: 0,
  legacyTxsSent: 0,
  /** Times a v1 tx fell back to legacy (format rejection or v1 budget misconfiguration). */
  fallbacks: 0,
  /** Cycles refused because TX_V1=on and the cluster does not report v1 active. */
  failClosedCycles: 0,
  /** v1 suspensions on landing evidence (landed v1 revert / unlanded canary). */
  landingSuspensions: 0,
  /** v1 isolation re-simulations in the last cycle (capped by TX_V1_ISOLATION_MAX_SIMS). */
  lastCycleIsolationSims: 0,
  /** Cycles in which the isolation cap was hit (some markets waited for the next cycle). */
  isolationCapHits: 0,
  /** v1 txs read back from chain: landed OK / landed and reverted / never landed. */
  v1LandedOk: 0,
  v1LandedReverts: 0,
  v1Unlanded: 0,
};

export function configureTxV1(s: TxV1Settings): void {
  settings = { ...s };
}
export function getTxV1Settings(): Readonly<TxV1Settings> {
  return settings;
}

/** Test hook: defaults, no suspension, zeroed stats. */
export function resetTxV1ForTests(s: TxV1Settings = { ...DEFAULT_TX_V1_SETTINGS }): void {
  settings = { ...s };
  suspendedUntilMs = 0;
  landingSuspendedUntilMs = 0;
  lastSuspendReason = null;
  canary.passed = 0;
  canary.failures = 0;
  canary.lastResult = null;
  v1SentAtLastLandedOk = 0;
  stallLogged = false;
  txV1Stats.lastFormat = null;
  txV1Stats.lastCycleTxs = 0;
  txV1Stats.lastCycleBaselineTxs = 0;
  txV1Stats.v1TxsSent = 0;
  txV1Stats.legacyTxsSent = 0;
  txV1Stats.fallbacks = 0;
  txV1Stats.failClosedCycles = 0;
  txV1Stats.landingSuspensions = 0;
  txV1Stats.lastCycleIsolationSims = 0;
  txV1Stats.isolationCapHits = 0;
  txV1Stats.v1LandedOk = 0;
  txV1Stats.v1LandedReverts = 0;
  txV1Stats.v1Unlanded = 0;
}

/** /health fields: `{ txV1: {...} }` when TX_V1 is auto/on, `{}` when off (default /health unchanged). */
export function txV1HealthFields(nowMs: number = Date.now()): Record<string, unknown> {
  if (settings.mode === "off") return {};
  return {
    txV1: {
      mode: settings.mode,
      suspended: nowMs < Math.max(suspendedUntilMs, landingSuspendedUntilMs),
      suspendedKind: nowMs < landingSuspendedUntilMs ? "landing" : nowMs < suspendedUntilMs ? "rejection" : null,
      suspendedReason: nowMs < Math.max(suspendedUntilMs, landingSuspendedUntilMs) ? lastSuspendReason : null,
      ...txV1Stats,
      canary: { required: settings.canaryCycles, active: canaryActive(), ...canary },
      landing: v1LandingHealth(),
    },
  };
}

/** Whether this v1 cycle is a canary cycle (K-2). */
export function canaryActive(): boolean {
  return settings.canaryCycles > 0 && canary.passed < settings.canaryCycles;
}

/** Record a canary cycle's outcome. `unlanded` suspends v1 (landing) and re-arms the canary. */
export function noteCanaryResult(result: "confirmed" | "unlanded" | "reverted" | "inconclusive", detail: string, nowMs: number = Date.now()): void {
  canary.lastResult = result;
  if (result === "confirmed") {
    canary.passed++;
    if (canary.passed === settings.canaryCycles) console.log(`[push][TX_V1] landing canary passed (${canary.passed} v1 cycles confirmed on chain)`);
  } else if (result === "unlanded") {
    canary.failures++;
    suspendV1ForLanding(`canary: ${detail}`, nowMs);
  }
}

/** Record a v1 tx's on-chain outcome (reconcile or canary). */
export function noteV1Landing(outcome: "ok" | "revert" | "unlanded"): void {
  if (outcome === "ok") {
    txV1Stats.v1LandedOk++;
    v1SentAtLastLandedOk = txV1Stats.v1TxsSent;
    stallLogged = false;
  } else if (outcome === "revert") txV1Stats.v1LandedReverts++;
  else txV1Stats.v1Unlanded++;
}

/** /health `txV1.landing`: v1 sends vs v1 txs seen landed OK (K-2 alert). */
export function v1LandingHealth(): { v1TxsSent: number; v1LandedOk: number; sentSinceLastLandedOk: number; stalled: boolean } {
  const sentSinceLastLandedOk = txV1Stats.v1TxsSent - v1SentAtLastLandedOk;
  return {
    v1TxsSent: txV1Stats.v1TxsSent,
    v1LandedOk: txV1Stats.v1LandedOk,
    sentSinceLastLandedOk,
    stalled: sentSinceLastLandedOk >= V1_STALL_ALERT_TXS,
  };
}

/** Log once (per stall) when v1 sends keep growing while none is seen landed OK. */
export function checkV1Stall(): void {
  const h = v1LandingHealth();
  if (h.stalled && !stallLogged) {
    stallLogged = true;
    console.error(
      `[push][TX_V1] ALERT: ${h.sentSinceLastLandedOk} v1 txs sent since the last v1 tx seen landed OK ` +
        `(sent ${h.v1TxsSent}, landed ok ${h.v1LandedOk}) — v1 pushes may not be landing`,
    );
  }
}

/** Result of {@link resolveSendFormat}. `null` = fail closed (TX_V1=on, cluster has no v1). */
export type FormatDecision = { format: KeeperTxFormat } | { format: null; reason: string };

/**
 * Format for this cycle's sends.
 *
 * @param conn - Connection the txs go to (devnet); its feature gate is read (cached by the SDK).
 * @param detect - Injected detector (tests).
 */
export async function resolveSendFormat(
  conn: Pick<Connection, "getAccountInfo">,
  nowMs: number = Date.now(),
  detect: (c: Pick<Connection, "getAccountInfo">) => Promise<boolean> = detectTxV1Support,
): Promise<FormatDecision> {
  if (settings.mode === "off") return { format: "legacy" };
  const supported = await detect(conn);
  if (settings.mode === "on") {
    // Explicitly required: never silently downgrade. A cluster/RPC that does not report v1
    // means "do not send", and is loud.
    if (!supported) return { format: null, reason: "TX_V1=on but the cluster does not report Transaction v1 active (or the feature read failed)" };
    // Landing evidence (landed v1 revert / unlanded canary) suspends v1 even under `on`.
    if (nowMs < landingSuspendedUntilMs) return { format: "legacy" };
    return { format: "v1" };
  }
  if (!supported) return { format: "legacy" };
  if (nowMs < Math.max(suspendedUntilMs, landingSuspendedUntilMs)) return { format: "legacy" };
  return { format: "v1" };
}

/** Suspend v1 after a fallback (auto mode re-probes after the cooldown). */
export function noteV1Fallback(reason: string, nowMs: number = Date.now()): void {
  txV1Stats.fallbacks++;
  suspendedUntilMs = nowMs + settings.retryAfterRejectMs;
  lastSuspendReason = reason.slice(0, 200);
}

/**
 * Suspend v1 (auto AND on) for `TX_V1_RETRY_AFTER_REJECT_MS` on LANDING evidence: a v1 tx landed
 * and reverted for a reason other than the benign late duplicate, or a canary v1 tx never landed.
 * Loud: this is the case the preflight cannot see.
 */
export function suspendV1ForLanding(reason: string, nowMs: number = Date.now()): void {
  txV1Stats.landingSuspensions++;
  // Re-prove landing with a fresh canary when v1 resumes.
  canary.passed = 0;
  landingSuspendedUntilMs = nowMs + settings.retryAfterRejectMs;
  lastSuspendReason = reason.slice(0, 200);
  console.error(
    `[push][TX_V1] ${lastSuspendReason} — v1 SUSPENDED for ${Math.round(settings.retryAfterRejectMs / 60_000)}min ` +
      `(legacy until then, mode=${settings.mode})`,
  );
}

/** Instruction index of the first payload ix: legacy txs carry a ComputeBudget ix at 0. */
export function ixOffsetFor(format: KeeperTxFormat): number {
  return format === "legacy" ? 1 : 0;
}

/** CU limit for a v1 push tx of `n` markets. */
export function pushComputeUnits(n: number): number {
  return Math.min(TX_MAX_COMPUTE_UNITS, settings.pushCuBase + n * settings.pushCuPerMarket);
}

/**
 * Loaded-accounts-data-size limit for a v1 tx touching writable/readonly data accounts of
 * `accountDataBytes` (data lengths, the per-account 64 is added here).
 */
export function loadedAccountsLimit(accountDataBytes: readonly number[]): number {
  if (settings.loadedAccountsBytes !== null) return settings.loadedAccountsBytes;
  const want = Math.ceil(loadedAccountsNeed(accountDataBytes) * LOADED_HEADROOM);
  return Math.max(1, Math.min(TX_MAX_LOADED_ACCOUNTS_DATA_BYTES, want));
}

/** Loaded-accounts-data bytes a v1 push tx over these data accounts needs (before headroom). */
export function loadedAccountsNeed(accountDataBytes: readonly number[]): number {
  return settings.loadedOverheadBytes + accountDataBytes.reduce((s, b) => s + b + LOADED_ACCOUNT_BASE_BYTES, 0);
}

/**
 * Whether one v1 tx over these data accounts stays inside the loaded-accounts limit: the
 * configured TX_V1_LOADED_ACCOUNTS_BYTES, or (derived) the 64 MiB protocol cap including
 * LOADED_HEADROOM. {@link loadedAccountsLimit} silently clamps to the cap, so the chunker must
 * split instead of building a tx whose limit is below what it loads.
 */
export function loadedAccountsFit(accountDataBytes: readonly number[]): boolean {
  const need = loadedAccountsNeed(accountDataBytes);
  if (settings.loadedAccountsBytes !== null) return need <= settings.loadedAccountsBytes;
  return Math.ceil(need * LOADED_HEADROOM) <= TX_MAX_LOADED_ACCOUNTS_DATA_BYTES;
}

/**
 * K-3: at most this many DISTINCT markets per cycle may be excluded from v1 for a budget error
 * that names their instruction; one more means the budget model itself is off (or the
 * attribution is not to be trusted under a cumulative CU meter) and v1 is suspended instead.
 */
export const V1_BUDGET_MARKETS_PER_CYCLE = 2;

/** Compile + sign a v1 tx. Throws if a v1 limit is exceeded (4096 B, 64 accounts, 64 ix). */
export function buildV1Wire(p: {
  payer: PublicKey;
  signers: readonly Keypair[];
  instructions: readonly TransactionInstruction[];
  blockhash: string;
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
}): Uint8Array {
  const compiled = compileV1Message({
    payer: p.payer,
    instructions: p.instructions,
    recentBlockhash: p.blockhash,
    config: {
      computeUnitLimit: p.computeUnitLimit,
      loadedAccountsDataSizeLimit: p.loadedAccountsDataSizeLimit,
      heapSizeBytes: settings.heapBytes === 0 ? undefined : settings.heapBytes,
    },
  });
  return signV1Message(compiled, p.signers);
}

/** Serialized size of a v1 tx, or Infinity if it cannot be a v1 tx at all. */
export function v1Size(p: Omit<Parameters<typeof buildV1Wire>[0], "signers">): number {
  try {
    return compileV1Message({
      payer: p.payer,
      instructions: p.instructions,
      recentBlockhash: p.blockhash,
      config: {
        computeUnitLimit: p.computeUnitLimit,
        loadedAccountsDataSizeLimit: p.loadedAccountsDataSizeLimit,
        heapSizeBytes: settings.heapBytes === 0 ? undefined : settings.heapBytes,
      },
    }).txBytes;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The web3.js 1.x Connection's internal JSON-RPC transport (carries the configured headers). */
interface RpcTransport {
  _rpcRequest(method: string, args: unknown[]): Promise<unknown>;
  commitment?: string;
}

export interface WireSimulation {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
  loadedAccountsDataSize?: number;
}

/**
 * Simulate serialized tx bytes with the same options the keeper's legacy preflight uses
 * (`connection.simulateTransaction(tx)`: base64, the connection's commitment, no sigVerify,
 * no blockhash replacement), plus any `extra` config.
 *
 * @throws V1RpcError carrying the node's JSON-RPC error code when the reply is a JSON-RPC
 *   error (decode/sanitize failures land here, and {@link isFormatRejection} classifies them by
 *   code); a plain Error (no code: never a format rejection) for anything else.
 */
export async function simulateWire(
  conn: Connection | RpcTransport,
  wire: Uint8Array,
  extra: Record<string, unknown> = {},
): Promise<WireSimulation> {
  const t = conn as unknown as RpcTransport;
  const config = { encoding: "base64", commitment: t.commitment ?? "confirmed", ...extra };
  const res = (await t._rpcRequest("simulateTransaction", [Buffer.from(wire).toString("base64"), config])) as {
    result?: { value?: { err?: unknown; logs?: string[] | null; unitsConsumed?: number; loadedAccountsDataSize?: number } };
    error?: { code?: number; message?: string };
  };
  if (res.error) {
    if (typeof res.error.code === "number") {
      throw new V1RpcError("simulateTransaction", res.error.code, res.error.message ?? JSON.stringify(res.error));
    }
    throw new Error(`failed to simulate transaction: ${JSON.stringify(res.error)}`);
  }
  const v = res.result?.value;
  if (!v) throw new Error("failed to simulate transaction: malformed response");
  return { err: v.err ?? null, logs: v.logs ?? null, unitsConsumed: v.unitsConsumed, loadedAccountsDataSize: v.loadedAccountsDataSize };
}

/**
 * True when a v1 PREFLIGHT failure is our own v1 budget being too small (compute or loaded
 * accounts data size) rather than a market fault. Such a chunk is re-sent in legacy (which
 * carries the keeper's long-standing 200k-per-push budget) and is never a strike against a market.
 */
export function isV1BudgetError(err: unknown, logs: readonly string[] | null = null): boolean {
  const s = typeof err === "string" ? err : JSON.stringify(err ?? null);
  if (/ComputationalBudgetExceeded|MaxLoadedAccountsDataSizeExceeded|InvalidLoadedAccountsDataSizeLimit/.test(s)) return true;
  if (/ProgramFailedToComplete/.test(s) && (logs ?? []).some((l) => /exceeded CUs meter|out of memory|memory allocation failed/i.test(l))) return true;
  return false;
}

/**
 * Send serialized v1 bytes through `conn.sendRawTransaction` (so the dry-run hard stop, which
 * replaces that method on the connection, still applies) and keep the node's JSON-RPC error
 * CODE when the send is refused.
 *
 * web3.js 1.x `sendRawTransaction` -> `sendEncodedTransaction` -> `this._rpcRequest(...)`, and on
 * a JSON-RPC error throws a SendTransactionError that carries only the message. This calls the
 * same method on a per-call view of the connection (`Object.create(conn)`) whose `_rpcRequest`
 * forwards to the real transport and records a `sendTransaction` error reply, so concurrent
 * sends never share state and nothing on the connection is patched. A recorded reply is
 * rethrown as a `V1RpcError` (cause = the original error); anything else (network failure,
 * the dry-run refusal, a web3.js SolanaJSONRPCError that already has `.code`) is rethrown as is.
 */
export async function sendWire(conn: Connection, wire: Uint8Array, opts: SendOptions): Promise<string> {
  const transport = (conn as unknown as Partial<RpcTransport>)._rpcRequest;
  const seen: { error?: { code: number; message: string } } = {};
  const view = Object.create(conn) as Connection;
  if (typeof transport === "function") {
    (view as unknown as RpcTransport)._rpcRequest = async (method: string, args: unknown[]): Promise<unknown> => {
      const res = await transport.call(conn, method, args);
      const e = (res as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (method === "sendTransaction" && e && typeof e.code === "number") {
        seen.error = { code: e.code, message: typeof e.message === "string" ? e.message : JSON.stringify(e) };
      }
      return res;
    };
  }
  try {
    return await view.sendRawTransaction(wire, opts);
  } catch (err) {
    if (seen.error) {
      const typed = new V1RpcError("sendTransaction", seen.error.code, seen.error.message);
      Object.defineProperty(typed, "cause", { value: err, enumerable: false });
      throw typed;
    }
    throw err;
  }
}

/**
 * True when a send/simulate failure means the node or cluster could not take v1 bytes at all.
 * By JSON-RPC error code only (SDK classifier): plain Error text is never a format rejection.
 */
export function isFormatRejection(err: unknown): boolean {
  return isTxV1FormatRejection(err);
}
