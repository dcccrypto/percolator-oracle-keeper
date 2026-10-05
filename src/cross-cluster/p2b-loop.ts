/**
 * cross-cluster/p2b-loop.ts
 *
 * The v2.1 ("P2b") keeper layer: one loop that hosts
 *   - tag 103 VaultLpAllocate cranks        (p2b-allocate.ts)
 *   - tag 104 AdlWindDown cranks            (p2b-wind-down.ts)
 *   - the hedged-lockout alert              (p2b-hedged-lockout.ts)
 *   - the Earn par-E3 gap monitor + /health (p2b-earn-gap.ts)
 * behind the feature gate (p2b-feature.ts).
 *
 * NO-OP BEFORE THE v2.1 PROGRAM: every tick starts with `gate.ensure()`. While the gate says
 * "unsupported" the tick returns immediately, so on today's programs the layer's whole footprint is
 * the gate's one cached probe (a registry/state read and a simulation per long TTL) and nothing is
 * ever sent, read or added to /health.
 *
 * Each tick reads ONE batched snapshot of every registry market (market + registry + vault_lp_state,
 * p2b-markets.ts) and hands it to the tasks that are due:
 *   wind-down  every tick (cheap when no market is close-only: no further RPC)
 *   allocate   per market, paced (default 60 s +-25%, p2b-allocate.ts)
 *   hedged     every HEDGED_LOCKOUT_INTERVAL_MS (30 s; only markets with a growth block cost an RPC)
 *   earn gap   every EARN_GAP_INTERVAL_MS (60 s; 1 RPC per non-bound vault)
 * The tick never throws and the loop never exits (same contract as the other keeper loops).
 */
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { AlertSink } from "./alerting.ts";
import type { MarketEntry, Registry } from "./registry.ts";
import { readVaultMarketSnapshots } from "./p2b-markets.ts";
import type { MarketRef, SnapshotConnection, VaultMarketSnapshot } from "./p2b-markets.ts";
import type { P2bFeatureGate } from "./p2b-feature.ts";
import { VaultLpAllocator } from "./p2b-allocate.ts";
import { AdlWindDownRunner } from "./p2b-wind-down.ts";
import { evaluateHedgedLockouts } from "./p2b-hedged-lockout.ts";
import type { HedgedLockoutRecord, HedgedLockoutThresholds } from "./p2b-hedged-lockout.ts";
import { EarnGapMonitor } from "./p2b-earn-gap.ts";
import { applyBalanceReading, createWalletBalanceState, formatSol, recordBalanceReadFailure, shouldRefreshBalance } from "./wallet-balance-guard.ts";
import type { WalletBalanceState } from "./wallet-balance-guard.ts";

export interface P2bLoopConfig {
  tickMs: number;
  hedgedIntervalMs: number;
  minKeeperBalanceLamports: number;
  balanceCheckIntervalMs: number;
  /** Print the structured `[health]` line every N ticks. */
  healthEveryTicks: number;
}

export const DEFAULT_P2B_LOOP_CONFIG: Omit<P2bLoopConfig, "minKeeperBalanceLamports" | "balanceCheckIntervalMs"> = {
  tickMs: 20_000,
  hedgedIntervalMs: 30_000,
  healthEveryTicks: 15,
};

type Env = Readonly<Record<string, string | undefined>>;

/** P2B_TICK_MS (20000), HEDGED_LOCKOUT_INTERVAL_MS (30000). Throws on garbage. */
export function p2bLoopConfigFromEnv(env: Env, minKeeperBalanceLamports: number, balanceCheckIntervalMs: number): P2bLoopConfig {
  const get = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1_000 || n > 86_400_000) throw new Error(`${name}="${raw}" must be an integer in [1000, 86400000]`);
    return n;
  };
  return {
    tickMs: get("P2B_TICK_MS", DEFAULT_P2B_LOOP_CONFIG.tickMs),
    hedgedIntervalMs: get("HEDGED_LOCKOUT_INTERVAL_MS", DEFAULT_P2B_LOOP_CONFIG.hedgedIntervalMs),
    minKeeperBalanceLamports,
    balanceCheckIntervalMs,
    healthEveryTicks: DEFAULT_P2B_LOOP_CONFIG.healthEveryTicks,
  };
}

export type P2bLoopConnection = SnapshotConnection & Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfoAndContext" | "getBalance">;

export interface P2bLoopDeps {
  conn: P2bLoopConnection;
  keeper: Keypair;
  programId: PublicKey;
  registry: Pick<Registry, "markets">;
  gate: P2bFeatureGate;
  sink: Pick<AlertSink, "reconcile" | "health">;
  allocator: VaultLpAllocator;
  windDown: AdlWindDownRunner;
  earnGap: EarnGapMonitor;
  hedged: HedgedLockoutThresholds;
  now?: () => number;
}

export interface P2bTickSummary {
  /** false: the gate said unsupported and the tick did nothing. */
  active: boolean;
  markets: number;
  snapshots: number;
  allocate: Record<string, number>;
  windDownMarkets: number;
  hedgedEvaluated: boolean;
  earnEvaluated: boolean;
}

function toRef(m: MarketEntry): MarketRef {
  return { marketAddress: m.marketAddress, label: m.label, assetIndex: m.assetIndex ?? 0 };
}

export class P2bLoop {
  private readonly wallet: WalletBalanceState = createWalletBalanceState();
  private lastHedgedAt = 0;
  private hedgedRecords: HedgedLockoutRecord[] = [];
  private ticks = 0;

  constructor(
    private readonly cfg: P2bLoopConfig,
    private readonly deps: P2bLoopDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  walletLow(): boolean {
    return this.wallet.low;
  }

  private async refreshWallet(): Promise<void> {
    const now = this.now();
    if (!shouldRefreshBalance(this.wallet, now, this.cfg.balanceCheckIntervalMs)) return;
    try {
      const lamports = await this.deps.conn.getBalance(this.deps.keeper.publicKey, "confirmed");
      const edge = applyBalanceReading(this.wallet, lamports, this.cfg.minKeeperBalanceLamports, now);
      if (edge === "went-low") console.warn(`[p2b] keeper wallet low (${formatSol(lamports)} SOL): tag 103/104 sends paused`);
      else if (edge === "recovered") console.log(`[p2b] keeper wallet recovered (${formatSol(lamports)} SOL): tag 103/104 sends resumed`);
    } catch {
      recordBalanceReadFailure(this.wallet, now); // keep the previous verdict: an RPC failure is not evidence of funds
    }
  }

  /** One pass. Never throws. */
  async tick(): Promise<P2bTickSummary> {
    const summary: P2bTickSummary = { active: false, markets: 0, snapshots: 0, allocate: {}, windDownMarkets: 0, hedgedEvaluated: false, earnEvaluated: false };
    try {
      if (!(await this.deps.gate.ensure())) return summary;
      summary.active = true;
      this.ticks++;
      const refs = this.deps.registry.markets.map(toRef);
      summary.markets = refs.length;
      if (refs.length === 0) return summary;
      await this.refreshWallet();
      const snaps = await readVaultMarketSnapshots(this.deps.conn, this.deps.programId, refs);
      summary.snapshots = snaps.size;
      const list: VaultMarketSnapshot[] = [...snaps.values()];

      // 1. tag 104: every tick, close-only markets only
      this.deps.windDown.beginCycle();
      for (const s of list) {
        const r = await this.deps.windDown.runMarket(s);
        if (r.kind === "acted") summary.windDownMarkets++;
      }

      // 2. tag 103: per-market pacing inside the allocator
      for (const s of list) {
        const o = await this.deps.allocator.runMarket(s);
        summary.allocate[o] = (summary.allocate[o] ?? 0) + 1;
      }
      await this.deps.sink.reconcile("p2b:allocate", this.deps.allocator.activeAlerts());

      // 3. hedged-lockout
      if (this.now() - this.lastHedgedAt >= this.cfg.hedgedIntervalMs) {
        this.lastHedgedAt = this.now();
        const h = await evaluateHedgedLockouts(this.deps.conn, list, this.deps.hedged);
        this.hedgedRecords = h.records;
        await this.deps.sink.reconcile("p2b:hedged-lockout", h.alerts);
        summary.hedgedEvaluated = true;
      }

      // 4. Earn par-E3 gap
      if (this.deps.earnGap.isDue()) {
        const alerts = await this.deps.earnGap.run(this.deps.conn, list);
        await this.deps.sink.reconcile("p2b:earn-gap", alerts);
        summary.earnEvaluated = true;
      }

      if (this.ticks % this.cfg.healthEveryTicks === 1) {
        this.deps.sink.health("p2b", {
          markets: summary.markets,
          allocate: this.deps.allocator.stats,
          windDown: this.deps.windDown.stats,
          earnVaults: this.deps.earnGap.health().length,
          hedgedEvaluated: this.hedgedRecords.length,
          walletLow: this.wallet.low,
        });
      }
    } catch (err) {
      console.error(`[p2b] tick error — ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
    return summary;
  }

  /**
   * Extra /health fields, or `{}` while the layer is off (so the payload is unchanged on today's programs).
   * `earnVaults` is the R3-M1 par-E3 gap per non-bound Earn vault; `p2b` carries the counters.
   */
  healthFields(): Record<string, unknown> {
    if (!this.deps.gate.isSupported()) return {};
    return {
      earnVaults: this.deps.earnGap.health(),
      p2b: {
        gate: this.deps.gate.snapshot(),
        allocate: this.deps.allocator.stats,
        windDown: this.deps.windDown.stats,
        hedgedLockout: this.hedgedRecords.map((r) => ({
          market: r.market,
          label: r.label,
          status: r.verdict.status,
          utilLongBps: r.verdict.utilLongBps === null ? null : Number(r.verdict.utilLongBps),
          utilShortBps: r.verdict.utilShortBps === null ? null : Number(r.verdict.utilShortBps),
          lpNetBps: r.verdict.lpNetBps === null ? null : Number(r.verdict.lpNetBps),
        })),
        walletLow: this.wallet.low,
      },
    };
  }
}

/** The long-running loop. Never awaited by the entrypoint, never throws out. */
export async function startP2bLoop(loop: P2bLoop, cfg: Pick<P2bLoopConfig, "tickMs">): Promise<void> {
  console.log(`[p2b] loop starting: tick=${cfg.tickMs}ms (a strict no-op until the wrapper answers the tag-103 probe)`);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    const start = Date.now();
    await loop.tick();
    await new Promise((r) => setTimeout(r, Math.max(1000, cfg.tickMs - (Date.now() - start))));
  }
}
