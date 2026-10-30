/**
 * cross-cluster/rpc-failover.ts — ordered RPC fallback for the keeper's `Connection`s.
 *
 * WHY: on 2026-10-17 the v2.2 keeper's single Helius key hit "max usage reached" (HTTP 429). Every call failed,
 * the launcher's preflight exited 1, and launchd crash-looped ~486 times. One exhausted endpoint must degrade
 * the keeper, not kill it.
 *
 * HOW: web3.js funnels every request (reads, simulate, sendRawTransaction, confirmation polling) through the
 * `fetch` given to `new Connection(url, { fetch })`. `createRpcFailover(...).fetch` is such a fetch: it rewrites
 * the request URL to the currently active endpoint and fails over down an ordered list on 429 / "max usage
 * reached" / 500 / 502-504 / repeated network errors. Because it sits at that seam it covers reads AND sends, and any
 * Connection built with it (the keeper's, the pusher's, the preflight's).
 *
 * SAFETY, per endpoint, before it is ever used (and again after each outage):
 *  - cluster: `getGenesisHash` must equal the expected genesis for the cluster. A mismatching endpoint is
 *    REFUSED for the life of the process (a devnet keeper must never push through a mainnet fallback).
 *  - freshness: `getSlot` is compared with the best recently seen slot across endpoints (projected forward by
 *    elapsed time). An endpoint lagging more than `maxSlotLag` (default 50) is treated as down. Re-checked
 *    every `slotCheckIntervalMs` while in use.
 *  - plausibility: a slot above what the chain can have reached since the anchor is suspect-ahead. The chain's speed is
 *    MEASURED (`getRecentPerformanceSamples`, chain-reported so the keeper's clock plays no part) from the two endpoints
 *    that corroborate the baseline; until then, or with no corroborating peer, it is bounded by `slotsPerSecond`
 *    (default 5, env `RPC_SLOTS_PER_SECOND`). On 2026-10-29 devnet ran ~4.2 slots/s against a hard-coded 2.5 and the
 *    guard locked out every honest endpoint ~80 s after boot. If two genesis-verified endpoints AGREE above the ceiling,
 *    the ceiling is what was wrong: it is re-anchored, the rate re-measured, and an [ALERT] logged.
 *  - blockhash freshness: a `getLatestBlockhash` reply whose own `context.slot` is more than `maxBlockhashLag`
 *    (default 75) behind the best known slot is NOT handed out. On 2026-10-29 17:49Z Helius devnet (every key)
 *    served one frozen blockhash ~3,800 slots old while its getSlot was current: HTTP 200, so nothing failed over,
 *    and every push / crank / fee tx was signed with a dead blockhash and dropped. That endpoint is skipped for
 *    blockhash requests only (its reads and sends stay where they are) on an exponential cooldown, re-tried after
 *    it, and `/health` says `rpc-degraded` / `stale-blockhash` meanwhile. No fresh blockhash anywhere = a
 *    `rpc-degraded` error, never a dead blockhash.
 *
 * RECOVERY: the primary is re-probed in the background (exponential cooldown, `primaryRetryMs` floor) and
 * becomes active again as soon as it passes the same checks.
 *
 * ALL DOWN: calls fail fast (no hammering) while each endpoint sits in a capped exponential cooldown; state is
 * logged loudly on transitions and `/health` reports `rpc-degraded` with the active endpoint.
 *
 * WEBSOCKETS: only `fetch` is wrapped. web3.js derives its websocket endpoint from the primary URL, so signature
 * subscriptions (confirmTransaction's default path) do not fail over. So the keeper does not use them: confirmation is
 * tx-confirm.ts confirmBySignature, getSignatureStatuses + getBlockHeight polling through this seam, pinned to the
 * sending endpoint (A7-1: it used to wait inside confirmTransaction, gated on the primary's websocket). A new
 * confirmTransaction / on*Change user must poll instead (only the uncalled pushAuthMark still calls confirmTransaction).
 *
 * SECRETS: endpoint URLs carry API keys (query string or path token). Nothing here logs or exposes a raw URL;
 * everything goes through `redactUrl` / `redactText`.
 */

import { createHash } from "node:crypto";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Public devnet. Rate limited, but always up and free: a degraded keeper beats a dead one. */
export const DEFAULT_DEVNET_FALLBACKS: readonly string[] = ["https://api.devnet.solana.com"];


/**
 * DEVNET_RPC_FALLBACK_URLS: comma-separated https URLs (http only for localhost). Unset = the public devnet
 * endpoint; `off` / `none` = no fallback (the old behaviour). Throws on a malformed entry so a typo fails
 * at boot, not during an outage.
 */
export function parseFallbackUrls(raw: string | undefined, dflt: readonly string[] = DEFAULT_DEVNET_FALLBACKS): string[] {
  const v = raw?.trim();
  if (v === undefined || v === "") return [...dflt];
  if (v === "off" || v === "none") return [];
  const out: string[] = [];
  for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error("RPC fallback URL list contains an entry that is not a URL (value withheld: it may carry a key)");
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
      throw new Error("RPC fallback URLs must be https (http only for localhost)");
    }
    out.push(part);
  }
  return out;
}


export const GENESIS_HASH = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;
/** Ceilings allow 15% over the chain's (measured) speed. (R153 round 4: 1.5x left 1.25 slots/s of slack.) */
export const HEADROOM = 1.15;
/**
 * Upper bound on chain speed used for the plausibility ceiling until the speed is measured (and the most a single,
 * uncorroborated rate report may claim). Devnet measured 4.1-4.2 slots/s on 2026-10-29; mainnet runs ~2.5.
 */
export const DEFAULT_MAX_SLOTS_PER_SECOND = 5;
/**
 * Solana's target speed (400 ms slots). Used ONLY to project an observation forward before the speed is measured.
 * Under-projecting is the lenient direction (a lag check loosens by seconds); over-projecting would make honest
 * endpoints and blockhashes look stale, so the upper bound is never used for projection.
 */
export const NOMINAL_SLOTS_PER_SECOND = 2.5;
/** Sanity cap on a corroborated measurement. */
const MAX_MEASURED_SLOTS_PER_SECOND = 50;
/** Two endpoints' rate reports corroborate each other when within this fraction of the larger. */
const RATE_AGREEMENT = 0.2;

export type FailoverCluster = keyof typeof GENESIS_HASH;

// ── secret redaction ─────────────────────────────────────────────────────────

const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_\-.~%]{16,}$/;

/** `https://host/path?api-key=SECRET` -> `https://host/path?***`; long path tokens become `***`. Never throws. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const p = u.pathname
      .split("/")
      .map((seg) => (TOKEN_SEGMENT_RE.test(seg) ? "***" : seg))
      .join("/");
    return `${u.protocol}//${u.host}${p === "/" ? "" : p}${u.search ? "?***" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

/** Scrub free text (error messages): every known endpoint URL/secret, any URL, any `api-key=`-style param. */
export function redactText(text: string, knownUrls: readonly string[] = []): string {
  let out = text;
  for (const raw of knownUrls) {
    out = out.split(raw).join(redactUrl(raw));
    try {
      const u = new URL(raw);
      for (const v of u.searchParams.values()) if (v.length >= 6) out = out.split(v).join("***");
      for (const seg of u.pathname.split("/")) if (TOKEN_SEGMENT_RE.test(seg)) out = out.split(seg).join("***");
    } catch {
      /* not a URL: nothing further to scrub */
    }
  }
  // ws(s) too: web3.js derives its websocket endpoint (same host, same path key) from the RPC URL.
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>),]+/gi, (m) => redactUrl(m));
  // A scheme-less `host.tld/<long token>` (some HTTP clients print the target without its scheme).
  out = out.replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?)\/[^\s"'<>),]*[A-Za-z0-9_-]{16,}[^\s"'<>),]*/gi, "$1/***");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer ***");
  out = out.replace(/\b(x-api-key|api-key|authorization|x-auth-token)\s*:\s*[^\s"',;)]+(?:\s+[^\s"',;)]+)?/gi, "$1: ***");
  out = out.replace(/((?:api[-_]?key|apikey|token|secret|key|password|passwd|pwd)=)[^&\s"']+/gi, "$1***");
  return out;
}

// ── failover core ────────────────────────────────────────────────────────────

export interface RpcFailoverOptions {
  cluster: FailoverCluster;
  /** Ordered: [0] is the primary. */
  urls: readonly string[];
  /** The real transport (default global fetch). Wrap with countingFetch so every attempt is counted. */
  base?: FetchLike;
  now?: () => number;
  /** Override for tests / other clusters; defaults to GENESIS_HASH[cluster]. */
  expectedGenesis?: string;
  maxSlotLag?: number; // default 50
  /** A getLatestBlockhash reply served more than this many slots behind the best known slot is refused. Default 75
   *  (a blockhash lives ~150 blocks; this keeps at least half of that, and admits a normal `finalized` lag). */
  maxBlockhashLag?: number;
  slotCheckIntervalMs?: number; // default 10_000
  primaryRetryMs?: number; // default 30_000
  backoffBaseMs?: number; // default 2_000
  backoffMaxMs?: number; // default 300_000
  /** Consecutive network errors / 5xx before an endpoint is marked down. Default 3. */
  networkErrorThreshold?: number;
  probeTimeoutMs?: number; // default 5_000
  /** Upper bound on chain speed (slots/s) until it is measured; also caps an uncorroborated rate report. Default 5. */
  slotsPerSecond?: number;
  /** Re-measure the chain speed at the next agreement of two endpoints once the measurement is this old. Default 600_000. */
  rateRefreshMs?: number;
  /** How long after a send the sending endpoint is preferred for status/confirmation polls (F4). Default 60_000. */
  pinMs?: number;
  /** If every endpoint has been rejected (lagging or suspect-ahead) for this long and they agree with each other, re-seed the floor. Default 300_000. */
  floorReseedMs?: number;
  /** Log an [ALERT] once all endpoints have been down this long (and every 5 min after). Default 120_000. */
  allDownAlertMs?: number;
  /** Max tolerated keeper clock error (s) before block-time checks are disabled. Default 10. */
  clockSkewAllowanceSec?: number;
  log?: (line: string) => void;
}

type EpState = "ok" | "down" | "refused";

interface Endpoint {
  idx: number;
  url: string;
  label: string; // redacted
  verified: boolean; // genesis checked since last outage
  /** Freshness established against a baseline (floor slot / other endpoint / block time). Writes need it (F1). */
  confirmed: boolean;
  /** Genesis matched the expected cluster. Permanent. No slot from an endpoint reaches the floor before this. */
  genesisOk: boolean;
  /** Last vet reported a slot implausibly far ahead of the floor. */
  suspectAhead: boolean;
  /** Overturned the floor on its own block time: unconfirmed for sends until a peer agrees (R153 round 5). */
  needsAgreement: boolean;
  /** Since when this endpoint has been consecutively rejected as lagging (null otherwise). */
  laggingSince: number | null;
  /** Last raw reply of a genesis-verified endpoint, kept OUT of every comparison except the escape hatch. */
  rawSlot: number | null;
  rawAt: number;
  refused: boolean; // wrong cluster, permanent
  consecutiveFailures: number;
  backoffExp: number;
  downUntil: number;
  lastError: string | null;
  slot: number | null;
  slotAt: number;
  lastVetAt: number;
  vetting: Promise<boolean> | null;
  /** Stale-blockhash state (see the header): skip for getLatestBlockhash until this time. */
  bhStale: boolean;
  bhStaleUntil: number;
  bhBackoffExp: number;
  bhLag: number | null;
}

export interface RpcFailoverSnapshot {
  cluster: FailoverCluster;
  status: "ok" | "rpc-degraded";
  reason: "primary-active" | "on-fallback" | "all-endpoints-down" | "stale-blockhash";
  active: string; // redacted
  activeIndex: number;
  endpoints: Array<{
    index: number;
    url: string; // redacted
    suspectAhead: boolean;
    confirmed: boolean; // freshness established; unconfirmed endpoints serve reads only
    state: EpState;
    consecutiveFailures: number;
    downForMs: number;
    lastError: string | null;
    slot: number | null;
    slotLag: number | null;
    /** Its last getLatestBlockhash reply was stale; skipped for blockhashes until `blockhashRetryInMs`. */
    blockhashStale: boolean;
    blockhashRetryInMs: number;
    blockhashLagSlots: number | null;
  }>;
  floorSlot: number | null; // highest accepted slot (public chain data)
  /** Chain speed in slots/s: measured (null until then), the configured bound, and the ceiling's rate (with HEADROOM). */
  slotRate: { measured: number | null; corroborated: boolean; bound: number; ceiling: number; measuredAgoMs: number | null };
  switches: number;
  lastSwitchAt: string | null;
}

export class RpcFailover {
  private readonly eps: Endpoint[];
  private readonly base: FetchLike;
  private readonly now: () => number;
  private readonly cfg: Required<
    Pick<
      RpcFailoverOptions,
      | "maxSlotLag"
      | "maxBlockhashLag"
      | "slotCheckIntervalMs"
      | "primaryRetryMs"
      | "backoffBaseMs"
      | "backoffMaxMs"
      | "networkErrorThreshold"
      | "probeTimeoutMs"
      | "slotsPerSecond"
      | "rateRefreshMs"
      | "pinMs"
      | "floorReseedMs"
      | "allDownAlertMs"
      | "clockSkewAllowanceSec"
    >
  >;
  private readonly expectedGenesis: string;
  private readonly cluster: FailoverCluster;
  private readonly log: (line: string) => void;
  private readonly urls: readonly string[];
  private active = 0;
  private switches = 0;
  private lastSwitchAt: number | null = null;
  private lastPrimaryProbeAt = 0;
  private allDownLoggedAt = 0;
  private rpcId = 1;
  /** Highest slot ever observed on any endpoint. Never expires, never projected: the chain only moves forward. */
  private floorSlot: number | null = null;
  /** N1: the plausibility line is anchored HERE, set at first corroboration or a hatch reseed, never by a raise. */
  /** Was the current floor corroborated by two agreeing genesis-verified endpoints (vs raised by a sole live one)? */
  private floorCorroborated = false;
  private floorSource: number | null = null;
  private primaryAlertAt = 0;
  /** Keeper wall-clock error vs the chain, measured once from an endpoint that agrees with a peer (both at head). */
  private skewSec = 0;
  private skewMeasured = false;
  /** |skew| beyond the allowance: every block-time path is switched off (loudly). */
  private blockTimeDisabled = false;
  private anchor: { slot: number; at: number } | null = null;
  private allDownSince: number | null = null;
  private allDownAlertedAt = 0;
  private pin: { idx: number; until: number } | null = null;
  /** Chain speed (slots/s) from getRecentPerformanceSamples; null until measured. */
  private measuredRate: number | null = null;
  /** Measured from two agreeing endpoints (may exceed the bound) or from one (capped at the bound). */
  private rateCorroborated = false;
  private rateAt = 0;
  private aboveCeilingAlertAt = 0;

  constructor(opts: RpcFailoverOptions) {
    if (opts.urls.length === 0) throw new Error("RpcFailover: at least one endpoint URL is required");
    this.cluster = opts.cluster;
    this.urls = [...opts.urls];
    this.base = opts.base ?? ((i, init) => fetch(i, init));
    this.now = opts.now ?? Date.now;
    this.expectedGenesis = opts.expectedGenesis ?? GENESIS_HASH[opts.cluster];
    this.cfg = {
      maxSlotLag: opts.maxSlotLag ?? 50,
      maxBlockhashLag: opts.maxBlockhashLag ?? 75,
      slotCheckIntervalMs: opts.slotCheckIntervalMs ?? 10_000,
      primaryRetryMs: opts.primaryRetryMs ?? 30_000,
      backoffBaseMs: opts.backoffBaseMs ?? 2_000,
      backoffMaxMs: opts.backoffMaxMs ?? 300_000,
      networkErrorThreshold: opts.networkErrorThreshold ?? 3,
      probeTimeoutMs: opts.probeTimeoutMs ?? 5_000,
      slotsPerSecond: opts.slotsPerSecond ?? DEFAULT_MAX_SLOTS_PER_SECOND,
      rateRefreshMs: opts.rateRefreshMs ?? 600_000,
      pinMs: opts.pinMs ?? 60_000,
      floorReseedMs: opts.floorReseedMs ?? 300_000,
      allDownAlertMs: opts.allDownAlertMs ?? 120_000,
      clockSkewAllowanceSec: opts.clockSkewAllowanceSec ?? 10,
    };
    this.log = opts.log ?? ((l) => console.error(l));
    this.eps = opts.urls.map((url, idx) => ({
      idx,
      url,
      label: redactUrl(url),
      // EVERY endpoint (primary included) is vetted (genesis + slot) before first use.
      verified: false,
      confirmed: false,
      genesisOk: false,
      suspectAhead: false,
      needsAgreement: false,
      laggingSince: null,
      rawSlot: null,
      rawAt: 0,
      refused: false,
      consecutiveFailures: 0,
      backoffExp: 0,
      downUntil: 0,
      lastError: null,
      slot: null,
      slotAt: 0,
      lastVetAt: 0,
      vetting: null,
      bhStale: false,
      bhStaleUntil: 0,
      bhBackoffExp: 0,
      bhLag: null,
    }));
  }

  /** Speed for the plausibility ceiling (before HEADROOM): measured, else the configured bound. */
  private ceilRate(): number {
    return this.measuredRate ?? this.cfg.slotsPerSecond;
  }

  /** Speed for projecting an observation forward: measured, else the nominal speed (never the upper bound). */
  private projRate(): number {
    return this.measuredRate ?? Math.min(this.cfg.slotsPerSecond, NOMINAL_SLOTS_PER_SECOND);
  }

  /** Pass as `new Connection(primaryUrl, { fetch: failover.fetch })`. */
  readonly fetch: FetchLike = (input, init) => this.doFetch(input, init);

  // ── helpers ───────────────────────────────────────────────────────────────

  private scrub(msg: string): string {
    return redactText(msg, this.urls);
  }

  private logLine(msg: string): void {
    this.log(`[rpc-failover:${this.cluster}] ${this.scrub(msg)}`);
  }

  private cooldown(ep: Endpoint): number {
    return Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** ep.backoffExp);
  }

  private markDown(ep: Endpoint, reason: string): void {
    const t = this.now();
    const wait = this.cooldown(ep);
    ep.backoffExp = Math.min(ep.backoffExp + 1, 30);
    ep.downUntil = t + wait;
    ep.verified = false; // re-vet (genesis + slot) before reuse
    ep.lastError = this.scrub(reason);
    this.logLine(`endpoint #${ep.idx} ${ep.label} DOWN (${ep.lastError}); retry in ${Math.round(wait / 1000)}s`);
  }

  private markGood(ep: Endpoint): void {
    ep.consecutiveFailures = 0;
    ep.backoffExp = 0;
    ep.downUntil = 0;
    ep.lastError = null;
  }

  private setActive(ep: Endpoint, why: string): void {
    if (this.active === ep.idx) return;
    const from = this.eps[this.active];
    this.active = ep.idx;
    this.switches++;
    this.lastSwitchAt = this.now();
    this.logLine(`ACTIVE ENDPOINT ${from.label} -> #${ep.idx} ${ep.label} (${why})`);
  }

  /** Recent (<60 s) observations of the other genesis-verified endpoints, projected to now. */
  private recentOthers(except: Endpoint): number[] {
    const t = this.now();
    const out: number[] = [];
    for (const o of this.eps) {
      if (o === except || o.slot === null || o.refused || !o.genesisOk) continue;
      const age = t - o.slotAt;
      if (age > 60_000) continue;
      out.push(o.slot + Math.floor((age / 1000) * this.projRate()));
    }
    return out;
  }

  private async rpc(ep: Endpoint, method: string, params?: unknown[]): Promise<{ status: number; result?: unknown; err?: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.probeTimeoutMs);
    try {
      const res = await this.base(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.rpcId++, method, params: params ?? (method === "getSlot" ? [{ commitment: "confirmed" }] : []) }),
        signal: ctl.signal,
      });
      if (res.status !== 200) {
        let body = "";
        try {
          body = (await res.text()).slice(0, 120);
        } catch {
          /* ignore */
        }
        return { status: res.status, err: `HTTP ${res.status} ${body}`.trim() };
      }
      const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) return { status: 200, err: `rpc error: ${j.error.message ?? "unknown"}` };
      return { status: 200, result: j.result };
    } catch (e) {
      return { status: 0, err: `network: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Genesis (once per outage) + slot-freshness check. Resolves true when the endpoint may carry traffic. */
  private vet(ep: Endpoint): Promise<boolean> {
    if (ep.vetting) return ep.vetting;
    ep.vetting = this.doVet(ep).finally(() => {
      ep.vetting = null;
    });
    return ep.vetting;
  }

  /** Record an ACCEPTED slot (genesis-verified, plausible). Only here may the floor move. */
  private accept(ep: Endpoint, slot: number): void {
    const t = this.now();
    ep.slot = slot;
    ep.slotAt = t;
    if (this.floorSlot === null) this.anchor = { slot, at: t };
    if (this.floorSlot === null || slot > this.floorSlot) this.floorSlot = slot; // raises do NOT move the anchor
  }

  /**
   * Highest slot any reply may show now: a FIXED line from the anchor (slot, time) at the chain's measured speed with
   * HEADROOM, plus 2x the lag bound. Because accepted raises never move the anchor, a lying endpoint cannot creep the
   * floor upward vet by vet: the most it can ever add is this line's own slack (100 slots + 15% of the chain's speed).
   */
  private floorCeiling(): number | null {
    if (this.anchor === null) return null;
    return this.anchor.slot + ((this.now() - this.anchor.at) / 1000) * this.ceilRate() * HEADROOM + 2 * this.cfg.maxSlotLag;
  }

  /** One endpoint's own report of the chain's speed: slots per second over its last five ~60 s samples. */
  private async reportedRate(ep: Endpoint): Promise<number | null> {
    const r = await this.rpc(ep, "getRecentPerformanceSamples", [5]);
    if (r.err !== undefined || !Array.isArray(r.result)) return null;
    let slots = 0;
    let secs = 0;
    for (const x of r.result as Array<{ numSlots?: unknown; samplePeriodSecs?: unknown }>) {
      if (typeof x?.numSlots !== "number" || typeof x?.samplePeriodSecs !== "number" || x.samplePeriodSecs <= 0) continue;
      slots += x.numSlots;
      secs += x.samplePeriodSecs;
    }
    const rate = secs > 0 ? slots / secs : NaN;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  /**
   * Measure the chain's speed from endpoints that just agreed on the slot. Two reports that agree with each other are
   * believed (the larger, so the ceiling stays an upper bound); a lone report, or two that disagree, is capped at the
   * configured bound, so no single endpoint can loosen the ceiling. A failed measurement keeps the previous one.
   */
  private async measureRate(eps: readonly Endpoint[], force = false): Promise<void> {
    const t = this.now();
    if (!force && this.measuredRate !== null && t - this.rateAt < this.cfg.rateRefreshMs) return;
    this.rateAt = t; // also rate-limits retries when no endpoint answers
    const rates = (await Promise.all(eps.slice(0, 2).map((e) => this.reportedRate(e)))).filter((r): r is number => r !== null);
    if (rates.length === 0) return;
    const hi = Math.max(...rates);
    const corroborated = rates.length === 2 && hi - Math.min(...rates) <= RATE_AGREEMENT * hi;
    const rate = corroborated ? Math.min(hi, MAX_MEASURED_SLOTS_PER_SECOND) : Math.min(hi, this.cfg.slotsPerSecond);
    const prev = this.measuredRate;
    this.measuredRate = rate;
    this.rateCorroborated = corroborated;
    if (prev === null || Math.abs(rate - prev) > 0.1 * prev) {
      this.logLine(`chain speed ${rate.toFixed(2)} slots/s (${corroborated ? "two endpoints agree" : `uncorroborated: capped at ${this.cfg.slotsPerSecond}`}${prev === null ? "" : `; was ${prev.toFixed(2)}`}); plausibility ceiling ${(rate * HEADROOM).toFixed(2)} slots/s`);
    }
  }

  /**
   * Quiet probes of the other endpoints for a first baseline. Each peer is GENESIS-checked first (a wrong-cluster
   * peer is refused and contributes nothing); slots are returned, not stored, so nothing here can touch the floor.
   */
  private async peerSlots(except: Endpoint): Promise<Array<{ ep: Endpoint; slot: number }>> {
    const t = this.now();
    const out: Array<{ ep: Endpoint; slot: number }> = [];
    await Promise.all(
      this.eps
        .filter((o) => o !== except && !o.refused && t >= o.downUntil)
        .map(async (o) => {
          if (!o.genesisOk) {
            const g = await this.rpc(o, "getGenesisHash");
            if (g.err !== undefined || typeof g.result !== "string") {
              this.markDown(o, g.err ?? "genesis probe returned no hash"); // N2: backoff, so dead peers are not re-probed every vet
              return;
            }
            if (g.result !== this.expectedGenesis) {
              this.refuse(o, g.result);
              return;
            }
            o.genesisOk = true;
          }
          const r = await this.rpc(o, "getSlot");
          if (r.err === undefined && typeof r.result === "number") out.push({ ep: o, slot: r.result });
          else this.markDown(o, r.err ?? "slot probe returned no slot");
        }),
    );
    return out;
  }

  private refuse(ep: Endpoint, genesis: string): void {
    ep.refused = true;
    ep.lastError = `cluster mismatch: genesis ${genesis.slice(0, 8)}... != expected ${this.expectedGenesis.slice(0, 8)}...`;
    this.logLine(`endpoint #${ep.idx} ${ep.label} REFUSED (${ep.lastError}); it will never be used`);
  }

  /** Escape hatch: every endpoint rejected as lagging for floorReseedMs yet they agree -> the floor was wrong, re-seed. */
  private maybeReseedFloor(): void {
    const t = this.now();
    const live = this.eps.filter((e) => !e.refused);
    if (live.length < 2 || live.some((e) => e.laggingSince === null || t - e.laggingSince < this.cfg.floorReseedMs || e.rawSlot === null)) return;
    const raws = live.map((e) => e.rawSlot as number).sort((x, y) => x - y);
    const ats = live.map((e) => e.rawAt);
    // replies were taken at different moments; allow the chain's own movement between them on top of maxSlotLag
    const tolerance = this.cfg.maxSlotLag + HEADROOM * this.ceilRate() * ((Math.max(...ats) - Math.min(...ats)) / 1000);
    if (raws[raws.length - 1] - raws[0] > tolerance) return;
    const proj = raws;
    // SAFE CHOICE, deliberately: the median of the RAW replies, not of replies projected forward by elapsed time. The
    // replies are hatch-old and a projection would assume the chain advanced at the full rate since; a floor that is
    // slightly low is harmless (the lag check merely gets looser by seconds), one too high re-creates the very lockout
    // this hatch exists to break.
    const median = raws[Math.floor(raws.length / 2)]; // unprojected: a floor slightly low is safe, one too high is the bug being repaired
    this.logLine(`[ALERT] every endpoint has been rejected as lagging for >= ${Math.round(this.cfg.floorReseedMs / 1000)}s but they agree with each other (slots ${proj.join(",")}); the slot floor ${this.floorSlot} was wrong, re-seeding it to ${median}`);
    this.floorSlot = median;
    this.anchor = { slot: median, at: t };
    this.floorCorroborated = true;
    for (const e of live) {
      e.laggingSince = null;
      e.downUntil = 0;
    }
  }

  private isAuthFailure(err: string): boolean {
    return /\bHTTP (401|403)\b/.test(err) && !/max usage reached|rate limit|quota/i.test(err);
  }

  /** F7: 401/403 is a revoked or wrong key, not a blip. Loud, parked at the maximum cooldown, and we fall back. */
  private authFail(ep: Endpoint, err: string): void {
    ep.backoffExp = 30;
    this.logLine(`[ALERT] endpoint #${ep.idx} ${ep.label} AUTH FAILURE (${err.slice(0, 80)}): key revoked or wrong? falling back; fix the key`);
    this.markDown(ep, `auth failure: ${err}`);
  }

  private async doVet(ep: Endpoint): Promise<boolean> {
    if (!ep.genesisOk) {
      const g = await this.rpc(ep, "getGenesisHash");
      if (g.err !== undefined || typeof g.result !== "string") {
        const err = g.err ?? "genesis probe returned no hash";
        if (this.isAuthFailure(err)) this.authFail(ep, err);
        else this.markDown(ep, err);
        return false;
      }
      if (g.result !== this.expectedGenesis) {
        this.refuse(ep, g.result);
        return false;
      }
      ep.genesisOk = true;
    }
    const s = await this.rpc(ep, "getSlot");
    if (s.err !== undefined || typeof s.result !== "number") {
      const err = s.err ?? "slot probe returned no slot";
      if (this.isAuthFailure(err)) this.authFail(ep, err);
      else this.markDown(ep, err);
      return false;
    }
    const slot = s.result;
    ep.lastVetAt = this.now();
    ep.rawSlot = slot;
    ep.rawAt = this.now();
    let confirmed = false;

    if (this.floorSlot === null) {
      // First baseline: this endpoint's slot must be corroborated by another GENESIS-VERIFIED endpoint within
      // maxSlotLag, or by a fresh block time. A lone (possibly bogus) reply never sets the floor.
      const peers = await this.peerSlots(ep);
      const agreePeers = peers.filter((p) => Math.abs(p.slot - slot) <= this.cfg.maxSlotLag);
      const agree = agreePeers.map((p) => p.slot);
      if (agree.length > 0) {
        this.accept(ep, slot);
        await this.measureRate([ep, agreePeers[0].ep]);
        const hi = Math.max(slot, ...agree);
        if (hi > (this.floorSlot ?? 0)) this.floorSlot = hi; // corroborated by a second genesis-verified endpoint
        this.floorCorroborated = true;
        this.floorSource = ep.idx;
        confirmed = true;
        await this.measureSkew(ep, slot);
      } else {
        const fresh = await this.blockTimeFresh(ep, slot);
        if (fresh === "stale") return false;
        // (A lone peer ahead of this endpoint is NOT used as a lower bound: one uncorroborated reply must never be able to
        // make an honest endpoint look lagging. R153 round 4 reverted the N3 lower-bound behaviour.)
        if (fresh === "fresh") {
          this.accept(ep, slot);
          this.floorCorroborated = false;
          this.floorSource = ep.idx;
          confirmed = true;
        } else {
          // Nothing to corroborate with. The operator's primary is trusted as before (no floor is set from an
          // unverified lone reply); an uncorroborated fallback may be read from, never sent through.
          ep.slot = slot;
          ep.slotAt = this.now();
          confirmed = ep.idx === 0;
        }
      }
    } else {
      // (a) plausibility: a reply far above what the chain could have reached since the floor was set is
      //     suspect-ahead. It is treated as down, logged, and NEVER raises the floor.
      const ceil = this.floorCeiling() as number;
      // Two genesis-verified endpoints agreeing above the ceiling outrank the keeper's own estimate of the chain's speed.
      let aboveCeilingAgree: number[] = [];
      if (slot > ceil) {
        const peers = (await this.peerSlots(ep)).filter((p) => Math.abs(p.slot - slot) <= this.cfg.maxSlotLag);
        if (peers.length > 0) {
          aboveCeilingAgree = peers.map((p) => p.slot);
          const t = this.now();
          const was = this.ceilRate();
          await this.measureRate([ep, peers[0].ep], true);
          if (t - this.aboveCeilingAlertAt >= 300_000) {
            this.aboveCeilingAlertAt = t;
            this.logLine(
              `[ALERT] endpoints #${ep.idx} and #${peers[0].ep.idx} agree at slot ~${slot}, above the plausibility ceiling ${Math.floor(ceil)} ` +
                `(assumed <= ${(was * HEADROOM).toFixed(2)} slots/s): the chain is faster than assumed or the keeper clock stepped back; ` +
                `re-anchoring (chain speed now ${this.ceilRate().toFixed(2)} slots/s)`,
            );
          }
        }
      }
      if (slot > ceil && aboveCeilingAgree.length === 0) {
        ep.suspectAhead = true;
        if (ep.laggingSince === null) ep.laggingSince = this.now();
        this.markDown(ep, `suspect-ahead: slot ${slot} exceeds what the chain can have reached (${Math.floor(ceil)}); floor ${this.floorSlot} unchanged`);
        this.maybeReseedFloor();
        return false;
      }
      ep.suspectAhead = false;
      const t = this.now();
      const others = this.recentOthers(ep);
      const agreeing = [...others.filter((o) => Math.abs(o - slot) <= this.cfg.maxSlotLag), ...aboveCeilingAgree];
      // (a2) corroborated raises only: a reply more than maxSlotLag above EVERY other recent endpoint is believed only
      //      if another endpoint agrees with it, or if it is the only live endpoint (nothing to compare against).
      if (others.length > 0 && agreeing.length === 0 && slot - Math.max(...others) > this.cfg.maxSlotLag) {
        ep.suspectAhead = true;
        if (ep.laggingSince === null) ep.laggingSince = t;
        this.markDown(ep, `suspect-ahead: slot ${slot} is ${slot - Math.max(...others)} above every other endpoint and none agrees (uncorroborated)`);
        this.maybeReseedFloor();
        return false;
      }
      // (b) lower bound: never more than maxSlotLag below the highest accepted slot (no expiry) ...
      const floor = this.floorSlot;
      if (floor - slot > this.cfg.maxSlotLag) {
        // ... unless that floor was raised by a SOLE live endpoint (uncorroborated) and is now contradicted: by two
        // agreeing endpoints below it, or by this endpoint's own fresh block time with the floor beyond what the
        // block-time window can explain. Then the floor was the lie: overturn it.
        let why: string | null = null;
        let base = slot;
        let btOverturn = false;
        if (!this.floorCorroborated && agreeing.length > 0) {
          why = "agreement of two genesis-verified endpoints below it";
          base = Math.min(slot, ...agreeing);
        } else if (!this.floorCorroborated && ep.idx === 0) {
          // Only the operator's primary may overturn on its own block time (the "returning primary" case); a fallback can
          // only overturn through agreement. A lying/lagging fallback that reports a fresh block time gets nothing.
          // Wall-clock arbiter: this endpoint's own block time dates its slot; the chain head cannot be further ahead
          // than (slot-20) + age*speed. A floor beyond that by more than the lag bound (+ ~6 s of clock skew) is a lie.
          const head = await this.headEstimate(ep, slot);
          if (head !== null && floor - Math.max(slot, head) > this.cfg.maxSlotLag + (this.skewMeasured ? 8 : 15)) {
            why = `this endpoint's block time (chain head ~${Math.floor(head)})`;
            base = Math.min(slot, head);
            btOverturn = true;
          }
        }
        if (why !== null) {
          this.logLine(`[ALERT] slot floor ${floor} (from sole-source endpoint #${this.floorSource}) overturned by ${why}: endpoint #${ep.idx} is at ${slot}; floor and anchor reset to ${base}`);
          this.floorSlot = base;
          this.anchor = { slot: base, at: t };
          this.floorCorroborated = agreeing.length > 0;
          this.floorSource = ep.idx;
          if (btOverturn && ep.idx !== 0) ep.needsAgreement = true; // a non-primary overturner would need a peer to agree before sending (unreachable today: only idx 0 overturns)
        } else {
          ep.slot = slot;
          ep.slotAt = t;
          if (ep.laggingSince === null) ep.laggingSince = t;
          if (ep.idx === 0 && !this.floorCorroborated && t - this.primaryAlertAt >= 300_000) {
            this.primaryAlertAt = t;
            this.logLine(`[ALERT] primary rejected as lagging: primary slot ${slot} vs floor ${floor} raised by sole-source endpoint #${this.floorSource}; if the fallback is the one that is wrong the keeper is stuck on it until the chain view agrees`);
          }
          this.markDown(ep, `lagging: slot ${slot} is ${floor - slot} behind the highest slot seen ${floor} (max ${this.cfg.maxSlotLag})`);
          this.maybeReseedFloor();
          return false;
        }
      }
      const raised = slot > (this.floorSlot ?? 0);
      this.accept(ep, slot);
      if (agreeing.length > 0) {
        // (2) re-anchor from agreement: slack is bounded by the interval since two endpoints last agreed.
        this.anchor = { slot: Math.min(slot, ...agreeing), at: t };
        this.floorCorroborated = true;
        this.floorSource = ep.idx;
        // a rate that was never measured / is due for a refresh: measure against an endpoint that just agreed
        if (this.measuredRate === null || t - this.rateAt >= this.cfg.rateRefreshMs) {
          const peer = this.eps.find((o) => o !== ep && o.genesisOk && !o.refused && o.slot !== null && t - o.slotAt <= 60_000);
          if (peer) await this.measureRate([ep, peer]);
        }
      } else if (raised) {
        this.floorCorroborated = false;
        this.floorSource = ep.idx;
      }
      confirmed = agreeing.length > 0;
      if (agreeing.length > 0) {
        ep.needsAgreement = false;
        await this.measureSkew(ep, slot);
      }
      if (!confirmed) {
        const fresh = await this.blockTimeFresh(ep, slot);
        if (fresh === "stale") return false;
        // an endpoint that overturned the floor on its own block time stays send-less until a peer agrees
        confirmed = ep.needsAgreement ? false : fresh === "fresh" ? true : ep.idx === 0;
      }
    }
    ep.laggingSince = null;
    ep.confirmed = confirmed;
    ep.verified = true;
    this.markGood(ep);
    return true;
  }

  /** Block time of slot-20 as seconds-old, corrected for the measured keeper clock error. null = unavailable/disabled. */
  private async blockAgeSec(ep: Endpoint, slot: number): Promise<number | null> {
    if (this.blockTimeDisabled) return null;
    const bt = await this.rpc(ep, "getBlockTime", [Math.max(0, slot - 20)]);
    if (bt.err !== undefined || typeof bt.result !== "number") return null;
    return this.now() / 1000 - bt.result - this.skewSec;
  }

  /**
   * Measure the keeper's clock error ONCE, from an endpoint that agrees with a peer (so it is at the chain head):
   * the block 20 slots back should be 20/speed s old (8 s at 2.5/s). Beyond the allowance every block-time path is disabled with an [ALERT]
   * (a skewed clock would let a lagging node pass as fresh, or a fresh one look stale).
   */
  private async measureSkew(ep: Endpoint, slot: number): Promise<void> {
    if (this.skewMeasured || this.blockTimeDisabled) return;
    const bt = await this.rpc(ep, "getBlockTime", [Math.max(0, slot - 20)]);
    if (bt.err !== undefined || typeof bt.result !== "number") return;
    const skew = this.now() / 1000 - bt.result - 20 / this.projRate();
    this.skewMeasured = true;
    this.logLine(`keeper clock vs chain: ${skew.toFixed(1)}s (allowance ${this.cfg.clockSkewAllowanceSec}s)`);
    if (Math.abs(skew) > this.cfg.clockSkewAllowanceSec) {
      this.blockTimeDisabled = true;
      this.logLine(`[ALERT] keeper clock is ${skew.toFixed(0)}s off the chain: block-time freshness checks are DISABLED (sends need peer agreement); fix NTP`);
    } else {
      this.skewSec = skew;
    }
  }

  /** Chain-head estimate from an endpoint's own block time: (slot-20) + seconds since that block * slots/s. */
  private async headEstimate(ep: Endpoint, slot: number): Promise<number | null> {
    if (!this.skewMeasured || this.blockTimeDisabled) return null;
    const age = await this.blockAgeSec(ep, slot);
    return age === null ? null : Math.max(0, slot - 20) + age * this.projRate();
  }

  /** Wall-clock anchor: the block time of a recent slot must be close to now. */
  private async blockTimeFresh(ep: Endpoint, slot: number, markStale = true): Promise<"fresh" | "stale" | "unknown"> {
    const ageSec = await this.blockAgeSec(ep, slot);
    if (ageSec === null) return "unknown";
    // lag bound + 20-slot offset (at the projection speed: lenient before measurement) + clock margin
    const maxAge = (this.cfg.maxSlotLag + 20) / this.projRate() + (this.skewMeasured ? 4 : 10);
    if (ageSec > maxAge) {
      if (!markStale) return "stale";
      this.markDown(ep, `stale: block time of slot ${slot - 20} is ${Math.round(ageSec)}s old (max ${Math.round(maxAge)}s)`);
      return "stale";
    }
    return "fresh";
  }

  private async usable(ep: Endpoint): Promise<boolean> {
    if (ep.refused) return false;
    const t = this.now();
    if (t < ep.downUntil) return false;
    // F2: the slot probe runs at most once per slotCheckIntervalMs, not once per request.
    if (ep.verified && t - ep.lastVetAt < this.cfg.slotCheckIntervalMs) return true;
    return this.vet(ep);
  }

  private maybeProbePrimary(): void {
    if (this.active === 0) return;
    const p = this.eps[0];
    const t = this.now();
    if (p.refused || t < p.downUntil || t - this.lastPrimaryProbeAt < this.cfg.primaryRetryMs) return;
    this.lastPrimaryProbeAt = t;
    p.verified = false; // full vet: genesis + slot
    void this.vet(p).then((ok) => {
      if (ok) this.setActive(p, "primary recovered");
    });
  }

  private static isQuota(status: number, body: string): boolean {
    if (status === 429) return true;
    return (status === 402 || status === 403) && /max usage reached|rate limit|quota/i.test(body);
  }

  /** Best slot known now: the freshest (<60 s) observation of any genesis-verified, confirmed endpoint, projected forward. */
  private bestKnownSlot(): number | null {
    const t = this.now();
    let best: number | null = null;
    for (const o of this.eps) {
      if (o.slot === null || o.refused || !o.genesisOk || !o.confirmed) continue;
      const age = t - o.slotAt;
      if (age > 60_000) continue;
      const projected = o.slot + Math.floor((age / 1000) * this.projRate());
      if (best === null || projected > best) best = projected;
    }
    return best;
  }

  /** Slots a getLatestBlockhash reply is behind the best known slot, or null when it cannot be judged. */
  private async blockhashLag(res: Response): Promise<number | null> {
    const best = this.bestKnownSlot();
    if (best === null) return null;
    try {
      const j = (await res.clone().json()) as { result?: { context?: { slot?: unknown } } };
      const slot = j.result?.context?.slot;
      return typeof slot === "number" && Number.isFinite(slot) ? best - slot : null;
    } catch {
      return null; // not JSON / an RPC error body: web3.js reports it; nothing to judge
    }
  }

  private markBlockhashStale(ep: Endpoint, lag: number): void {
    const t = this.now();
    const wait = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** ep.bhBackoffExp);
    ep.bhBackoffExp = Math.min(ep.bhBackoffExp + 1, 30);
    ep.bhStaleUntil = t + wait;
    ep.bhLag = lag;
    if (!ep.bhStale) {
      this.logLine(
        `[ALERT] stale blockhash from endpoint #${ep.idx} ${ep.label}: getLatestBlockhash served ${lag} slots behind the best known slot ` +
          `(max ${this.cfg.maxBlockhashLag}); every tx signed with it would be dropped. Blockhashes come from the other endpoints; retry in ${Math.round(wait / 1000)}s`,
      );
    }
    ep.bhStale = true;
  }

  private markBlockhashFresh(ep: Endpoint, lag: number | null): void {
    if (ep.bhStale) this.logLine(`endpoint #${ep.idx} ${ep.label}: blockhash fresh again${lag === null ? "" : ` (${lag} slots behind)`}`);
    ep.bhStale = false;
    ep.bhStaleUntil = 0;
    ep.bhBackoffExp = 0;
    ep.bhLag = lag;
  }

  private async doFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.maybeProbePrimary();
    const body0 = typeof init?.body === "string" ? init.body : "";
    const isWrite = /"method"\s*:\s*"(sendTransaction|requestAirdrop)"/.test(body0);
    const isStatusPoll = /"method"\s*:\s*"(getSignatureStatuses|getSignatureStatus|getTransaction|isBlockhashValid|getBlockHeight)"/.test(body0);
    const isBlockhash = /"method"\s*:\s*"getLatestBlockhash"/.test(body0);
    const t0 = this.now();
    // F4: confirmation/status polls follow the endpoint that took the send (a different node may not know the signature yet).
    const first = isStatusPoll && this.pin && t0 < this.pin.until ? this.pin.idx : this.active;
    const order = [this.eps[first], ...this.eps.filter((e) => e.idx !== first)];
    let skippedUnconfirmed = false;
    const activeAtStart = this.active;
    let lastRes: Response | null = null;
    let lastErr: unknown = null;
    let staleBlockhash = false;
    for (const ep of order) {
      if (isBlockhash && ep.bhStale && this.now() < ep.bhStaleUntil) {
        staleBlockhash = true;
        continue;
      }
      if (!(await this.usable(ep))) continue;
      if (isWrite && !ep.confirmed) {
        skippedUnconfirmed = true; // F1: never send through an endpoint whose freshness could not be established
        continue;
      }
      let res: Response;
      try {
        res = await this.base(ep.url, init);
      } catch (e) {
        lastErr = e;
        if (++ep.consecutiveFailures >= this.cfg.networkErrorThreshold) {
          this.markDown(ep, `${ep.consecutiveFailures} consecutive network errors: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      let body = "";
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        try {
          body = await res.clone().text();
        } catch {
          /* ignore */
        }
      }
      if (RpcFailover.isQuota(res.status, body)) {
        lastRes = res;
        this.markDown(ep, `HTTP ${res.status} quota/rate limit (max usage reached)`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        lastRes = res;
        this.authFail(ep, `HTTP ${res.status}`);
        continue;
      }
      // 500 too: 2026-10-16 22:10-22:45Z Helius devnet answered "500 Internal server error" for 35 min (JSON-RPC errors are 200).
      if (res.status === 500 || (res.status >= 502 && res.status <= 504)) {
        lastRes = res;
        if (++ep.consecutiveFailures >= this.cfg.networkErrorThreshold) this.markDown(ep, `HTTP ${res.status}`);
        continue;
      }
      ep.consecutiveFailures = 0;
      if (isBlockhash && res.status === 200) {
        const lag = await this.blockhashLag(res);
        if (lag !== null && lag > this.cfg.maxBlockhashLag) {
          this.markBlockhashStale(ep, lag);
          staleBlockhash = true;
          continue; // a dead blockhash is worse than none: try the next endpoint, never move `active` for it
        }
        this.markBlockhashFresh(ep, lag);
      }
      this.allDownSince = null;
      if (isWrite) this.pin = { idx: ep.idx, until: this.now() + this.cfg.pinMs };
      // A blockhash served elsewhere because the active endpoint's was stale does not move `active` (its reads/sends are fine).
      const pinnedServe = (isStatusPoll && ep.idx === first && first !== this.active) || (isBlockhash && this.eps[this.active].bhStale && ep.idx !== this.active);
      // Only the request that saw the current active endpoint fail may move it (a concurrent primary recovery wins).
      if (!pinnedServe && this.active === activeAtStart) this.setActive(ep, ep.idx === 0 ? "primary serving" : `failover from #${this.active}`);
      return res;
    }
    if (isBlockhash && staleBlockhash) {
      throw new Error(`rpc-degraded: no ${this.cluster} RPC endpoint is serving a fresh blockhash (stale beyond ${this.cfg.maxBlockhashLag} slots); not signing with a dead one`);
    }
    // Nothing answered: fail loudly but rate-limited, never crash.
    const t = this.now();
    this.maybeReseedFloor();
    if (this.allDownSince === null) this.allDownSince = t;
    if (t - this.allDownSince >= this.cfg.allDownAlertMs && t - this.allDownAlertedAt >= 300_000) {
      this.allDownAlertedAt = t;
      this.logLine(`[ALERT] keeper is alive but USELESS: no usable ${this.cluster} RPC endpoint for ${Math.round((t - this.allDownSince) / 1000)}s (no reads, no pushes); fix the RPC key/quota or fallbacks`);
    }
    if (t - this.allDownLoggedAt > 30_000) {
      this.allDownLoggedAt = t;
      this.logLine(`ALL ENDPOINTS DOWN (${this.eps.map((e) => `#${e.idx} ${e.refused ? "refused" : t < e.downUntil ? `cooldown ${Math.round((e.downUntil - t) / 1000)}s` : "failing"}`).join(", ")}); backing off`);
    }
    if (skippedUnconfirmed && !lastRes) {
      throw new Error(`rpc-degraded: no slot-confirmed ${this.cluster} RPC endpoint available for a write (reads still served)`);
    }
    if (lastRes) return lastRes; // let web3.js apply its own 429 retry; our cooldown makes repeats fail fast
    throw new Error(`rpc-degraded: all ${this.cluster} RPC endpoints are down${lastErr ? ` (last: ${this.scrub(lastErr instanceof Error ? lastErr.message : String(lastErr))})` : ""}`);
  }

  // ── observability ─────────────────────────────────────────────────────────

  isAllDown(): boolean {
    const t = this.now();
    return this.eps.every((e) => e.refused || t < e.downUntil);
  }

  snapshot(): RpcFailoverSnapshot {
    const t = this.now();
    const allDown = this.isAllDown();
    const pr = this.projRate();
    const bestAll = Math.max(-1, ...this.eps.filter((e) => e.slot !== null && !e.refused).map((e) => (e.slot as number) + Math.floor(((t - e.slotAt) / 1000) * pr)));
    const activeBhStale = this.eps[this.active].bhStale;
    return {
      cluster: this.cluster,
      status: allDown || this.active !== 0 || activeBhStale ? "rpc-degraded" : "ok",
      reason: allDown ? "all-endpoints-down" : this.active !== 0 ? "on-fallback" : activeBhStale ? "stale-blockhash" : "primary-active",
      active: this.eps[this.active].label,
      activeIndex: this.active,
      endpoints: this.eps.map((e) => ({
        index: e.idx,
        url: e.label,
        confirmed: e.confirmed,
        suspectAhead: e.suspectAhead,
        state: e.refused ? "refused" : t < e.downUntil ? "down" : "ok",
        consecutiveFailures: e.consecutiveFailures,
        downForMs: Math.max(0, e.downUntil - t),
        lastError: e.lastError,
        slot: e.slot,
        slotLag: e.slot !== null && bestAll >= 0 ? Math.max(0, bestAll - (e.slot + Math.floor(((t - e.slotAt) / 1000) * pr))) : null,
        blockhashStale: e.bhStale,
        blockhashRetryInMs: e.bhStale ? Math.max(0, e.bhStaleUntil - t) : 0,
        blockhashLagSlots: e.bhLag,
      })),
      floorSlot: this.floorSlot,
      slotRate: {
        measured: this.measuredRate,
        corroborated: this.rateCorroborated,
        bound: this.cfg.slotsPerSecond,
        ceiling: this.ceilRate() * HEADROOM,
        measuredAgoMs: this.measuredRate === null ? null : Math.max(0, t - this.rateAt),
      },
      switches: this.switches,
      lastSwitchAt: this.lastSwitchAt === null ? null : new Date(this.lastSwitchAt).toISOString(),
    };
  }
}

// ── process-wide registry (feeds /health) ────────────────────────────────────

const registered = new Map<string, RpcFailover>();

export function registerRpcFailover(label: string, f: RpcFailover): void {
  registered.set(label, f);
}

/** Additive /health fields. `{}` when no failover is registered. `degraded` is true on a fallback or all-down. */
export function rpcFailoverHealth(): { degraded: boolean; fields: Record<string, unknown> } {
  if (registered.size === 0) return { degraded: false, fields: {} };
  const snaps: Record<string, RpcFailoverSnapshot> = {};
  let degraded = false;
  for (const [label, f] of registered) {
    const s = f.snapshot();
    snaps[label] = s;
    if (s.status === "rpc-degraded") degraded = true;
  }
  return { degraded, fields: { rpcFailover: snaps } };
}

/** Positive finite number from an env string, else the default. */
export function envNumber(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Wire-up helper. `fallbacks` is the already-parsed ordered list (see parseFallbackUrls). Returns null when empty, so
 * a deployment that opts out (`off`) keeps plain web3.js behaviour on the single endpoint.
 */
export function failoverFromEnv(
  cluster: FailoverCluster,
  primaryUrl: string,
  fallbackList: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  base: FetchLike,
): RpcFailover | null {
  const fallbacks = fallbackList.filter((u) => u !== primaryUrl);
  if (fallbacks.length === 0) return null;
  const f = new RpcFailover({
    cluster,
    urls: [primaryUrl, ...fallbacks],
    base,
    maxSlotLag: envNumber(env.RPC_MAX_SLOT_LAG, 50),
    maxBlockhashLag: envNumber(env.RPC_MAX_BLOCKHASH_LAG, 75),
    slotsPerSecond: envNumber(env.RPC_SLOTS_PER_SECOND, DEFAULT_MAX_SLOTS_PER_SECOND),
    slotCheckIntervalMs: envNumber(env.RPC_SLOT_CHECK_MS, 10_000),
    primaryRetryMs: envNumber(env.RPC_PRIMARY_RETRY_MS, 30_000),
    backoffBaseMs: envNumber(env.RPC_BACKOFF_BASE_MS, 2_000),
    backoffMaxMs: envNumber(env.RPC_BACKOFF_MAX_MS, 300_000),
    floorReseedMs: envNumber(env.RPC_FLOOR_RESEED_MS, 300_000),
    allDownAlertMs: envNumber(env.RPC_ALL_DOWN_ALERT_MS, 120_000),
  });
  registerRpcFailover(cluster, f);
  console.log(`[rpc-failover:${cluster}] ordered endpoints: ${[primaryUrl, ...fallbacks].map(redactUrl).join(" > ")}`);
  return f;
}

/** True for an error that says the RPC is unavailable (quota, overload, network), not that the data is wrong. */
export function isTransientRpcError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /\b(429|5\d\d)\b|too many requests|max usage|rate limit|fetch failed|rpc-degraded|endpoints are down|econn|etimedout|enotfound|socket hang up|network|timed? ?out|unavailable/.test(m);
}

/**
 * Preflight rule when the ownership check cannot run because no RPC answered.
 * - "proceed": the registry is byte-identical to one that already passed the ownership check (stamp matches), so
 *   starting changes nothing the check protects. The keeper then degrades (retries, fails over) instead of
 *   crash-looping and leaving every market to age past the stale-resolve window.
 * - "refuse": the registry is new or changed and cannot be verified; refusing is the safe answer.
 */
export function preflightOutageDecision(registrySha: string, stampSha: string | undefined): "proceed" | "refuse" {
  return stampSha !== undefined && stampSha.trim() === registrySha ? "proceed" : "refuse";
}

/**
 * F3: what a preflight stamp attests to. The ownership check is "these markets are owned by THIS wrapper on THIS
 * cluster", so the stamp binds the registry bytes AND the wrapper program id AND the cluster genesis. A re-deploy to
 * new program ids with an unchanged registry therefore never reuses an old stamp.
 */
export function preflightStampSha(registryBytes: Uint8Array, wrapperProgramId: string, genesisHash: string): string {
  return createHash("sha256").update(registryBytes).update("\n").update(wrapperProgramId).update("\n").update(genesisHash).digest("hex");
}
