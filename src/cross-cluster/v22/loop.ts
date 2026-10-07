/**
 * cross-cluster/v22/loop.ts
 *
 * The v2.2 layer's orchestrator. Created by cross-cluster.ts ONLY when KEEPER_V22=on; with it off nothing here is
 * imported into a running path (the legacy delegation hooks stay empty).
 *
 *   - `sweepDelegate`  installed into the recovery cranker (delegation.ts) when KEEPER_V22_SWEEP=on: for a variant-B
 *     market the per-cycle accrue+refresh work is this layer's settle round (sweep.ts) instead of the #147 sweep.
 *   - `tick()`         every KEEPER_V22_TICK_MS, per v2.2 market: bond fee crank (78), holding rent (106), dust sweep
 *     (118), G9 (111), stake sync (stake 31), keeper Earn exits (77). Each job is its own flag and is skipped
 *     when its flag is off.
 *   - /health          `v22` block (health.ts): flags, per-market band / pin health, pairing stats, per-job counters.
 *
 * Every send goes through exec.ts (simulate first; dry-run logs "would send"). A market whose layout is not variant B
 * is ignored (the legacy cranker owns v1 / v2.1); a market whose layout is UNKNOWN is a loud, counted problem
 * (layout-guard-metrics.ts), never a silent fallback.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { deriveInsuranceUnitsV22, deriveStakePool } from "@percolatorct/sdk";
import type { MarketEntry } from "../registry.ts";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { decodeMarketRefreshState, isAssetLossStale } from "../positioned-refresh.ts";
import { setCrankRefreshHealth } from "../refresh-coordination.ts";
import { LOSS_STALE_ALERT_CYCLES } from "../recovery-cranker.ts";
import { describeV22Flags, pairingActive } from "./flags.ts";
import type { V22Flags } from "./flags.ts";
import { allJobCounters } from "./exec.ts";
import type { ExecContext } from "./exec.ts";
import { crankOracleAccounts, loadV22Market } from "./market.ts";
import type { V22MarketCtx, V22MarketLoad } from "./market.ts";
import { loadV22Positioned, lpNearLiquidation, parseAccrueAnchors } from "./positioned.ts";
import type { V22Positioned } from "./positioned.ts";
import { DEFAULT_SWEEP_ROUND_CONFIG, freshGapBackoff, pairingStats, runSettleRound } from "./sweep.ts";
import type { GapBackoff, RentPlanInput as RoundInputRent, RoundResult, SweepDeps, SweepRoundConfig } from "./sweep.ts";
import { redactErrorText } from "./redact.ts";
import { loneLpCrankSuppressed, markV22Market, portfolioWeight, weightBudgetFor } from "./settle-pairing.ts";
import { crankBondFee } from "./fee-bond.ts";
import { freshRentState, markRentSettled, planRentSettles, settleRentOnce } from "./rent.ts";
import { buildSettleHoldingRentIxV22 } from "@percolatorct/sdk";
import { freshDustState, sweepDustOnce } from "./dust.ts";
import { freshG9State, g9Once } from "./g9.ts";
import { freshStakeSyncState, stakeSyncOnce } from "./stake-sync.ts";
import { executeKeeperExits, fetchRedemptionRequests, freshEarnExitState } from "./earn-exit.ts";
import { bandHealthFor } from "./band.ts";
import type { BandHealth } from "./band.ts";
import { setBondFeeDelegated, setLoneLpCrankSuppressor, setProtectiveTrigger, setSweepDelegate } from "./delegation.ts";
import type { SweepDelegateArgs } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";

export interface V22LoopDeps {
  conn: Connection;
  keeper: Keypair;
  programId: PublicKey;
  /** The live registry (hot-reloaded in place). */
  markets: () => ReadonlyArray<Pick<MarketEntry, "marketAddress" | "label" | "lpPortfolio">>;
  flags: V22Flags;
  /** Global DRY_RUN / --dry-run. */
  dryRun: boolean;
  /** Mainnet-flavoured wrapper: G9 modes 0 and 2 take the allowlist + leg accounts. */
  mainnetBuild?: boolean;
  anchors?: Map<string, PublicKey>;
  feeIntervalMs?: number;
  now?: () => number;
  log?: (s: string) => void;
}

interface MarketRuntime {
  rent: ReturnType<typeof freshRentState>;
  dust: ReturnType<typeof freshDustState>;
  g9: ReturnType<typeof freshG9State>;
  stake: ReturnType<typeof freshStakeSyncState>;
  quarantine: Map<string, bigint>;
  gapBackoff: GapBackoff;
  earn: ReturnType<typeof freshEarnExitState>;
  lastProtectiveAtMs: number;
  lossStaleCycles: number;
  lastFeeAtMs: number;
  lastEarnAtMs: number;
  lastBand: BandHealth | null;
  lastRound: { paired: boolean; txs: number; lpSettled: boolean; gapSlots: number | null; abandoned: string | null; settled: number; missing: number; protective: boolean; at: number } | null;
  lastG9: string | null;
  lastFee: string | null;
  lastStake: string | null;
  lastEarn: string | null;
  layoutNote: string | null;
  positionedCache: { at: number; value: V22Positioned } | null;
  sweepInflight: boolean;
}

const POSITIONED_TTL_MS = 10_000;

export class V22Loop {
  private readonly rt = new Map<string, MarketRuntime>();
  private readonly log: (s: string) => void;
  private readonly now: () => number;
  private ticks = 0;
  private lastTickAt: number | null = null;
  private layoutProblems = new Map<string, string>();

  constructor(private readonly d: V22LoopDeps) {
    this.log = d.log ?? ((s) => console.log(s));
    this.now = d.now ?? Date.now;
  }

  private rtFor(addr: string): MarketRuntime {
    let r = this.rt.get(addr);
    if (!r) {
      r = {
        rent: freshRentState(),
        dust: freshDustState(),
        g9: freshG9State(),
        stake: freshStakeSyncState(),
        quarantine: new Map(),
        gapBackoff: freshGapBackoff(),
        earn: freshEarnExitState(),
        lastProtectiveAtMs: 0,
        lossStaleCycles: 0,
        lastFeeAtMs: 0,
        lastEarnAtMs: 0,
        lastBand: null,
        lastRound: null,
        lastG9: null,
        lastFee: null,
        lastStake: null,
        lastEarn: null,
        layoutNote: null,
        positionedCache: null,
        sweepInflight: false,
      };
      this.rt.set(addr, r);
    }
    return r;
  }

  private execCtx(): ExecContext {
    return { conn: this.d.conn, keeper: this.d.keeper, dryRun: this.d.dryRun || this.d.flags.dryRun, log: this.log };
  }

  private roundConfig(): SweepRoundConfig {
    return { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: this.d.flags.pairing, weightBudget: weightBudgetFor() };
  }

  /** Install the legacy-path hooks. Called once at startup. */
  install(): void {
    const f = this.d.flags;
    if (f.sweep) setSweepDelegate((a) => this.sweepDelegate(a));
    if (f.feeCrankBond) setBondFeeDelegated(true);
    setLoneLpCrankSuppressor((m) => loneLpCrankSuppressed({ loneLpCrankFlag: f.loneLpCrank, pairingActive: pairingActive(f), isV22Market: this.isV22(m) }));
    if (pairingActive(f)) setProtectiveTrigger((m) => void this.protectiveRound(m).catch(() => {}));
    setV22HealthProvider(() => this.healthFields());
  }

  private isV22(addr: string): boolean {
    return this.rt.has(addr) && this.rt.get(addr)?.layoutNote === "v2.2-b";
  }

  private async positionedFor(ctx: V22MarketCtx, r: MarketRuntime): Promise<V22Positioned | null> {
    const t = this.now();
    if (r.positionedCache && t - r.positionedCache.at < POSITIONED_TTL_MS) return r.positionedCache.value;
    const v = await loadV22Positioned(this.d.conn, ctx, (this.d.anchors ?? parseAccrueAnchors(process.env.KEEPER_V22_ACCRUE_ANCHORS)).get(ctx.market.toBase58()) ?? null, this.d.keeper.publicKey);
    if (v) r.positionedCache = { at: t, value: v };
    return v;
  }

  private noteLoad(entry: { marketAddress: string }, load: V22MarketLoad): V22MarketCtx | null {
    const r = this.rtFor(entry.marketAddress);
    if (load.ok) {
      r.layoutNote = "v2.2-b";
      this.layoutProblems.delete(entry.marketAddress);
      markV22Market(entry.marketAddress);
      return load.ctx;
    }
    if (load.reason === "not-v22") return null;
    r.layoutNote = load.reason;
    this.layoutProblems.set(entry.marketAddress, `${load.reason}: ${load.detail}`.slice(0, 200));
    return null;
  }

  private sweepDeps(): SweepDeps {
    return { exec: this.execCtx(), getSlot: () => this.d.conn.getSlot("confirmed") };
  }

  /**
   * The recovery cranker's per-market hook for a variant-B market (KEEPER_V22_SWEEP). Returns true ONLY when this layer
   * actually ran (or a round is already running); on every "could not run" path it returns FALSE so the legacy
   * accrual-only crank still runs this cycle (review F-5: the engine clock must keep moving).
   */
  async sweepDelegate(a: SweepDelegateArgs): Promise<boolean> {
    return this.runRoundFor(a.conn, a.entry, false);
  }

  private async runRoundFor(conn: Connection, entry: { marketAddress: string; label: string; lpPortfolio?: string }, protective: boolean): Promise<boolean> {
    const r = this.rtFor(entry.marketAddress);
    if (r.sweepInflight) return true; // a round is running and accrues the market
    r.sweepInflight = true;
    try {
      const load = await loadV22Market(conn, entry, this.d.programId);
      const ctx = this.noteLoad(entry, load);
      if (!ctx) return false;
      r.lastBand = bandHealthFor(ctx);
      if (ctx.refresh.lifecycle !== 2 && ctx.refresh.lifecycle !== 3) return false; // not Active / DrainOnly
      const positioned = await this.positionedFor(ctx, r);
      if (!positioned || !positioned.lp) {
        this.log(`[v22][sweep] ${ctx.label}: no vault LP portfolio or the positioned set is unreadable; leaving this cycle to the legacy accrual crank`);
        return false;
      }
      const f = this.d.flags;
      // Rent settles ride the round (tag 106 in place of that portfolio's refresh), only when pairing is acting.
      let rent: RoundInputRent | undefined;
      if (f.holdingRent && ctx.isRent && pairingActive(f)) {
        const plan = planRentSettles(ctx, positioned, r.rent, f.rentCadenceSlots, true, 4);
        if (plan.due.length > 0) {
          const oracle = crankOracleAccounts(ctx);
          rent = { due: new Set(plan.due.map((x) => x.portfolio)), build: (p) => buildSettleHoldingRentIxV22(ctx.sdk, this.d.keeper.publicKey, p.pubkey, 0, BigInt(ctx.readSlot), ctx.oracleMode === 1 ? oracle : []) };
        }
      }
      const res = await runSettleRound(
        this.sweepDeps(),
        { market: ctx.market, label: ctx.label },
        {
          lp: positioned.lp.pubkey,
          lpWeight: portfolioWeight(positioned.lp),
          counterparties: positioned.counterparties,
          anchor: positioned.flatAnchor,
          oracleAccounts: crankOracleAccounts(ctx),
          quarantine: r.quarantine,
          nowSlot: ctx.readSlot,
          gapBackoff: r.gapBackoff,
          rent,
          protective,
        },
        this.roundConfig(),
      );
      if (rent) {
        markRentSettled(r.rent, ctx, res.rentSettled);
        pairingStats.rentSettlesInRound += res.rentSettled.length;
      }
      r.positionedCache = null; // positions changed
      this.recordRound(ctx, r, res, positioned, protective);
      await this.publishHealth(ctx, r, positioned, res);
      // 78 at the END of a paired round (the LP was just settled with its counterparties), not on its own timer.
      if (f.feeCrankBond && ctx.bond && res.lpSettled && this.now() - r.lastFeeAtMs >= (this.d.feeIntervalMs ?? 200_000)) {
        r.lastFeeAtMs = this.now();
        const fee = await crankBondFee(this.sweepDeps(), ctx, positioned, { mode: this.d.flags.pairing, weightBudget: weightBudgetFor(), afterRound: true });
        r.lastFee = fee.kind === "skipped" ? `skipped: ${fee.reason}` : `after-round ${fee.kind}`;
      }
      return true;
    } catch (err) {
      this.log(`[v22][sweep] ${entry.label}: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
      return false;
    } finally {
      r.sweepInflight = false;
    }
  }

  /**
   * Protective trigger (installed into the suppressed lone-LP-crank path): when the LP itself is near liquidation or a
   * senior draw is pending, run a full PAIRED round NOW instead of waiting for the next crank cycle. Never a lone LP
   * crank. Latency without it: up to one crank cycle (CRANK_INTERVAL_MS, default 20 s) plus the round; with it: the
   * time of one round (about 1-5 s) after the landed push. Debounced per market.
   */
  private async protectiveRound(marketAddress: string): Promise<void> {
    const entry = this.d.markets().find((m) => m.marketAddress === marketAddress);
    if (!entry || !this.isV22(marketAddress)) return;
    const r = this.rtFor(marketAddress);
    if (r.sweepInflight || this.now() - r.lastProtectiveAtMs < 5_000) return;
    r.lastProtectiveAtMs = this.now();
    const load = await loadV22Market(this.d.conn, entry, this.d.programId);
    if (!load.ok) return;
    const ctx = load.ctx;
    let lpData: Uint8Array | null = null;
    if (ctx.lpPortfolio) {
      const info = await this.d.conn.getAccountInfo(ctx.lpPortfolio, "processed");
      lpData = info ? new Uint8Array(info.data) : null;
    }
    if (ctx.seniorDrawOutstandingAtoms > 0n || lpNearLiquidation(lpData)) {
      this.log(`[v22][protect] ${ctx.label}: LP needs protection (${ctx.seniorDrawOutstandingAtoms > 0n ? "senior draw pending" : "near liquidation"}): running a full paired round now`);
      r.positionedCache = null;
      await this.runRoundFor(this.d.conn, entry, true);
    }
  }

  private recordRound(ctx: V22MarketCtx, r: MarketRuntime, res: RoundResult, positioned: V22Positioned, protective: boolean): void {
    const misses = res.missing.filter((m) => m.why !== "current");
    r.lastRound = { paired: res.plan.paired && misses.length === 0, txs: res.plan.txs.length, lpSettled: res.lpSettled, gapSlots: res.gapSlots, abandoned: res.abandoned, settled: res.settled.length, missing: misses.length, protective, at: this.now() };
    const summary = `${r.lastRound.paired ? "PAIRED" : "UNPAIRED"}${protective ? " (protective)" : ""} ${res.plan.txs.length} tx(s), lp ${res.lpSettled ? "settled" : res.plan.lpDeferred ? "deferred (strict)" : "not settled"}, settled ${res.settled.length}/${positioned.counterparties.length} counterparties, missing ${misses.length}, pruned ${res.pruned}${res.gapSlots !== null ? `, gap ${res.gapSlots} slots` : ""}${res.abandoned ? `, ${res.abandoned}` : ""}`;
    this.log(`[v22][sweep] ${ctx.label}: ${summary}`);
  }

  private async publishHealth(ctx: V22MarketCtx, r: MarketRuntime, positioned: V22Positioned, res: RoundResult): Promise<void> {
    let post = ctx.refresh;
    try {
      const info = await this.d.conn.getAccountInfo(ctx.market, "processed");
      if (info) post = decodeMarketRefreshState(new Uint8Array(info.data));
    } catch {
      // keep the pre-read
    }
    const stale = isAssetLossStale(post);
    r.lossStaleCycles = stale ? r.lossStaleCycles + 1 : 0;
    setCrankRefreshHealth(ctx.marketAddress, {
      staleLong: Number(ctx.refresh.staleLong),
      staleShort: Number(ctx.refresh.staleShort),
      postStaleLong: Number(post.staleLong),
      postStaleShort: Number(post.staleShort),
      positioned: positioned.all.length,
      overflow: res.missing.filter((m) => m.why !== "current").length,
      overflowRefreshed: 0,
      overflowError: res.abandoned,
      lossStaleCycles: r.lossStaleCycles,
      status: r.lossStaleCycles >= LOSS_STALE_ALERT_CYCLES ? "loss-stale" : "ok",
      layout: { id: ctx.layout.id, problem: null, kind: "ok", accountLen: ctx.data.length, provisional: ctx.layout.provisional, hasPositions: positioned.all.length > 0 },
      updatedAt: this.now(),
    });
  }

  /** One pass of the non-sweep jobs over every registry market. Never throws. */
  async tick(): Promise<void> {
    this.ticks++;
    this.lastTickAt = this.now();
    const f = this.d.flags;
    const exec = this.execCtx();
    for (const entry of this.d.markets()) {
      try {
        const load = await loadV22Market(this.d.conn, entry, this.d.programId);
        const ctx = this.noteLoad(entry, load);
        if (!ctx) continue;
        const r = this.rtFor(entry.marketAddress);
        r.lastBand = bandHealthFor(ctx);
        if (r.sweepInflight) continue;
        const needsPositioned = f.feeCrankBond || f.holdingRent || f.dustSweep;
        const positioned = needsPositioned ? await this.positionedFor(ctx, r) : null;
        const pairing = pairingActive(f) ? f.pairing : "off";

        // With the sweep + pairing on, 78 runs at the end of a paired round (runRoundFor); this timer is the sweep-off path.
        if (f.feeCrankBond && ctx.bond && !pairingActive(f) && this.now() - r.lastFeeAtMs >= (this.d.feeIntervalMs ?? 200_000)) {
          r.lastFeeAtMs = this.now();
          const res = await crankBondFee(this.sweepDeps(), ctx, positioned, { mode: pairing, weightBudget: weightBudgetFor() });
          r.lastFee = res.kind === "skipped" ? `skipped: ${res.reason}` : res.kind;
        }
        // With the sweep + pairing on, rent settles ride the round (tag 106 in place of the refresh); this is the sweep-off path.
        if (f.holdingRent && ctx.isRent && positioned && !pairingActive(f)) {
          const res = await settleRentOnce(exec, ctx, positioned, r.rent, { cadenceSlots: f.rentCadenceSlots, pairingActive: pairingActive(f) });
          if (res.outcomes.length > 0) this.log(`[v22][rent] ${ctx.label}: ${res.outcomes.length} settle(s) ${res.outcomes.map((o) => o.outcome.kind).join(",")}`);
        }
        if (f.dustSweep && ctx.isBand && positioned) {
          await sweepDustOnce(exec, ctx, positioned, r.dust);
        }
        if (f.g9) {
          const unitsInfo = await this.d.conn.getAccountInfo(deriveInsuranceUnitsV22(this.d.programId, ctx.market)[0], "processed");
          const g = await g9Once(exec, ctx, unitsInfo ? new Uint8Array(unitsInfo.data) : null, r.g9, { dryRun: f.g9DryRun, allowAnyOracleMode: f.g9AllowAnyOracleMode, mainnetBuild: this.d.mainnetBuild === true, drawCapAtoms: f.g9DrawCapAtoms });
          r.lastG9 = g.action.kind === "none" || g.action.kind === "wait" ? `${g.action.kind}: ${g.action.reason}` : `${g.action.kind}: ${g.outcome?.kind ?? "n/a"}`;
        }
        if (f.stakeSync) {
          const poolInfo = await this.d.conn.getAccountInfo(deriveStakePool(ctx.market, STAKE_PROGRAM_ID)[0], "processed");
          const s = await stakeSyncOnce(exec, ctx, poolInfo ? new Uint8Array(poolInfo.data) : null, r.stake, { intervalMs: f.stakeSyncIntervalMs, nowMs: this.now() });
          r.lastStake = s.kind;
          if (s.kind === "diverged") this.log(`[v22][stake-sync] ${ctx.label}: InsuranceReadingsDiverged(44): refused; backing off ${r.stake.diverged} time(s), no retry until the backoff ends`);
        }
        if (f.earnExit && this.now() - r.lastEarnAtMs >= 30_000) {
          r.lastEarnAtMs = this.now();
          const reqs = await fetchRedemptionRequests(this.d.conn, ctx);
          const ex = await executeKeeperExits(exec, ctx, reqs, 2, r.earn);
          r.lastEarn = ex.gate.ok ? `executed ${ex.outcomes.length}` : `gated: ${ex.gate.reason}`;
        }
      } catch (err) {
        this.log(`[v22] ${entry.label}: tick error: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
      }
    }
  }

  healthFields(): Record<string, unknown> {
    const markets: Record<string, unknown> = {};
    for (const [addr, r] of this.rt) {
      if (r.layoutNote === null) continue;
      markets[addr] = {
        layout: r.layoutNote,
        ...(r.lastBand ? { band: r.lastBand } : {}),
        ...(r.lastRound ? { lastRound: r.lastRound } : {}),
        ...(r.lastFee ? { fee78: r.lastFee } : {}),
        ...(r.lastG9 ? { g9: r.lastG9 } : {}),
        ...(r.lastStake ? { stakeSync: r.lastStake } : {}),
        ...(r.lastEarn ? { earnExit: r.lastEarn } : {}),
        ...(this.layoutProblems.has(addr) ? { layoutProblem: redactErrorText(this.layoutProblems.get(addr) as string, 200) } : {}),
      };
    }
    return {
      flags: describeV22Flags(this.d.flags),
      ticks: this.ticks,
      lastTickAgoMs: this.lastTickAt === null ? null : this.now() - this.lastTickAt,
      pairing: { ...pairingStats },
      jobs: allJobCounters(),
      layoutProblems: Object.fromEntries([...this.layoutProblems].map(([k, v]) => [k, redactErrorText(v, 200)])),
      markets,
    };
  }
}

/** Run `tick` on an interval until the process ends. Never throws out. */
export async function startV22Loop(loop: V22Loop, tickMs: number): Promise<void> {
  for (;;) {
    try {
      await loop.tick();
    } catch (err) {
      console.error(`[v22] tick crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
