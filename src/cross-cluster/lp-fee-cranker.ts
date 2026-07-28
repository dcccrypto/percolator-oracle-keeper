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
} from "@percolatorct/sdk";
import type { Registry } from "./registry.ts";
import { WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

/** LP vaults serve backing domain 0; domain 1 has no vault (see CreateLpVault). */
const LP_VAULT_DOMAIN = 0;

const COMPUTE_UNIT_LIMIT = 120_000;

/** Engine code for "no new fees to distribute" — expected, not a failure. */
const NO_FEES_TO_CRANK = 38;

export interface LpFeeCrankConfig {
  /** Milliseconds between sweeps. */
  intervalMs: number;
  /** Build and log, but never send. */
  dryRun: boolean;
}

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
  const msg = err instanceof Error ? err.message : String(err);
  const json = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (json) return Number(json[1]);
  const hex = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  return null;
}

/**
 * Crank one market's LP fees. Never throws — every outcome is reported.
 */
export async function crankLpFeesOnce(
  devnetConn: Connection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
): Promise<"cranked" | "no-fees" | "skipped" | { error: string }> {
  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return { error: "unparseable market address" };
  }

  const [registry] = deriveLpVaultRegistry(WRAPPER_PROGRAM_ID, market);
  const [ledger] = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, LP_VAULT_DOMAIN);

  // Both reads in ONE round trip — this runs per market per cycle.
  let infos: Array<{ data: Buffer } | null>;
  try {
    infos = (await devnetConn.getMultipleAccountsInfo([registry, ledger], "confirmed")) as Array<
      { data: Buffer } | null
    >;
  } catch (err) {
    return { error: `account read failed: ${(err as Error).message.slice(0, 100)}` };
  }
  const [registryInfo, ledgerInfo] = infos;

  // No vault, or no depositor yet -> nothing to distribute. Skipping locally
  // keeps a market with no LPs from costing a transaction every single cycle.
  if (!registryInfo) return "skipped";
  if (!ledgerInfo) return "skipped";

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
      }),
      data: Buffer.from(encodeLpVaultCrankFees()),
    }),
  );

  try {
    const { blockhash, lastValidBlockHeight } = await devnetConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    const sig = await devnetConn.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
    await devnetConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`[lp-fee] distributed ${marketAddress.slice(0, 8)}… sig=${sig.slice(0, 16)}…`);
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
 * Periodic LP-fee distribution loop. Mirrors startRecoveryCrankLoop's shape:
 * isolated per-market errors, concurrent sweep, never throws out of scope.
 */
export async function startLpFeeCrankLoop(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  config: LpFeeCrankConfig,
): Promise<void> {
  console.log(
    `[lp-fee] LP fee crank loop starting: ${registry.markets.length} markets,` +
      ` interval=${config.intervalMs}ms, mode=${config.dryRun ? "DRY-RUN" : "LIVE"}`,
  );

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  let cycle = 0;
  while (!stopping) {
    const start = Date.now();
    try {
      const r = await crankAllLpFeesOnce(devnetConn, keeper, registry, config.dryRun);
      // Only speak up when something actually moved, or every ~20 cycles, so a
      // quiet fleet does not fill the log with "nothing happened".
      if (r.cranked.length > 0 || cycle % 20 === 0) {
        console.log(
          `[lp-fee] cycle ${cycle}: ${r.cranked.length} distributed, ` +
            `${r.noFees.length} no-fees, ${r.skipped.length} no-vault/no-depositors, ` +
            `${r.failed.length} failed`,
        );
      }
    } catch (err) {
      // Defense in depth — crankAllLpFeesOnce already swallows per-market errors.
      console.error(`[lp-fee] sweep error — ${(err as Error).message.slice(0, 140)}`);
    }
    cycle++;
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, Math.max(1000, config.intervalMs - elapsed)));
  }
}
