/**
 * wrapper-market-group-offset.ts
 *
 * Shared VERSION-gated MARKET_GROUP_OFF selection (security review 3 must-fix).
 *
 * The wrapper's account header is [magic:8][version:2 LE][kind:1][pad:1][reserved:4]
 * (V17_HEADER_LEN = 16), and MARKET_GROUP_OFF = HEADER_LEN + WRAPPER_CONFIG_LEN is
 * CONFIG-RELATIVE, not a fixed constant across program versions. The protocol-fee
 * program change (percolator-prog@626fb617) grew WrapperConfigV16 432 -> 496 bytes
 * and bumped the header's VERSION field 16 -> 17 in the SAME commit, so
 * MARKET_GROUP_OFF moves 448 -> 512 and every asset-profile slot (including
 * oracle_authority, oracle_mode, mark_ewma_e6, etc.) shifts by the same +64
 * downstream.
 *
 * During a mixed-fleet window — some devnet markets re-seeded at VERSION 17,
 * others still VERSION 16 — computing profileOff with the V17 offset
 * UNCONDITIONALLY decodes 64 bytes into the wrong struct on any VERSION-16
 * account: still in-bounds (passes a naive length check), still parses as
 * plausible-looking data, but it is reading the wrong field. Any reader that
 * derives a byte offset from V17_MARKET_GROUP_OFF must gate on the account's
 * own header VERSION byte instead of assuming VERSION 17.
 *
 * Originally added to cross-cluster/auth-mark-pusher.ts (oracle_authority
 * read); factored out here so index.ts's oracle-mode read
 * (v17OracleProfileOffset / cacheV17OracleMode) can share the exact same
 * version table instead of duplicating it.
 */
import {
  V17_MAGIC,
  V17_MARKET_GROUP_OFF,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  LAYOUT_V22,
} from "@percolatorct/sdk";

/** Byte offset of the 8-byte account magic within the header. */
export const HEADER_MAGIC_OFF = 0;
/** Byte offset of the u16 LE VERSION field within the header (right after the magic). */
export const HEADER_VERSION_OFF = 8;

/** Pre-protocol-fee wrapper account VERSION (percolator-prog v16_program.rs, parent of 626fb617). */
export const VERSION_16 = 16;
/** Post-protocol-fee wrapper account VERSION. Re-exported for caller convenience. */
export const VERSION_17 = V17_EXPECTED_VERSION;

/**
 * Pre-protocol-fee MARKET_GROUP_OFF (VERSION 16): HEADER_LEN(16) + WRAPPER_CONFIG_LEN_V16(432) = 448.
 *
 * ⚠ MUST be pinned, NOT derived from V17_MARKET_GROUP_OFF. The v17 config grew
 * in TWO steps: protocol-fee 432->496 (+64) AND fee-split 496->576 (+80), so
 * V17_MARKET_GROUP_OFF is now 592 and the v17->v16 delta is 144, not 64. The old
 * `V17_MARKET_GROUP_OFF - 64` derivation silently became 528 (wrong) the moment
 * the SDK was refreshed to the 576-byte fee-split layout — which would misread
 * every VERSION-16 account by 80 bytes. v16's config is genuinely 432, so pin it.
 */
export const V16_MARKET_GROUP_OFF = 448; // HEADER_LEN(16) + WRAPPER_CONFIG_LEN_V16(432)

/** v2.2 wrapper account VERSION (percolator-prog release/v22-wrapper-rem 6c078a0e `constants::VERSION = 19`). */
export const VERSION_19 = 19;

/**
 * v2.2 (VERSION 19, variant B = the launch candidate) market geometry, read from the SDK's LAYOUT_V22 row (the keeper
 * types no slot-length literal; see leg-cap.test.ts). Expected values, from the wrapper RC and the chain:
 *   MARKET_GROUP_OFF   = HEADER_LEN(16) + WRAPPER_CONFIG_LEN(576) = 592   (RC v16_program.rs:111-112, :686; unchanged)
 *   MARKET_GROUP_LEN   = size_of::<MarketGroupV16HeaderAccount>() = 806   (v2.1: 758; V16ConfigAccount grew +48 B band/rent)
 *   ASSET_SLOT_STRIDE  = 1024 wrapper + 1637 engine                      (v2.1: 1024 + 1301)
 *   ASSET_WRAPPER_LEN  = 1024                                            (unchanged)
 * Verified 2026-10-10 on the fresh v2.2 devnet slabs (wrapper 6kpg2wi7, 4,059 B = one slot): at 592 + 806 the asset-0
 * profile reads oracle_mode 3 (AuthMark) and oracle_authority = the keeper; at the v2.1 592 + 758 it reads a garbage
 * authority. `v22-fresh-k1-k4.test.ts` pins these numbers against real VERSION-19 account bytes.
 *
 * ⚠ The VERSION-19 MARKET_GROUP_OFF equals v2.1's (592), so a table holding ONLY the group offset would "accept"
 * VERSION 19 and then read every profile 48 bytes early (the K-2 trap). Callers must use the per-version
 * `marketGroupLen` / `assetSlotStride` / `wrapperSlotLen` returned here, never the V17 constants.
 */
if (LAYOUT_V22.version !== VERSION_19) {
  throw new Error(`pinned SDK LAYOUT_V22 is VERSION ${LAYOUT_V22.version}, keeper expects ${VERSION_19}: update wrapper-market-group-offset.ts`);
}
export const V19_MARKET_GROUP_OFF = LAYOUT_V22.marketGroupOff;
export const V19_MARKET_GROUP_LEN = LAYOUT_V22.marketGroupLen;
export const V19_MARKET_ASSET_SLOT_LEN = LAYOUT_V22.assetSlotStride;
export const V19_ASSET_ORACLE_WRAPPER_LEN = LAYOUT_V22.wrapperSlotLen;

/** The per-VERSION geometry every wrapper-slot-relative read needs. */
export interface MarketGeometry {
  /** HEADER_LEN + WRAPPER_CONFIG_LEN: start of the market-group header. */
  marketGroupOff: number;
  /** size_of::<MarketGroupV16HeaderAccount>(): asset slot 0 starts at marketGroupOff + marketGroupLen. */
  marketGroupLen: number;
  /** Stride of one asset slot (wrapper prefix + engine slot). */
  assetSlotStride: number;
  /** Wrapper prefix of each slot (oracle profile @0, control sequences @512, ...); the engine slot follows it. */
  wrapperSlotLen: number;
}

/**
 * Versions this keeper knows how to decode, with their FULL geometry. VERSION 16 and 18 (exported as VERSION_17 for
 * history: the SDK's V17_EXPECTED_VERSION is 18) share the v2.1 group length and stride; VERSION 19 does not.
 */
export const MARKET_GEOMETRY_BY_VERSION: Readonly<Record<number, Readonly<MarketGeometry>>> = {
  [VERSION_16]: { marketGroupOff: V16_MARKET_GROUP_OFF, marketGroupLen: V17_MARKET_GROUP_LEN, assetSlotStride: V17_MARKET_ASSET_SLOT_LEN, wrapperSlotLen: V17_ASSET_ORACLE_WRAPPER_LEN },
  [VERSION_17]: { marketGroupOff: V17_MARKET_GROUP_OFF, marketGroupLen: V17_MARKET_GROUP_LEN, assetSlotStride: V17_MARKET_ASSET_SLOT_LEN, wrapperSlotLen: V17_ASSET_ORACLE_WRAPPER_LEN },
  [VERSION_19]: { marketGroupOff: V19_MARKET_GROUP_OFF, marketGroupLen: V19_MARKET_GROUP_LEN, assetSlotStride: V19_MARKET_ASSET_SLOT_LEN, wrapperSlotLen: V19_ASSET_ORACLE_WRAPPER_LEN },
};

/** MARKET_GROUP_OFF per VERSION (kept for existing callers/tests; derived from {@link MARKET_GEOMETRY_BY_VERSION}). */
export const MARKET_GROUP_OFF_BY_VERSION: Readonly<Record<number, number>> = Object.fromEntries(
  Object.entries(MARKET_GEOMETRY_BY_VERSION).map(([v, g]) => [Number(v), g.marketGroupOff]),
);

/** Absolute offset of asset `assetIndex`'s wrapper slot (= its AssetOracleProfile) for a resolved geometry. */
export function assetSlotOffset(g: MarketGeometry, assetIndex: number): number {
  return g.marketGroupOff + g.marketGroupLen + assetIndex * g.assetSlotStride;
}

export type MarketGroupOffsetResult =
  | ({ ok: true; version: number } & MarketGeometry)
  | { ok: false; reason: "too-short" }
  | { ok: false; reason: "bad-magic"; magic: bigint }
  | { ok: false; reason: "unrecognized-version"; version: number };

/**
 * Read an account's header magic + VERSION and resolve the correct
 * geometry (MARKET_GROUP_OFF, MARKET_GROUP_LEN, slot stride, wrapper-slot length) for that VERSION.
 *
 * Fails closed (never guesses an offset):
 *   - "too-short": buffer doesn't even reach the VERSION field.
 *   - "bad-magic": not a v16/v17 wrapper-owned account (magic mismatch).
 *   - "unrecognized-version": magic is right but VERSION isn't in the table —
 *     the on-chain layout changed again and this table needs a new entry.
 *
 * Callers should treat any `ok: false` result as "cannot safely compute a
 * wrapper-config-relative offset — skip, don't decode with a guessed offset."
 */
export function selectMarketGroupOffset(data: Uint8Array): MarketGroupOffsetResult {
  if (data.length < HEADER_VERSION_OFF + 2) {
    return { ok: false, reason: "too-short" };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getBigUint64(HEADER_MAGIC_OFF, true);
  if (magic !== V17_MAGIC) {
    return { ok: false, reason: "bad-magic", magic };
  }
  const version = view.getUint16(HEADER_VERSION_OFF, true);
  const geometry = MARKET_GEOMETRY_BY_VERSION[version];
  if (geometry === undefined) {
    return { ok: false, reason: "unrecognized-version", version };
  }
  return { ok: true, version, ...geometry };
}
