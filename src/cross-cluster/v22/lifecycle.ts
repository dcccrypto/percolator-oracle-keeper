/**
 * cross-cluster/v22/lifecycle.ts
 *
 * The market-lifecycle engine of the v2.2 layer (plan v22-market-lifecycle-plan-2026-10-25, option C). It owns:
 *   1. the dead-market classifier run every tick (lifecycle-classify.ts), /health `v22.lifecycle` and the alerts;
 *   2. the permissionless stale resolve, tag 39 (lifecycle-resolve.ts: guards, re-verification, send), default OFF;
 *   3. forced fee collection (tags 78 and 87 + stake 12) in the DEAD-PRICE warn band, before maturity refuses them.
 *
 * V22Loop.tick calls `beginTick()`, `observe(ctx)` for every registry market it already read (NO extra RPC), then
 * `endTick()`. The only RPC the engine adds: one `getSlot` per tick (proves the chain is reachable), and, at most every
 * `discoveryMs`, one keys-only getProgramAccounts for wrapper markets that have no registry row, plus one batched read of
 * those. Everything the engine writes to the chain goes through exec.ts (simulate first; dry-run logs).
 *
 * With KEEPER_V22_STALE_RESOLVE=off and KEEPER_V22_WARN_BAND_FEES=off (the defaults) the engine sends NOTHING.
 *
 * AFTER A RESOLVE: the existing terminal path picks the market up on its own. For a REGISTRY market the fee-job loop's
 * terminal-insurance job (terminal-insurance.ts windDownOnce -> decodeTerminalState -> resolved) and its portfolio cleanup
 * (resolved-portfolio-cleanup.ts) run on the next fee-loop cycle, the push loop stops pushing it (markTerminal here, and its own
 * B20 read), and the v2.2 loop's `terminalKindOf` skips it. A market WITHOUT a registry row is not swept by those jobs (they walk
 * the registry); its holders use the app flow (W30 is permissionless after force_close_delay). That gap is named in the PR.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import type { Alert, AlertSink } from "../alerting.ts";
import { markTerminal } from "../push-deadline.ts";
import { buildV22MarketCtx } from "./market.ts";
import type { V22MarketCtx } from "./market.ts";
import type { LifecycleConfig } from "./flags.ts";
import { classifyMarket, observeQuiet, openInterestIsZero, quietMsOf, tradeFeeAccrualSum } from "./lifecycle-classify.ts";
import type { MarketLifecycle, QuietEntry } from "./lifecycle-classify.ts";
import { lifecycleLedger } from "./lifecycle-ledger.ts";
import type { ObservationLedger } from "./lifecycle-ledger.ts";
import { RESOLVE_GUARDS, decideResolve, resolveStaleOnce } from "./lifecycle-resolve.ts";
import type { AttemptRecord, GuardName, ResolveDecision, ResolveInput } from "./lifecycle-resolve.ts";
import { redactErrorText } from "./redact.ts";

export const LIFECYCLE_ALERT_SCOPE = "v22-lifecycle";

/** Wrapper account header the discovery scan matches: MAGIC (8, LE) + VERSION 19 (u16 LE) + KIND 1 (market). */
const WRAPPER_MAGIC_LE = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
export const MARKET_HEADER_V22 = Buffer.concat([WRAPPER_MAGIC_LE, Buffer.from([19, 0]), Buffer.from([1])]);

export interface LifecycleStore {
  load(): Record<string, QuietEntry>;
  save(rec: Record<string, QuietEntry>): void;
}

/** JSON file store (atomic rename). Never throws. */
export function fileStore(file: string): LifecycleStore {
  return {
    load() {
      try {
        const j = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; markets?: Record<string, QuietEntry> };
        if (j.version !== 1 || !j.markets) return {};
        const out: Record<string, QuietEntry> = {};
        for (const [k, v] of Object.entries(j.markets)) if (typeof v?.quietSinceMs === "number" && typeof v?.feeSum === "string") out[k] = v;
        return out;
      } catch {
        return {};
      }
    },
    save(rec) {
      try {
        const tmp = `${file}.tmp-${process.pid}`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, markets: rec }));
        fs.renameSync(tmp, file);
      } catch {
        // a failed save keeps the previous file; the clock is only a lower bound anyway
      }
    },
  };
}

export type LifecycleConnection = Pick<Connection, "getSlot" | "getProgramAccounts" | "getMultipleAccountsInfoAndContext" | "getAccountInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses">;

export interface LifecycleDeps {
  conn: LifecycleConnection;
  keeper: Keypair;
  programId: PublicKey;
  cfg: LifecycleConfig;
  /** Global DRY_RUN / KEEPER_V22_DRY_RUN: forces the resolve to `dry`. */
  dryRun: boolean;
  registered: (marketAddress: string) => boolean;
  sink: Pick<AlertSink, "reconcile" | "fire">;
  /** Forced fee round for a warn-band market: tag 78 then tag 87 + stake 12. Returns a one-line summary. Absent = no forcing. */
  forceFees?: (ctx: V22MarketCtx) => Promise<string>;
  ledger?: ObservationLedger;
  store?: LifecycleStore | null;
  now?: () => number;
  log?: (s: string) => void;
}

interface Tracked {
  ctx: V22MarketCtx;
  lc: MarketLifecycle;
  registered: boolean;
  label: string;
}

export interface LifecycleView {
  registered: boolean;
  classes: string[];
  priceBand: string;
  ageSlots: string | null;
  staleSlots: string | null;
  pctOfWindow: number | null;
  neverConnected: string | null;
  keeperCanPush: boolean;
  oiZero: boolean | null;
  quietDays: number;
  resolve: { decision: string; guard: string | null; reason: string | null } | null;
  fees: string | null;
}

export class LifecycleEngine {
  private readonly ledger: ObservationLedger;
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly store: LifecycleStore | null;
  private readonly quiet = new Map<string, QuietEntry>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly lastFeeAt = new Map<string, number>();
  private readonly lastFee = new Map<string, string>();
  private readonly decisions = new Map<string, ResolveDecision | { action: "dry-run"; detail: string } | { action: "sent"; signature: string } | { action: "error"; detail: string }>();
  private observed = new Map<string, Tracked>();
  private unreg = new Map<string, Tracked>();
  private lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  private lastSaveAt = 0;
  private resolvedThisCycle = 0;
  private resolvesSent = 0;
  private tickReadFailures = 0;
  private massHold = false;
  private outageShaped = 0;
  private lastCounts: Record<string, number> = {};

  constructor(private readonly d: LifecycleDeps) {
    this.ledger = d.ledger ?? lifecycleLedger;
    this.ledger.setMaxGapMs(d.cfg.maxGapMs);
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.log(s));
    this.store = d.store === undefined ? (d.cfg.stateFile ? fileStore(d.cfg.stateFile) : null) : d.store;
    if (this.store) for (const [k, v] of Object.entries(this.store.load())) this.quiet.set(k, v);
  }

  private deadInterestMs(): number {
    return this.d.cfg.deadInterestDays * 86_400_000;
  }

  beginTick(): void {
    this.observed = new Map();
    this.resolvedThisCycle = 0;
    this.tickReadFailures = 0;
  }

  /** A registry market's read failed for an RPC reason (not "account not found"): the tick is not a clean observation. */
  noteReadFailure(): void {
    this.tickReadFailures++;
  }

  private classifyCtx(ctx: V22MarketCtx, registered: boolean, label: string): Tracked {
    const nowMs = this.now();
    const addr = ctx.marketAddress;
    const prevQuiet = this.quiet.get(addr);
    const q = observeQuiet(prevQuiet, { oiZero: openInterestIsZero(ctx.data), feeSum: tradeFeeAccrualSum(ctx.data), nowMs });
    this.quiet.set(addr, q);
    const lc = classifyMarket({
      data: ctx.data,
      readSlot: BigInt(ctx.readSlot),
      registered,
      keeper: this.d.keeper.publicKey,
      keeperLandedPush: this.ledger.pushLandedSinceBoot(addr),
      keeperObservedMs: this.ledger.continuousMs(nowMs),
      neverConnectedGraceSlots: BigInt(this.d.cfg.neverConnectedGraceSlots),
      quietMs: quietMsOf(q, nowMs),
      deadInterestMs: this.deadInterestMs(),
    });
    return { ctx, lc, registered, label };
  }

  /** Classify one registry market the loop just read. No RPC. Never throws. */
  observe(ctx: V22MarketCtx): MarketLifecycle | null {
    if (!this.d.cfg.classify) return null;
    try {
      const t = this.classifyCtx(ctx, this.d.registered(ctx.marketAddress), ctx.label);
      this.observed.set(ctx.marketAddress, t);
      return t.lc;
    } catch (err) {
      this.log(`[v22][lifecycle] ${ctx.label}: classify failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
      return null;
    }
  }

  // ── Discovery of wrapper markets that have no registry row ─────────────────────────────────────────────────────────

  private async discover(): Promise<void> {
    const nowMs = this.now();
    if (this.d.cfg.discoveryMs <= 0) return;
    const due = nowMs - this.lastDiscoveryAt >= this.d.cfg.discoveryMs;
    let addrs: string[];
    if (due) {
      this.lastDiscoveryAt = nowMs;
      // Keys only (dataSlice length 0): the scan costs one cheap call, the account bytes are read afterwards for the few that matter.
      const res = await this.d.conn.getProgramAccounts(this.d.programId, {
        dataSlice: { offset: 0, length: 0 },
        filters: [{ memcmp: { offset: 0, bytes: MARKET_HEADER_V22.toString("base64"), encoding: "base64" } }],
      });
      addrs = res.map((a) => a.pubkey.toBase58()).filter((a) => !this.d.registered(a));
      for (const k of [...this.unreg.keys()]) if (!addrs.includes(k)) this.unreg.delete(k);
    } else {
      // Between scans only the unregistered markets that are in (or near) a dead band are re-read, every tick.
      addrs = [...this.unreg.entries()].filter(([, t]) => t.lc.price.kind === "warn" || t.lc.price.kind === "matured").map(([k]) => k);
    }
    for (let i = 0; i < addrs.length; i += 100) {
      const chunk = addrs.slice(i, i + 100);
      const res = await this.d.conn.getMultipleAccountsInfoAndContext(chunk.map((a) => new PublicKey(a)), "processed");
      res.value.forEach((info, j) => {
        const addr = chunk[j];
        if (!info || !info.owner.equals(this.d.programId)) {
          this.unreg.delete(addr);
          return;
        }
        const built = buildV22MarketCtx({ marketAddress: addr, label: `unregistered ${addr.slice(0, 8)}`, programId: this.d.programId, data: new Uint8Array(info.data), readSlot: res.context.slot, registryData: null, vaultLpStateData: null });
        if (!built.ok) {
          this.unreg.delete(addr);
          return;
        }
        const t = this.classifyCtx(built.ctx, false, built.ctx.label);
        if (t.lc.terminal !== null) this.unreg.delete(addr);
        else this.unreg.set(addr, t);
      });
    }
  }

  // ── Per tick ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async endTick(): Promise<void> {
    if (!this.d.cfg.classify) return;
    const nowMs = this.now();
    let chainOk = true;
    try {
      await this.d.conn.getSlot("confirmed");
    } catch {
      chainOk = false;
    }
    this.ledger.noteTick(chainOk && this.tickReadFailures === 0, nowMs);
    try {
      await this.discover();
    } catch (err) {
      this.log(`[v22][lifecycle] discovery failed (registered markets are unaffected): ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
    const all: Tracked[] = [...this.observed.values(), ...[...this.unreg.values()].filter((u) => !this.observed.has(u.ctx.marketAddress))];
    this.tally(all);
    this.assessOutage(all, nowMs);
    await this.reconcileAlerts(all);
    if (chainOk) {
      await this.warnBandFees(all);
      await this.resolveMatured(all);
    }
    this.persist();
  }

  private tally(all: Tracked[]): void {
    const c: Record<string, number> = { healthy: 0, neverConnected: 0, deadPriceWarn: 0, deadPriceMatured: 0, deadInterest: 0, noResolveWindow: 0, terminal: 0 };
    for (const t of all) {
      for (const k of t.lc.classes) {
        const key = k === "never-connected" ? "neverConnected" : k === "dead-price-warn" ? "deadPriceWarn" : k === "dead-price-matured" ? "deadPriceMatured" : k === "dead-interest" ? "deadInterest" : k === "no-resolve-window" ? "noResolveWindow" : k;
        c[key] = (c[key] ?? 0) + 1;
      }
    }
    this.lastCounts = c;
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private alertsFor(all: Tracked[]): { never: Alert[]; warn: Alert[]; matured: Alert[]; interest: Alert[] } {
    const never: Alert[] = [];
    const warn: Alert[] = [];
    const matured: Alert[] = [];
    const interest: Alert[] = [];
    for (const t of all) {
      const addr = t.ctx.marketAddress;
      const lc = t.lc;
      if (lc.neverConnected) {
        never.push({
          kind: "market-never-connected",
          severity: "warn",
          subject: t.label,
          message: `NEVER-CONNECTED (${lc.neverConnected}): the price is not advancing and this keeper has no push path to ${addr}. ${t.registered ? "" : "No registry row. "}Once matured anyone can resolve it with tag 39; creators of such markets are owed the sunk-rent refund.`,
          data: { market: addr, reason: lc.neverConnected, registered: t.registered },
        });
      }
      if (lc.price.kind === "warn") {
        warn.push({
          kind: "market-dead-price",
          severity: "warn",
          subject: t.label,
          message: `DEAD-PRICE warn: price is ${lc.price.pctBps / 100}% of the way to the stale-resolve window (${lc.price.ageSlots}/${lc.price.staleSlots} slots, ${lc.price.remainingSlots} left). ${t.registered && this.d.cfg.warnBandFees ? "Forcing the fee legs now." : "Fee legs (tags 78 / 87) are refused once it matures."}`,
          data: { market: addr, ageSlots: lc.price.ageSlots.toString(), staleSlots: lc.price.staleSlots.toString() },
        });
      }
      if (lc.price.kind === "matured") {
        matured.push({
          kind: "market-dead-price",
          severity: lc.keeperCanPush ? "critical" : "warn",
          subject: t.label,
          message: `DEAD-PRICE MATURED: ${addr} price is ${lc.price.ageSlots} slots old (window ${lc.price.staleSlots}); anyone can resolve it (tag 39). ${lc.keeperCanPush ? "The keeper CAN push this market: check its source and pushes." : "The keeper has no push path to it."} stale resolve=${this.d.cfg.staleResolve}`,
          data: { market: addr, ageSlots: lc.price.ageSlots.toString(), keeperCanPush: lc.keeperCanPush, neverConnected: lc.neverConnected ?? null },
        });
      }
      if (lc.deadInterest) {
        interest.push({
          kind: "market-dead-interest",
          severity: "warn",
          subject: t.label,
          message: `DEAD-INTEREST: ${addr} is priced, open interest is 0 and no trade-fee accrual has been observed for ${Math.floor(lc.quietMs / 86_400_000)} days (observation-based lower bound). Retirement is a deliberate admin action; the keeper does not do it.`,
          data: { market: addr, quietDays: Math.floor(lc.quietMs / 86_400_000) },
        });
      }
    }
    return { never, warn, matured, interest };
  }

  private async reconcileAlerts(all: Tracked[]): Promise<void> {
    try {
      const a = this.alertsFor(all);
      await this.d.sink.reconcile(`${LIFECYCLE_ALERT_SCOPE}:never-connected`, a.never);
      await this.d.sink.reconcile(`${LIFECYCLE_ALERT_SCOPE}:dead-price-warn`, a.warn);
      await this.d.sink.reconcile(`${LIFECYCLE_ALERT_SCOPE}:dead-price-matured`, a.matured);
      await this.d.sink.reconcile(`${LIFECYCLE_ALERT_SCOPE}:dead-interest`, a.interest);
      const held: Alert[] = this.massHold
        ? [{ kind: "stale-resolve-held", severity: "critical", subject: "*", message: `${this.outageShaped} pushable markets are matured while the keeper has a usable source for them: outage-shaped. The keeper is NOT resolving any market; check RPC / the push loop.`, data: { outageShapedMatured: this.outageShaped, threshold: this.d.cfg.massThreshold } }]
        : [];
      await this.d.sink.reconcile(`${LIFECYCLE_ALERT_SCOPE}:resolve-held`, held);
    } catch (err) {
      this.log(`[v22][lifecycle] alert delivery failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  // ── Fee collection in the warn band ────────────────────────────────────────────────────────────────────────────────

  /** Pure plan: which warn-band registry markets get a forced fee round this tick (closest to maturity first, bounded, spaced). */
  planWarnBandFees(all: ReadonlyArray<Tracked>, nowMs: number): Tracked[] {
    const c = this.d.cfg;
    if (!c.warnBandFees || !this.d.forceFees) return [];
    return all
      .filter((t) => t.registered && t.lc.price.kind === "warn" && nowMs - (this.lastFeeAt.get(t.ctx.marketAddress) ?? Number.NEGATIVE_INFINITY) >= c.warnBandFeeSpacingMs)
      .sort((a, b) => (b.lc.price.kind === "warn" && a.lc.price.kind === "warn" ? b.lc.price.pctBps - a.lc.price.pctBps : 0))
      .slice(0, c.warnBandFeeMaxPerTick);
  }

  private async warnBandFees(all: Tracked[]): Promise<void> {
    const nowMs = this.now();
    for (const t of this.planWarnBandFees(all, nowMs)) {
      this.lastFeeAt.set(t.ctx.marketAddress, nowMs);
      try {
        const s = await (this.d.forceFees as (c: V22MarketCtx) => Promise<string>)(t.ctx);
        this.lastFee.set(t.ctx.marketAddress, s);
        this.log(`[v22][lifecycle] ${t.label}: warn-band fee round: ${s}`);
      } catch (err) {
        const m = redactErrorText(err instanceof Error ? err.message : String(err), 140);
        this.lastFee.set(t.ctx.marketAddress, `failed: ${m}`);
        this.log(`[v22][lifecycle] ${t.label}: warn-band fee round failed: ${m}`);
      }
    }
  }

  // ── Permissionless stale resolve ───────────────────────────────────────────────────────────────────────────────────

  private effectiveMode(): "off" | "dry" | "on" {
    const m = this.d.cfg.staleResolve;
    return m === "on" && this.d.dryRun ? "dry" : m;
  }

  private inputFor(t: Tracked, nowMs: number, maturedCount: number): ResolveInput {
    const addr = t.ctx.marketAddress;
    return {
      mode: this.effectiveMode(),
      lc: t.lc,
      continuousMs: this.ledger.continuousMs(nowMs),
      sourceUnavailableMs: this.ledger.sourceUnavailableMs(addr, nowMs),
      maturedCount,
      resolvedThisCycle: this.resolvedThisCycle,
      attempt: this.attempts.get(addr),
      nowMs,
      cfg: this.d.cfg,
    };
  }

  /** Outage-shaped = matured markets the keeper could push and still holds (or recently held) a usable source for. */
  private assessOutage(all: Tracked[], nowMs: number): void {
    this.outageShaped = all.filter((t) => t.lc.price.kind === "matured" && t.lc.keeperCanPush && this.ledger.sourceUnavailableMs(t.ctx.marketAddress, nowMs) < this.d.cfg.minObservationMs).length;
    this.massHold = this.outageShaped > this.d.cfg.massThreshold;
  }

  private async resolveMatured(all: Tracked[]): Promise<void> {
    const mode = this.effectiveMode();
    const nowMs = this.now();
    const matured = all.filter((t) => t.lc.price.kind === "matured");
    for (const t of matured.sort((a, b) => (b.lc.price.kind === "matured" && a.lc.price.kind === "matured" ? Number(b.lc.price.ageSlots - a.lc.price.ageSlots) : 0))) {
      const addr = t.ctx.marketAddress;
      const input = this.inputFor(t, nowMs, this.outageShaped);
      const dec = decideResolve(input);
      this.decisions.set(addr, dec);
      if (mode === "off" || dec.action !== "resolve") continue;
      this.attempts.set(addr, { atMs: nowMs, landed: false }); // marked BEFORE any RPC: one attempt per window, whatever happens next
      this.resolvedThisCycle++;
      const stillOk = RESOLVE_GUARDS.filter((g) => g.name !== ("not-attempted" satisfies GuardName) && g.name !== ("cycle-bound" satisfies GuardName));
      const res = await resolveStaleOnce({
        conn: this.d.conn as never,
        exec: { conn: this.d.conn as never, keeper: this.d.keeper, dryRun: this.d.dryRun, log: this.log },
        programId: this.d.programId,
        market: t.ctx.market,
        label: t.label,
        mode,
        expectedLastGoodOracleSlot: t.lc.price.kind === "matured" ? t.lc.price.lastGoodOracleSlot : 0n,
        reguard: () => {
          const n = this.now();
          const d2 = decideResolve({ ...this.inputFor(t, n, this.outageShaped), attempt: undefined, resolvedThisCycle: 0 }, stillOk);
          return d2.action === "hold" ? `${d2.guard}: ${d2.reason}` : null;
        },
        log: this.log,
      });
      switch (res.kind) {
        case "dry-run":
          this.decisions.set(addr, { action: "dry-run", detail: res.detail });
          this.log(`[v22][lifecycle] DRY-RUN ${res.detail}`);
          break;
        case "sent":
          if (res.landed === "landed") {
            this.attempts.set(addr, { atMs: nowMs, landed: true });
            this.resolvesSent++;
            markTerminal(addr, "resolved");
            this.decisions.set(addr, { action: "sent", signature: res.signature });
            this.log(`[v22][lifecycle] RESOLVED ${t.label} ${addr} with tag 39 sig=${res.signature.slice(0, 16)}…`);
            await this.fireSent(t, res.signature);
          } else {
            this.decisions.set(addr, { action: "error", detail: `tag 39 ${res.landed} sig=${res.signature.slice(0, 16)}…` });
            this.log(`[v22][lifecycle] ${t.label}: tag 39 ${res.landed} (retry only after ${this.d.cfg.resolveRetryMs} ms and a fresh re-read)`);
          }
          break;
        case "held":
          this.decisions.set(addr, { action: "hold", guard: "matured", reason: res.reason });
          this.log(`[v22][lifecycle] ${t.label}: resolve held before send: ${res.reason}`);
          break;
        case "refused":
          this.decisions.set(addr, { action: "error", detail: `refused ${res.name}` });
          this.log(`[v22][lifecycle] ${t.label}: tag 39 refused by the program (${res.name})${res.expected ? " [expected state]" : ""}`);
          break;
        case "failed":
          this.decisions.set(addr, { action: "error", detail: res.error });
          this.log(`[v22][lifecycle] ${t.label}: tag 39 failed: ${res.error}`);
          break;
      }
    }
  }

  private async fireSent(t: Tracked, signature: string): Promise<void> {
    try {
      await this.d.sink.fire(`${LIFECYCLE_ALERT_SCOPE}:resolved`, {
        kind: "stale-resolve-sent",
        severity: "critical",
        subject: t.label,
        message: `keeper RESOLVED ${t.ctx.marketAddress} with tag 39 (permissionless stale resolve, price ${t.lc.price.kind === "matured" ? t.lc.price.ageSlots : "?"} slots old). Settlement runs through the terminal path.`,
        data: { market: t.ctx.marketAddress, signature },
        dedupe: signature,
      });
    } catch {
      // alert delivery must never undo or block anything
    }
  }

  // ── Persistence / health ───────────────────────────────────────────────────────────────────────────────────────────

  private persist(): void {
    if (!this.store) return;
    const nowMs = this.now();
    if (nowMs - this.lastSaveAt < 300_000) return;
    this.lastSaveAt = nowMs;
    this.store.save(Object.fromEntries(this.quiet));
  }

  view(addr: string): LifecycleView | null {
    const t = this.observed.get(addr) ?? this.unreg.get(addr);
    return t ? this.viewOf(t) : null;
  }

  private viewOf(t: Tracked): LifecycleView {
    const lc = t.lc;
    const p = lc.price;
    const dec = this.decisions.get(t.ctx.marketAddress);
    return {
      registered: t.registered,
      classes: lc.classes,
      priceBand: p.kind,
      ageSlots: p.kind === "not-live" ? null : p.ageSlots.toString(),
      staleSlots: p.kind === "fresh" || p.kind === "warn" || p.kind === "matured" ? p.staleSlots.toString() : null,
      pctOfWindow: p.kind === "fresh" || p.kind === "warn" || p.kind === "matured" ? p.pctBps / 100 : null,
      neverConnected: lc.neverConnected,
      keeperCanPush: lc.keeperCanPush,
      oiZero: lc.oiZero,
      quietDays: Math.floor(lc.quietMs / 86_400_000),
      resolve: dec ? (dec.action === "hold" ? { decision: "hold", guard: dec.guard, reason: dec.reason } : dec.action === "resolve" ? { decision: "resolve", guard: null, reason: null } : { decision: dec.action, guard: null, reason: "detail" in dec ? dec.detail : "signature" in dec ? dec.signature : null }) : null,
      fees: this.lastFee.get(t.ctx.marketAddress) ?? null,
    };
  }

  healthFields(): Record<string, unknown> {
    const nowMs = this.now();
    const markets: Record<string, LifecycleView> = {};
    for (const t of [...this.observed.values(), ...this.unreg.values()]) {
      if (t.lc.classes.length === 1 && (t.lc.classes[0] === "healthy" || t.lc.classes[0] === "terminal")) continue;
      markets[t.ctx.marketAddress] = this.viewOf(t);
    }
    return {
      enabled: this.d.cfg.classify,
      staleResolve: this.effectiveMode(),
      warnBandFees: this.d.cfg.warnBandFees,
      observation: this.ledger.snapshot(nowMs),
      counts: { ...this.lastCounts, unregisteredTracked: this.unreg.size },
      outageShapedMatured: this.outageShaped,
      massHold: this.massHold,
      resolvesSent: this.resolvesSent,
      lastDiscoveryAgoMs: Number.isFinite(this.lastDiscoveryAt) ? nowMs - this.lastDiscoveryAt : null,
      markets,
    };
  }
}
