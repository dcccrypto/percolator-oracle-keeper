/**
 * cross-cluster/vault-lp-junior-watch.ts
 *
 * Read-only watch for the last step of a bound vault's wind-down (P3 F-14,
 * WIP 31efd250; re-check against the P3 FINAL sha when it lands).
 *
 * After F-14, tag 101 moves NO SPL: the whole vault-LP payout goes back into
 * the vault's own backing pot. Once the market is terminal-flat the order is
 * 78 (Resolved harvest, also absorbs the claim-free terminal residual) ->
 * every senior's 77 (Earn redemption) -> the JUNIOR's 102
 * VaultLpReleaseSurplus, which pays the junior what is left over C. Tag 102 is
 * junior-owner-signed (handle_vault_lp_release_surplus: expect_signer +
 * owner == st.junior_owner), so the keeper cannot run it: it alerts instead
 * when the seniors are done but the junior has not released for N cycles.
 *
 * Signals (all SDK-decoded or offset-verified; structs identical on 6377376a
 * and the P3 WIP):
 *   terminal-flat     mode 1, materialized_portfolio_count 0, c_tot 0 (market-state.ts)
 *   bound             LpVaultRegistryV16._reserved[0] == 1 (abs 160)
 *   seniors done      registry total_lp_shares_outstanding == 0 AND
 *                     VaultLpStateV18.senior_claim_atoms == 0 (abs 16+128, u128)
 *   junior pending    the vault's own backing ledger (["lp_backing"..., domain])
 *                     BackingDomainLedgerAccountV16.total_principal_atoms > 0
 *                     (abs 16+64 = 80, u128; kind 3). Tag 102's Resolved path
 *                     subtracts what it pays from exactly this counter.
 *                     Live check 2026-09-30: SOLCAT domain-0 ledger reads
 *                     5,000,512,268 = 5,000,000,000 deposited + 512,268 cranked
 *                     fees (fee-flow audit §2).
 * On 6377376a no vault is bound, so this never alerts there.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { deriveLpBackingLedger, deriveLpVaultRegistry, parseLpVaultRegistry } from "@percolatorct/sdk";
import { decodeTerminalState, isTerminalFlat } from "./market-state.ts";
import { lpVaultRegistryBound } from "./lp-fee-cranker.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";

const KIND_BACKING_DOMAIN_LEDGER = 3;
const LEDGER_TOTAL_PRINCIPAL_OFF = 16 + 64;
const VAULT_LP_SENIOR_CLAIM_OFF = 16 + 128;

function u128(d: Uint8Array, off: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
}

export function ledgerTotalPrincipal(d: Uint8Array): bigint | null {
  if (d.length < LEDGER_TOTAL_PRINCIPAL_OFF + 16 || d[10] !== KIND_BACKING_DOMAIN_LEDGER) return null;
  return u128(d, LEDGER_TOTAL_PRINCIPAL_OFF);
}

export function vaultLpSeniorClaim(d: Uint8Array): bigint | null {
  if (!decodeVaultLpState(d)) return null;
  return u128(d, VAULT_LP_SENIOR_CLAIM_OFF);
}

export interface JuniorWatchConfig {
  wrapperProgramId: PublicKey;
  /** Cycles after the seniors are done before alerting that 102 has not run. */
  alertCycles: number;
}

export type JuniorWatchConnection = Pick<Connection, "getMultipleAccountsInfo">;

/** One market. Never throws. `streaks` is per-process state keyed by market. */
export async function watchJuniorRelease(
  conn: JuniorWatchConnection,
  marketAddress: string,
  cfg: JuniorWatchConfig,
  streaks: Map<string, number>,
): Promise<FeeJobOutcome> {
  const reset = (o: FeeJobOutcome): FeeJobOutcome => {
    streaks.delete(marketAddress);
    return o;
  };
  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return { kind: "failed", error: "unparseable market address" };
  }
  try {
    const registryKey = deriveLpVaultRegistry(cfg.wrapperProgramId, market)[0];
    const stateKey = deriveVaultLpState(cfg.wrapperProgramId, market);
    const [mi, ri, si] = await conn.getMultipleAccountsInfo([market, registryKey, stateKey], "confirmed");
    if (!mi || !ri || !si) return reset({ kind: "nothing" });
    const term = decodeTerminalState(new Uint8Array(mi.data));
    if (!isTerminalFlat(term)) return reset({ kind: "nothing" });
    const regData = new Uint8Array(ri.data);
    if (!lpVaultRegistryBound(regData)) return reset({ kind: "nothing" });
    const reg = parseLpVaultRegistry(regData);
    const stData = new Uint8Array(si.data);
    const state = decodeVaultLpState(stData);
    const seniorClaim = vaultLpSeniorClaim(stData);
    if (!state || seniorClaim === null) return reset({ kind: "nothing" });
    if (reg.totalLpSharesOutstanding !== 0n || seniorClaim !== 0n) {
      return reset({ kind: "nothing", detail: "seniors not done yet (77 pending)" });
    }
    const [li] = await conn.getMultipleAccountsInfo([deriveLpBackingLedger(cfg.wrapperProgramId, market, Number(reg.domain))[0]], "confirmed");
    const principal = li ? ledgerTotalPrincipal(new Uint8Array(li.data)) : null;
    if (principal === null || principal === 0n) return reset({ kind: "nothing", detail: "junior surplus released (or none)" });
    const n = (streaks.get(marketAddress) ?? 0) + 1;
    streaks.set(marketAddress, n);
    if (n < cfg.alertCycles) {
      return { kind: "skipped", reason: `seniors done; junior 102 pending (${n}/${cfg.alertCycles} cycles)` };
    }
    return {
      kind: "blocked",
      alertKind: "vault-lp-junior-release-pending",
      reason:
        `every senior has redeemed (shares 0, senior claim 0) but the junior's VaultLpReleaseSurplus (tag 102) has not run for ${n} cycles: ` +
        `${principal} atoms of backing principal still sit in the vault's domain-${reg.domain} pot. Only the junior owner ${state.juniorOwner.toBase58()} can sign it.`,
    };
  } catch (err) {
    return { kind: "failed", error: `read/decode failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
}

export function makeJuniorWatchJob(cfg: JuniorWatchConfig, streaks = new Map<string, number>()): FeeJob {
  return {
    name: "vault-lp-junior-watch",
    run: (ctx, m) => watchJuniorRelease(ctx.conn, m.marketAddress, cfg, streaks),
  };
}

export function juniorWatchConfigFromEnv(env: Readonly<Record<string, string | undefined>>, wrapperProgramId: PublicKey): JuniorWatchConfig {
  const raw = env.ALERT_JUNIOR_RELEASE_CYCLES;
  const n = raw === undefined || raw.trim() === "" ? 3 : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`ALERT_JUNIOR_RELEASE_CYCLES="${raw}" must be a positive integer`);
  return { wrapperProgramId, alertCycles: n };
}
