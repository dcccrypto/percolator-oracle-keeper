import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { ACCOUNT_KIND, BackstopMode, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@percolatorct/sdk";
import { G9_DRAW_RETRY_SLOTS, G9_PROPOSE_RETRY_SLOTS, G9_RESTORE_RETRY_SLOTS, decideG9, freshG9State, g9ExtraTail, g9Once, oracleQualifies } from "./g9.ts";
import type { V22MarketCtx } from "./market.ts";
import { customAt, execCtx, fakeExecConn, key, v22Ctx } from "./test-helpers.ts";

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const ctxLike = (o: Partial<Pick<V22MarketCtx, "oracleMode" | "oracleLegCount" | "bound" | "lpPortfolio" | "marketAddress" | "refresh">> = {}) =>
  ({ oracleMode: 1, oracleLegCount: 1, bound: true, lpPortfolio: key(1), marketAddress: "M", refresh: undefined, ...o }) as never;
const units = (pending = 0n, receivable = 0n) => ({ g9PendingSlot: pending, backstopReceivableAtoms: receivable });

/** A valid InsuranceUnits account (the decoder runs the program's validate_insurance_units). */
function unitsBytes(pending: bigint, receivable: bigint): Uint8Array {
  const L = LAYOUT_V22 as unknown as { version: number; headerLen?: number };
  const hdr = 16;
  const b = Buffer.alloc(hdr + 192);
  b.writeBigUInt64LE(WRAPPER_ACCOUNT_MAGIC, 0);
  b.writeUInt16LE(L.version, 8);
  b[10] = ACCOUNT_KIND.InsuranceUnits;
  Buffer.from(key(5).toBytes()).copy(b, hdr); // marketGroup, non-zero
  b.writeBigUInt64LE(100n, hdr + 32); // total = stake + creator
  b.writeBigUInt64LE(60n, hdr + 48);
  b.writeBigUInt64LE(40n, hdr + 64);
  b.writeBigUInt64LE(receivable & U64_MAX, hdr + 80);
  b[hdr + 136] = 1; // version
  b.writeBigUInt64LE(pending, hdr + 160);
  return new Uint8Array(b);
}

describe("g9 oracleQualifies", () => {
  it("allowAny lifts the gate; otherwise Hybrid with legs only", () => {
    assert.equal(oracleQualifies({ oracleMode: 0, oracleLegCount: 0 }, true), true);
    assert.equal(oracleQualifies({ oracleMode: 1, oracleLegCount: 2 }, false), true);
    assert.equal(oracleQualifies({ oracleMode: 1, oracleLegCount: 0 }, false), false);
    assert.equal(oracleQualifies({ oracleMode: 3, oracleLegCount: 2 }, false), false);
    assert.equal(oracleQualifies({ oracleMode: 0, oracleLegCount: 2 }, false), false);
  });
});

describe("g9 decideG9 (pure)", () => {
  const st = () => freshG9State();
  it("refuses without a ledger, a bound LP, or a qualifying oracle", () => {
    assert.equal(decideG9(ctxLike(), null, 0n, false, st()).kind, "none");
    assert.match((decideG9(ctxLike({ bound: false }), units(), 0n, false, st()) as { reason: string }).reason, /no bound vault LP/);
    assert.match((decideG9(ctxLike({ lpPortfolio: null }), units(), 0n, false, st()) as { reason: string }).reason, /no bound vault LP/);
    assert.match((decideG9(ctxLike({ oracleMode: 0 }), units(), 0n, false, st()) as { reason: string }).reason, /oracle mode 0/);
  });
  it("no proposal, nothing owed: propose, then spaced by the retry window", () => {
    const s = st();
    assert.deepEqual(decideG9(ctxLike(), units(), 10_000n, false, s), { kind: "propose" });
    s.lastAttempt.set("M|propose", 10_000n);
    assert.equal(decideG9(ctxLike(), units(), 10_000n + G9_PROPOSE_RETRY_SLOTS - 1n, false, s).kind, "none");
    assert.equal(decideG9(ctxLike(), units(), 10_000n + G9_PROPOSE_RETRY_SLOTS, false, s).kind, "propose");
  });
  it("open proposal: wait for the 9,000-slot delay with the exact remainder", () => {
    const a = decideG9(ctxLike(), units(1_000n), 5_000n, false, st());
    assert.deepEqual(a, { kind: "wait", reason: "proposal open: waiting out the 9,000-slot delay", remainingSlots: 5_000n });
  });
  it("draw window [p+9000, p+18000): draw, spaced by the draw retry; lapsed falls through to propose", () => {
    const s = st();
    assert.equal(decideG9(ctxLike(), units(1_000n), 10_000n, false, s).kind, "draw");
    assert.equal(decideG9(ctxLike(), units(1_000n), 18_999n, false, s).kind, "draw");
    s.lastAttempt.set("M|draw", 10_000n);
    assert.equal(decideG9(ctxLike(), units(1_000n), 10_000n + G9_DRAW_RETRY_SLOTS - 1n, false, s).kind, "none");
    assert.equal(decideG9(ctxLike(), units(1_000n), 19_000n, false, st()).kind, "propose"); // lapsed
  });
  it("owed backstop restores before it proposes; spaced; u64-max receivable and slot still compare exactly", () => {
    const s = st();
    assert.equal(decideG9(ctxLike(), units(0n, 1n), 0n, false, s).kind, "restore");
    assert.equal(decideG9(ctxLike(), units(0n, U64_MAX), 0n, false, s).kind, "restore");
    s.lastAttempt.set("M|restore", 100n);
    assert.equal(decideG9(ctxLike(), units(0n, 1n), 100n + G9_RESTORE_RETRY_SLOTS - 1n, false, s).kind, "propose");
    // pending slot near 2^64: the open window is computed in BigInt (no wrap, no float rounding)
    const a = decideG9(ctxLike(), units(2n ** 60n + 1n), 0n, false, st()) as { remainingSlots: bigint };
    assert.equal(a.remainingSlots, 2n ** 60n + 1n + 9_000n);
  });
  it("a clock behind the last attempt is not due (no negative-spacing misfire)", () => {
    const s = st();
    s.lastAttempt.set("M|propose", 5_000n);
    assert.equal(decideG9(ctxLike(), units(), 4_000n, false, s).kind, "none");
  });
});

describe("g9 g9ExtraTail", () => {
  const ctx = v22Ctx();
  it("no tail off mainnet, and none for restores", () => {
    assert.deepEqual(g9ExtraTail(ctx, false, BackstopMode.Propose as 2), []);
    assert.deepEqual(g9ExtraTail(ctx, true, BackstopMode.Restore as 1), []);
    assert.deepEqual(g9ExtraTail(ctx, true, BackstopMode.RestoreFromPnl as 3), []);
  });
  it("mainnet propose/draw: allowlist PDA first, then the leg feeds", () => {
    const t = g9ExtraTail(ctx, true, BackstopMode.Draw as 0);
    assert.equal(t.length, 1 + ctx.oracleLegFeeds.length);
  });
});

describe("g9Once", () => {
  const P = { dryRun: false, allowAnyOracleMode: true, mainnetBuild: false, drawCapAtoms: 7n };
  const withUnits = () => {
    return v22Ctx({ currentSlot: 50_000n });
  };

  it("null, empty and garbage ledger bytes decode to 'no ledger': no tx, no state change", async () => {
    for (const data of [null, new Uint8Array(0), new Uint8Array(500)]) {
      const f = fakeExecConn();
      const st = freshG9State();
      const r = await g9Once(execCtx(f.conn), withUnits(), data, st, P);
      assert.equal(r.action.kind, "none");
      assert.equal(r.outcome, null);
      assert.equal(f.sims.length, 0);
      assert.equal(st.lastAttempt.size, 0);
    }
  });

  it("a valid ledger with an open proposal waits and sends nothing", async () => {
    const ctx = withUnits();
    const f = fakeExecConn();
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(BigInt(ctx.readSlot) - 10n, 0n), freshG9State(), P);
    assert.equal(r.action.kind, "wait");
    assert.equal(f.sims.length, 0);
  });

  it("propose: simulates, sends tag 111 and records the attempt slot", async () => {
    const ctx = withUnits();
    const f = fakeExecConn();
    const st = freshG9State();
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(0n, 0n), st, P);
    assert.equal(r.action.kind, "propose");
    assert.equal(r.outcome?.kind, "sent");
    assert.deepEqual(f.sent.map((s) => s.tags), [[111]]);
    assert.equal(st.lastAttempt.get(`${ctx.marketAddress}|propose`), BigInt(ctx.readSlot));
  });

  it("dry-run sends nothing but still records the attempt", async () => {
    const ctx = withUnits();
    const f = fakeExecConn();
    const st = freshG9State();
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(0n, 0n), st, { ...P, dryRun: true });
    assert.equal(r.outcome?.kind, "dry-run");
    assert.equal(f.sent.length, 0);
    assert.equal(st.lastAttempt.size, 1);
  });

  it("an expected refusal (114) on propose is reported as refused/expected, nothing sent", async () => {
    const ctx = withUnits();
    const f = fakeExecConn({ simErr: () => customAt(0, 114) });
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(0n, 0n), freshG9State(), P);
    assert.equal(r.outcome?.kind, "refused");
    assert.equal((r.outcome as { expected: boolean }).expected, true);
    assert.equal(f.sent.length, 0);
  });

  it("draw inside the window", async () => {
    const ctx = withUnits();
    const f = fakeExecConn();
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(BigInt(ctx.readSlot) - 9_500n, 0n), freshG9State(), P);
    assert.equal(r.action.kind, "draw");
    assert.equal(f.sent.length, 1);
  });

  it("restore: mode 3 first; when it is refused, falls back to mode 1 in the same sweep", async () => {
    const ctx = withUnits();
    const f = fakeExecConn({ simErr: (_i, n) => (n === 0 ? customAt(0, 116) : null) });
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(0n, 5n), freshG9State(), P);
    assert.equal(r.action.kind, "restore");
    assert.equal(f.sims.length, 2);
    assert.equal(f.sent.length, 1);
    assert.equal(r.outcome?.kind, "sent");
  });

  it("restore: mode 3 succeeds -> mode 1 not tried", async () => {
    const ctx = withUnits();
    const f = fakeExecConn();
    const r = await g9Once(execCtx(f.conn), ctx, unitsBytes(0n, 5n), freshG9State(), P);
    assert.equal(r.action.kind, "restore");
    assert.equal(f.sims.length, 1);
  });

  it("oracle gate holds in g9Once: Manual mode without allowAny does nothing", async () => {
    const ctx = withUnits();
    const f = fakeExecConn();
    const r = await g9Once(execCtx(f.conn), { ...ctx, oracleMode: 0, oracleLegCount: 0 } as V22MarketCtx, unitsBytes(0n, 0n), freshG9State(), { ...P, allowAnyOracleMode: false });
    assert.equal(r.action.kind, "none");
    assert.equal(f.sims.length, 0);
  });

  it("unused import guard", () => {
    assert.ok(Keypair.generate());
  });
});
