/**
 * cross-cluster/capacity-snapshots.ts
 *
 * Growth telemetry (devnet-v2-growth-plan-2026-10-04 §2.11, P0-F): every CAPACITY_SNAPSHOT_INTERVAL_MS
 * (5 min) write one row per growth market to Supabase `market_capacity_snapshots`, so the app can
 * chart capacity, utilisation per side, the max-leverage ladder and Earn NAV over time.
 *
 * OFF BY DEFAULT. `KEEPER_CAPACITY_SNAPSHOTS` must be "1"/"true" AND `SUPABASE_URL` +
 * `SUPABASE_SERVICE_ROLE_KEY` set (the table has RLS on with no policies, like chart_candles, so only
 * the service role can write). With the flag off, `tick()` returns before any RPC or fetch.
 *
 * NO-OP ON LEGACY MARKETS. A market is snapshotted only if it is bound to a vault LP AND its
 * asset-slot [672, 792) growth record decodes (`decodeAssetGrowthV19` is null when the bytes are
 * all-zero, which is every market of today's programs). A legacy market costs no RPC beyond the one
 * batched market/registry/state read.
 *
 * SAFETY. Read-only on chain. `tick()` never throws (a decoder failure on one market skips that
 * market, a sink failure is counted); one request in flight at most; the crank/push loops never wait on it.
 *
 * Definitions (stored values, see supabase/migrations/20261005000000_market_capacity_snapshots.sql):
 *   lp_equity_atoms   C_m = conservativeEquity(LP capital, pnl, fee credits)   (includes allocated Earn)
 *   n_cap_q           floor(C_m * lambda * POS_SCALE / (1e4 * price_e6))
 *   u_*_bps           users-side OI / N_cap (quoteMaxLeverage; the LP's own leg is excluded)
 *   max_leverage_*    quoteMaxLeverage(...) in x100 (0 when that side is closed to new risk)
 *   earn_principal    vault_lp_state.senior_claim_atoms
 *   earn_nav          principal - senior_draw_outstanding (clamped at 0): claim-adjusted, an approximation
 *                     of what a senior could redeem while a draw is unpaid
 *   nav_per_share     earn_nav / registry.total_lp_shares_outstanding, 9 dp, null when no shares
 *   credit_rate_bps   NOT yet captured (null): the winner credit rate needs the pot ledgers
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  GROWTH_POS_SCALE,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  conservativeEquity,
  decodeAssetGrowthV19,
  deriveVaultLpExtP2b,
  decodeVaultLpExtV19,
  isBankruptcyHlockActive,
  parsePortfolioV17,
  quoteMaxLeverage,
} from "@percolatorct/sdk";
import type { QuoteMaxLeverageInput, VaultLpExtV19 } from "@percolatorct/sdk";
import { decodeAdlState } from "./adl-state.ts";
import { readU128, readU64, readVaultMarketSnapshots } from "./p2b-markets.ts";
import type { MarketRef, SnapshotConnection, VaultMarketSnapshot } from "./p2b-markets.ts";
import { deriveVaultLpState as deriveVaultLpStatePda } from "./resolved-portfolio-cleanup.ts";
import { vaultLpEffectivePositionQ } from "./p2b-hedged-lockout.ts";

// ── Layout (absolute offsets; cross-checked against app/lib/limits/constants.ts) ──
const HEADER_LEN = 16;
const G = V17_MARKET_GROUP_OFF;
const CFG = G + 32;
const CFG_INITIAL_MARGIN_BPS = 62;
const CFG_MAX_ABS_FUNDING_E9_PER_SLOT = 126;
const H_INSURANCE = 301;
const H_BANKRUPTCY_HLOCK = 621;
const WCFG_LP_FEE_ACCRUED_ATOMS = 496;
const ASSET_SLOT_BASE_LEN = 1024;
const AS_EFFECTIVE_PRICE = 25;
// vault_lp_state (absolute, header included): SDK VAULT_LP_STATE_OFF_P3
const VLS_SENIOR_CLAIM = 144;
const VLS_JUNIOR_DEPOSITED = 160;
const VLS_JUNIOR_WITHDRAWN = 176;
const VLS_SENIOR_DRAWN_OUTSTANDING = 256;

export interface CapacitySnapshotRow {
  slab: string;
  asset_index: number;
  ts: string;
  slot: number;
  price_e6: string;
  earn_principal_atoms: string;
  earn_nav_atoms: string;
  earn_shares: string;
  nav_per_share: string | null;
  allocated_atoms: string;
  junior_atoms: string;
  cushion_atoms: string;
  lp_equity_atoms: string;
  n_cap_q: string | null;
  /** N_cap in collateral atoms: n_cap_q * price_e6 / POS_SCALE (= C_m * lambda / 1e4, floored). */
  capacity_notional_atoms: string | null;
  u_long_bps: number | null;
  u_short_bps: number | null;
  imr_dyn_long_bps: number | null;
  imr_dyn_short_bps: number | null;
  l_ceil_x100: number;
  max_leverage_long_x100: number;
  max_leverage_short_x100: number;
  long_closed: boolean;
  short_closed: boolean;
  long_closed_reason: string | null;
  short_closed_reason: string | null;
  oi_long_q: string;
  oi_short_q: string;
  lp_net_q: string;
  max_abs_funding_e9_per_slot: string;
  fee_income_atoms: string;
  insurance_atoms: string;
  credit_rate_bps: number | null;
  adl_active: boolean;
  hlock_active: boolean;
  draw_outstanding_atoms: string;
}

export interface CapacitySnapshotConfig {
  enabled: boolean;
  intervalMs: number;
  supabaseUrl: string;
  serviceKey: string;
  timeoutMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const on = (v: string | undefined): boolean => v !== undefined && ["1", "true"].includes(v.trim().toLowerCase());

/** Throws on garbage or on "enabled without credentials" so a typo fails boot, not a loop. */
export function capacitySnapshotConfigFromEnv(env: Env): CapacitySnapshotConfig {
  const enabled = on(env.KEEPER_CAPACITY_SNAPSHOTS);
  const rawInterval = env.CAPACITY_SNAPSHOT_INTERVAL_MS;
  let intervalMs = 300_000;
  if (rawInterval !== undefined && rawInterval.trim() !== "") {
    const n = Number(rawInterval);
    if (!Number.isInteger(n) || n < 10_000 || n > 86_400_000) throw new Error(`CAPACITY_SNAPSHOT_INTERVAL_MS="${rawInterval}" must be an integer in [10000, 86400000]`);
    intervalMs = n;
  }
  const supabaseUrl = (env.SUPABASE_URL ?? "").trim();
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (enabled) {
    if (supabaseUrl === "" || serviceKey === "") throw new Error("KEEPER_CAPACITY_SNAPSHOTS is on but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both set");
    let u: URL;
    try {
      u = new URL(supabaseUrl);
    } catch {
      throw new Error("SUPABASE_URL is not a valid URL");
    }
    if (u.protocol !== "https:") throw new Error("SUPABASE_URL must be https for capacity snapshots (the service key travels in the request)");
  }
  return { enabled, intervalMs, supabaseUrl, serviceKey, timeoutMs: 5_000 };
}

// ── Pure row builder ──────────────────────────────────────────────────────────

export interface BuildRowInput {
  snapshot: VaultMarketSnapshot;
  /** vault_lp_state account bytes. */
  vaultLpStateData: Uint8Array;
  /** VaultLpExtV19 account bytes, null when the PDA does not exist (pre-P2b). */
  vaultLpExtData: Uint8Array | null;
  /** The bound vault LP portfolio bytes. */
  lpPortfolioData: Uint8Array;
  nowMs: number;
}

function decimal9(num: bigint, den: bigint): string | null {
  if (den <= 0n) return null;
  const scaled = (num * 1_000_000_000n) / den;
  return `${scaled / 1_000_000_000n}.${(scaled % 1_000_000_000n).toString().padStart(9, "0")}`;
}

const bpsOrNull = (v: bigint | null): number | null => (v === null ? null : Number(v));

/**
 * One row, or null when the market has no growth record / is not a readable bound v18 market. Pure; throws only
 * on programmer error (callers wrap per market).
 */
export function buildCapacityRow(i: BuildRowInput): CapacitySnapshotRow | null {
  const s = i.snapshot;
  if (!s.bound || !s.marketData || !s.registry) return null;
  const assetIndex = s.ref.assetIndex;
  const growth = decodeAssetGrowthV19(s.marketData, assetIndex);
  if (growth === null) return null; // legacy market: nothing to say
  const adl = decodeAdlState(s.marketData, assetIndex);
  if (!adl) return null;
  const d = i.vaultLpStateData;
  const m = s.marketData;
  const lp = parsePortfolioV17(i.lpPortfolioData);
  const priceOff = slotEngineBase(assetIndex) + AS_EFFECTIVE_PRICE;
  const priceE6 = readU64(m, priceOff);
  const lpEff = vaultLpEffectivePositionQ(lp, assetIndex, adl);
  const hlock = m.length > G + H_BANKRUPTCY_HLOCK ? isBankruptcyHlockActive(m[G + H_BANKRUPTCY_HLOCK] as number) : false;
  const input: QuoteMaxLeverageInput = {
    engineImrBps: readU64(m, CFG + CFG_INITIAL_MARGIN_BPS),
    growth,
    lpCapital: lp.capital,
    lpPnl: lp.pnl,
    lpFeeCredits: lp.feeCredits,
    lpEffectivePositionQ: lpEff,
    assetBound: true,
    oiEffLongQ: adl.oiEffLong,
    oiEffShortQ: adl.oiEffShort,
    priceE6,
    bankruptcyHlockActive: hlock,
  };
  const qL = quoteMaxLeverage(input, "long");
  const qS = quoteMaxLeverage(input, "short");
  const principal = readU128(d, VLS_SENIOR_CLAIM);
  const outstanding = readU128(d, VLS_SENIOR_DRAWN_OUTSTANDING);
  const nav = principal > outstanding ? principal - outstanding : 0n;
  const shares = s.registry.totalLpSharesOutstanding;
  const junior = readU128(d, VLS_JUNIOR_DEPOSITED) - readU128(d, VLS_JUNIOR_WITHDRAWN);
  let ext: VaultLpExtV19 | null = null;
  try {
    ext = i.vaultLpExtData ? decodeVaultLpExtV19(i.vaultLpExtData) : null;
  } catch {
    ext = null; // a malformed ext PDA must not suppress the rest of the row; allocation reads as 0
  }
  return {
    slab: s.ref.marketAddress,
    asset_index: assetIndex,
    ts: new Date(i.nowMs).toISOString(),
    slot: s.slot,
    price_e6: priceE6.toString(),
    earn_principal_atoms: principal.toString(),
    earn_nav_atoms: nav.toString(),
    earn_shares: shares.toString(),
    nav_per_share: decimal9(nav, shares),
    allocated_atoms: (ext?.allocatedAtoms ?? 0n).toString(),
    junior_atoms: (junior < 0n ? 0n : junior).toString(),
    cushion_atoms: (ext?.cushionAccruedAtoms ?? 0n).toString(),
    lp_equity_atoms: conservativeEquity(lp.capital, lp.pnl, lp.feeCredits).toString(),
    n_cap_q: qL.nCapQ === null ? null : qL.nCapQ.toString(),
    capacity_notional_atoms: qL.nCapQ === null ? null : ((qL.nCapQ * priceE6) / GROWTH_POS_SCALE).toString(),
    u_long_bps: bpsOrNull(qL.utilizationBps),
    u_short_bps: bpsOrNull(qS.utilizationBps),
    imr_dyn_long_bps: bpsOrNull(qL.imrBps),
    imr_dyn_short_bps: bpsOrNull(qS.imrBps),
    l_ceil_x100: growth.ceilX100,
    max_leverage_long_x100: qL.maxLeverageX100,
    max_leverage_short_x100: qS.maxLeverageX100,
    long_closed: qL.closed,
    short_closed: qS.closed,
    long_closed_reason: qL.closedReason,
    short_closed_reason: qS.closedReason,
    oi_long_q: adl.oiEffLong.toString(),
    oi_short_q: adl.oiEffShort.toString(),
    lp_net_q: lpEff.toString(),
    max_abs_funding_e9_per_slot: readU64(m, CFG + CFG_MAX_ABS_FUNDING_E9_PER_SLOT).toString(),
    fee_income_atoms: readU128(m, HEADER_LEN + WCFG_LP_FEE_ACCRUED_ATOMS).toString(),
    insurance_atoms: readU128(m, G + H_INSURANCE).toString(),
    credit_rate_bps: null,
    adl_active: adl.reduceOnly,
    hlock_active: hlock,
    draw_outstanding_atoms: outstanding.toString(),
  };
}

/** Absolute offset of the engine asset record: group + group len + stride * i + wrapper block. */
function slotEngineBase(assetIndex: number): number {
  return G + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN + ASSET_SLOT_BASE_LEN;
}

// ── Sink ──────────────────────────────────────────────────────────────────────

export interface SnapshotSink {
  insert(rows: ReadonlyArray<CapacitySnapshotRow>): Promise<void>;
}

/** PostgREST insert. Never logs the key or the URL path. */
export function createSupabaseSnapshotSink(cfg: Pick<CapacitySnapshotConfig, "supabaseUrl" | "serviceKey" | "timeoutMs">, fetchImpl: typeof fetch = globalThis.fetch): SnapshotSink {
  const endpoint = `${cfg.supabaseUrl.replace(/\/+$/, "")}/rest/v1/market_capacity_snapshots`;
  return {
    async insert(rows) {
      if (rows.length === 0) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            apikey: cfg.serviceKey,
            authorization: `Bearer ${cfg.serviceKey}`,
            prefer: "return=minimal,resolution=ignore-duplicates",
          },
          body: JSON.stringify(rows),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`supabase insert HTTP ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── Snapshotter ───────────────────────────────────────────────────────────────

export type SnapshotReadConnection = SnapshotConnection & Pick<Connection, "getMultipleAccountsInfo">;

export interface SnapshotterDeps {
  conn: SnapshotReadConnection;
  programId: PublicKey;
  markets: () => ReadonlyArray<MarketRef>;
  sink: SnapshotSink;
  now?: () => number;
  log?: (line: string) => void;
}

export interface SnapshotterStats {
  ticks: number;
  rowsWritten: number;
  skippedLegacy: number;
  decodeFailures: number;
  sinkFailures: number;
  lastOkMs: number | null;
}

export class CapacitySnapshotter {
  readonly stats: SnapshotterStats = { ticks: 0, rowsWritten: 0, skippedLegacy: 0, decodeFailures: 0, sinkFailures: 0, lastOkMs: null };
  private lastRunMs = 0;
  private inflight = false;

  constructor(
    private readonly cfg: Pick<CapacitySnapshotConfig, "enabled" | "intervalMs">,
    private readonly deps: SnapshotterDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One pass if due. Returns rows written. Never throws; zero RPC and zero fetch while disabled. */
  async tick(): Promise<number> {
    if (!this.cfg.enabled) return 0;
    const t = this.now();
    if (this.inflight || (this.lastRunMs !== 0 && t - this.lastRunMs < this.cfg.intervalMs)) return 0;
    this.inflight = true;
    this.lastRunMs = t;
    this.stats.ticks++;
    const log = this.deps.log ?? ((l: string) => console.warn(l));
    try {
      const refs = this.deps.markets();
      if (refs.length === 0) return 0;
      const snaps = await readVaultMarketSnapshots(this.deps.conn, this.deps.programId, refs);
      const growthSnaps: VaultMarketSnapshot[] = [];
      for (const s of snaps.values()) {
        let hasGrowth = false;
        try {
          hasGrowth = s.bound && s.vaultLp !== null && s.marketData !== null && decodeAssetGrowthV19(s.marketData, s.ref.assetIndex) !== null;
        } catch {
          this.stats.decodeFailures++;
        }
        if (hasGrowth) growthSnaps.push(s);
        else this.stats.skippedLegacy++;
      }
      if (growthSnaps.length === 0) return 0;
      // second batched read: vault_lp_state, VaultLpExtV19 and the LP portfolio of each growth market
      const keys: PublicKey[] = [];
      for (const s of growthSnaps) {
        keys.push(deriveVaultLpStatePda(this.deps.programId, s.market), deriveVaultLpExtP2b(this.deps.programId, s.market)[0], (s.vaultLp as NonNullable<typeof s.vaultLp>).lpPortfolio);
      }
      const infos: Array<{ data: Buffer } | null> = [];
      for (let k = 0; k < keys.length; k += 99) {
        infos.push(...((await this.deps.conn.getMultipleAccountsInfo(keys.slice(k, k + 99), "confirmed")) as Array<{ data: Buffer } | null>));
      }
      const rows: CapacitySnapshotRow[] = [];
      growthSnaps.forEach((s, idx) => {
        try {
          const st = infos[3 * idx];
          const ext = infos[3 * idx + 1];
          const port = infos[3 * idx + 2];
          if (!st || !port) return;
          const row = buildCapacityRow({
            snapshot: s,
            vaultLpStateData: new Uint8Array(st.data),
            vaultLpExtData: ext ? new Uint8Array(ext.data) : null,
            lpPortfolioData: new Uint8Array(port.data),
            nowMs: t,
          });
          if (row) rows.push(row);
        } catch {
          this.stats.decodeFailures++;
        }
      });
      if (rows.length === 0) return 0;
      try {
        await this.deps.sink.insert(rows);
        this.stats.rowsWritten += rows.length;
        this.stats.lastOkMs = t;
        return rows.length;
      } catch (err) {
        this.stats.sinkFailures++;
        log(`[capacity] snapshot write failed: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
        return 0;
      }
    } catch (err) {
      this.stats.sinkFailures++;
      log(`[capacity] tick error: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
      return 0;
    } finally {
      this.inflight = false;
    }
  }
}

/** The long-running loop. Never awaited by the entrypoint, never throws out. */
export async function startCapacitySnapshotLoop(s: CapacitySnapshotter, cfg: Pick<CapacitySnapshotConfig, "intervalMs">): Promise<void> {
  console.log(`[capacity] snapshot loop starting: every ${cfg.intervalMs} ms (growth markets only)`);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    await s.tick();
    await new Promise((r) => setTimeout(r, Math.min(cfg.intervalMs, 30_000)));
  }
}
