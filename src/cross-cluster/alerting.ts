/**
 * cross-cluster/alerting.ts
 *
 * Structured health lines and alerts for the keeper (ops track, master plan
 * 2026-09-29).
 *
 * Why: "keeper healthy" used to be inferred from successful price pushes, and
 * that hid a 3.5-day engine-clock freeze (2026-09-25 -> 09-28): pushes kept
 * landing while every crank reverted. The signals that actually say a market
 * is alive are the ones this module watches:
 *
 *   - slot lag       chain slot − engine `header.current_slot` (the engine clock)
 *   - crank ok/rev   consecutive crank reverts per market
 *   - pushes/cycle   price pushes landed in each push cycle
 *   - lapsed buckets Fresh backing buckets past expiry (block one side)
 *   - bankrupt       positioned accounts with equity <= 0 not liquidated
 *   - fee jobs       fee legs that cannot be pushed (e.g. stake pool unbound)
 *   - ADL reduce-only  a_long/a_short != ADL_ONE (F-3/R2): opens revert
 *                    Custom(21) until one whole side exits; reported with the
 *                    observed duration and both sides' OI so an abandoned
 *                    position is visible
 *
 * Output:
 *   `[health] {json}`  one line per sample batch, machine-parseable
 *   `[ALERT] {json}`   when a condition crosses its threshold, then at most
 *                      once per cooldown while it persists, and one
 *                      `[ALERT-RESOLVED] {json}` when it clears.
 *   Optional webhook:  KEEPER_ALERT_WEBHOOK_URL (https only). The body is
 *                      `{ text, alert }` — `text` works for Slack/Discord
 *                      incoming webhooks as-is. Delivery failures are logged
 *                      and never thrown: alerting must not take down a loop.
 *
 * Evaluation is a pure function of (sample, thresholds, previous state) so it
 * is unit-testable without RPC; the sink owns dedupe/cooldown and delivery.
 */

export type AlertSeverity = "warn" | "critical";

export type AlertKind =
  | "slot-lag"
  | "crank-reverts"
  | "zero-pushes"
  | "lapsed-bucket"
  | "bankrupt-unliquidated"
  | "fee-leg-blocked"
  | "fee-job-failed"
  | "adl-reduce-only";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** Market label or address; "*" for keeper-wide conditions. */
  subject: string;
  message: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface AlertThresholds {
  /** Slots the engine clock may trail the chain before alerting. */
  slotLagWarn: number;
  /** ... and before the alert is critical (the accrue-staleness cliff is ~475 slots). */
  slotLagCritical: number;
  /** Consecutive crank reverts on one market before alerting. */
  crankConsecutiveReverts: number;
  /** Consecutive push cycles that landed zero pushes (with markets registered). */
  zeroPushCycles: number;
  /** Consecutive crank cycles a lapsed bucket persists (repairs should clear it in one). */
  lapsedBucketCycles: number;
  /** Consecutive crank cycles a bankrupt account persists un-liquidated. */
  bankruptCycles: number;
  /** Minimum ms between repeats of the same (kind, subject) alert. */
  cooldownMs: number;
  /** Slots a market may stay ADL reduce-only before the alert turns critical (R2). */
  adlReduceOnlyCriticalSlots: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  slotLagWarn: 300,
  slotLagCritical: 450,
  crankConsecutiveReverts: 3,
  zeroPushCycles: 10,
  lapsedBucketCycles: 3,
  bankruptCycles: 2,
  cooldownMs: 15 * 60_000,
  adlReduceOnlyCriticalSlots: 9_000, // ~1 hour
};

type Env = Readonly<Record<string, string | undefined>>;

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${name}="${raw}" must be a positive integer`);
  }
  return n;
}

/** Thresholds from env (ALERT_*), falling back to DEFAULT_THRESHOLDS. Throws on garbage. */
export function thresholdsFromEnv(env: Env): AlertThresholds {
  const t: AlertThresholds = {
    slotLagWarn: envInt(env, "ALERT_SLOT_LAG_WARN", DEFAULT_THRESHOLDS.slotLagWarn),
    slotLagCritical: envInt(env, "ALERT_SLOT_LAG_CRITICAL", DEFAULT_THRESHOLDS.slotLagCritical),
    crankConsecutiveReverts: envInt(env, "ALERT_CRANK_REVERTS", DEFAULT_THRESHOLDS.crankConsecutiveReverts),
    zeroPushCycles: envInt(env, "ALERT_ZERO_PUSH_CYCLES", DEFAULT_THRESHOLDS.zeroPushCycles),
    lapsedBucketCycles: envInt(env, "ALERT_LAPSED_BUCKET_CYCLES", DEFAULT_THRESHOLDS.lapsedBucketCycles),
    bankruptCycles: envInt(env, "ALERT_BANKRUPT_CYCLES", DEFAULT_THRESHOLDS.bankruptCycles),
    cooldownMs: envInt(env, "ALERT_COOLDOWN_MS", DEFAULT_THRESHOLDS.cooldownMs),
    adlReduceOnlyCriticalSlots: envInt(env, "ALERT_ADL_REDUCE_ONLY_CRITICAL_SLOTS", DEFAULT_THRESHOLDS.adlReduceOnlyCriticalSlots),
  };
  if (t.slotLagCritical < t.slotLagWarn) {
    throw new Error("ALERT_SLOT_LAG_CRITICAL must be >= ALERT_SLOT_LAG_WARN");
  }
  return t;
}

// ── Per-market crank health ──────────────────────────────────────────────────

/** What the recovery cranker observed for one market in one cycle. */
export interface CrankHealthSample {
  label: string;
  market: string;
  /** Slot the market account was read at. */
  chainSlot: bigint;
  /** Engine `header.current_slot` in that read; null when the header did not decode. */
  engineSlot: bigint | null;
  /** Crank landed clean this cycle (preflight ok + sent). */
  crankOk: boolean;
  /** Crank reverted in preflight this cycle. */
  crankReverted: boolean;
  totalOk: number;
  totalReverts: number;
  consecutiveReverts: number;
  lastRevertCode: number | null;
  /** Fresh backing buckets past expiry at read time. */
  lapsedBuckets: number;
  /** Bankrupt positioned accounts found in simulation this cycle. */
  bankruptFound: number;
  /** ... of which a liquidate crank was included in the landed tx. */
  bankruptLiquidated: number;
  /** ADL side factors + effective OI (adl-state.ts); null when not a v18 market header. */
  adl?: { aLong: bigint; aShort: bigint; oiEffLong: bigint; oiEffShort: bigint; reduceOnly: boolean } | null;
}

/** Streak counters carried between cycles, per market. */
export interface CrankHealthStreaks {
  lapsedCycles: number;
  bankruptCycles: number;
  /**
   * First observation of the current reduce-only episode: chain slot + wall ms.
   * The chain keeps no "entered reduce-only at", so this is "observed since"
   * (reset by a keeper restart); `sinceBoot` flags that caveat in the alert.
   */
  reduceOnlySince: { slot: bigint; ms: number; sinceBoot: boolean } | null;
  /** True once any sample with a decoded ADL state was seen for this market. */
  adlObserved: boolean;
}

export function freshStreaks(): CrankHealthStreaks {
  return { lapsedCycles: 0, bankruptCycles: 0, reduceOnlySince: null, adlObserved: false };
}

const ADL_ONE_ = 1_000_000_000_000_000n;
function frac(a: bigint): string {
  const x = (a * 1_000_000n) / ADL_ONE_;
  return `${x / 1_000_000n}.${(x % 1_000_000n).toString().padStart(6, "0")}`;
}

export function slotLag(s: Pick<CrankHealthSample, "chainSlot" | "engineSlot">): number | null {
  if (s.engineSlot === null) return null;
  const lag = s.chainSlot - s.engineSlot;
  return Number(lag < 0n ? 0n : lag);
}

/**
 * Evaluate one market sample. Returns the alerts that are ACTIVE now and the
 * updated streaks. Pure.
 */
export function evaluateCrankHealth(
  s: CrankHealthSample,
  prev: CrankHealthStreaks,
  t: AlertThresholds,
  nowMs: number = Date.now(),
): { active: Alert[]; streaks: CrankHealthStreaks } {
  const active: Alert[] = [];
  // ADL reduce-only (F-3/R2). Unknown (null/undefined) never alerts and never
  // resets an episode: a single undecodable read is not evidence it ended.
  let reduceOnlySince = prev.reduceOnlySince;
  if (s.adl) {
    if (!s.adl.reduceOnly) {
      reduceOnlySince = null;
    } else {
      reduceOnlySince = reduceOnlySince ?? { slot: s.chainSlot, ms: nowMs, sinceBoot: !prev.adlObserved };
      const slots = s.chainSlot > reduceOnlySince.slot ? s.chainSlot - reduceOnlySince.slot : 0n;
      const minutes = Math.floor((nowMs - reduceOnlySince.ms) / 60_000);
      const { aLong, aShort, oiEffLong, oiEffShort } = s.adl;
      const oneSideEmpty = oiEffLong === 0n || oiEffShort === 0n;
      active.push({
        kind: "adl-reduce-only",
        severity: slots >= BigInt(t.adlReduceOnlyCriticalSlots) ? "critical" : "warn",
        subject: s.label,
        message:
          `ADL reduce-only for >= ${slots} slots (~${minutes} min observed${reduceOnlySince.sinceBoot ? ", since keeper boot" : ""}): ` +
          `a_long=${frac(aLong)} a_short=${frac(aShort)} x ADL_ONE; OI long ${oiEffLong} / short ${oiEffShort}. ` +
          "Opens revert Custom(21) until one whole side exits; holders exit with tag 44 RebalanceReduce" +
          (oneSideEmpty ? "." : ". Both sides still hold OI — an abandoned position keeps the market reduce-only (R2)."),
        data: {
          market: s.market,
          aLong: aLong.toString(),
          aShort: aShort.toString(),
          oiEffLong: oiEffLong.toString(),
          oiEffShort: oiEffShort.toString(),
          reduceOnlySlots: Number(slots),
          reduceOnlyMinutes: minutes,
          sinceSlot: reduceOnlySince.slot.toString(),
        },
      });
    }
  }
  const lag = slotLag(s);
  if (lag !== null && lag >= t.slotLagWarn) {
    active.push({
      kind: "slot-lag",
      severity: lag >= t.slotLagCritical ? "critical" : "warn",
      subject: s.label,
      message:
        `engine clock ${lag} slots behind chain (engine ${s.engineSlot} vs chain ${s.chainSlot}) — ` +
        "cranks are not advancing this market; risk-increasing trades will revert Custom(21) past the staleness cliff",
      data: { lag, engineSlot: String(s.engineSlot), chainSlot: String(s.chainSlot), market: s.market },
    });
  }
  if (s.consecutiveReverts >= t.crankConsecutiveReverts) {
    active.push({
      kind: "crank-reverts",
      severity: "critical",
      subject: s.label,
      message: `crank reverted ${s.consecutiveReverts}x consecutively (last Custom(${s.lastRevertCode ?? "?"}))`,
      data: { consecutive: s.consecutiveReverts, lastCode: s.lastRevertCode, ok: s.totalOk, rev: s.totalReverts, market: s.market },
    });
  }
  const lapsedCycles = s.lapsedBuckets > 0 ? prev.lapsedCycles + 1 : 0;
  if (lapsedCycles >= t.lapsedBucketCycles) {
    active.push({
      kind: "lapsed-bucket",
      severity: "warn",
      subject: s.label,
      message: `${s.lapsedBuckets} lapsed backing bucket(s) for ${lapsedCycles} cycles — the expiry repair is not landing; one side cannot trade`,
      data: { lapsedBuckets: s.lapsedBuckets, cycles: lapsedCycles, market: s.market },
    });
  }
  const unliquidated = Math.max(0, s.bankruptFound - s.bankruptLiquidated);
  const bankruptCycles = unliquidated > 0 ? prev.bankruptCycles + 1 : 0;
  if (bankruptCycles >= t.bankruptCycles) {
    active.push({
      kind: "bankrupt-unliquidated",
      severity: "critical",
      subject: s.label,
      message: `${unliquidated} bankrupt account(s) not liquidated for ${bankruptCycles} cycles — losses keep growing against the backstop`,
      data: { bankrupt: s.bankruptFound, liquidated: s.bankruptLiquidated, cycles: bankruptCycles, market: s.market },
    });
  }
  return { active, streaks: { lapsedCycles, bankruptCycles, reduceOnlySince, adlObserved: prev.adlObserved || !!s.adl } };
}

/** Compact JSON for the `[health]` line. */
export function crankHealthRecord(s: CrankHealthSample): Record<string, string | number | null> {
  return {
    m: s.label,
    lag: slotLag(s),
    ok: s.totalOk,
    rev: s.totalReverts,
    cons: s.consecutiveReverts,
    lapsed: s.lapsedBuckets,
    bankrupt: s.bankruptFound,
    liq: s.bankruptLiquidated,
    ...(s.adl?.reduceOnly
      ? { ro: 1, aL: frac(s.adl.aLong), aS: frac(s.adl.aShort), oiL: s.adl.oiEffLong.toString(), oiS: s.adl.oiEffShort.toString() }
      : {}),
  };
}

// ── Push-cycle health ────────────────────────────────────────────────────────

export interface PushCycleSample {
  cycle: number;
  registered: number;
  attempted: number;
  pushed: number;
}

export function evaluatePushCycle(
  s: PushCycleSample,
  prevZeroStreak: number,
  t: AlertThresholds,
): { active: Alert[]; zeroStreak: number } {
  const zeroStreak = s.registered > 0 && s.pushed === 0 ? prevZeroStreak + 1 : 0;
  const active: Alert[] = [];
  if (zeroStreak >= t.zeroPushCycles) {
    active.push({
      kind: "zero-pushes",
      severity: "critical",
      subject: "*",
      message: `no price push landed for ${zeroStreak} consecutive cycles (${s.registered} markets registered, ${s.attempted} attempted last cycle) — every AuthMark is frozen`,
      data: { zeroStreak, registered: s.registered, attempted: s.attempted },
    });
  }
  return { active, zeroStreak };
}

// ── Sink: dedupe, cooldown, delivery ─────────────────────────────────────────

export type WebhookPoster = (url: string, body: string) => Promise<void>;

export interface AlertSinkOptions {
  thresholds: AlertThresholds;
  webhookUrl?: string;
  post?: WebhookPoster;
  now?: () => number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

const defaultPost: WebhookPoster = async (url, body) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Validate the webhook URL. https only: the URL is itself a credential for
 * most webhook providers, and alerts carry market state. Returns the URL, or
 * throws with a message that does NOT echo the URL (it would land in logs).
 */
export function validateWebhookUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("KEEPER_ALERT_WEBHOOK_URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("KEEPER_ALERT_WEBHOOK_URL must use https://");
  return u.toString();
}

export class AlertSink {
  private readonly lastSent = new Map<string, number>();
  /** Active alert key -> the severity it last fired with (echoed on RESOLVED). */
  private readonly activeKeys = new Map<string, AlertSeverity>();
  private readonly opts: Required<Omit<AlertSinkOptions, "webhookUrl">> & { webhookUrl?: string };

  constructor(opts: AlertSinkOptions) {
    this.opts = {
      thresholds: opts.thresholds,
      webhookUrl: opts.webhookUrl,
      post: opts.post ?? defaultPost,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((l) => console.log(l)),
      logError: opts.logError ?? ((l) => console.error(l)),
    };
  }

  get thresholds(): AlertThresholds {
    return this.opts.thresholds;
  }

  /** Emit one structured health line. */
  health(scope: string, record: Record<string, unknown>): void {
    this.opts.log(`[health] ${JSON.stringify({ scope, ts: new Date(this.opts.now()).toISOString(), ...record }, bigintSafe)}`);
  }

  /**
   * Report the full set of ACTIVE alerts for one scope (e.g. all markets of a
   * crank cycle). New or cooled-down alerts fire; alerts of this scope that
   * are no longer active fire a single RESOLVED line. Returns what fired.
   */
  async reconcile(scope: string, active: Alert[]): Promise<Alert[]> {
    const now = this.opts.now();
    const fired: Alert[] = [];
    const activeNow = new Set<string>();
    for (const a of active) {
      const key = `${scope}|${a.kind}|${a.subject}`;
      activeNow.add(key);
      const last = this.lastSent.get(key);
      if (last === undefined || now - last >= this.opts.thresholds.cooldownMs) {
        this.lastSent.set(key, now);
        fired.push(a);
        await this.deliver("ALERT", a);
      }
    }
    for (const [key, sev] of [...this.activeKeys]) {
      if (!key.startsWith(`${scope}|`) || activeNow.has(key)) continue;
      this.activeKeys.delete(key);
      this.lastSent.delete(key);
      const [, kind, subject] = key.split("|");
      await this.deliver("ALERT-RESOLVED", {
        kind: kind as AlertKind,
        severity: sev,
        subject,
        message: "condition cleared",
      });
    }
    for (const a of active) this.activeKeys.set(`${scope}|${a.kind}|${a.subject}`, a.severity);
    return fired;
  }

  /** Fire a one-off alert immediately (still subject to the cooldown). */
  async fire(scope: string, a: Alert): Promise<boolean> {
    const key = `${scope}|${a.kind}|${a.subject}`;
    const now = this.opts.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.opts.thresholds.cooldownMs) return false;
    this.lastSent.set(key, now);
    await this.deliver("ALERT", a);
    return true;
  }

  private async deliver(tag: "ALERT" | "ALERT-RESOLVED", a: Alert): Promise<void> {
    const line = `[${tag}] ${JSON.stringify(a, bigintSafe)}`;
    if (tag === "ALERT") this.opts.logError(line);
    else this.opts.log(line);
    if (!this.opts.webhookUrl) return;
    const text = `${tag === "ALERT" ? `[${a.severity.toUpperCase()}]` : "[RESOLVED]"} percolator-keeper ${a.kind} ${a.subject}: ${a.message}`;
    try {
      await this.opts.post(this.opts.webhookUrl, JSON.stringify({ text, alert: a }, bigintSafe));
    } catch (err) {
      // Never echo the URL — it is a credential.
      this.opts.logError(`[alerting] webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/**
 * Process-wide sink, configured from env. Lazily created so importing this
 * module in tests has no side effects.
 */
let shared: AlertSink | null = null;
export function getAlertSink(): AlertSink {
  if (!shared) {
    shared = new AlertSink({
      thresholds: thresholdsFromEnv(process.env),
      webhookUrl: validateWebhookUrl(process.env.KEEPER_ALERT_WEBHOOK_URL),
    });
  }
  return shared;
}
