/**
 * cross-cluster/retire.ts
 *
 * v1 wind-down: per-market retire at open interest 0.
 *
 * The v1 keeper must keep pricing and cranking a market for as long as anyone can still exit it
 * (an exit on a stale market reverts). A market may therefore leave the registry only when it is
 * provably empty: no open interest, and trader capital plus Earn principal under a small threshold
 * (default 1 sim-USDC). An explicit hard date (KEEPER_RETIRE_HARD_DATE) retires regardless, as the
 * founder's "v1 is over" switch.
 *
 * Fail-safe: any read or decode failure means KEEP. Dry-run is the default; nothing is removed
 * unless KEEPER_RETIRE_APPLY=1 and the keeper itself is not in DRY_RUN.
 *
 * Earn principal is the backing-domain ledger `total_principal_atoms` of domains 0 and 1 (the two
 * pots of a non-bound vault; the same ledger vault-lp-junior-watch.ts reads). It is an upper
 * bound on NAV, so a vault with unrealised loss is retired slightly later, never earlier.
 */
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { V17_MARKET_GROUP_OFF, deriveLpBackingLedger } from "@percolatorct/sdk";
import { decodeTerminalState } from "./market-state.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import { ledgerTotalPrincipal } from "./vault-lp-junior-watch.ts";
import { removeMarket, saveRegistry } from "./registry.ts";
import type { Registry } from "./registry.ts";

/** `c_tot` u128 @ group+317 (market-state.ts H_C_TOT). */
const H_C_TOT = 317;

export interface MarketEconomics {
  /** Stored positions (both sides) plus stale-account counts: any non-zero means somebody can still be in. */
  openInterest: bigint;
  /** Total trader capital (header c_tot), collateral atoms. */
  capitalAtoms: bigint;
  /** Earn principal across both pots, collateral atoms. */
  earnPrincipalAtoms: bigint;
}

export interface RetireConfig {
  /** Retire only when capital + Earn principal is below this many atoms. Default 1_000_000 (1 sim-USDC, 6 dp). */
  thresholdAtoms: bigint;
  /** Epoch ms; once reached every market is retired regardless of contents. null = no hard date. */
  hardRetireAtMs: number | null;
  nowMs: number;
}

export type RetireDecision = { retire: boolean; reason: string };

/** Pure. `econ === null` means the read failed: always keep. */
export function decideRetire(econ: MarketEconomics | null, cfg: RetireConfig): RetireDecision {
  if (cfg.hardRetireAtMs !== null && cfg.nowMs >= cfg.hardRetireAtMs) {
    return { retire: true, reason: "hard retire date reached" };
  }
  if (econ === null) return { retire: false, reason: "read failed; keeping (fail-safe)" };
  if (econ.openInterest !== 0n) return { retire: false, reason: `open interest ${econ.openInterest}` };
  const inside = econ.capitalAtoms + econ.earnPrincipalAtoms;
  if (inside >= cfg.thresholdAtoms) {
    return { retire: false, reason: `${inside} atoms still inside (capital ${econ.capitalAtoms}, earn ${econ.earnPrincipalAtoms})` };
  }
  return { retire: true, reason: `OI 0 and ${inside} atoms inside (< ${cfg.thresholdAtoms})` };
}

export function retireConfigFromEnv(env: Readonly<Record<string, string | undefined>>, nowMs: number): RetireConfig {
  const t = env.KEEPER_RETIRE_THRESHOLD_ATOMS;
  let thresholdAtoms = 1_000_000n;
  if (t !== undefined && /^\d+$/.test(t)) thresholdAtoms = BigInt(t);
  let hardRetireAtMs: number | null = null;
  if (env.KEEPER_RETIRE_HARD_DATE) {
    const ms = Date.parse(env.KEEPER_RETIRE_HARD_DATE);
    if (Number.isFinite(ms)) hardRetireAtMs = ms; // unparseable = no hard date (never retire by accident)
  }
  return { thresholdAtoms, hardRetireAtMs, nowMs };
}

function u128(d: Uint8Array, off: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
}

export type RetireConnection = Pick<Connection, "getMultipleAccountsInfo">;

/** Never throws; null on any failure, a non-Live market or an undecodable account. */
export async function readMarketEconomics(
  conn: RetireConnection,
  marketAddress: string,
  wrapperProgramId: PublicKey,
): Promise<MarketEconomics | null> {
  try {
    const market = new PublicKey(marketAddress);
    const keys = [market, deriveLpBackingLedger(wrapperProgramId, market, 0)[0], deriveLpBackingLedger(wrapperProgramId, market, 1)[0]];
    const [mi, l0, l1] = await conn.getMultipleAccountsInfo(keys, "confirmed");
    if (!mi) return null;
    const data = new Uint8Array(mi.data);
    const term = decodeTerminalState(data);
    if (!term || term.kind !== "live") return null;
    const g = V17_MARKET_GROUP_OFF;
    if (data.length < g + H_C_TOT + 16) return null;
    const s = decodeMarketRefreshState(data);
    const openInterest = s.storedPosLong + s.storedPosShort + s.staleLong + s.staleShort;
    let earn = 0n;
    for (const li of [l0, l1]) {
      if (!li) continue; // a pot that was never created holds nothing
      const p = ledgerTotalPrincipal(new Uint8Array(li.data));
      if (p === null) return null; // exists but does not decode: unknown, keep
      earn += p;
    }
    return { openInterest, capitalAtoms: u128(data, g + H_C_TOT), earnPrincipalAtoms: earn };
  } catch {
    return null;
  }
}

export interface RetireDeps {
  read: (marketAddress: string) => Promise<MarketEconomics | null>;
  cfg: RetireConfig;
  /** false = log only (the default). */
  apply: boolean;
  registryPath: string;
  retired: RetiredSet;
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

/** One pass over the registry. Returns the addresses retired (or that would be, in dry-run). */
export async function runRetirePass(registry: Registry, deps: RetireDeps): Promise<string[]> {
  const out: string[] = [];
  for (const m of [...registry.markets]) {
    let econ: MarketEconomics | null = null;
    try {
      econ = await deps.read(m.marketAddress);
    } catch {
      econ = null;
    }
    const d = decideRetire(econ, deps.cfg);
    if (!d.retire) continue;
    const tag = `${m.label} (${m.marketAddress.slice(0, 8)}…)`;
    out.push(m.marketAddress);
    if (!deps.apply) {
      console.log(`[retire] DRY-RUN would retire ${tag}: ${d.reason}`);
      continue;
    }
    removeMarket(registry, m.marketAddress);
    deps.retired.add(m.marketAddress);
    try {
      saveRegistry(registry, deps.registryPath);
    } catch (err) {
      console.error(`[retire] saveRegistry failed (retired in memory only): ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`[retire] RETIRED ${tag}: ${d.reason}`);
  }
  return out;
}

export async function startRetireLoop(registry: Registry, deps: RetireDeps, intervalMs: number): Promise<void> {
  console.log(`[retire] starting: interval=${intervalMs}ms apply=${deps.apply} threshold=${deps.cfg.thresholdAtoms} hardDate=${deps.cfg.hardRetireAtMs ?? "none"}`);
  for (;;) {
    try {
      await runRetirePass(registry, { ...deps, cfg: { ...deps.cfg, nowMs: Date.now() } });
    } catch (err) {
      console.error(`[retire] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
