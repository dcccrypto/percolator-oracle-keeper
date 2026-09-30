/**
 * cross-cluster/lp-fee-cranker.ts
 *
 * Distributes accrued LP trading fees into each market's LP vault.
 *
 * Why this exists (verified on-chain 2026-07-28):
 *   Every trade splits its fee four ways into counters stored on the SLAB —
 *   `protocol_fee_accrued_atoms`, `lp_fee_accrued_atoms`,
 *   `insurance_reserve_accrued_atoms` and `creator_fee_claimable_atoms`. On a
 *   fresh market a 500-notional round trip at 30 bps produced exactly
 *   600000 / 1440000 / 480000 / 480000 (20% / 48% / 16% / 16%), so the split
 *   itself is correct and the LP's share is NOT lost.
 *
 *   But `lp_fee_accrued_atoms` only becomes LP-vault value when someone calls
 *   `LpVaultCrankFees`, and NOTHING called it. The keeper sent PushAuthMark and
 *   PermissionlessCrank and nothing else, so the counter grew forever and every
 *   LP depositor saw 0% APY no matter how much the market traded. That is the
 *   whole reason the Earn page still advertises 0%.
 *
 * What it does:
 *   Every `intervalMs`, for each registry market: derive the LP vault registry
 *   and the domain-0 backing ledger, and fire one `LpVaultCrankFees`.
 *
 * Two conditions make the crank a guaranteed no-op, and both are NORMAL rather
 * than faults — they are skipped locally so the loop costs nothing:
 *
 *   1. No LP vault registry. The market's creator never ran CreateLpVault.
 *   2. No backing ledger. The ledger PDA is created LAZILY by the first
 *      `DepositToLpVault` — it does not exist at market creation. Cranking
 *      without it fails `IncorrectProgramId` (the runtime rejects the
 *      System-owned placeholder), which looks alarming in logs but only ever
 *      means "nobody has deposited into this LP vault yet".
 *
 * `Custom(38)` (`LpVaultNoFeesToCrank`) is likewise expected, not an error: it
 * is the healthy answer whenever no new fees accrued since the last crank. It
 * is counted but never logged as a failure, or a quiet market would page
 * someone every cycle.
 *
 * Deliberately separate from the oracle push loop, for the same reasons
 * recovery-cranker.ts is: independent interval, isolated errors, and one
 * instruction per transaction.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  encodeLpVaultCrankFees,
  ACCOUNTS_LP_VAULT_CRANK_FEES,
  buildAccountMetas,
  deriveLpVaultRegistry,
  deriveLpBackingLedger,
  parseLpVaultRegistry,
} from "@percolatorct/sdk";
import { SystemProgram } from "@solana/web3.js";
import type { Registry } from "./registry.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { confirmBySignature, customCodeOf } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import { isTerminalMarket } from "./terminal-insurance.ts";

/**
 * Fallback only. v17 vaults are DUAL-DOMAIN: the vault serves both pots of its
 * asset and its own pot is `registry.domain`, which is NOT always 0 (a market
 * that appends an asset binds the vault to that asset's domain). We read the
 * real value off the registry below and only fall back to this if the account
 * cannot be parsed.
 */
const LP_VAULT_DOMAIN_FALLBACK = 0;

const COMPUTE_UNIT_LIMIT = 120_000;

/** Engine code for "no new fees to distribute" — expected, not a failure. */
const NO_FEES_TO_CRANK = 38;

export interface LpFeeCrankResult {
  /** Markets whose fees were actually distributed. */
  cranked: string[];
  /** Markets with nothing to distribute (Custom(38)) — healthy. */
  noFees: string[];
  /** Markets with no LP vault or no ledger yet — nothing to do. */
  skipped: string[];
  /** Markets that failed for a reason worth looking at. */
  failed: Array<{ market: string; error: string }>;
}

function extractErrorCode(err: unknown): number | null {
  return customCodeOf(err instanceof Error ? err.message : err);
}

/** The Connection surface the LP-fee crank uses (stubbable in tests). */
export type LpFeeConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses"
>;

/**
 * Crank one market's LP fees. Never throws — every outcome is reported.
 */
export async function crankLpFeesOnce(
  devnetConn: LpFeeConnection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
  confirmOpts?: ConfirmOptions,
): Promise<"cranked" | "no-fees" | "skipped" | { error: string }> {
  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return { error: "unparseable market address" };
  }

  const [registry] = deriveLpVaultRegistry(WRAPPER_PROGRAM_ID, market);

  // ONE round trip, as before. Dual-domain changed WHICH signal tells us not to
  // bother sending: the ledger's existence used to stand in for "has a depositor",
  // but the program now creates the target ledger on first use, so a missing
  // ledger is no longer a reason to skip. The registry's own share count is the
  // direct signal and costs no extra read — it is also exactly what the program
  // checks (it rejects LpVaultZeroSharesMinted when no share can claim the atoms).
  let infos: Array<{ data: Buffer } | null>;
  try {
    infos = (await devnetConn.getMultipleAccountsInfo([registry, market], "confirmed")) as Array<
      { data: Buffer } | null
    >;
  } catch (err) {
    return { error: `account read failed: ${(err as Error).message.slice(0, 100)}` };
  }
  const [registryInfo, marketInfo] = infos;
  // B13: tag 78 is Live-only; a Resolved market / tombstone is never cranked.
  if (marketInfo && isTerminalMarket(new Uint8Array(marketInfo.data))) return "skipped";

  // No vault -> nothing to distribute. Skipping locally keeps a market with no
  // LP vault from costing a transaction every single cycle.
  if (!registryInfo) return "skipped";

  let domainIdx = LP_VAULT_DOMAIN_FALLBACK;
  try {
    const parsed = parseLpVaultRegistry(new Uint8Array(registryInfo.data));
    domainIdx = Number(parsed.domain);
    if (parsed.totalLpSharesOutstanding === 0n) return "skipped";
  } catch {
    // Unparseable registry: fall back rather than skip, so a layout change does
    // not silently stop fee cranking on every market at once.
  }

  const [ledger] = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, domainIdx);
  const [siblingLedger] = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, domainIdx ^ 1);

  if (dryRun) {
    console.log(`[lp-fee] [DRY-RUN] LpVaultCrankFees ${marketAddress.slice(0, 8)}…`);
    return "skipped";
  }

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
  tx.add(
    new TransactionInstruction({
      programId: WRAPPER_PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_LP_VAULT_CRANK_FEES, {
        cranker: keeper.publicKey,
        market,
        registry,
        ledger,
        siblingLedger,
        systemProgram: SystemProgram.programId,
      }),
      data: Buffer.from(encodeLpVaultCrankFees({ domain: domainIdx })),
    }),
  );

  try {
    const { blockhash, lastValidBlockHeight } = await devnetConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    const sig = await devnetConn.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
    // F6 (fee-flow audit 2026-09-29): the signature STATUS decides, not whether
    // confirmTransaction returned before its block-height deadline. SOLCAT
    // 5xq4yAXH… and ANSEM 4RJv6kJt… were logged as "block height exceeded"
    // failures but had landed. A confirmation that carries value.err (landed but
    // failed on chain) is a failure, not a success, too.
    const c = await confirmBySignature(devnetConn, sig, blockhash, lastValidBlockHeight, confirmOpts);
    if (c.status === "failed") {
      if (c.code === NO_FEES_TO_CRANK) return "no-fees";
      return { error: `landed but failed on chain: ${JSON.stringify(c.err).slice(0, 100)} sig=${sig.slice(0, 16)}…` };
    }
    if (c.status === "not-landed") {
      return { error: `not landed (retry next cycle): ${c.reason} sig=${sig.slice(0, 16)}…` };
    }
    console.log(`[lp-fee] distributed ${marketAddress.slice(0, 8)}… sig=${sig.slice(0, 16)}… [${c.via}]`);
    return "cranked";
  } catch (err) {
    if (extractErrorCode(err) === NO_FEES_TO_CRANK) return "no-fees";
    return { error: (err instanceof Error ? err.message : String(err)).slice(0, 140) };
  }
}

/** One sweep over every registry market. Never throws. */
export async function crankAllLpFeesOnce(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  dryRun: boolean,
): Promise<LpFeeCrankResult> {
  const result: LpFeeCrankResult = { cranked: [], noFees: [], skipped: [], failed: [] };

  await Promise.allSettled(
    registry.markets.map(async (m) => {
      const outcome = await crankLpFeesOnce(devnetConn, keeper, m.marketAddress, dryRun);
      if (outcome === "cranked") result.cranked.push(m.marketAddress);
      else if (outcome === "no-fees") result.noFees.push(m.marketAddress);
      else if (outcome === "skipped") result.skipped.push(m.marketAddress);
      else result.failed.push({ market: m.marketAddress, error: outcome.error });
    }),
  );

  if (result.failed.length > 0) {
    console.error(
      `[lp-fee] ${result.failed.length} market(s) failed — ` +
        result.failed.map((f) => `${f.market.slice(0, 8)}…: ${f.error}`).join(" | "),
    );
  }
  return result;
}

/**
 * The LP-fee crank as a fee job (see fee-jobs.ts), so it runs in the shared
 * fee loop next to the stake-fee push and inherits its health/alerting.
 */
export function makeLpFeeJob(confirmOpts?: ConfirmOptions): FeeJob {
  return {
    name: "lp-fee",
    async run(ctx, m): Promise<FeeJobOutcome> {
      const o = await crankLpFeesOnce(ctx.conn, ctx.keeper, m.marketAddress, ctx.dryRun, confirmOpts);
      if (o === "cranked") return { kind: "done", detail: "LP fees distributed into the LP vault" };
      if (o === "no-fees") return { kind: "nothing", detail: "no new LP fees (Custom(38))" };
      if (o === "skipped") return { kind: "skipped", reason: "no LP vault, or no depositors yet" };
      return { kind: "failed", error: o.error };
    },
  };
}
