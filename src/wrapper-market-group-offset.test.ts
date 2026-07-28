/**
 * Tests for wrapper-market-group-offset.ts — the version-gated MARKET_GROUP_OFF
 * selection that every wrapper-config-relative byte read in this keeper depends on.
 *
 * Run with: node --import tsx/esm --test src/wrapper-market-group-offset.test.ts
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * On 2026-07-23 this keeper silently stopped pushing prices for days. Root cause
 * was NOT a code bug: it was a stale pnpm snapshot of `@percolatorct/sdk` that
 * still exported V17_WRAPPER_CONFIG_LEN = 496 while the deployed wrapper had
 * grown the config to 576. Every asset-profile offset is computed as
 *   HEADER_LEN(16) + WRAPPER_CONFIG_LEN + MARKET_GROUP_LEN + i*ASSET_SLOT_LEN
 * so an 80-byte-stale config length shifted the read by 80 bytes. The keeper then
 * decoded `oracle_authority` out of the wrong struct, concluded it was not the
 * market's authority, and skipped the push — in-bounds, no exception, no error log.
 *
 * Nothing in the suite caught it, because no test pinned the ABSOLUTE constants;
 * everything re-derived offsets from the same SDK export that had gone stale.
 * These tests exist specifically to fail when the linked SDK's layout constants
 * move, so a stale or regressed snapshot is loud instead of silent.
 *
 * Grounded on-chain 2026-07-24 against both live devnet markets
 * (BPgSUbDsxZ9bkauWgd6eQ8oLHVx6pSsvfAjPGsS2Sso8 and
 * 7FBXdrm1vQ4ktQJjMwurq4cAHkVB1gKoZ7Hx3CAQv6P4, owner DhSkE7u…), both of which
 * report header VERSION 17 and, at the 592-based offset, oracleMode = 3
 * (AUTH_MARK) with oracleAuthority == the keeper's own pubkey. At the stale
 * 512-based offset the very same accounts read oracleMode = 0 (MANUAL) and a
 * garbage authority — i.e. the outage reproduces exactly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  V17_MAGIC,
  V17_WRAPPER_CONFIG_LEN,
  V17_MARKET_GROUP_OFF,
  V17_HEADER_LEN,
} from "@percolatorct/sdk";
import {
  selectMarketGroupOffset,
  V16_MARKET_GROUP_OFF,
  MARKET_GROUP_OFF_BY_VERSION,
  VERSION_16,
  VERSION_17,
  HEADER_VERSION_OFF,
} from "./wrapper-market-group-offset.js";

/**
 * Build a synthetic wrapper account header.
 *
 * @param version  value written to the u16 LE VERSION field at byte 8
 * @param magic    8-byte LE magic at byte 0 (defaults to the real wrapper magic)
 * @param len      total buffer length
 */
function makeHeader(version: number, magic: bigint = V17_MAGIC, len = 64): Uint8Array {
  const buf = new Uint8Array(len);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, magic, true);
  dv.setUint16(HEADER_VERSION_OFF, version, true);
  return buf;
}

// ══════════════════════════════════════════════════════════════
// SDK layout canaries — these are the stale-snapshot detectors
// ══════════════════════════════════════════════════════════════
describe("linked SDK layout constants (stale-snapshot canary)", () => {
  it("V17_WRAPPER_CONFIG_LEN is 576 (fee-split layout), NOT the pre-fee-split 496", () => {
    // 496 is the value the stale snapshot carried during the 2026-07-23 outage.
    // 432 is the older VERSION-16 value. Both must be treated as regressions.
    assert.equal(
      V17_WRAPPER_CONFIG_LEN,
      576,
      `Linked SDK reports WRAPPER_CONFIG_LEN=${V17_WRAPPER_CONFIG_LEN}. ` +
        `576 is the deployed fee-split layout; 496/432 mean the snapshot is stale ` +
        `and every oracle-profile read will be shifted — the keeper will silently ` +
        `stop pushing prices. Force-refresh: rm -rf node_modules/.pnpm/@percolatorct+sdk* ` +
        `node_modules/@percolatorct/sdk && pnpm install`,
    );
  });

  it("V17_MARKET_GROUP_OFF is 592 = HEADER_LEN(16) + 576", () => {
    assert.equal(V17_HEADER_LEN, 16, "header is [magic:8][version:2][kind:1][pad:1][reserved:4]");
    assert.equal(V17_MARKET_GROUP_OFF, 592);
    // Pin the relationship too, so a change to either input is attributable.
    assert.equal(V17_MARKET_GROUP_OFF, V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN);
  });

  it("the fee-split config growth did NOT move MARKET_GROUP_OFF back to 512", () => {
    // Explicit negative assertion: 512 is the stale value that reproduces the outage.
    assert.notEqual(V17_MARKET_GROUP_OFF, 512, "MARKET_GROUP_OFF regressed to the stale 512");
    assert.notEqual(V17_MARKET_GROUP_OFF, 448, "MARKET_GROUP_OFF regressed to the VERSION-16 448");
  });
});

// ══════════════════════════════════════════════════════════════
// The V16 pin — must be a literal, never derived from the V17 constant
// ══════════════════════════════════════════════════════════════
describe("V16_MARKET_GROUP_OFF is pinned, not derived", () => {
  it("is exactly 448 = HEADER_LEN(16) + WRAPPER_CONFIG_LEN_V16(432)", () => {
    assert.equal(V16_MARKET_GROUP_OFF, 448);
  });

  it("is NOT the old `V17_MARKET_GROUP_OFF - 64` derivation", () => {
    // That derivation was correct only while the v17 config was 496. Once the
    // fee-split grew it to 576 the derivation silently yields 528 — an 80-byte
    // misread of every VERSION-16 account. This assertion fails if anyone
    // reintroduces it.
    assert.notEqual(
      V16_MARKET_GROUP_OFF,
      V17_MARKET_GROUP_OFF - 64,
      "V16_MARKET_GROUP_OFF appears to be derived as V17_MARKET_GROUP_OFF - 64 (=528). " +
        "It must be the pinned literal 448.",
    );
  });

  it("sits 144 bytes below the current v17 offset (432 -> 576 is +144 total)", () => {
    assert.equal(V17_MARKET_GROUP_OFF - V16_MARKET_GROUP_OFF, 144);
  });
});

// ══════════════════════════════════════════════════════════════
// Version gating
// ══════════════════════════════════════════════════════════════
describe("selectMarketGroupOffset", () => {
  it("resolves a VERSION 17 account to 592", () => {
    const r = selectMarketGroupOffset(makeHeader(VERSION_17));
    assert.equal(r.ok, true);
    assert.deepEqual(r, { ok: true, version: 17, marketGroupOff: 592 });
  });

  it("resolves a VERSION 16 account to 448 — NOT to the v17 offset", () => {
    // This is the mixed-fleet case the module was written for: decoding a
    // VERSION-16 account at the v17 offset stays in-bounds and yields
    // plausible-looking garbage.
    const r = selectMarketGroupOffset(makeHeader(VERSION_16));
    assert.equal(r.ok, true);
    assert.deepEqual(r, { ok: true, version: 16, marketGroupOff: 448 });
    assert.notEqual(
      (r as { marketGroupOff: number }).marketGroupOff,
      V17_MARKET_GROUP_OFF,
      "a VERSION-16 account must never resolve to the VERSION-17 offset",
    );
  });

  it("fails closed on a foreign/unowned account (bad magic)", () => {
    const r = selectMarketGroupOffset(makeHeader(VERSION_17, 0xdeadbeefdeadbeefn));
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "bad-magic");
    assert.equal((r as { magic: bigint }).magic, 0xdeadbeefdeadbeefn);
  });

  it("fails closed on an unrecognized VERSION rather than guessing an offset", () => {
    // A future VERSION 18 with another config growth must NOT be decoded with
    // the v17 offset. This is the assertion that turns the next layout change
    // from a silent misread into a visible skip.
    const r = selectMarketGroupOffset(makeHeader(18));
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "unrecognized-version");
    assert.equal((r as { version: number }).version, 18);
  });

  it("fails closed on a buffer too short to contain the VERSION field", () => {
    const r = selectMarketGroupOffset(new Uint8Array(HEADER_VERSION_OFF + 1));
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "too-short");
  });

  it("respects byteOffset when handed a subarray view (no buffer-origin bug)", () => {
    // selectMarketGroupOffset builds a DataView over data.buffer; if it ignored
    // data.byteOffset it would read the padding instead of the header.
    const backing = new Uint8Array(128);
    backing.set(makeHeader(VERSION_17), 32);
    const view = backing.subarray(32);
    const r = selectMarketGroupOffset(view);
    assert.equal(r.ok, true);
    assert.deepEqual(r, { ok: true, version: 17, marketGroupOff: 592 });
  });

  it("the version table has an entry for exactly the two known versions", () => {
    assert.deepEqual(
      Object.keys(MARKET_GROUP_OFF_BY_VERSION).map(Number).sort((a, b) => a - b),
      [16, 17],
    );
    assert.equal(MARKET_GROUP_OFF_BY_VERSION[16], 448);
    assert.equal(MARKET_GROUP_OFF_BY_VERSION[17], 592);
  });
});
