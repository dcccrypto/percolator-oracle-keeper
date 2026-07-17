/**
 * Tests for the recovery-cranker's PermissionlessCrank wire format
 * (security/auth-mark-pusher-version-gate — W3 sync, upstream wrapper #206).
 *
 * FIX W3: the wrapper's PermissionlessCrank instruction (tag 5) no longer
 * accepts caller-supplied close_q (u128) / fee_bps (u64) — liquidation size
 * and fee are now engine-selected. The wire payload shrank 53 -> 29 bytes.
 * This pins the EXACT bytes buildCrankIx() sends every cycle so a
 * regression back to the pre-W3 53-byte layout (or any other drift from the
 * v16_program.rs Instruction::PermissionlessCrank decode) fails loudly
 * instead of silently breaking every crank against a W3 program.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/recovery-cranker.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buildCrankIx } from "./recovery-cranker.ts";
import { IX_TAG, PROGRAM_IDS_V17 } from "@percolatorct/sdk";

const OWNER = PublicKey.unique();
const MARKET = PublicKey.unique();
const PORTFOLIO = PublicKey.unique();

describe("buildCrankIx — PermissionlessCrank W3 wire format", () => {
  it("produces exactly 29 bytes (post-W3; pre-W3 was 53)", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.data.length, 29);
  });

  it("pins the full 29-byte payload byte for byte", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    // tag(5) + action(0=Refresh) + assetIndex(u16=0) + nowSlot(u64=0) +
    // fundingRateE9(i128=0, hardcoded) + recoveryReason(0) — all-zero
    // payload apart from the tag byte, since this loop always cranks with
    // action=FeeSweep/Refresh, assetIndex=0, nowSlot=0, recoveryReason=0.
    const expected = new Uint8Array(29); // zero-filled
    expected[0] = IX_TAG.PermissionlessCrank;
    assert.deepEqual([...ix.data], [...expected]);
  });

  it("tag byte is IX_TAG.PermissionlessCrank (5)", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.data[0], IX_TAG.PermissionlessCrank);
    assert.equal(ix.data[0], 5);
  });

  it("targets the v17 wrapper program", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.programId.toBase58(), PROGRAM_IDS_V17.percolator);
  });

  it("account order is [owner(signer,writable), market(writable), portfolio(writable)]", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.keys.length, 3);
    assert.equal(ix.keys[0].pubkey.toBase58(), OWNER.toBase58());
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[1].pubkey.toBase58(), MARKET.toBase58());
    assert.equal(ix.keys[1].isWritable, true);
    assert.equal(ix.keys[2].pubkey.toBase58(), PORTFOLIO.toBase58());
    assert.equal(ix.keys[2].isWritable, true);
  });
});
