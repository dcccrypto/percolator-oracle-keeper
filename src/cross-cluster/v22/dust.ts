/**
 * cross-cluster/v22/dust.ts   (KEEPER_V22_DUST_SWEEP, default OFF, its own flag)
 *
 * Tag 118 SweepBandDustLeg: closes a band leg whose notional at the current mark is below HALF the market minimum,
 * bilaterally against the bound vault LP at the current mark, with no fee. Accounts [caller][market w][portfolio w]
 * [bound vault LP w]. Band markets only.
 *
 * HAZARD (Wave B review N-6 / v22-band-defaults doc): keep this OFF on any live market whose deployed wrapper
 * predates the bilateral fix (the first version used a unilateral reduce that pushed the asset close-only). Even
 * with the flag on, the keeper never decides "dust" itself: it ranks portfolios by their smallest leg and lets the
 * program's own simulation decide. A refused simulation puts the portfolio on a cool-down; only a clean one is sent.
 */
import { buildSweepBandDustLegIxV22 } from "@percolatorct/sdk";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";
import type { V22Positioned } from "./positioned.ts";
import { legAwareTxUnits } from "./settle-pairing.ts";

export interface DustState {
  /** `market|portfolio` -> slot until which the portfolio is not simulated again. */
  cooldownUntil: Map<string, bigint>;
}
export const freshDustState = (): DustState => ({ cooldownUntil: new Map() });
export const DUST_COOLDOWN_SLOTS = 9_000n;
export const DUST_TX_UNITS = 600_000;

/** Candidates: smallest leg first, skipping cool-downs and the LP. Pure. */
export function dustCandidates(ctx: V22MarketCtx, positioned: V22Positioned, st: DustState, max: number): string[] {
  if (!ctx.isBand) return [];
  const now = BigInt(ctx.readSlot);
  return positioned.counterparties
    .map((p) => ({ k: p.pubkey.toBase58(), abs: positioned.minLegAbs.get(p.pubkey.toBase58()) ?? null }))
    .filter((x) => x.abs !== null)
    .filter((x) => (st.cooldownUntil.get(`${ctx.marketAddress}|${x.k}`) ?? 0n) <= now)
    .sort((a, b) => ((a.abs as bigint) < (b.abs as bigint) ? -1 : (a.abs as bigint) > (b.abs as bigint) ? 1 : a.k < b.k ? -1 : 1))
    .slice(0, max)
    .map((x) => x.k);
}

export async function sweepDustOnce(
  exec: ExecContext,
  ctx: V22MarketCtx,
  positioned: V22Positioned,
  st: DustState,
  maxPerTick = 3,
): Promise<Array<{ portfolio: string; outcome: ExecOutcome }>> {
  if (!ctx.isBand || !ctx.lpPortfolio) return [];
  const out: Array<{ portfolio: string; outcome: ExecOutcome }> = [];
  for (const k of dustCandidates(ctx, positioned, st, maxPerTick)) {
    const p = positioned.counterparties.find((x) => x.pubkey.toBase58() === k);
    if (!p) continue;
    const ix = buildSweepBandDustLegIxV22(ctx.sdk, exec.keeper.publicKey, p.pubkey, 0);
    const outcome = await simulateAndSend(exec, [ix], { job: "dust-118", label: `${ctx.label} ${k.slice(0, 6)}`, units: legAwareTxUnits(p, DUST_TX_UNITS) });
    out.push({ portfolio: k, outcome });
    if (outcome.kind === "refused") st.cooldownUntil.set(`${ctx.marketAddress}|${k}`, BigInt(ctx.readSlot) + DUST_COOLDOWN_SLOTS);
  }
  return out;
}
