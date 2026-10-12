/**
 * cross-cluster/v22/band.ts
 *
 * Band-market health. Errors 104 (PriceBandPinned), 111 (PriceBandPositionCap), 112 (PriceBandTooNarrow) and 113
 * (PriceBandLegBelowMinNotional) are EXPECTED STATES of a band market (errors.ts BAND_EXPECTED_CODES): counted and
 * logged by name, never alerted as failures. The one thing the keeper must watch is the PIN DURATION: a pinned
 * price (the mark is held at P_last while the target differs) forces a recovery at the stale P_last once it exceeds
 * `band_max_pin_slots` (Pmax, default 9,000 slots, about 1 h; Wave B review E-M1). `pinDurationSlots` is surfaced
 * per market in /health, with a `half` (>= Pmax/2) and `critical` (>= 80% Pmax) marker.
 */
import type { V22MarketCtx } from "./market.ts";

export const SLOT_SECONDS = 0.4;

export type PinLevel = "none" | "pinned" | "half" | "critical";

export interface BandHealth {
  band: boolean;
  pinned: boolean;
  pinSinceSlot: string;
  pinDurationSlots: string;
  pinDurationSecs: number;
  maxPinSlots: string;
  pinLevel: PinLevel;
  uncertified: { long: string; short: string };
  liqPending: { long: string; short: string };
  maxPositionsPerSide: string;
}

export function pinLevelOf(durationSlots: bigint, maxPinSlots: bigint): PinLevel {
  if (durationSlots <= 0n) return "none";
  if (maxPinSlots <= 0n) return "pinned";
  if (durationSlots * 10n >= maxPinSlots * 8n) return "critical";
  if (durationSlots * 2n >= maxPinSlots) return "half";
  return "pinned";
}

export function bandHealthFor(ctx: V22MarketCtx): BandHealth {
  const b = ctx.band;
  return {
    band: ctx.isBand,
    pinned: ctx.pinDurationSlots > 0n,
    pinSinceSlot: b.pinSinceSlot.toString(),
    pinDurationSlots: ctx.pinDurationSlots.toString(),
    pinDurationSecs: Math.round(Number(ctx.pinDurationSlots) * SLOT_SECONDS),
    maxPinSlots: b.maxPinSlots.toString(),
    pinLevel: pinLevelOf(ctx.pinDurationSlots, b.maxPinSlots),
    uncertified: { long: b.uncertifiedLong.toString(), short: b.uncertifiedShort.toString() },
    liqPending: { long: b.liqPendingLong.toString(), short: b.liqPendingShort.toString() },
    maxPositionsPerSide: b.maxPositionsPerSide.toString(),
  };
}
