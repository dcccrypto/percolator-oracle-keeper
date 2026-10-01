/**
 * cross-cluster/bankrupt-close-watch.ts
 *
 * `bankrupt-close-expiring` (security INFO, P3 FINAL 58e379f1): the wrapper adopted
 * upstream 13b3a8b2 ("Fix expired close auto-crank liveness"). On a LIVE market, a
 * portfolio whose bankrupt close is still active with residual left once
 * `max_close_slot` has passed lets ANYONE's PermissionlessCrank on that portfolio
 * select the engine's DeclareRecovery (mode -> Recovery), after which Recovery's own
 * bounded crank step reaches Resolved. That is by design (h-lock liveness), but it
 * ends the market, so the operator must see it coming.
 *
 *   warn      active close with residual, max_close_slot - chain_slot <= warnSlots
 *   critical  chain_slot > max_close_slot (expired: any crank can now escalate)
 *
 * Offsets (engine 35ddd692 — P3 changes no engine code; computed from source,
 * cross-checked two ways: `capital` lands at abs 148 = the SDK's PF_CAPITAL_OFF,
 * and `stale_state` at 16+9165 = the frontend's offset_of-verified PF_STALE_STATE):
 *   PortfolioAccountV16Account.close_progress @ struct 9169 -> abs 9185
 *   CloseProgressLedgerV16Account (packed, 184 B): active u8 @0, finalized @1,
 *     canceled @2, close_id u64 @3, asset_index u32 @11, max_close_slot u64 @48,
 *     residual_remaining u128 @168.
 * A pending close = active && !finalized && !canceled && residual_remaining != 0
 * (engine `has_pending_residual`; the wrapper valve tests active && residual > 0).
 * Live devnet 2026-09-30: 2 of 141 portfolios have an active ledger — both
 * finalized with 0 residual (TEXTIT 5oYeGqkw…, Murphy EXgiHLfx…): no alert.
 *
 * Read-only. One filtered getProgramAccounts per market per fee cycle (only
 * portfolios of this market whose ledger `active` byte is 1, 184-byte slice).
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { marketMode } from "./market-state.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";

export const CLOSE_PROGRESS_OFF = 9185;
export const CLOSE_PROGRESS_LEN = 184;

export interface CloseProgress {
  active: boolean;
  finalized: boolean;
  canceled: boolean;
  closeId: bigint;
  assetIndex: number;
  maxCloseSlot: bigint;
  residualRemaining: bigint;
}

/** Decode the 184-byte ledger (either the full portfolio account or the slice at CLOSE_PROGRESS_OFF). */
export function decodeCloseProgress(d: Uint8Array, isSlice = false): CloseProgress | null {
  const o = isSlice ? 0 : CLOSE_PROGRESS_OFF;
  if (d.length < o + CLOSE_PROGRESS_LEN) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u64 = (x: number) => v.getBigUint64(o + x, true);
  return {
    active: d[o] === 1,
    finalized: d[o + 1] === 1,
    canceled: d[o + 2] === 1,
    closeId: u64(3),
    assetIndex: v.getUint32(o + 11, true),
    maxCloseSlot: u64(48),
    residualRemaining: u64(168) | (u64(176) << 64n),
  };
}

export function hasPendingResidual(c: CloseProgress): boolean {
  return c.active && !c.finalized && !c.canceled && c.residualRemaining !== 0n;
}

export interface BankruptCloseWatchConfig {
  wrapperProgramId: PublicKey;
  /** Warn when max_close_slot is at most this many slots away. */
  warnSlots: bigint;
}

export type BankruptCloseConnection = Pick<Connection, "getProgramAccounts" | "getMultipleAccountsInfo" | "getSlot">;

export async function watchBankruptCloses(
  conn: BankruptCloseConnection,
  marketAddress: string,
  cfg: BankruptCloseWatchConfig,
): Promise<FeeJobOutcome> {
  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return { kind: "failed", error: "unparseable market address" };
  }
  try {
    const [mi] = await conn.getMultipleAccountsInfo([market], "confirmed");
    // The valve only exists on LIVE markets (group.header.mode == 0).
    if (!mi || marketMode(new Uint8Array(mi.data)) !== 0) return { kind: "nothing" };
    const accs = await conn.getProgramAccounts(cfg.wrapperProgramId, {
      dataSlice: { offset: CLOSE_PROGRESS_OFF, length: CLOSE_PROGRESS_LEN },
      filters: [
        { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
        { memcmp: { offset: 16, bytes: market.toBase58() } },
        { memcmp: { offset: CLOSE_PROGRESS_OFF, bytes: "2" } }, // base58 of [0x01]: active == 1
      ],
    });
    const pending = accs
      .map((a) => ({ portfolio: a.pubkey.toBase58(), c: decodeCloseProgress(new Uint8Array(a.account.data), true) }))
      .filter((x): x is { portfolio: string; c: CloseProgress } => x.c !== null && hasPendingResidual(x.c));
    if (pending.length === 0) return { kind: "nothing" };
    const now = BigInt(await conn.getSlot("confirmed"));
    const expired = pending.filter((x) => now > x.c.maxCloseSlot);
    const soon = pending.filter((x) => now <= x.c.maxCloseSlot && x.c.maxCloseSlot - now <= cfg.warnSlots);
    const describe = (x: { portfolio: string; c: CloseProgress }) =>
      `portfolio ${x.portfolio} (close #${x.c.closeId}, asset ${x.c.assetIndex}, residual ${x.c.residualRemaining}, max_close_slot ${x.c.maxCloseSlot}, ` +
      (now > x.c.maxCloseSlot ? `expired ${now - x.c.maxCloseSlot} slots ago)` : `${x.c.maxCloseSlot - now} slots left)`);
    if (expired.length > 0) {
      return {
        kind: "blocked",
        alertKind: "bankrupt-close-expiring",
        severity: "critical",
        reason:
          `market ${marketAddress}: bankrupt close EXPIRED with residual left — any crank on it now moves the market to Recovery, then Resolved: ` +
          expired.map(describe).join("; "),
      };
    }
    if (soon.length > 0) {
      return {
        kind: "blocked",
        alertKind: "bankrupt-close-expiring",
        severity: "warn",
        reason:
          `market ${marketAddress}: bankrupt close within ${cfg.warnSlots} slots of max_close_slot with residual left (after that, any crank escalates to Recovery -> Resolved): ` +
          soon.map(describe).join("; "),
      };
    }
    return { kind: "nothing", detail: `${pending.length} pending bankrupt close(s), none near expiry` };
  } catch (err) {
    return { kind: "failed", error: `read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
}

export function bankruptCloseWatchConfigFromEnv(env: Readonly<Record<string, string | undefined>>, wrapperProgramId: PublicKey): BankruptCloseWatchConfig {
  const raw = env.ALERT_BANKRUPT_CLOSE_WARN_SLOTS;
  if (raw !== undefined && raw.trim() !== "" && !/^\d+$/.test(raw.trim())) throw new Error(`ALERT_BANKRUPT_CLOSE_WARN_SLOTS="${raw}" must be a non-negative integer`);
  // Default 3,000 slots (~20 min): comfortably more than the fee-job cadence (200 s ≈ 500 slots).
  return { wrapperProgramId, warnSlots: raw === undefined || raw.trim() === "" ? 3_000n : BigInt(raw.trim()) };
}

export function makeBankruptCloseWatchJob(cfg: BankruptCloseWatchConfig): FeeJob {
  return { name: "bankrupt-close-watch", run: (ctx, m) => watchBankruptCloses(ctx.conn, m.marketAddress, cfg) };
}
