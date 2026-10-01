/**
 * cross-cluster/adl-state.ts
 *
 * Detect the ADL reduce-only state (F-3 / R1–R2, ledger
 * f3-market-freeze-triage-2026-09-30.md). After a bankruptcy ADL the engine
 * keeps an asset REDUCE-ONLY while `a_long != ADL_ONE || a_short != ADL_ONE`:
 * every risk-increasing leg change reverts Custom(21), so the market looks
 * frozen for opens. It reopens only once one whole side has exited (the
 * zero-OI reset). R2: a single abandoned position per side keeps it that way
 * indefinitely, so the alert carries the duration and both sides' OI.
 *
 * Layout, verified against engine 35ddd692 `AssetStateV16Account` (v16.rs:7371,
 * packed POD): market_id u64 @0, retired_slot u64 @8, lifecycle u8 @16,
 * raw_oracle_target_price @17, effective_price @25, fund_px_last @33,
 * slot_last @41, a_long u128 @49, a_short u128 @65. OI effective long/short
 * u128 @289/@305 (the same offsets positioned-refresh.ts already uses).
 * ADL_ONE = 1e15 (engine lib.rs:16). The frontend reaches the same offsets via
 * offset_of! (wt-app-limits app/lib/limits/constants.ts).
 *
 * v18 ONLY: a v17 slab reads a_long = a_short = 0 at these offsets, which would
 * look like the reduce-only state. The header must be the wrapper magic,
 * VERSION 18 and kind 1 (market account) or this returns null.
 */
import { V17_MARKET_GROUP_LEN, V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";

export const ADL_ONE = 1_000_000_000_000_000n;

const WRAPPER_MAGIC = 0x5045_5243_5631_3600n;
const WRAPPER_VERSION_V18 = 18;
const HEADER_KIND_OFF = 10;
const KIND_MARKET_ACCOUNT = 1;

const ASSET_SLOT_LEN = 2325;
const ASSET_WRAPPER_LEN = 1024;
const AS_A_LONG = 49;
const AS_A_SHORT = 65;
const AS_OI_EFF_LONG = 289;
const AS_OI_EFF_SHORT = 305;

export interface AdlState {
  aLong: bigint;
  aShort: bigint;
  oiEffLong: bigint;
  oiEffShort: bigint;
  reduceOnly: boolean;
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}
function u128(d: Uint8Array, off: number): bigint {
  return u64(d, off) | (u64(d, off + 8) << 64n);
}

export function isV18MarketHeader(d: Uint8Array): boolean {
  if (d.length < 16) return false;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(0, true) === WRAPPER_MAGIC && v.getUint16(8, true) === WRAPPER_VERSION_V18 && d[HEADER_KIND_OFF] === KIND_MARKET_ACCOUNT;
}

/** null for a non-v18 market header or a too-short buffer — never a guess. */
export function decodeAdlState(d: Uint8Array, assetIndex = 0): AdlState | null {
  if (!isV18MarketHeader(d)) return null;
  const a = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
  if (d.length < a + AS_OI_EFF_SHORT + 16) return null;
  const aLong = u128(d, a + AS_A_LONG);
  const aShort = u128(d, a + AS_A_SHORT);
  return {
    aLong,
    aShort,
    oiEffLong: u128(d, a + AS_OI_EFF_LONG),
    oiEffShort: u128(d, a + AS_OI_EFF_SHORT),
    reduceOnly: aLong !== ADL_ONE || aShort !== ADL_ONE,
  };
}

/** A as a decimal fraction of ADL_ONE, e.g. "0.861700". */
export function adlFraction(a: bigint): string {
  const scaled = (a * 1_000_000n) / ADL_ONE;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, "0")}`;
}
