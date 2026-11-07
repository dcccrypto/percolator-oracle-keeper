/**
 * Meteora DLMM +-2% executable quote depth (bigtest 2026-11 Medium #6). OBSERVE-ONLY: nothing here feeds
 * resolvePushDepth or any PushAuthMark byte (see dlmm-depth-observe.ts and its byte-identity test).
 *
 * LAYOUT SOURCE. Account layouts are the Meteora `lb_clmm` program's, from its Anchor IDL
 * (github.com/MeteoraAg/dlmm-sdk, ts-client/src/dlmm/idl/idl.json, program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo,
 * v0.12.0, read 2026-11-07) and confirmed byte-for-byte against the captured mainnet fixtures in
 * __fixtures__/dlmm/ (account sizes 904 / 10136, discriminators = sha256("account:LbPair"|"account:BinArray")[..8]):
 *
 *   LbPair (904 B):  [0..8) disc | StaticParameters 32 B [8..40) | VariableParameters 32 B [40..72) | bump_seed[1] 72 |
 *                    bin_step_seed[2] 73 | pair_type u8 75 | active_id i32 @76 | bin_step u16 @80 | status u8 82 | ... |
 *                    token_x_mint @88 | token_y_mint @120 (X = base, Y = QUOTE; the same offsets the SDK's parseDexPool uses)
 *   BinArray (10136 B): disc [0..8) | index i64 @8 | version u8 @16 | pad[7] | lb_pair pubkey @24 | bins[70] @56
 *   Bin (144 B, v0.12): amount_x u64 @0 | amount_y u64 @8 | price u128 @16 (Q64.64, Y atoms per X atom) | liquidity_supply u128 @32 |
 *                    fulfilled_order_amount_x/y, limit_order_fee_ask/bid_side (u64 x4) @48 | fee_amount_x/y_per_token_stored u128 x2 @80 |
 *                    open_order_amount u64 @112 | total_processing_order_amount u64 @120 | processed_order_remaining_amount u64 @128 |
 *                    order_age u32 @136 | limit_order_ask_side u8 @140 | pad[3]
 *                    LIMIT-ORDER LIQUIDITY IS EXCLUDED: only amount_x / amount_y (the AMM liquidity) is counted, not open_order_amount
 *                    or processed_order_remaining_amount. The SDK's swappable amount includes limit orders, so this UNDERSTATES depth
 *                    (conservative; ~$54 ask / ~$351 bid on the SOL fixture). Revisit if this ever stops being observe-only.
 *   PDA:             ["bin_array", lb_pair, index i64 LE] under the DLMM program; index = floor(bin_id / 70) (toward -inf).
 *   bin price:       (1 + bin_step/10000)^bin_id.  A bin above the active id holds only X, below only Y, the active bin both.
 *
 * Every byte this module relies on is checked (discriminators, lb_pair, index, length, stored price vs the bin-step
 * price on every bin that holds liquidity); any mismatch is a refusal, never a guess.
 *
 * DEFINITIONS. P0 = the active bin's price.
 *   ask side (price up 2%):  quote needed to buy ALL X sitting in bins id in [active, active+nu], nu = the last bin whose
 *                            price <= 1.02 * P0.   sum floor(amount_x * price_q64 >> 64)
 *   bid side (price down 2%): quote received selling into ALL Y in bins id in [active-nd, active], nd = the last bin whose
 *                            price >= 0.98 * P0.   sum amount_y
 *   The active bin contributes only its own side (X to the ask, Y to the bid), which is exactly how DLMM fills it (both at
 *   the bin price) - no part of it is counted on the wrong side. Swap fees are NOT added (a taker pays slightly more, a
 *   seller receives slightly less), so both figures are the pre-fee, slightly smaller-than-paid numbers. Everything rounds down.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { quoteIsNotUsdOrWsol } from "./price-reader.ts";
import { WSOL_MINT } from "@percolatorct/sdk";

export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const BINS_PER_ARRAY = 70;
export const BIN_SIZE = 144;
export const BIN_ARRAY_HEADER = 56;
export const BIN_ARRAY_LEN = BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE; // 10136
export const LB_PAIR_LEN = 904;
const MAX_BIN_STEP = 10_000;
const MAX_ACTIVE_ID_ABS = 500_000;
const U64_MAX = (1n << 64n) - 1n;
const MAX_DECIMALS = 24;
/** A stored bin price may differ from the bin-step price by at most 1 part in 1e9 (rounding of the program's own pow). */
const PRICE_TOLERANCE_DEN = 1_000_000_000n;

const LB_PAIR_DISC = createHash("sha256").update("account:LbPair").digest().subarray(0, 8);
const BIN_ARRAY_DISC = createHash("sha256").update("account:BinArray").digest().subarray(0, 8);

function hasDisc(d: Uint8Array, disc: Uint8Array): boolean {
  if (d.length < 8) return false;
  for (let i = 0; i < 8; i++) if (d[i] !== disc[i]) return false;
  return true;
}

/** floor(bin_id / 70), rounding toward -infinity (lb_clmm's BinArray::bin_id_to_bin_array_index). */
export function binArrayIndexOf(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY);
}

export function binArrayAddress(lbPair: PublicKey, index: number): PublicKey {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), b], DLMM_PROGRAM_ID)[0];
}

/** (1 + binStep/10000)^binId as a Q64.64 integer (floor), computed in Q128 so the 64-bit result keeps its precision. */
export function priceQ64(binId: number, binStep: number): bigint {
  const ONE = 1n << 128n;
  let base = ONE + (BigInt(binStep) << 128n) / 10_000n;
  let e = BigInt(Math.abs(binId));
  let r = ONE;
  while (e > 0n) {
    if (e & 1n) r = (r * base) >> 128n;
    e >>= 1n;
    if (e > 0n) base = (base * base) >> 128n;
  }
  if (binId < 0) r = (ONE * ONE) / r;
  return r >> 64n;
}

export type Refusal = { ok: false; reason: string };

export interface DlmmPlan {
  ok: true;
  activeId: number;
  binStep: number;
  /** bins above the active one (inclusive of none) whose price is within +2% */
  binsUp: number;
  /** bins below the active one whose price is within -2% */
  binsDown: number;
  /** bin-array indexes (ascending) that cover [active-binsDown, active+binsUp] */
  indexes: number[];
}

function readPair(poolData: Uint8Array): { ok: true; activeId: number; binStep: number } | Refusal {
  if (poolData.length < LB_PAIR_LEN) return { ok: false, reason: `LbPair too short (want 904) (${poolData.length})` };
  if (!hasDisc(poolData, LB_PAIR_DISC)) return { ok: false, reason: "LbPair discriminator mismatch" };
  const dv = new DataView(poolData.buffer, poolData.byteOffset, poolData.byteLength);
  const activeId = dv.getInt32(76, true);
  const binStep = dv.getUint16(80, true);
  if (binStep === 0 || binStep > MAX_BIN_STEP) return { ok: false, reason: `bin_step ${binStep} out of range` };
  if (Math.abs(activeId) > MAX_ACTIVE_ID_ABS) return { ok: false, reason: `active_id ${activeId} out of range` };
  return { ok: true, activeId, binStep };
}

/** The bin-array indexes needed to cover +-2% of this pool's active bin, or a refusal. Pure; the keeper fetches them. */
export function planDlmmBinArrays(poolData: Uint8Array): DlmmPlan | Refusal {
  const p = readPair(poolData);
  if (!p.ok) return p;
  const { activeId, binStep } = p;
  const p0 = priceQ64(activeId, binStep);
  const hi = p0 * 102n;
  const lo = p0 * 98n;
  const est = (ratio: number) => Math.max(0, Math.floor(Math.log(ratio) / Math.log(1 + binStep / 1e4)));
  let up = est(1.02);
  while (priceQ64(activeId + up, binStep) * 100n > hi) up--;
  while (priceQ64(activeId + up + 1, binStep) * 100n <= hi) up++;
  let down = est(1 / 0.98);
  while (down > 0 && priceQ64(activeId - down, binStep) * 100n < lo) down--;
  while (priceQ64(activeId - down - 1, binStep) * 100n >= lo) down++;
  const indexes: number[] = [];
  for (let i = binArrayIndexOf(activeId - down); i <= binArrayIndexOf(activeId + up); i++) indexes.push(i);
  return { ok: true, activeId, binStep, binsUp: up, binsDown: down, indexes };
}

export interface DlmmDepth {
  /** USD e6, rounded down. */
  bidUsdE6: bigint;
  askUsdE6: bigint;
  /** min(bid, ask): the attested-candidate figure. */
  minUsdE6: bigint;
  /** The same two figures in the pool's quote atoms (floor). */
  bidQuoteAtoms: bigint;
  askQuoteAtoms: bigint;
  activeId: number;
  binStep: number;
  /** Spot in quote units per whole base token x 1e6 (the active bin's stored price); USD for a USD-stable quote. */
  spotQuotePerBaseE6: bigint;
  binArrays: number[];
}

export interface DlmmDepthInput {
  lbPair: PublicKey;
  poolData: Uint8Array;
  /** bin-array index -> account data, or null / absent when the account does not exist. */
  binArrays: ReadonlyMap<number, Uint8Array | null>;
  decimals: { base: number; quote: number } | undefined;
  /** SOL/USD e6, needed (and used) only for a WSOL quote. */
  solPriceE6?: bigint;
}

const okDec = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_DECIMALS;

/** +-2% depth of a DLMM pool, or a refusal with the reason. Never a partial or guessed number. */
export function computeDlmmDepth(inp: DlmmDepthInput): { ok: true; depth: DlmmDepth } | Refusal {
  const dec = inp.decimals;
  if (!dec || !okDec(dec.base) || !okDec(dec.quote)) return { ok: false, reason: "token decimals unknown" };
  const plan = planDlmmBinArrays(inp.poolData);
  if (!plan.ok) return plan;
  const pool = inp.poolData;
  const quoteMint = new PublicKey(pool.subarray(120, 152));
  if (quoteIsNotUsdOrWsol(quoteMint)) {
    return { ok: false, reason: `quote mint ${quoteMint.toBase58()} is neither WSOL nor a USD stable` };
  }
  const wsol = quoteMint.equals(WSOL_MINT);
  if (wsol && (inp.solPriceE6 === undefined || inp.solPriceE6 <= 0n)) {
    return { ok: false, reason: "WSOL quote but no SOL/USD rate" };
  }
  const { activeId, binStep } = plan;

  // Every array in the +-2% range must be present and pass the layout checks.
  const views = new Map<number, DataView>();
  for (const idx of plan.indexes) {
    const a = inp.binArrays.get(idx);
    if (!a) return { ok: false, reason: `bin array ${idx} missing` };
    if (a.length < BIN_ARRAY_LEN) return { ok: false, reason: `bin array ${idx} too short (${a.length})` };
    if (!hasDisc(a, BIN_ARRAY_DISC)) return { ok: false, reason: `bin array ${idx} discriminator mismatch` };
    const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
    if (dv.getBigInt64(8, true) !== BigInt(idx)) return { ok: false, reason: `bin array ${idx} index field mismatch` };
    if (inp.lbPair.toBase58() !== new PublicKey(a.subarray(24, 56)).toBase58()) return { ok: false, reason: `bin array ${idx} belongs to another pool` };
    views.set(idx, dv);
  }
  const bin = (id: number) => {
    const idx = binArrayIndexOf(id);
    const dv = views.get(idx)!;
    const o = BIN_ARRAY_HEADER + (id - idx * BINS_PER_ARRAY) * BIN_SIZE;
    const price = dv.getBigUint64(o + 16, true) | (dv.getBigUint64(o + 24, true) << 64n);
    return { x: dv.getBigUint64(o, true), y: dv.getBigUint64(o + 8, true), price };
  };
  const priceOk = (id: number, stored: bigint): boolean => {
    const want = priceQ64(id, binStep);
    const diff = stored > want ? stored - want : want - stored;
    return diff * PRICE_TOLERANCE_DEN <= want;
  };

  const active = bin(activeId);
  if (!priceOk(activeId, active.price)) return { ok: false, reason: "active bin stored price disagrees with bin_step price" };

  let askAtoms = 0n;
  let bidAtoms = 0n;
  for (let id = activeId; id <= activeId + plan.binsUp; id++) {
    const b = bin(id);
    if (b.x === 0n) continue;
    if (!priceOk(id, b.price)) return { ok: false, reason: `bin ${id} stored price disagrees with bin_step price` };
    askAtoms += (b.x * b.price) >> 64n;
  }
  for (let id = activeId - plan.binsDown; id <= activeId; id++) {
    const b = bin(id);
    if (b.y === 0n) continue;
    if (!priceOk(id, b.price)) return { ok: false, reason: `bin ${id} stored price disagrees with bin_step price` };
    bidAtoms += b.y;
  }

  const unit = 10n ** BigInt(dec.quote);
  const toUsd = (atoms: bigint): bigint => (wsol ? (atoms * inp.solPriceE6!) / unit : (atoms * 1_000_000n) / unit);
  const bidUsdE6 = toUsd(bidAtoms);
  const askUsdE6 = toUsd(askAtoms);
  if (bidUsdE6 > U64_MAX || askUsdE6 > U64_MAX) return { ok: false, reason: "depth overflows u64" };
  const spot = (active.price * 10n ** BigInt(dec.base) * 1_000_000n) / ((1n << 64n) * unit);
  return {
    ok: true,
    depth: {
      bidUsdE6,
      askUsdE6,
      minUsdE6: bidUsdE6 < askUsdE6 ? bidUsdE6 : askUsdE6,
      bidQuoteAtoms: bidAtoms,
      askQuoteAtoms: askAtoms,
      activeId,
      binStep,
      spotQuotePerBaseE6: spot,
      binArrays: plan.indexes,
    },
  };
}
