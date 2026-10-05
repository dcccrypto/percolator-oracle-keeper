/**
 * cross-cluster/retire.ts
 *
 * v1 wind-down: per-market retire at open interest 0.
 *
 * The v1 keeper must keep pricing and cranking a market for as long as anyone can still exit it
 * (an exit on a stale market reverts). A market may therefore leave the registry only when it is
 * provably empty: no open interest, and trader capital plus Earn principal under a small threshold
 * (default 1 whole collateral token, scaled by the collateral mint's own decimals).
 *
 * Guards (security review 2026-10-05, M-1 / L-1 / L-2 / L-3):
 *   - Fail-safe: any read or decode failure means KEEP, also after the hard date. A market account
 *     not owned by the configured wrapper, an Earn registry whose backing ledger is missing, or a
 *     collateral mint that does not decode is "unknown", never "empty".
 *   - Confirmation: a market is removed only after `confirmReads` consecutive retire verdicts, one
 *     per pass (passes are KEEPER_RETIRE_INTERVAL_MS apart), never on the boot pass. Any keep
 *     verdict or failed read resets the count.
 *   - Age: a market younger than `minAgeMs` (registeredAt, else first seen by this process) is kept,
 *     so a just-created, still unfunded market is not retired.
 *   - Hard date (KEEPER_RETIRE_HARD_DATE): past it, an EMPTY market still retires as usual, and a
 *     market that still holds OI or funds retires only if KEEPER_RETIRE_HARD_CONFIRM repeats the
 *     hard date verbatim. Each such override is logged with what the market still holds.
 *
 * Dry-run is the default; nothing is removed unless KEEPER_RETIRE_APPLY=1 and the keeper itself is
 * not in DRY_RUN.
 *
 * Earn principal is the backing-domain ledger `total_principal_atoms` of the vault's own domain
 * (the same ledger vault-lp-junior-watch.ts reads). It is an upper bound on NAV, so a vault with
 * unrealised loss is retired later, never earlier.
 */
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  V17_MARKET_GROUP_OFF,
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  parseLpVaultRegistry,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import { decodeTerminalState } from "./market-state.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import { ledgerTotalPrincipal } from "./vault-lp-junior-watch.ts";
import { removeMarket, saveRegistry } from "./registry.ts";
import type { MarketEntry, Registry } from "./registry.ts";

/** `c_tot` u128 @ group+317 (market-state.ts H_C_TOT). */
const H_C_TOT = 317;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PeFkUFTpyM4mt";
/** SPL Mint: decimals u8 @ 44, is_initialized u8 @ 45 (82-byte base layout, also the Token-2022 prefix). */
const MINT_DECIMALS_OFF = 44;
const MINT_INITIALIZED_OFF = 45;
const MINT_BASE_LEN = 82;

export interface MarketEconomics {
  /** Stored positions (both sides) plus stale-account counts: any non-zero means somebody can still be in. */
  openInterest: bigint;
  /** Total portfolio capital (header c_tot), collateral atoms. Includes the Earn vault's own LP portfolio, so it
   *  overlaps Earn principal: the sum is conservative (a market retires later, never earlier). */
  capitalAtoms: bigint;
  /** Earn principal of the vault's backing domain, collateral atoms (0 when the market has no Earn vault). */
  earnPrincipalAtoms: bigint;
  /** Collateral mint decimals, read from the mint account. */
  decimals: number;
}

export interface RetireConfig {
  /** Threshold in millionths of one whole collateral token. Default 1_000_000 (= 1 token). */
  thresholdMicroUnits: bigint;
  /** Epoch ms; past it, empty markets retire as usual and non-empty ones only with `hardConfirmed`. */
  hardRetireAtMs: number | null;
  /** KEEPER_RETIRE_HARD_CONFIRM repeated KEEPER_RETIRE_HARD_DATE verbatim. */
  hardConfirmed: boolean;
  /** Consecutive retire verdicts (one per pass) before a removal. Never below 2. */
  confirmReads: number;
  /** A market younger than this is kept. */
  minAgeMs: number;
  nowMs: number;
}

export type RetireDecision = { retire: boolean; reason: string; override?: boolean };

export const DEFAULT_CONFIRM_READS = 3;
export const MIN_CONFIRM_READS = 2;
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60_000;

/** Threshold in atoms for a mint with `decimals`. */
export function thresholdAtoms(cfg: Pick<RetireConfig, "thresholdMicroUnits">, decimals: number): bigint {
  return (cfg.thresholdMicroUnits * 10n ** BigInt(decimals)) / 1_000_000n;
}

/** Pure, single read. `econ === null` means the read failed: always keep, hard date or not. */
export function decideRetire(econ: MarketEconomics | null, cfg: RetireConfig): RetireDecision {
  if (econ === null) return { retire: false, reason: "read failed; keeping (fail-safe)" };
  const limit = thresholdAtoms(cfg, econ.decimals);
  const inside = econ.capitalAtoms + econ.earnPrincipalAtoms;
  const holds =
    `OI ${econ.openInterest}, capital ${econ.capitalAtoms}, earn ${econ.earnPrincipalAtoms} atoms ` +
    `(${econ.decimals} dp, threshold ${limit})`;
  const empty = econ.openInterest === 0n && inside < limit;
  if (empty) return { retire: true, reason: `empty: ${holds}` };
  const hardReached = cfg.hardRetireAtMs !== null && cfg.nowMs >= cfg.hardRetireAtMs;
  if (hardReached && cfg.hardConfirmed) {
    return { retire: true, override: true, reason: `HARD DATE OVERRIDE (confirmed) on a market that still holds ${holds}` };
  }
  if (hardReached) {
    return { retire: false, reason: `hard date reached but the market still holds ${holds}; set KEEPER_RETIRE_HARD_CONFIRM to the hard date to override` };
  }
  return { retire: false, reason: `not empty: ${holds}` };
}

/** "1", "0.5", "2.25": whole tokens with up to 6 decimals, as millionths. null if unparseable. */
function parseUnits(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function retireConfigFromEnv(env: Readonly<Record<string, string | undefined>>, nowMs: number): RetireConfig {
  const thresholdMicroUnits = (env.KEEPER_RETIRE_THRESHOLD_UNITS ? parseUnits(env.KEEPER_RETIRE_THRESHOLD_UNITS) : null) ?? 1_000_000n;
  let hardRetireAtMs: number | null = null;
  const hardDate = env.KEEPER_RETIRE_HARD_DATE?.trim();
  if (hardDate) {
    const ms = Date.parse(hardDate);
    if (Number.isFinite(ms)) hardRetireAtMs = ms; // unparseable = no hard date (never retire by accident)
  }
  const hardConfirmed = hardRetireAtMs !== null && env.KEEPER_RETIRE_HARD_CONFIRM?.trim() === hardDate;
  const n = Number(env.KEEPER_RETIRE_CONFIRM_READS);
  const confirmReads = Number.isInteger(n) && n >= MIN_CONFIRM_READS ? n : DEFAULT_CONFIRM_READS;
  const a = Number(env.KEEPER_RETIRE_MIN_AGE_MS);
  const minAgeMs = env.KEEPER_RETIRE_MIN_AGE_MS !== undefined && Number.isFinite(a) && a >= 0 ? a : DEFAULT_MIN_AGE_MS;
  return { thresholdMicroUnits, hardRetireAtMs, hardConfirmed, confirmReads, minAgeMs, nowMs };
}

function u128(d: Uint8Array, off: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
}

/** Decimals of an initialized SPL / Token-2022 mint, or null. */
export function mintDecimals(info: { owner: PublicKey; data: Uint8Array | Buffer } | null): number | null {
  if (!info) return null;
  const owner = info.owner.toBase58();
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) return null;
  const d = info.data;
  if (d.length < MINT_BASE_LEN || d[MINT_INITIALIZED_OFF] !== 1) return null;
  return d[MINT_DECIMALS_OFF];
}

export type RetireConnection = Pick<Connection, "getMultipleAccountsInfo">;

/**
 * Never throws; null on any failure: RPC error, missing or foreign-owned market, non-Live or
 * undecodable market, undecodable collateral mint, an Earn registry not owned by the wrapper, or an
 * Earn registry whose backing ledger is missing or does not decode.
 */
export async function readMarketEconomics(
  conn: RetireConnection,
  marketAddress: string,
  wrapperProgramId: PublicKey,
): Promise<MarketEconomics | null> {
  try {
    const market = new PublicKey(marketAddress);
    const registryKey = deriveLpVaultRegistry(wrapperProgramId, market)[0];
    const [mi, ri] = await conn.getMultipleAccountsInfo([market, registryKey], "confirmed");
    if (!mi || !mi.owner.equals(wrapperProgramId)) return null;
    const data = new Uint8Array(mi.data);
    const term = decodeTerminalState(data);
    if (!term || term.kind !== "live") return null;
    const g = V17_MARKET_GROUP_OFF;
    if (data.length < g + H_C_TOT + 16) return null;
    const s = decodeMarketRefreshState(data);
    const openInterest = s.storedPosLong + s.storedPosShort + s.staleLong + s.staleShort;
    const mint = parseWrapperConfigV17(data).collateralMint;

    let ledgerKey: PublicKey | null = null;
    if (ri) {
      if (!ri.owner.equals(wrapperProgramId)) return null;
      const reg = parseLpVaultRegistry(new Uint8Array(ri.data));
      ledgerKey = deriveLpBackingLedger(wrapperProgramId, market, Number(reg.domain))[0];
    }
    const [mintInfo, li] = await conn.getMultipleAccountsInfo(ledgerKey ? [mint, ledgerKey] : [mint], "confirmed");
    const decimals = mintDecimals(mintInfo);
    if (decimals === null) return null;
    let earn = 0n; // no Earn registry: the market has no vault
    if (ledgerKey) {
      if (!li || !li.owner.equals(wrapperProgramId)) return null; // registry without its ledger: unknown
      const p = ledgerTotalPrincipal(new Uint8Array(li.data));
      if (p === null) return null;
      earn = p;
    }
    return { openInterest, capitalAtoms: u128(data, g + H_C_TOT), earnPrincipalAtoms: earn, decimals };
  } catch {
    return null;
  }
}

/** Retired markets, persisted beside the registry so a restart or the register poll cannot re-admit them. */
export class RetiredSet {
  private readonly set = new Set<string>();
  constructor(private readonly path: string | null) {
    if (path && fs.existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
        if (Array.isArray(parsed)) for (const a of parsed) if (typeof a === "string") this.set.add(a);
      } catch {
        /* unreadable file: start empty; a market is only ever re-added, never lost */
      }
    }
  }
  has = (addr: string): boolean => this.set.has(addr);
  add(addr: string): void {
    this.set.add(addr);
    if (this.path) fs.writeFileSync(this.path, JSON.stringify([...this.set].sort(), null, 2) + "\n", "utf8");
  }
}

/** Per-process state across passes. */
export interface RetireState {
  /** Consecutive retire verdicts per market. */
  streaks: Map<string, number>;
  /** First time this process saw a market without `registeredAt`. */
  firstSeen: Map<string, number>;
}

export const newRetireState = (): RetireState => ({ streaks: new Map(), firstSeen: new Map() });

export interface RetireDeps {
  read: (marketAddress: string) => Promise<MarketEconomics | null>;
  cfg: RetireConfig;
  /** false = log only (the default). */
  apply: boolean;
  registryPath: string;
  retired: RetiredSet;
  state: RetireState;
}

function marketAgeMs(m: MarketEntry, state: RetireState, nowMs: number): number {
  if (typeof m.registeredAt === "number" && Number.isFinite(m.registeredAt)) return nowMs - m.registeredAt;
  let seen = state.firstSeen.get(m.marketAddress);
  if (seen === undefined) {
    seen = nowMs;
    state.firstSeen.set(m.marketAddress, seen);
  }
  return nowMs - seen;
}

/**
 * One pass over the registry. Returns the addresses retired (or that would be, in dry-run) on this
 * pass. `boot` = the first pass after start: verdicts are counted but nothing is retired.
 */
export async function runRetirePass(registry: Registry, deps: RetireDeps, opts: { boot?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const { cfg, state } = deps;
  const need = Math.max(cfg.confirmReads, MIN_CONFIRM_READS);
  for (const m of [...registry.markets]) {
    const tag = `${m.label} (${m.marketAddress.slice(0, 8)}…)`;
    let econ: MarketEconomics | null = null;
    try {
      econ = await deps.read(m.marketAddress);
    } catch {
      econ = null;
    }
    const d = decideRetire(econ, cfg);
    const age = marketAgeMs(m, state, cfg.nowMs);
    if (!d.retire || age < cfg.minAgeMs) {
      state.streaks.delete(m.marketAddress);
      if (d.retire) console.log(`[retire] keeping ${tag}: younger than ${cfg.minAgeMs}ms (${age}ms)`);
      else if (d.reason.startsWith("hard date reached")) console.warn(`[retire] keeping ${tag}: ${d.reason}`);
      continue;
    }
    const n = (state.streaks.get(m.marketAddress) ?? 0) + 1;
    state.streaks.set(m.marketAddress, n);
    if (d.override) console.warn(`[retire] ${tag}: ${d.reason} (${n}/${need})`);
    if (opts.boot || n < need) {
      console.log(`[retire] ${tag}: retire verdict ${n}/${need}${opts.boot ? " (boot pass: never retires)" : ""}: ${d.reason}`);
      continue;
    }
    out.push(m.marketAddress);
    if (!deps.apply) {
      console.log(`[retire] DRY-RUN would retire ${tag}: ${d.reason}`);
      continue;
    }
    removeMarket(registry, m.marketAddress);
    deps.retired.add(m.marketAddress);
    state.streaks.delete(m.marketAddress);
    try {
      saveRegistry(registry, deps.registryPath);
    } catch (err) {
      console.error(`[retire] saveRegistry failed (retired in memory only): ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`[retire] RETIRED ${tag} after ${n} consecutive reads: ${d.reason}`);
  }
  return out;
}

export async function startRetireLoop(registry: Registry, deps: Omit<RetireDeps, "state">, intervalMs: number): Promise<void> {
  const c = deps.cfg;
  console.log(
    `[retire] starting: interval=${intervalMs}ms apply=${deps.apply} threshold=${c.thresholdMicroUnits}e-6 tokens ` +
      `confirmReads=${Math.max(c.confirmReads, MIN_CONFIRM_READS)} minAge=${c.minAgeMs}ms ` +
      `hardDate=${c.hardRetireAtMs ?? "none"} hardConfirmed=${c.hardConfirmed}`,
  );
  const state = newRetireState();
  let boot = true;
  for (;;) {
    try {
      await runRetirePass(registry, { ...deps, state, cfg: { ...c, nowMs: Date.now() } }, { boot });
    } catch (err) {
      console.error(`[retire] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    boot = false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
