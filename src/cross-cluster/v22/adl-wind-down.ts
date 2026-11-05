/**
 * cross-cluster/v22/adl-wind-down.ts   (KEEPER_V22_ADL_WIND_DOWN, default OFF, its own flag)
 *
 * Tag 104 `AdlWindDown` sender for v2.2 markets: the bounded exit from ADL reduce-only ("close-only").
 *
 * Why this exists. The only tag-104 sender the keeper had is the v2.1 P2b runner (../p2b-wind-down.ts). On v2.2 it never
 * runs, for three independent reasons (instr104 investigation 2026-11-05):
 *   1. the P2b layer's feature probe simulates tag 103 without the `["bond_tranche", market]` account [9] that every
 *      bond market requires since Phase 4, so the program answers NotEnoughAccountKeys, the probe calls that "unknown",
 *      and the whole P2b layer stays OFF forever (it re-probes every minute and never logs);
 *   2. its market reader is v2.1-only (`isV18MarketHeader`, VERSION 18), so a v2.2 (VERSION 19) market reads as null;
 *   3. its holder scan keeps only 9,563 B (v2.1) portfolios; v2.2 portfolios are 10,603 B.
 * D1 (d1-watch.ts) only MONITORS, and only band markets. So a v2.2 market that latched (A < ADL_ONE on a side) stayed
 * close-only indefinitely: devnet SOL (a_short 0.9349) had never been armed on chain.
 *
 * Design: the PROGRAM decides, the keeper only reads its answer. Each turn, for a close-only asset, the keeper simulates
 * tag 104 on one holder and parses the wrapper's `sol_log_64` line:
 *   (104, 0, since, bound, now)  not eligible yet. `since == now` means THIS call would arm the episode (nobody has):
 *                                send it once. `since < now` means armed and waiting: send nothing, sleep until
 *                                `since + bound`.
 *   (104, 1, closed_q, cleared, now)  this call would close the holder's whole leg at the mark: send it, then the next
 *                                holder, up to `maxClosesPerTurn`.
 *   a refusal                    classified and counted, never raised (21 lagging/pending mark or deficit account,
 *                                27 stale pushed mark, 16 stale binding, 22 not in ADL).
 * No v2.2 offset of the episode record is decoded here (none is needed), so a layout change cannot make the keeper
 * guess. Every send is simulated first (simulateAndSend); dry-run (KEEPER_V22_DRY_RUN / DRY_RUN) sends nothing.
 *
 * Side choice: the same rule as the reviewed v2.1 runner (reduceOnlySide): close legs on the side whose A < ADL_ONE
 * (both: the side with fewer holders). The engine closes one whole leg per call and the last leg of a side zeroes
 * both sides and starts both resets (engine v16.rs `wind_down_adl_position_not_atomic`). The vault LP is closed last.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { buildAdlWindDownIx, parsePortfolioV17 } from "@percolatorct/sdk";
import { ADL_ONE, decodeAdlState } from "../adl-state.ts";
import { reduceOnlySide } from "../p2b-wind-down.ts";
import { fetchMarketPortfolios } from "../recovery-cranker.ts";
import { engineSlotBase } from "../market-layout.ts";
import { observationAssetsFor } from "../multi-asset.ts";
import { simulateAndSend, simulateOnly } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import { crankOracleAccounts } from "./market.ts";
import type { V22MarketCtx } from "./market.ts";

/** `collateral_mint` inside the wrapper config (market offset 16 + 32), the account tag 104 checks at [3]. */
const CFG_COLLATERAL_MINT_OFF = 48;
export const WIND_DOWN_V22_UNITS = 600_000;
/** After a turn that sent nothing and learned nothing (refusal / no holders), leave the asset alone this long. */
export const WIND_DOWN_V22_RETRY_SLOTS = 150n;

export type WindDownLog =
  | { kind: "not-eligible"; since: bigint; bound: bigint; now: bigint }
  | { kind: "closed"; closedQ: bigint; cleared: boolean; now: bigint }
  | { kind: "none" };

/** Parse the wrapper's `sol_log_64(104, ...)` line out of simulation logs. Pure. */
export function parseWindDownLog(logs: ReadonlyArray<string> | null | undefined): WindDownLog {
  for (const l of logs ?? []) {
    const m = l.match(/Program log: 0x68, 0x([01]), 0x([0-9a-f]+), 0x([0-9a-f]+), 0x([0-9a-f]+)\s*$/i);
    if (!m) continue;
    const [a, b, c] = [BigInt(`0x${m[2]}`), BigInt(`0x${m[3]}`), BigInt(`0x${m[4]}`)];
    if (m[1] === "0") return { kind: "not-eligible", since: a, bound: b, now: c };
    return { kind: "closed", closedQ: a, cleared: b !== 0n, now: c };
  }
  return { kind: "none" };
}

export interface WindDownHolder {
  pubkey: PublicKey;
  portfolioId: bigint;
  positionEpoch: bigint;
  longLegs: number;
  shortLegs: number;
  isLp: boolean;
}

/** Portfolios with an active leg on `assetIndex`, at the market's v2.2 portfolio length. Pure. */
export function windDownHolders(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  assetIndex: number,
  portfolioLen: number,
  lp: PublicKey | null,
): WindDownHolder[] {
  const out: WindDownHolder[] = [];
  for (const { pubkey, data } of accounts) {
    if (data.length !== portfolioLen) continue;
    let p;
    try {
      p = parsePortfolioV17(data);
    } catch {
      continue;
    }
    let longLegs = 0;
    let shortLegs = 0;
    for (const leg of p.legs) {
      if (!leg.active || leg.assetIndex !== assetIndex) continue;
      if (leg.side === 0) longLegs++;
      else shortLegs++;
    }
    if (longLegs + shortLegs === 0) continue;
    out.push({ pubkey, portfolioId: p.portfolioId, positionEpoch: p.matcherPositionEpoch, longLegs, shortLegs, isLp: lp !== null && pubkey.equals(lp) });
  }
  return out;
}

/** Targets for a close turn: the reduce-only side's holders, the vault LP last, then by key (deterministic). Pure. */
export function windDownTargets(adl: { aLong: bigint; aShort: bigint }, holders: ReadonlyArray<WindDownHolder>): WindDownHolder[] {
  const longs = holders.filter((h) => h.longLegs > 0);
  const shorts = holders.filter((h) => h.shortLegs > 0);
  const side = reduceOnlySide(adl, longs.length, shorts.length);
  const on = side === "long" ? longs : shorts;
  return [...(on.length > 0 ? on : holders)].sort((a, b) => (a.isLp !== b.isLp ? (a.isLp ? 1 : -1) : a.pubkey.toBase58() < b.pubkey.toBase58() ? -1 : 1));
}

export interface WindDownV22State {
  /** `market|asset` -> slot before which the asset is not simulated again. */
  nextSlot: Map<string, bigint>;
}
export const freshWindDownV22State = (): WindDownV22State => ({ nextSlot: new Map() });

export type WindDownV22Action =
  | { kind: "armed"; outcome: ExecOutcome }
  | { kind: "waiting"; since: bigint; eligibleAtSlot: bigint }
  | { kind: "closed"; outcomes: ExecOutcome[]; cleared: boolean }
  | { kind: "refused"; name: string }
  | { kind: "skipped"; reason: string };

export interface WindDownV22Result {
  assetIndex: number;
  action: WindDownV22Action;
}

export interface WindDownV22Deps {
  exec: ExecContext;
  /** Portfolio accounts of the market (default: one filtered getProgramAccounts at the layout's portfolio length). */
  fetchPortfolios?: (market: PublicKey, portfolioLen: number) => Promise<Array<{ pubkey: PublicKey; data: Uint8Array }>>;
  /** Test seams (default: exec.ts). */
  simulate?: typeof simulateOnly;
  send?: typeof simulateAndSend;
  maxClosesPerTurn?: number;
  log?: (s: string) => void;
}

function defaultFetch(conn: Connection) {
  return async (market: PublicKey, len: number) =>
    (await fetchMarketPortfolios(conn, market, len)).map((a) => ({ pubkey: a.pubkey, data: new Uint8Array(a.account.data) }));
}

/**
 * One turn over every close-only Active/DrainOnly asset of a v2.2 market. Never throws. Sends at most one arming call,
 * or up to `maxClosesPerTurn` closes, per asset.
 */
export async function windDownV22Once(ctx: V22MarketCtx, st: WindDownV22State, d: WindDownV22Deps): Promise<WindDownV22Result[]> {
  const out: WindDownV22Result[] = [];
  const log = d.log ?? d.exec.log ?? ((s: string) => console.log(s));
  const simulate = d.simulate ?? simulateOnly;
  const send = d.send ?? simulateAndSend;
  const nowSlot = BigInt(ctx.readSlot);
  let holdersCache: Array<{ pubkey: PublicKey; data: Uint8Array }> | null = null;
  for (const assetIndex of observationAssetsFor(ctx.marketAddress)) {
    const k = `${ctx.marketAddress}|${assetIndex}`;
    try {
      const adl = decodeAdlState(ctx.data, assetIndex);
      if (!adl || (adl.aLong === ADL_ONE && adl.aShort === ADL_ONE)) {
        st.nextSlot.delete(k);
        continue;
      }
      const lifecycle = ctx.data[engineSlotBase(ctx.layout, assetIndex) + ctx.layout.asset.lifecycle];
      if (lifecycle !== 2 && lifecycle !== 3) continue; // only Active / DrainOnly assets can be wound down
      if ((st.nextSlot.get(k) ?? 0n) > nowSlot) continue;
      holdersCache ??= await (d.fetchPortfolios ?? defaultFetch(d.exec.conn as unknown as Connection))(ctx.market, ctx.layout.portfolioAccountLen);
      const holders = windDownHolders(holdersCache, assetIndex, ctx.layout.portfolioAccountLen, ctx.lpPortfolio);
      if (holders.length === 0) {
        st.nextSlot.set(k, nowSlot + WIND_DOWN_V22_RETRY_SLOTS);
        out.push({ assetIndex, action: { kind: "skipped", reason: "no holders" } });
        continue;
      }
      const mint = new PublicKey(ctx.data.subarray(CFG_COLLATERAL_MINT_OFF, CFG_COLLATERAL_MINT_OFF + 32));
      const ixFor = (h: WindDownHolder): TransactionInstruction =>
        buildAdlWindDownIx(
          ctx.programId,
          { caller: d.exec.keeper.publicKey, market: ctx.market, portfolio: h.pubkey, collateralMint: mint },
          { nowSlot, assetIndex, portfolioId: h.portfolioId, positionEpoch: h.positionEpoch },
          crankOracleAccounts(ctx),
        );
      const targets = windDownTargets(adl, holders);
      const probe = await simulate(d.exec, [ixFor(targets[0])], { units: WIND_DOWN_V22_UNITS });
      if (probe.err) {
        const name = probe.code !== null ? `Custom(${probe.code})` : JSON.stringify(probe.err).slice(0, 80);
        st.nextSlot.set(k, nowSlot + WIND_DOWN_V22_RETRY_SLOTS);
        out.push({ assetIndex, action: { kind: "refused", name } });
        continue;
      }
      const view = parseWindDownLog(probe.logs);
      if (view.kind === "none") {
        st.nextSlot.set(k, nowSlot + WIND_DOWN_V22_RETRY_SLOTS);
        out.push({ assetIndex, action: { kind: "skipped", reason: "no tag-104 log in the simulation (price not caught up?)" } });
        continue;
      }
      if (view.kind === "not-eligible") {
        const eligibleAt = view.since + view.bound;
        if (view.since === view.now) {
          // Nobody armed this episode: this call records the start slot on chain.
          const outcome = await send(d.exec, [ixFor(targets[0])], { job: "adl-104", label: `${ctx.label} arm a${assetIndex}`, units: WIND_DOWN_V22_UNITS });
          log(`[v22][adl-104] ${ctx.label} asset ${assetIndex}: arming the wind-down episode (eligible at slot ~${eligibleAt}): ${outcome.kind}`);
          st.nextSlot.set(k, outcome.kind === "sent" && outcome.landed === "landed" ? eligibleAt : nowSlot + WIND_DOWN_V22_RETRY_SLOTS);
          out.push({ assetIndex, action: { kind: "armed", outcome } });
        } else {
          st.nextSlot.set(k, eligibleAt > nowSlot ? eligibleAt : nowSlot + 1n);
          out.push({ assetIndex, action: { kind: "waiting", since: view.since, eligibleAtSlot: eligibleAt } });
        }
        continue;
      }
      // Eligible: close the reduce-only side, one whole leg per call, each simulated again by simulateAndSend.
      const outcomes: ExecOutcome[] = [];
      let cleared = false;
      for (const h of targets.slice(0, d.maxClosesPerTurn ?? 3)) {
        const outcome = await send(d.exec, [ixFor(h)], { job: "adl-104", label: `${ctx.label} close a${assetIndex} ${h.pubkey.toBase58().slice(0, 6)}${h.isLp ? " (vault LP)" : ""}`, units: WIND_DOWN_V22_UNITS });
        outcomes.push(outcome);
        const eff = outcome.kind === "sent" || outcome.kind === "dry-run" ? parseWindDownLog(outcome.logs) : { kind: "none" as const };
        if (eff.kind === "closed" && eff.cleared) cleared = true;
        if (outcome.kind !== "sent" && outcome.kind !== "dry-run") break; // a refusal: re-read next turn
        if (cleared) break;
      }
      log(`[v22][adl-104] ${ctx.label} asset ${assetIndex}: wind-down close x${outcomes.length} [${outcomes.map((o) => o.kind).join(",")}]${cleared ? " — ADL cleared" : ""}`);
      st.nextSlot.set(k, nowSlot + 1n);
      out.push({ assetIndex, action: { kind: "closed", outcomes, cleared } });
    } catch (err) {
      st.nextSlot.set(k, nowSlot + WIND_DOWN_V22_RETRY_SLOTS);
      out.push({ assetIndex, action: { kind: "skipped", reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) } });
    }
  }
  return out;
}
