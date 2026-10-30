/**
 * cross-cluster/v22/g9.ts   (KEEPER_V22_G9; default OFF, and DRY-RUN FIRST: KEEPER_V22_G9_DRY_RUN defaults to ON)
 *
 * Tag 111 InsuranceBackstopDraw (G9), permissionless:
 *   mode 2 PROPOSE  records the slot (a second proposal is refused while one is open)
 *   mode 0 DRAW     only in [propose + 9,000, propose + 18,000) slots; the proposal is consumed; due / eligibility / caps
 *                   are re-checked at draw time
 *   mode 1 RESTORE  repays the insurance lent to the vault LP (`backstop_receivable`) when the LP can pay
 * The state machine is read from the chain (InsuranceUnitsV20.g9_pending_slot / backstop_receivable), not kept in
 * memory, so a keeper restart in the middle of the 9,000-slot wait resumes correctly.
 *
 * ORACLE GATE (Wave D review R-7/R-8 and the mainnet recommendation): G9 is only meaningful on an externally
 * sourced oracle. The keeper proposes / draws only when asset 0 is Hybrid (oracle_mode 1) with legs; Manual (0),
 * AuthMark (3) are refused locally. `KEEPER_V22_G9_ALLOW_ANY_ORACLE_MODE=on` lifts this for devnet testing (the
 * wrapper's own gate is `devnet_override || (Hybrid && AUTHENTICATED)`; the provenance byte is NOT read here).
 * MAINNET BUILDS: modes 0 and 2 also take the feed allowlist PDA and the leg accounts (read-only, found by KEY in
 * accounts[7..]); pass `mainnetBuild` so the tail is added. Both are unverified without a live v2.2 market.
 */
import { PublicKey } from "@solana/web3.js";
import { BackstopMode, buildInsuranceBackstopDrawIxV22, decodeInsuranceUnitsV20, deriveG9FeedAllowlistV22, deriveInsuranceUnitsV22, G9_DELAY_SLOTS_V22, G9_EXEC_WINDOW_SLOTS_V22 } from "@percolatorct/sdk";
import type { InsuranceUnitsV20 } from "@percolatorct/sdk";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";

export const ORACLE_MODE_HYBRID = 1;
export const G9_TX_UNITS = 600_000;
/** Retry spacing (slots) after a refused attempt of each kind. */
export const G9_PROPOSE_RETRY_SLOTS = 1_500n;
export const G9_DRAW_RETRY_SLOTS = 50n;
export const G9_RESTORE_RETRY_SLOTS = 1_500n;

export type G9Action =
  | { kind: "none"; reason: string }
  | { kind: "wait"; reason: string; remainingSlots: bigint }
  | { kind: "propose" | "draw" | "restore" };

export interface G9State {
  /** `market|kind` -> slot of the last attempt (any outcome). */
  lastAttempt: Map<string, bigint>;
}
export const freshG9State = (): G9State => ({ lastAttempt: new Map() });

export function oracleQualifies(ctx: Pick<V22MarketCtx, "oracleMode" | "oracleLegCount">, allowAny: boolean): boolean {
  if (allowAny) return true;
  return ctx.oracleMode === ORACLE_MODE_HYBRID && ctx.oracleLegCount > 0;
}

/** Pure decision from the units ledger and the clock. */
export function decideG9(
  ctx: Pick<V22MarketCtx, "oracleMode" | "oracleLegCount" | "bound" | "lpPortfolio" | "marketAddress" | "refresh">,
  units: Pick<InsuranceUnitsV20, "g9PendingSlot" | "backstopReceivableAtoms"> | null,
  nowSlot: bigint,
  allowAny: boolean,
  st: G9State,
): G9Action {
  if (!units) return { kind: "none", reason: "no insurance-units ledger (not a units market)" };
  if (!ctx.bound || !ctx.lpPortfolio) return { kind: "none", reason: "no bound vault LP" };
  if (!oracleQualifies(ctx, allowAny)) return { kind: "none", reason: `oracle mode ${ctx.oracleMode} does not qualify (Hybrid with legs only)` };
  const due = (kind: string, every: bigint): boolean => {
    const last = st.lastAttempt.get(`${ctx.marketAddress}|${kind}`);
    return last === undefined || nowSlot - last >= every;
  };
  const p = units.g9PendingSlot;
  if (p !== 0n) {
    const open = p + G9_DELAY_SLOTS_V22;
    const close = open + G9_EXEC_WINDOW_SLOTS_V22;
    if (nowSlot < open) return { kind: "wait", reason: "proposal open: waiting out the 9,000-slot delay", remainingSlots: open - nowSlot };
    if (nowSlot < close) return due("draw", G9_DRAW_RETRY_SLOTS) ? { kind: "draw" } : { kind: "none", reason: "draw retry spacing" };
    // lapsed: fall through to a fresh proposal (a lapsed proposal cannot draw)
  }
  if (units.backstopReceivableAtoms > 0n && due("restore", G9_RESTORE_RETRY_SLOTS)) return { kind: "restore" };
  if (due("propose", G9_PROPOSE_RETRY_SLOTS)) return { kind: "propose" };
  return { kind: "none", reason: "propose retry spacing" };
}

/**
 * The oracle tail (feed allowlist + leg feeds) belongs to modes 0 and 2 ONLY: the program's R-1/R-7/R-8 oracle gate covers
 * tag 111 modes 0 and 2 (v16_program.rs:37947). Both restores (1 RESTORE, 3 RESTORE-FROM-PNL) need no feed (GH#183).
 */
export function g9ExtraTail(ctx: V22MarketCtx, mainnetBuild: boolean, mode: 0 | 1 | 2 | 3): PublicKey[] {
  if (!mainnetBuild || mode === BackstopMode.Restore || mode === BackstopMode.RestoreFromPnl) return [];
  return [deriveG9FeedAllowlistV22(ctx.programId)[0], ...ctx.oracleLegFeeds];
}

export async function g9Once(
  exec: ExecContext,
  ctx: V22MarketCtx,
  unitsData: Uint8Array | null,
  st: G9State,
  p: { dryRun: boolean; allowAnyOracleMode: boolean; mainnetBuild: boolean; drawCapAtoms: bigint },
): Promise<{ action: G9Action; outcome: ExecOutcome | null }> {
  let units: InsuranceUnitsV20 | null = null;
  if (unitsData) {
    try {
      units = decodeInsuranceUnitsV20(unitsData);
    } catch {
      units = null;
    }
  }
  const now = BigInt(ctx.readSlot);
  const action = decideG9(ctx, units, now, p.allowAnyOracleMode, st);
  if (action.kind === "none" || action.kind === "wait") return { action, outcome: null };
  st.lastAttempt.set(`${ctx.marketAddress}|${action.kind}`, now);
  // 114-116 are the G9 / rescue refusals: "not eligible right now" is an expected answer to a propose / draw / restore probe.
  const expected = new Set<number>([114, 115, 116, 21]);
  const attempt = (mode: 0 | 1 | 2 | 3, job: string): Promise<ExecOutcome> => {
    const cap = mode === BackstopMode.Propose ? 0n : p.drawCapAtoms;
    const ix = buildInsuranceBackstopDrawIxV22(ctx.sdk, exec.keeper.publicKey, mode, cap, g9ExtraTail(ctx, p.mainnetBuild, mode));
    return simulateAndSend(exec, [ix], { job, label: ctx.label, units: G9_TX_UNITS, dryRun: p.dryRun, expected });
  };
  if (action.kind === "restore") {
    // GH#183 / program KEEPER NOTE (W4-4): try mode 3 (RESTORE-FROM-PNL, repays the backstop from the vault LP's source-backed
    // profit) first. It can REVERT where mode 1 would succeed (the capacity read errors on an inconsistent source ledger), so a
    // simulation that REFUSES it falls back to mode 1 (capital) in the SAME sweep. Nothing is sent for the refused attempt.
    const pnl = await attempt(BackstopMode.RestoreFromPnl, "g9-restore-pnl");
    if (pnl.kind !== "refused") return { action, outcome: pnl };
    return { action, outcome: await attempt(BackstopMode.Restore, "g9-restore") };
  }
  const outcome = await attempt(action.kind === "propose" ? BackstopMode.Propose : BackstopMode.Draw, `g9-${action.kind}`);
  return { action, outcome };
}

export { deriveInsuranceUnitsV22 };
