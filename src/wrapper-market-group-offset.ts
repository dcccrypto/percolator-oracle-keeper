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
import { V17_MAGIC, V17_MARKET_GROUP_OFF, V17_EXPECTED_VERSION } from "@percolatorct/sdk";

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

/**
 * Versions this keeper knows how to decode, mapped to their MARKET_GROUP_OFF.
 * V17_MARKET_GROUP_LEN and V17_MARKET_ASSET_SLOT_LEN are unchanged between
 * VERSION 16 and 17 (per the SDK: "the header/asset-slot structs themselves
 * are unchanged" — only MARKET_GROUP_OFF shifted), so only this offset needs
 * a version branch; callers add V17_MARKET_GROUP_LEN / assetIndex * V17_MARKET_ASSET_SLOT_LEN
 * on top of whatever this table returns.
 */
export const MARKET_GROUP_OFF_BY_VERSION: Readonly<Record<number, number>> = {
  [VERSION_16]: V16_MARKET_GROUP_OFF,
  [VERSION_17]: V17_MARKET_GROUP_OFF,
};

export type MarketGroupOffsetResult =
  | { ok: true; version: number; marketGroupOff: number }
  | { ok: false; reason: "too-short" }
  | { ok: false; reason: "bad-magic"; magic: bigint }
  | { ok: false; reason: "unrecognized-version"; version: number };

/**
 * Read an account's header magic + VERSION and resolve the correct
 * MARKET_GROUP_OFF for that VERSION.
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
  const marketGroupOff = MARKET_GROUP_OFF_BY_VERSION[version];
  if (marketGroupOff === undefined) {
    return { ok: false, reason: "unrecognized-version", version };
  }
  return { ok: true, version, marketGroupOff };
}
