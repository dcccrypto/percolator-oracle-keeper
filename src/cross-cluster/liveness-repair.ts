/**
 * cross-cluster/liveness-repair.ts
 *
 * Two permissionless, market-only wrapper instructions that un-brick a Live
 * market the accrual/refresh crank cannot fix on its own. Neither moves
 * tokens, neither takes a caller-chosen slot or amount, and the engine refuses
 * both unless the market is actually in the state being repaired, so sending
 * one early is a clean revert, never a state change.
 *
 * 1. ExpireBackingBucket (tag 89, `handle_expire_backing_bucket`).
 *    A realized loss opens the domain's backing bucket as `Fresh` with a
 *    FIXED expiry (`current_slot + max(max_accrual_dt, h_max,
 *    max_bankrupt_close_lifetime)`), never extended while it stays Fresh.
 *    Once that expiry passes the bucket is a dead end until someone advances
 *    it to Expired/Impaired (wrapper doc on `Instruction::ExpireBackingBucket`):
 *      - settling a gain against it -> EngineStale Custom(19)
 *        (`validate_source_domain_ledger_current`) — this is every crank and
 *        refresh that touches a portfolio holding a claim on that domain, so
 *        the market's accrual clock stops and every trade reverts;
 *      - reserving a further loss against it -> EngineLockActive Custom(21)
 *        (`prepare_counterparty_backing_add_delta`, expiry-mismatch arm);
 *      - TopUpBackingBucket / DepositToLpVault into it -> Custom(21), same arm.
 *    Observed live 2026-09-29: PAID and CATE (domain 1 lapsed) — every keeper
 *    crank reverted Custom(19) ("RECOVERED after 12 reverts" treadmill, engine
 *    clock hundreds of slots behind, UI "engine behind"); Murphy (both domains
 *    lapsed) — the Earn deposit reverted Custom(21).
 *    The engine gate (`prepare_counterparty_backing_expiry_delta`) is
 *    `status == Fresh && now_slot >= expiry_slot`, with `now_slot` the runtime
 *    Clock. We only send it for a Fresh bucket whose expiry is strictly below
 *    the slot the market was read at.
 *
 * 2. FinalizeResetSide (tag 45, `handle_finalize_reset_side` ->
 *    `finalize_side_reset_not_atomic`).
 *    A full drain reset leaves a side in `ResetPending`. Nothing but this
 *    instruction moves it back to `Normal`, and `asset_risk_increase_gate`
 *    rejects EVERY risk-increasing trade with Custom(21) while either side is
 *    not Normal. Observed live 2026-09-29: COLLECT and Murphy short side
 *    ResetPending with 0 stored positions — every open reverted "market
 *    locked". The engine gate is `stored_pos_count == 0 && stale_account_count
 *    == 0 && pending_obligation_count == 0 && pending_domain_loss_barrier ==
 *    0`; we mirror it exactly so the instruction is only sent when it lands.
 *
 * Both are prepended to the per-market crank transaction (see planCrankTx):
 * the repaired state is then what the accrual crank and the refreshes see.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_EXPIRE_BACKING_BUCKET,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  buildAccountMetas,
  encodeExpireBackingBucket,
} from "@percolatorct/sdk";

import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

/** Wrapper instruction tag for FinalizeResetSide (v16_program.rs `45 => Self::FinalizeResetSide`). */
export const FINALIZE_RESET_SIDE_TAG = 45;

// Engine slot layout (percolator src/v16.rs, `EngineAssetSlotV16Account` /
// `AssetStateV16Account` / `BackingBucketV16Account`, all packed POD). The
// engine slot starts right after the asset's 1024-byte wrapper oracle block.
const ASSET_SLOT_LEN = 2325;
const ASSET_WRAPPER_LEN = 1024;
const AS_STORED_POS_LONG = 321;
const AS_STORED_POS_SHORT = 329;
const AS_STALE_LONG = 337;
const AS_STALE_SHORT = 345;
const AS_PENDING_OBL_LONG = 353;
const AS_PENDING_OBL_SHORT = 361;
const AS_MODE_LONG = 513;
const AS_MODE_SHORT = 514;
/** size_of::<AssetStateV16Account>() */
const ASSET_STATE_LEN = 515;
// EngineAssetSlotV16Account after `asset`: 4 x u128 insurance budget/spent,
// then pending_domain_loss_barrier_long/short (u64), 2 x SourceCreditState
// (184 B each), then backing_long / backing_short (97 B each).
const SLOT_BARRIER_LONG = ASSET_STATE_LEN + 64;
const SLOT_BARRIER_SHORT = ASSET_STATE_LEN + 72;
const SLOT_BACKING_LONG = ASSET_STATE_LEN + 80 + 2 * 184;
// market_id u64 + 5 x u128 + expiry_slot u64 + status u8 (packed).
const BACKING_LEN = 97;
const BK_EXPIRY = 88;
const BK_STATUS = 96;

/** `BackingBucketStatusV16` wire bytes. */
export const BUCKET_FRESH = 1;
/** `SideModeV16` wire bytes. */
export const SIDE_MODE_RESET_PENDING = 2;

export interface BucketState {
  domain: number;
  status: number;
  expirySlot: bigint;
}

export interface SideResetState {
  /** 0 = long, 1 = short (wrapper `decode_side`). */
  side: 0 | 1;
  mode: number;
  storedPos: bigint;
  stale: bigint;
  pendingObligations: bigint;
  pendingDomainLossBarrier: bigint;
}

export interface LivenessState {
  assetIndex: number;
  buckets: [BucketState, BucketState];
  sides: [SideResetState, SideResetState];
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}

export function decodeLivenessState(data: Uint8Array, assetIndex = 0): LivenessState {
  const a = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
  if (data.length < a + SLOT_BACKING_LONG + 2 * BACKING_LEN) {
    throw new Error(`decodeLivenessState: market account too short (${data.length} bytes)`);
  }
  const bucket = (i: 0 | 1): BucketState => {
    const b = a + SLOT_BACKING_LONG + i * BACKING_LEN;
    return { domain: assetIndex * 2 + i, status: data[b + BK_STATUS], expirySlot: u64(data, b + BK_EXPIRY) };
  };
  const side = (s: 0 | 1): SideResetState => ({
    side: s,
    mode: data[a + (s === 0 ? AS_MODE_LONG : AS_MODE_SHORT)],
    storedPos: u64(data, a + (s === 0 ? AS_STORED_POS_LONG : AS_STORED_POS_SHORT)),
    stale: u64(data, a + (s === 0 ? AS_STALE_LONG : AS_STALE_SHORT)),
    pendingObligations: u64(data, a + (s === 0 ? AS_PENDING_OBL_LONG : AS_PENDING_OBL_SHORT)),
    pendingDomainLossBarrier: u64(data, a + (s === 0 ? SLOT_BARRIER_LONG : SLOT_BARRIER_SHORT)),
  });
  return { assetIndex, buckets: [bucket(0), bucket(1)], sides: [side(0), side(1)] };
}

export type LivenessRepair =
  | { kind: "expire"; domain: number }
  | { kind: "finalize"; assetIndex: number; side: 0 | 1 };

/**
 * The repairs this market needs right now. `nowSlot` is the slot the market
 * account was read at; a bucket is expired only once its expiry is strictly
 * below it, so the runtime Clock at landing is guaranteed past it too.
 */
export function planLivenessRepairs(s: LivenessState, nowSlot: bigint): LivenessRepair[] {
  const out: LivenessRepair[] = [];
  for (const b of s.buckets) {
    if (b.status === BUCKET_FRESH && b.expirySlot < nowSlot) out.push({ kind: "expire", domain: b.domain });
  }
  for (const side of s.sides) {
    if (
      side.mode === SIDE_MODE_RESET_PENDING &&
      side.storedPos === 0n &&
      side.stale === 0n &&
      side.pendingObligations === 0n &&
      side.pendingDomainLossBarrier === 0n
    ) {
      out.push({ kind: "finalize", assetIndex: s.assetIndex, side: side.side });
    }
  }
  return out;
}

export function buildExpireBackingBucketIx(market: PublicKey, domain: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_EXPIRE_BACKING_BUCKET, [market]),
    data: Buffer.from(encodeExpireBackingBucket({ domain })),
  });
}

/** FinalizeResetSide wire: [45, asset_index u16 LE, side u8]; accounts: [market (w)]. */
export function buildFinalizeResetSideIx(market: PublicKey, assetIndex: number, side: 0 | 1): TransactionInstruction {
  const data = Buffer.alloc(4);
  data[0] = FINALIZE_RESET_SIDE_TAG;
  data.writeUInt16LE(assetIndex, 1);
  data[3] = side;
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: [{ pubkey: market, isSigner: false, isWritable: true }],
    data,
  });
}

export function buildLivenessRepairIx(market: PublicKey, r: LivenessRepair): TransactionInstruction {
  return r.kind === "expire"
    ? buildExpireBackingBucketIx(market, r.domain)
    : buildFinalizeResetSideIx(market, r.assetIndex, r.side);
}

export function describeRepair(r: LivenessRepair): string {
  return r.kind === "expire" ? `ExpireBackingBucket(d${r.domain})` : `FinalizeResetSide(${r.side === 0 ? "long" : "short"})`;
}
