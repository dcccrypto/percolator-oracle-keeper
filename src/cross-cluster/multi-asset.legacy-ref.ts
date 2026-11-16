/** Pre-perf reference of the multi-asset decoders (per-asset decodeMarketRefreshState). Test oracle only. */
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import type { MarketRefreshState } from "./positioned-refresh.ts";

const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;

/** Per-asset refresh state of the observed assets (asset order). Assets out of range are skipped. */
export function legacyDecodeAssetRefreshStates(data: Uint8Array, assets: ReadonlyArray<number>): Array<{ assetIndex: number; state: MarketRefreshState }> {
  const out: Array<{ assetIndex: number; state: MarketRefreshState }> = [];
  for (const assetIndex of assets) {
    try {
      out.push({ assetIndex, state: decodeMarketRefreshState(data, assetIndex) });
    } catch {
      // out of range for this account: not an asset of this market
    }
  }
  return out;
}

/**
 * One MarketRefreshState for the cranker and the v2.2 layer, over every observed asset. For `[0]` this is EXACTLY
 * `decodeMarketRefreshState(data)` (single-asset behaviour). Otherwise:
 *   - header words (currentSlot, maxAccrualDtSlots, lossStaleActive) are shared;
 *   - lifecycle / K-F epochs are asset 0's (the market-level gate the callers already apply);
 *   - stored / stale counts are SUMMED (they match a positioned set built over the same assets);
 *   - slotLast is the OLDEST Active/DrainOnly observed asset (what the catch-up must cover);
 *   - contributesToLossStale is true iff some asset is loss-stale by the clock, so `isAssetLossStale` on the result
 *     equals "some observed asset is loss-stale".
 * Throws like decodeMarketRefreshState when asset 0 cannot be decoded.
 */
export function legacyDecodeMarketRefreshStateFor(data: Uint8Array, assets: ReadonlyArray<number>): MarketRefreshState {
  if (assets.length === 1 && assets[0] === 0) return decodeMarketRefreshState(data);
  const base = decodeMarketRefreshState(data);
  const per = legacyDecodeAssetRefreshStates(data, assets);
  if (per.length === 0) return base;
  let storedPosLong = 0n;
  let storedPosShort = 0n;
  let staleLong = 0n;
  let staleShort = 0n;
  let clockStale = false;
  let oldestActive: bigint | null = null;
  for (const { state: s } of per) {
    storedPosLong += s.storedPosLong;
    storedPosShort += s.storedPosShort;
    staleLong += s.staleLong;
    staleShort += s.staleShort;
    if (s.contributesToLossStale && s.slotLast < s.currentSlot) clockStale = true;
    if (s.lifecycle === LIFECYCLE_ACTIVE || s.lifecycle === LIFECYCLE_DRAIN_ONLY) {
      if (oldestActive === null || s.slotLast < oldestActive) oldestActive = s.slotLast;
    }
  }
  const slotLast = oldestActive ?? base.slotLast;
  return {
    ...base,
    slotLast,
    storedPosLong,
    storedPosShort,
    staleLong,
    staleShort,
    // With clockStale false the result must not read loss-stale through the clock even when the OLDEST asset is
    // behind (that asset holds nothing); with it true, slotLast (the oldest) is < currentSlot by construction.
    contributesToLossStale: clockStale,
  };
}

