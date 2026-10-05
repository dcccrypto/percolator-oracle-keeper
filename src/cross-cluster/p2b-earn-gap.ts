/**
 * cross-cluster/p2b-earn-gap.ts
 *
 * R3-M1 support: expose and alert on the par - E3 gap of every NON-bound Earn vault.
 *
 * P2b prices a non-bound Earn vault's ENTRY at par and its EXIT at E3 (the pot's physical net of
 * open winner claims). Their difference `parMinusE3Atoms` bounds what a redeemer can be skimmed by
 * the touch order of open portfolios (security review R3-M1): the mitigation is to keep touching
 * EVERY open portfolio each cycle (see `refreshPruneBudget` in recovery-cranker.ts) and to watch
 * this gap. The quantity is computed from raw accounts with the SDK's
 * `nonboundVaultPricingFromAccountsP2b` (market account + the two pot ledgers `["lp_backing_ledger",
 * market, domain u16 LE]` for `registry.domain` and `registry.domain ^ 1`), read-only, on a slow cadence.
 *
 * Eligible markets: an LP-vault registry exists and its bound flag is 0. A market with no registry
 * (or a bound vault) is skipped; a vault with no ledger yet prices at zero on both readings and
 * reports 0, not an error.
 *
 * /health (additive): `earnVaults: [{ market, label, domain, entryNavAtoms, exitNavAtoms,
 * parMinusE3Atoms, parMinusE3Bps, updatedSlot }]`, bigints as decimal strings.
 *
 * Alert (`earn-par-e3-gap`, warn): `parMinusE3Bps > EARN_GAP_ALERT_BPS` (default 100) for at least
 * `EARN_GAP_ALERT_CYCLES` (default 3) consecutive evaluations; cleared when it drops back.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { deriveLpBackingLedger, nonboundVaultPricingFromAccountsP2b } from "@percolatorct/sdk";
import type { Alert } from "./alerting.ts";
import type { VaultMarketSnapshot } from "./p2b-markets.ts";

export interface EarnGapConfig {
  intervalMs: number;
  alertBps: number;
  alertCycles: number;
}

export const DEFAULT_EARN_GAP_CONFIG: EarnGapConfig = { intervalMs: 60_000, alertBps: 100, alertCycles: 3 };

type Env = Readonly<Record<string, string | undefined>>;

/** EARN_GAP_INTERVAL_MS (60000), EARN_GAP_ALERT_BPS (100), EARN_GAP_ALERT_CYCLES (3). Throws on garbage. */
export function earnGapConfigFromEnv(env: Env): EarnGapConfig {
  const get = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}="${raw}" must be an integer in [${min}, ${max}]`);
    return n;
  };
  return {
    intervalMs: get("EARN_GAP_INTERVAL_MS", DEFAULT_EARN_GAP_CONFIG.intervalMs, 1_000, 86_400_000),
    alertBps: get("EARN_GAP_ALERT_BPS", DEFAULT_EARN_GAP_CONFIG.alertBps, 0, 10_000),
    alertCycles: get("EARN_GAP_ALERT_CYCLES", DEFAULT_EARN_GAP_CONFIG.alertCycles, 1, 1_000),
  };
}

/** The /health record of one non-bound Earn vault. */
export interface EarnVaultHealth {
  market: string;
  label: string;
  domain: number;
  entryNavAtoms: string;
  exitNavAtoms: string;
  parMinusE3Atoms: string;
  parMinusE3Bps: number;
  updatedSlot: number;
}

export type EarnGapConnection = Pick<Connection, "getMultipleAccountsInfoAndContext">;

/** A market is a non-bound Earn vault when its registry exists, parsed, and is NOT bound. */
export function isNonBoundEarnVault(s: VaultMarketSnapshot): boolean {
  return s.registry !== null && !s.bound && s.marketData !== null;
}

export class EarnGapMonitor {
  private readonly records = new Map<string, EarnVaultHealth>();
  private readonly streak = new Map<string, number>();
  private readonly loggedErrors = new Set<string>();
  private lastRunAt: number | null = null;

  constructor(
    private readonly cfg: EarnGapConfig,
    private readonly programId: PublicKey,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (l) => console.warn(l),
  ) {}

  /** Is the slow cadence up? */
  isDue(): boolean {
    return this.lastRunAt === null || this.now() - this.lastRunAt >= this.cfg.intervalMs;
  }

  /** Current /health records (a copy), in insertion order. */
  health(): EarnVaultHealth[] {
    return [...this.records.values()];
  }

  /**
   * Evaluate every non-bound Earn vault of `snaps`. Returns the ACTIVE alerts (streak >= alertCycles).
   * A vault that cannot be priced this run keeps no record and resets its streak. Never throws.
   */
  async run(conn: EarnGapConnection, snaps: Iterable<VaultMarketSnapshot>): Promise<Alert[]> {
    this.lastRunAt = this.now();
    const seen = new Set<string>();
    const alerts: Alert[] = [];
    for (const s of snaps) {
      if (!isNonBoundEarnVault(s)) continue;
      const key = s.ref.marketAddress;
      seen.add(key);
      try {
        const domain = s.registry!.domain;
        const [own] = deriveLpBackingLedger(this.programId, s.market, domain);
        const [sib] = deriveLpBackingLedger(this.programId, s.market, domain ^ 1);
        const res = await conn.getMultipleAccountsInfoAndContext([own, sib], "confirmed");
        const [o, b] = res.value;
        const p = nonboundVaultPricingFromAccountsP2b({
          marketData: s.marketData!,
          registryDomain: domain,
          feeShareBps: s.registry!.feeShareBps,
          ownLedgerData: o ? new Uint8Array(o.data) : null,
          siblingLedgerData: b ? new Uint8Array(b.data) : null,
        });
        this.records.set(key, {
          market: key,
          label: s.ref.label,
          domain,
          entryNavAtoms: p.entryNavAtoms.toString(),
          exitNavAtoms: p.exitNavAtoms.toString(),
          parMinusE3Atoms: p.parMinusE3Atoms.toString(),
          parMinusE3Bps: p.parMinusE3Bps,
          updatedSlot: res.context.slot,
        });
        this.loggedErrors.delete(key);
        const n = p.parMinusE3Bps > this.cfg.alertBps ? (this.streak.get(key) ?? 0) + 1 : 0;
        this.streak.set(key, n);
        if (n >= this.cfg.alertCycles) alerts.push(earnGapAlert(s.ref.label, key, p.parMinusE3Bps, p.parMinusE3Atoms, n, this.cfg.alertBps));
      } catch (err) {
        this.records.delete(key);
        this.streak.set(key, 0);
        if (!this.loggedErrors.has(key)) {
          this.loggedErrors.add(key);
          this.log(`[earn-gap] ${s.ref.label}: cannot price the vault (${(err instanceof Error ? err.message : String(err)).slice(0, 120)}) — logged once`);
        }
      }
    }
    // a market that left the set (retired / became bound) leaves /health too
    for (const key of [...this.records.keys()]) {
      if (!seen.has(key)) {
        this.records.delete(key);
        this.streak.delete(key);
      }
    }
    return alerts;
  }
}

export function earnGapAlert(label: string, market: string, bps: number, atoms: bigint, cycles: number, thresholdBps: number): Alert {
  return {
    kind: "earn-par-e3-gap",
    severity: "warn",
    subject: label,
    message:
      `this non-bound Earn vault exits at E3, ${bps} bps (${atoms} atoms) below its par entry price for ${cycles} consecutive checks ` +
      `(threshold ${thresholdBps} bps): a redeemer can lose up to that gap to the portfolio touch order (R3-M1). ` +
      "Every open portfolio must be touched each cycle until the gap closes.",
    data: { market, parMinusE3Bps: bps, parMinusE3Atoms: atoms.toString(), cycles },
  };
}
