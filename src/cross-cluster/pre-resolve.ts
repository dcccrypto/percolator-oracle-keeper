/**
 * cross-cluster/pre-resolve.ts
 *
 * Crank the LP (tag 78) and staker (tag 87 -> stake AccrueFees) fee legs of a
 * market BEFORE anyone sends ResolveMarket, and report what would be lost.
 *
 * Why (fee-flow audit 2026-09-29, F4): tags 78 and 87 are Live-only, so once a
 * market resolves those two legs can never be moved again, and CloseSlab then
 * SPL-burns every unbudgeted insurance atom — which is exactly the sum of the
 * outstanding protocol, creator, LP and staker legs (`handle_close_slab`
 * passes `additional_reserved = 0`). Protocol (84) and creator (90) CAN still
 * be claimed while Resolved, but only before CloseSlab.
 *
 * The keeper itself never sends ResolveMarket. This is the gate for whoever
 * does: `scripts/pre-resolve-drain.ts --market <slab>` runs it and exits
 * non-zero while any Live-only leg is still outstanding, so an operator
 * runbook (or the app's reclaim flow) can refuse to continue.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { readFeeLegs } from "./fee-legs.ts";
import type { FeeLegs } from "./fee-legs.ts";
import { crankLpFeesOnce } from "./lp-fee-cranker.ts";
import { pushStakeFeesOnce } from "./stake-fee-pusher.ts";
import type { StakeFeeConfig, StakeFeeConnection } from "./stake-fee-pusher.ts";
import type { FeeJobOutcome } from "./fee-jobs.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";

export interface PreResolveReport {
  market: string;
  before: FeeLegs;
  after: FeeLegs;
  lp: "cranked" | "no-fees" | "skipped" | "not-needed" | { error: string };
  stake: FeeJobOutcome | { kind: "not-needed" };
  /** Live-only legs still outstanding: lost for good at resolve. */
  blockers: string[];
  /** Claimable after resolve, but burned by CloseSlab if not claimed first. */
  warnings: string[];
  safeToResolve: boolean;
}

export type PreResolveConnection = StakeFeeConnection & Pick<Connection, "getAccountInfo">;

export interface PreResolveDeps {
  crankLp: typeof crankLpFeesOnce;
  pushStake: typeof pushStakeFeesOnce;
}

const defaultDeps: PreResolveDeps = { crankLp: crankLpFeesOnce, pushStake: pushStakeFeesOnce };

async function legsOf(conn: PreResolveConnection, market: PublicKey): Promise<FeeLegs> {
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) throw new Error(`market ${market.toBase58()} not found`);
  return readFeeLegs(new Uint8Array(info.data));
}

/**
 * Drain what can be drained, then re-read and judge. `dryRun` simulates only
 * (both cranks build and simulate; nothing is sent).
 */
export async function drainFeeLegsBeforeResolve(
  conn: PreResolveConnection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
  stakeCfg: StakeFeeConfig,
  confirmOpts?: ConfirmOptions,
  deps: PreResolveDeps = defaultDeps,
): Promise<PreResolveReport> {
  const market = new PublicKey(marketAddress);
  const before = await legsOf(conn, market);

  // Order: LP first, then stake. Both clamp to the same shared pool
  // (insurance − reserved − domain budgets); the order does not change what
  // either may take, it only makes the report read top to bottom.
  const lp = before.lpOwed > 0n
    ? await deps.crankLp(conn, keeper, marketAddress, dryRun, confirmOpts)
    : ("not-needed" as const);
  const stake = before.stakeOwed > 0n
    ? await deps.pushStake(conn, keeper, marketAddress, dryRun, { ...stakeCfg, confirm: confirmOpts ?? stakeCfg.confirm })
    : ({ kind: "not-needed" } as const);

  const after = dryRun ? before : await legsOf(conn, market);

  const blockers: string[] = [];
  if (after.lpOwed > 0n) {
    const why = typeof lp === "string" ? lp : `error: ${lp.error}`;
    blockers.push(`LP leg ${after.lpOwed} atoms still owed (tag 78 ${why}); Live-only — lost at resolve`);
  }
  if (after.stakeOwed > 0n) {
    const why =
      stake.kind === "skipped" || stake.kind === "blocked" ? stake.reason
        : stake.kind === "failed" ? stake.error
          : stake.kind;
    blockers.push(`staker leg ${after.stakeOwed} atoms still owed (tag 87: ${why}); Live-only — lost at resolve`);
  }
  const warnings: string[] = [];
  if (after.protocolOwed > 0n) {
    warnings.push(`protocol leg ${after.protocolOwed} atoms: claim with tag 84 before CloseSlab (it is burned there)`);
  }
  if (after.creatorClaimable !== null && after.creatorClaimable > 0n) {
    warnings.push(`creator leg ${after.creatorClaimable} atoms: claim with tag 90 before CloseSlab (it is burned there)`);
  }
  if (after.creatorClaimable === null) {
    warnings.push("creator leg unreadable (unknown account VERSION) — check it by hand before CloseSlab");
  }
  return { market: marketAddress, before, after, lp, stake, blockers, warnings, safeToResolve: blockers.length === 0 };
}
