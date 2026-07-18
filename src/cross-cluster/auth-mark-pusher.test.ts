/**
 * Literal-pinned regression test for the auth-mark-pusher's wrapper program id
 * (2026-07-17 fresh devnet triple cutover — security/auth-mark-pusher-version-gate).
 *
 * auth-mark-pusher.ts sources WRAPPER_PROGRAM_ID directly from the SDK's
 * PROGRAM_IDS_V17.percolator constant (not an env var). Asserting
 * `WRAPPER_PROGRAM_ID.toBase58() === PROGRAM_IDS_V17.percolator` would be a
 * vacuous self-check — both sides read the same constant, so the assertion
 * can never fail regardless of which program the SDK actually points at.
 *
 * These tests instead pin the LITERAL fresh wrapper address so a future SDK
 * bump that silently reverts (or drifts) the devnet default is caught here,
 * independent of whatever PROGRAM_IDS_V17 currently contains. They also pin
 * the LITERAL superseded (2026-06-26) wrapper address as a must-not-equal
 * guard — the old wrapper is still live on devnet with ~152 existing markets,
 * so accidentally targeting it again would silently push marks to the wrong
 * program's markets (or fail with a signer/owner mismatch there).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/auth-mark-pusher.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

// Fresh devnet triple — deployed + upgraded 2026-07-17, hash-verified on-chain.
const FRESH_WRAPPER = "DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj";

// Superseded 2026-06-26 wrapper — still live on devnet with ~152 existing
// markets, but no longer the SDK default. Must NOT be what this file targets.
const OLD_WRAPPER = "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9";

describe("auth-mark-pusher WRAPPER_PROGRAM_ID — fresh triple cutover (2026-07-17)", () => {
  it("targets the fresh devnet wrapper (literal pin, not a re-import of the SDK constant)", () => {
    assert.equal(WRAPPER_PROGRAM_ID.toBase58(), FRESH_WRAPPER);
  });

  it("does NOT target the superseded 2026-06-26 wrapper", () => {
    assert.notEqual(WRAPPER_PROGRAM_ID.toBase58(), OLD_WRAPPER);
  });
});
