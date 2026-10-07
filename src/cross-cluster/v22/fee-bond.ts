/**
 * cross-cluster/v22/fee-bond.ts   (KEEPER_V22_FEE_CRANK_BOND)
 *
 * Tag 78 (LpVaultCrankFees) on a BOND market. Once the registry's bond flag (struct byte 146) is set, 78 REQUIRES
 *   [7] vault_lp_ext (w)   [8] the vault LP portfolio (WRITABLE: it is re-certified before the bonds are valued)
 *   [9] the bond tranche PDA (w)
 * and fails closed without them (Wave C review N-1). 78 also fails closed when the LP cannot be refreshed, so the
 * LP is cranked (tag 5) FIRST, in the same transaction.
 *
 * SETTLE_PAIRING: that LP crank settles the LP. Under the pairing policy the tx is
 *   [LP crank, refresh <every counterparty>, 78]   when LP + counterparties + 78 fit the weight budget (paired), else
 *   prefer: [LP crank, 78]  (counted as an unpaired LP settle)        strict: [78] alone if its simulation passes,
 *   otherwise the fee crank is DEFERRED (fees can wait; the sweep settles the LP paired).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { deriveBondTrancheV22, deriveLpBackingLedger, deriveLpVaultRegistry, deriveVaultLpExtP2b, withBondTailV22 } from "@percolatorct/sdk";
import { buildCrankFeesIx } from "../lp-fee-cranker.ts";
import { buildObservationCrankIx, buildRefreshCrankIx } from "../positioned-refresh.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";
import type { V22Positioned } from "./positioned.ts";
import { portfolioWeight } from "./settle-pairing.ts";
import type { PairingMode } from "./flags.ts";

/** Engine "no new fees to distribute": healthy no-op. */
export const NO_FEES_TO_CRANK = 38;
/** Weight of the tag-78 instruction (about 400k CU at 35k per weight unit). */
export const FEE_78_WEIGHT = 12;

export type BondFeeSkip = "not-bond" | "no-ext" | "no-lp" | "not-bound" | "program-mismatch";

/** The tag-78 instruction of a bond market (exported for the account-list tests). */
export function buildBondCrankFeesIx(ctx: V22MarketCtx, keeper: PublicKey): TransactionInstruction {
  if (!ctx.lpPortfolio) throw new Error("bond tag 78 needs the vault LP portfolio");
  const [registry] = deriveLpVaultRegistry(ctx.programId, ctx.market);
  const [ledger] = deriveLpBackingLedger(ctx.programId, ctx.market, ctx.registryDomain);
  const [siblingLedger] = deriveLpBackingLedger(ctx.programId, ctx.market, ctx.registryDomain ^ 1);
  const base = buildCrankFeesIx({
    keeper,
    market: ctx.market,
    registry,
    ledger,
    siblingLedger,
    domainIdx: ctx.registryDomain,
    bound: true,
    tail: { vaultLpExt: deriveVaultLpExtP2b(ctx.programId, ctx.market)[0], lpPortfolio: ctx.lpPortfolio },
  });
  return withBondTailV22(base, deriveBondTrancheV22(ctx.programId, ctx.market)[0]);
}

export function bondFeeSkipReason(ctx: V22MarketCtx): BondFeeSkip | null {
  if (!ctx.bond) return "not-bond";
  if (!ctx.bound) return "not-bound";
  if (!ctx.ext) return "no-ext";
  if (!ctx.lpPortfolio) return "no-lp";
  if (!ctx.programId.equals(WRAPPER_PROGRAM_ID)) return "program-mismatch";
  return null;
}

export type BondFeeShape = "paired" | "lp-only-unpaired" | "fee-only" | "deferred";

export interface BondFeePlan {
  shape: BondFeeShape;
  ixs: TransactionInstruction[];
  note: string;
}

/** Choose the tx shape for the pairing mode. Pure. */
export function planBondFee(ctx: V22MarketCtx, keeper: PublicKey, positioned: V22Positioned | null, mode: PairingMode, weightBudget: number): BondFeePlan {
  const fee = buildBondCrankFeesIx(ctx, keeper);
  const lp = ctx.lpPortfolio as PublicKey;
  const lpCrank = buildObservationCrankIx(keeper, ctx.market, lp);
  if (mode === "off") return { shape: "lp-only-unpaired", ixs: [lpCrank, fee], note: "pairing off: [LP crank, 78]" };
  const cps = positioned?.counterparties ?? [];
  const lpW = positioned?.lp ? portfolioWeight(positioned.lp) : 3;
  const w = cps.reduce((n, p) => n + portfolioWeight(p), 0) + lpW + FEE_78_WEIGHT;
  if (positioned && w <= weightBudget) {
    const ordered = [...cps].sort((a, b) => portfolioWeight(b) - portfolioWeight(a));
    return { shape: "paired", ixs: [lpCrank, ...ordered.map((p) => buildRefreshCrankIx(keeper, ctx.market, p.pubkey)), fee], note: `paired: LP + ${cps.length} counterparties + 78 (weight ${w}/${weightBudget})` };
  }
  if (mode === "prefer") return { shape: "lp-only-unpaired", ixs: [lpCrank, fee], note: `prefer: weight ${w} > ${weightBudget}, LP settled without all counterparties (counted)` };
  return { shape: "fee-only", ixs: [fee], note: `strict: weight ${w} > ${weightBudget}; 78 alone if its simulation passes, else deferred` };
}

export type BondFeeResult = { kind: "skipped"; reason: BondFeeSkip } | { kind: "nothing"; detail: string } | { kind: "deferred"; detail: string } | { kind: "sent" | "dry-run"; shape: BondFeeShape; outcome: ExecOutcome } | { kind: "refused"; outcome: ExecOutcome; shape: BondFeeShape } | { kind: "failed"; error: string };

export async function crankBondFee(
  exec: ExecContext,
  ctx: V22MarketCtx,
  positioned: V22Positioned | null,
  p: { mode: PairingMode; weightBudget: number; unpairedCounter?: { n: number } },
): Promise<BondFeeResult> {
  const skip = bondFeeSkipReason(ctx);
  if (skip) return { kind: "skipped", reason: skip };
  try {
    const plan = planBondFee(ctx, exec.keeper.publicKey, positioned, p.mode, p.weightBudget);
    const expected = new Set<number>([NO_FEES_TO_CRANK]);
    const out = await simulateAndSend(exec, plan.ixs, { job: "fee-78", label: ctx.label, units: 1_400_000, expected });
    if (out.kind === "refused") {
      if (out.code === NO_FEES_TO_CRANK) return { kind: "nothing", detail: "no new LP fees (38)" };
      if (plan.shape === "fee-only") return { kind: "deferred", detail: `strict: 78 alone refused (${out.name}); deferred to the next sweep` };
      return { kind: "refused", outcome: out, shape: plan.shape };
    }
    if (out.kind === "failed") return { kind: "failed", error: out.error };
    if (plan.shape === "lp-only-unpaired" && p.unpairedCounter) p.unpairedCounter.n++;
    return { kind: out.kind === "sent" ? "sent" : "dry-run", shape: plan.shape, outcome: out };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export { PublicKey };
