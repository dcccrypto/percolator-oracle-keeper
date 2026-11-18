/**
 * F2 (LP audit 4.6): the SECOND, INDEPENDENT price pusher.
 *
 * One keeper outage must not let every v2.2 market go stale and become permissionlessly resolvable (18,000 slots). This role
 * is the keeper's push loop and nothing else: no cranks, no liquidations, no Earn / fee / stake jobs (src/pusher.ts). It runs on
 * its own process, host and RPC endpoint, and BACKS OFF while the primary is healthy.
 *
 * Back-off: a market is on STANDBY while `estimatedClusterSlot - last_good_oracle_slot < takeoverSlots` (the primary, or anyone, pushed
 * recently). Only once the on-chain price is older than `takeoverSlots` does this pusher push (a TAKEOVER). A takeover push moves
 * last_good_oracle_slot, so against a dead primary it pushes about once per `takeoverSlots`, which is all the safety goal needs
 * (the resolve window is 18,000 slots); against a live primary it never pushes. Unknown or stale state = push (fail OPEN: the
 * point of this process is liveness, and a duplicate is harmless).
 *
 * Duplicate pushes are harmless: PushAuthMark's observation_sequence is a strictly-increasing nonce (`proposed <= current` ->
 * Custom(19) EngineStale, a plain revert that changes nothing). Both pushers read the on-chain watermark and propose
 * watermark + 1, so when they race, one lands and the other reverts in PREFLIGHT; the pusher's push path answers 19 by re-reading
 * the nonce and retrying once (no quarantine strike), and the primary does the same. Neither can corrupt the other's state.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { Alert } from "./alerting.ts";
import { MAX_ACCOUNTS_PER_RPC } from "./rpc-chunk.ts";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";

const SLOT_MS = 400;
const LAST_GOOD_SLOT_OFF = 16 + 152; // WrapperConfigV16 @ header 16; last_good_oracle_slot @ +152
const SLICE_LEN = LAST_GOOD_SLOT_OFF + 8;
/** AssetOracleProfileV16.last_good_oracle_slot, relative to the asset's wrapper slot (prog v16_program.rs:1534; SDK parseAssetOracleProfileV17 b+216). */
const PROFILE_LAST_GOOD_OFF = 216;

/** Gate key of one asset's clock: the bare market address for asset 0 (the config clock), `<market>#<k>` for k > 0. */
function clockKey(market: string, assetIndex: number): string {
  return assetIndex > 0 ? `${market}#${assetIndex}` : market;
}

export interface PusherConfig {
  /** Push only when the on-chain price is at least this many slots old. */
  takeoverSlots: bigint;
  /** How often the on-chain state is re-read. */
  refreshMs: number;
  /** State older than this is treated as unknown (-> push). */
  staleStateMs: number;
  /** A takeover alert stays active this long after the last takeover push. */
  alertHoldMs: number;
}

export const DEFAULT_PUSHER_CONFIG: PusherConfig = { takeoverSlots: 60n, refreshMs: 2_000, staleStateMs: 30_000, alertHoldMs: 120_000 };

type Env = Readonly<Record<string, string | undefined>>;
function envPosInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}="${raw}" must be a positive integer`);
  return n;
}

/** PUSHER_TAKEOVER_SLOTS (60), PUSHER_REFRESH_MS (2000), PUSHER_STALE_STATE_MS (30000), PUSHER_ALERT_HOLD_MS (120000). Throws on garbage. */
export function pusherConfigFromEnv(env: Env): PusherConfig {
  return {
    takeoverSlots: BigInt(envPosInt(env, "PUSHER_TAKEOVER_SLOTS", Number(DEFAULT_PUSHER_CONFIG.takeoverSlots))),
    refreshMs: envPosInt(env, "PUSHER_REFRESH_MS", DEFAULT_PUSHER_CONFIG.refreshMs),
    staleStateMs: envPosInt(env, "PUSHER_STALE_STATE_MS", DEFAULT_PUSHER_CONFIG.staleStateMs),
    alertHoldMs: envPosInt(env, "PUSHER_ALERT_HOLD_MS", DEFAULT_PUSHER_CONFIG.alertHoldMs),
  };
}

/**
 * The pusher must not share the primary's RPC endpoint (a shared provider outage would take both down). `primary` is the
 * primary keeper's devnet endpoint, supplied as PUSHER_PRIMARY_DEVNET_RPC_URL. Returns a fatal message, or null when fine.
 * Compared on host + api-key query so two keys on the same host count as different endpoints, a copied URL does not.
 */
export function rpcEndpointProblem(own: string | undefined, primary: string | undefined): string | null {
  if (!own) return "DEVNET_RPC_URL is required";
  if (!primary) return null;
  const norm = (u: string): string => {
    try {
      const x = new URL(u);
      return `${x.host}${x.pathname}?${x.searchParams.get("api-key") ?? ""}`;
    } catch {
      return u.trim();
    }
  };
  return norm(own) === norm(primary)
    ? "DEVNET_RPC_URL equals PUSHER_PRIMARY_DEVNET_RPC_URL: the second pusher must use its OWN RPC endpoint"
    : null;
}

interface MarketState {
  lastGood: bigint;
  clusterSlot: bigint;
  at: number;
}

export interface TakeoverView {
  standby: boolean;
  gapSlots: string | null;
  lastGoodSlot: string | null;
  takeoverPushes: number;
  lastTakeoverAgoMs: number | null;
}

export class TakeoverGate {
  private readonly state = new Map<string, MarketState>();
  private readonly takeoverAt = new Map<string, number>();
  private readonly takeoverCount = new Map<string, number>();
  private readonly labels = new Map<string, string>();

  constructor(private readonly cfg: PusherConfig, private readonly now: () => number = Date.now) {}

  /**
   * `assetIndex` 0 = the market-wide config clock; k > 0 = that asset's own profile clock. PushAuthMark advances
   * `profile.last_good_oracle_slot` for the pushed asset only and `config.last_good_oracle_slot` for asset 0 only
   * (prog v16_program.rs:16669-16676, #379), while permissionless resolve matures on "global OR per-asset profile"
   * (global_or_profile_resolve_matured_at_slot, :7253-7263). Asset k's standby must follow asset k's clock.
   */
  update(market: string, lastGood: bigint, clusterSlot: bigint, atMs = this.now(), assetIndex = 0): void {
    this.state.set(clockKey(market, assetIndex), { lastGood, clusterSlot, at: atMs });
  }
  setLabel(market: string, label: string): void {
    this.labels.set(market, label);
  }

  /** Slots since the on-chain price was last good, or null when unknown / stale. */
  gapSlots(market: string, nowMs = this.now(), assetIndex = 0): bigint | null {
    const s = this.state.get(clockKey(market, assetIndex));
    // A negative age means the wall clock stepped back since the read: the elapsed time is unknowable, so the state is
    // unknown (-> push), not "fresh until the clock catches up".
    if (!s || nowMs < s.at || nowMs - s.at > this.cfg.staleStateMs) return null;
    const est = s.clusterSlot + BigInt(Math.max(0, Math.floor((nowMs - s.at) / SLOT_MS)));
    return est > s.lastGood ? est - s.lastGood : 0n;
  }

  /** True while the primary is healthy for this market: do NOT push. Unknown = false (push). */
  isStandby(market: string, nowMs = this.now(), assetIndex = 0): boolean {
    const g = this.gapSlots(market, nowMs, assetIndex);
    return g !== null && g < this.cfg.takeoverSlots;
  }

  /** A push landed from this role. It is a takeover push when the gate was open (always, since standby markets never push). */
  recordPush(market: string, nowMs = this.now()): void {
    this.takeoverAt.set(market, nowMs);
    this.takeoverCount.set(market, (this.takeoverCount.get(market) ?? 0) + 1);
  }

  /** Active "this pusher is keeping the market alive" alerts (the paging hook). */
  activeAlerts(nowMs = this.now()): Alert[] {
    const out: Alert[] = [];
    for (const [market, at] of this.takeoverAt) {
      if (nowMs - at > this.cfg.alertHoldMs) continue;
      const label = this.labels.get(market) ?? market;
      out.push({
        kind: "pusher-takeover",
        severity: "critical",
        subject: label,
        message:
          `the second pusher is the one keeping ${label} alive: the on-chain price was older than ${this.cfg.takeoverSlots} slots, ` +
          `so the primary keeper is NOT pushing this market (${this.takeoverCount.get(market) ?? 0} takeover push(es) since boot). Check the primary keeper.`,
        data: { market, takeoverPushes: this.takeoverCount.get(market) ?? 0 },
      });
    }
    return out;
  }

  health(markets: readonly string[], nowMs = this.now()): Record<string, TakeoverView> {
    const out: Record<string, TakeoverView> = {};
    for (const m of markets) {
      const s = this.state.get(m);
      const g = this.gapSlots(m, nowMs);
      const at = this.takeoverAt.get(m);
      out[m] = {
        standby: this.isStandby(m, nowMs),
        gapSlots: g === null ? null : g.toString(),
        lastGoodSlot: s ? s.lastGood.toString() : null,
        takeoverPushes: this.takeoverCount.get(m) ?? 0,
        lastTakeoverAgoMs: at === undefined ? null : nowMs - at,
      };
    }
    return out;
  }
}

type SliceInfo = { data: Buffer } | null;
type SliceRead = (keys: PublicKey[], cfg: unknown) => Promise<SliceInfo[]>;

/**
 * `getMultipleAccountsInfo` with a data slice, at most MAX_ACCOUNTS_PER_RPC keys per call (the RPC rejects more and web3.js does
 * not chunk). A chunk that throws or comes back short is isolated: its keys are `undefined` (unknown -> push), the rest are kept.
 * (rpc-chunk.ts's helper cannot take a dataSlice, and would pull whole accounts.)
 */
async function readSlices(
  conn: Pick<Connection, "getMultipleAccountsInfo">,
  keys: readonly PublicKey[],
  dataSlice: { offset: number; length: number },
): Promise<Array<SliceInfo | undefined>> {
  const out: Array<SliceInfo | undefined> = new Array(keys.length).fill(undefined);
  const read = conn.getMultipleAccountsInfo as unknown as SliceRead;
  const starts: number[] = [];
  for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_RPC) starts.push(i);
  await Promise.all(
    starts.map(async (start) => {
      const chunk = keys.slice(start, start + MAX_ACCOUNTS_PER_RPC);
      try {
        const got = await read([...chunk], { commitment: "confirmed", dataSlice });
        if (got.length !== chunk.length) return;
        got.forEach((g, j) => (out[start + j] = g));
      } catch {
        // this chunk stays unknown -> fail open for its markets only
      }
    }),
  );
  return out;
}

/**
 * Read cluster slot + each market's `last_good_oracle_slot` (a 176-byte slice per market: header + config up to the field) into the
 * gate. `assetsByMarket` lists the asset indices k > 0 this pusher pushes per market; each one's own profile clock is read too
 * (an 8-byte slice at that asset's slot, VERSION-aware). A market whose header does not look like a wrapper market, or whose read
 * fails, is left without fresh state (-> push). Reads are chunked at 100 keys. Never throws.
 */
export async function refreshTakeoverGate(
  conn: Pick<Connection, "getSlot" | "getMultipleAccountsInfo">,
  gate: TakeoverGate,
  markets: readonly string[],
  nowMs: number = Date.now(),
  assetsByMarket: ReadonlyMap<string, readonly number[]> = new Map(),
): Promise<void> {
  try {
    if (markets.length === 0) return;
    const keys = markets.map((m) => new PublicKey(m));
    // dataSlice keeps this to ~176 bytes per market instead of the whole account
    const [slot, infos] = await Promise.all([
      conn.getSlot("confirmed"),
      readSlices(conn, keys, { offset: 0, length: SLICE_LEN }),
    ]);
    const clusterSlot = BigInt(slot);
    // asset clock reads, grouped by byte offset (VERSION decides geometry) so each group is one chunked call
    const byOffset = new Map<number, Array<{ market: string; asset: number }>>();
    infos.forEach((info, i) => {
      if (!info || info.data.length < SLICE_LEN) return;
      const d = info.data;
      gate.update(markets[i], d.readBigUInt64LE(LAST_GOOD_SLOT_OFF), clusterSlot, nowMs);
      const geo = selectMarketGroupOffset(d);
      if (!geo.ok) return;
      for (const asset of assetsByMarket.get(markets[i]) ?? []) {
        if (asset <= 0) continue;
        const off = assetSlotOffset(geo, asset) + PROFILE_LAST_GOOD_OFF;
        const list = byOffset.get(off) ?? [];
        list.push({ market: markets[i], asset });
        byOffset.set(off, list);
      }
    });
    await Promise.all(
      [...byOffset].map(async ([offset, rows]) => {
        const got = await readSlices(conn, rows.map((r) => new PublicKey(r.market)), { offset, length: 8 });
        got.forEach((g, j) => {
          if (!g || g.data.length < 8) return;
          gate.update(rows[j].market, g.data.readBigUInt64LE(0), clusterSlot, nowMs, rows[j].asset);
        });
      }),
    );
  } catch {
    // leave the old state to age out -> fail open
  }
}
