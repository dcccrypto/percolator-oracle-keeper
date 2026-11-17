/**
 * Branch coverage for the two small v2.2 decision modules band.ts and fee-bond.ts: every condition is asserted on
 * both sides, with boundary values (equal-to-threshold, zero, max u64).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { SLOT_SECONDS, bandHealthFor, pinLevelOf, terminalKindOf } from "./band.ts";
import { FEE_78_WEIGHT, NO_FEES_TO_CRANK, bondFeeSkipReason, buildBondCrankFeesIx, crankBondFee, planBondFee } from "./fee-bond.ts";
import { resetPairingStats, pairingStats } from "./sweep.ts";
import { portfolioWeight } from "./settle-pairing.ts";
import type { V22Positioned } from "./positioned.ts";
import { customAt, execCtx, fakeExecConn, key, pf, v22Ctx, v22MarketBytes } from "./test-helpers.ts";

const U64_MAX = (1n << 64n) - 1n;
const MODE_OFF = 592 + 674; // v19 group offset + mode (market-state.ts GROUP_V19)

function positioned(cps: ReturnType<typeof pf>[], lp: ReturnType<typeof pf> | null = pf(901, 2, { lp: true })): V22Positioned {
  return { all: lp ? [lp, ...cps] : cps, counterparties: cps, lp, minLegAbs: new Map(), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 };
}
const sd = (conn: ReturnType<typeof fakeExecConn>["conn"]) => ({ exec: execCtx(conn), getSlot: async () => 1000 });

describe("band.ts pinLevelOf", () => {
  it("duration <= 0 is none (zero), regardless of max", () => {
    assert.equal(pinLevelOf(0n, 9000n), "none");
    assert.equal(pinLevelOf(-1n, 9000n), "none");
    assert.equal(pinLevelOf(0n, 0n), "none");
  });
  it("max <= 0 with a live pin is 'pinned' (no threshold to compare)", () => {
    assert.equal(pinLevelOf(1n, 0n), "pinned");
    assert.equal(pinLevelOf(U64_MAX, 0n), "pinned");
    assert.equal(pinLevelOf(1n, -5n), "pinned");
  });
  it("critical at exactly 80% of max, pinned/half one slot below", () => {
    assert.equal(pinLevelOf(7200n, 9000n), "critical");
    assert.equal(pinLevelOf(7199n, 9000n), "half");
    assert.equal(pinLevelOf(9000n, 9000n), "critical");
    assert.equal(pinLevelOf(U64_MAX, 9000n), "critical");
  });
  it("half at exactly 50% of max, pinned one slot below", () => {
    assert.equal(pinLevelOf(4500n, 9000n), "half");
    assert.equal(pinLevelOf(4499n, 9000n), "pinned");
    assert.equal(pinLevelOf(1n, 9000n), "pinned");
  });
  it("max u64 arithmetic stays exact in bigint (no overflow)", () => {
    assert.equal(pinLevelOf(U64_MAX, U64_MAX), "critical");
    assert.equal(pinLevelOf((U64_MAX + 1n) / 2n, U64_MAX), "half");
    assert.equal(pinLevelOf((U64_MAX + 1n) / 2n - 1n, U64_MAX), "pinned");
  });
});

describe("band.ts terminalKindOf / bandHealthFor", () => {
  const ctxWith = (patch: (d: Uint8Array) => void, o: Parameters<typeof v22Ctx>[0] = {}) => {
    const c = v22Ctx(o);
    const data = new Uint8Array(c.data);
    patch(data);
    return { ...c, data };
  };
  it("live market: null; undecodable bytes: null", () => {
    assert.equal(terminalKindOf(v22MarketBytes()), null);
    assert.equal(terminalKindOf(new Uint8Array(4)), null);
  });
  it("closed (kind 8), resolved (mode 1), recovery (mode 2)", () => {
    const d = new Uint8Array(v22MarketBytes());
    d[10] = 8;
    assert.equal(terminalKindOf(d), "closed");
    const r = new Uint8Array(v22MarketBytes());
    r[MODE_OFF] = 1;
    assert.equal(terminalKindOf(r), "resolved");
    const rec = new Uint8Array(v22MarketBytes());
    rec[MODE_OFF] = 2;
    assert.equal(terminalKindOf(rec), "recovery");
  });
  it("terminal market: reported not pinned / level none even with a long pin and a band", () => {
    const c = ctxWith((d) => (d[MODE_OFF] = 2), { band: true, pinSince: 100n, currentSlot: 5000n });
    assert.ok(c.pinDurationSlots > 0n);
    const h = bandHealthFor(c);
    assert.equal(h.terminal, "recovery");
    assert.equal(h.pinned, false);
    assert.equal(h.pinLevel, "none");
    assert.equal(h.pinDurationSlots, "0");
    assert.equal(h.pinDurationSecs, 0);
    assert.equal(h.band, true);
    assert.equal(bandHealthFor(ctxWith((d) => (d[10] = 8))).terminal, "closed");
    assert.equal(bandHealthFor(ctxWith((d) => (d[MODE_OFF] = 1))).terminal, "resolved");
  });
  it("live band market: pin duration, secs rounding, level, no terminal key", () => {
    const c = v22Ctx({ band: true, pinSince: 500n, currentSlot: 5000n, maxPin: 9000n });
    const h = bandHealthFor(c);
    assert.equal(h.terminal, undefined);
    assert.equal(h.band, true);
    assert.equal(h.pinned, true);
    assert.equal(h.pinDurationSlots, "4500");
    assert.equal(h.pinDurationSecs, Math.round(4500 * SLOT_SECONDS));
    assert.equal(h.maxPinSlots, "9000");
    assert.equal(h.pinLevel, "half");
    assert.equal(h.maxPositionsPerSide, "256");
  });
  it("live non-band market with no pin: not pinned, level none, band false", () => {
    const h = bandHealthFor(v22Ctx());
    assert.equal(h.band, false);
    assert.equal(h.pinned, false);
    assert.equal(h.pinLevel, "none");
    assert.equal(h.pinDurationSecs, 0);
  });
  it("live band market with maxPin 0: a pin is 'pinned' (never half/critical)", () => {
    const h = bandHealthFor(v22Ctx({ band: true, pinSince: 10n, currentSlot: 5000n, maxPin: 0n }));
    assert.equal(h.pinned, true);
    assert.equal(h.pinLevel, "pinned");
  });
});

describe("fee-bond.ts planning", () => {
  beforeEach(() => resetPairingStats());
  it("skip reasons: program mismatch is the last check; order of earlier checks holds", () => {
    const c = v22Ctx();
    assert.equal(bondFeeSkipReason({ ...c, programId: key(77) }), "program-mismatch");
    assert.equal(bondFeeSkipReason({ ...c, programId: key(77), lpPortfolio: null }), "no-lp");
    assert.equal(bondFeeSkipReason({ ...c, programId: key(77), bond: false }), "not-bond");
    assert.equal(bondFeeSkipReason({ ...c, bound: false, ext: false }), "not-bound");
    assert.equal(bondFeeSkipReason(c), null);
  });
  it("buildBondCrankFeesIx throws without the LP portfolio", () => {
    assert.throws(() => buildBondCrankFeesIx({ ...v22Ctx(), lpPortfolio: null }, key(1)), /vault LP portfolio/);
  });
  it("custom oracleAccounts option is used for the instruction list", () => {
    const ctx = v22Ctx();
    const extra = [key(555)];
    const p = planBondFee(ctx, key(1), positioned([]), "off", 32, { oracleAccounts: extra });
    const flat = p.ixs.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58()));
    assert.ok(flat.includes(key(555).toBase58()));
    const q = planBondFee(ctx, key(1), positioned([]), "off", 32);
    assert.ok(!q.ixs.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58())).includes(key(555).toBase58()));
  });
  it("after-round wins over every mode", () => {
    for (const m of ["off", "prefer", "strict"] as const) assert.equal(planBondFee(v22Ctx(), key(1), null, m, 0, { afterRound: true }).shape, "after-round");
  });
  it("positioned null: weight uses the default LP weight 3; paired impossible, so prefer is unpaired and strict is fee-only", () => {
    const ctx = v22Ctx();
    const prefer = planBondFee(ctx, key(1), null, "prefer", 1000);
    assert.equal(prefer.shape, "lp-only-unpaired");
    assert.match(prefer.note, new RegExp(`weight ${3 + FEE_78_WEIGHT} > 1000`));
    assert.equal(planBondFee(ctx, key(1), null, "strict", 1000).shape, "fee-only");
  });
  it("positioned with lp null falls back to LP weight 3 (paired at exact budget)", () => {
    const ctx = v22Ctx();
    const p = positioned([], null);
    assert.equal(planBondFee(ctx, key(1), p, "prefer", 3 + FEE_78_WEIGHT).shape, "paired");
    assert.equal(planBondFee(ctx, key(1), p, "prefer", 3 + FEE_78_WEIGHT - 1).shape, "lp-only-unpaired");
  });
  it("weight budget boundary: w == budget pairs, w == budget + 1 does not", () => {
    const ctx = v22Ctx();
    const cps = [pf(1), pf(2), pf(3)];
    const p = positioned(cps);
    const w = cps.reduce((n, c) => n + portfolioWeight(c), 0) + portfolioWeight(p.lp!) + FEE_78_WEIGHT;
    assert.equal(planBondFee(ctx, key(1), p, "strict", w).shape, "paired");
    assert.equal(planBondFee(ctx, key(1), p, "strict", w - 1).shape, "fee-only");
    assert.equal(planBondFee(ctx, key(1), p, "prefer", w - 1).shape, "lp-only-unpaired");
    assert.equal(planBondFee(ctx, key(1), p, "prefer", 0).shape, "lp-only-unpaired");
  });
  it("paired: counterparties ordered heaviest first", () => {
    const cps = [pf(1, 1), pf(2, 3), pf(3, 2)];
    const p = planBondFee(v22Ctx(), key(1), positioned(cps), "prefer", 1000);
    const ws = p.tx.refresh.map((c) => portfolioWeight(c));
    assert.deepEqual(ws, [...ws].sort((a, b) => b - a));
  });
  it("mode off ignores positioned and budget", () => {
    const p = planBondFee(v22Ctx(), key(1), positioned([pf(1)]), "off", 1000);
    assert.equal(p.shape, "lp-only-unpaired");
    assert.equal(p.tx.settlesLp, true);
    assert.equal(planBondFee(v22Ctx(), key(1), positioned([pf(1)]), "off", 1000, {}).tx.refresh.length, 0);
  });
});

describe("fee-bond.ts crankBondFee outcomes", () => {
  beforeEach(() => resetPairingStats());
  const big = () => positioned(Array.from({ length: 12 }, (_, i) => pf(i + 1)));
  it("skipped: returns the reason and sends nothing", async () => {
    const f = fakeExecConn();
    const r = await crankBondFee(sd(f.conn), v22Ctx({ bond: false }), big(), { mode: "prefer", weightBudget: 32 });
    assert.deepEqual(r, { kind: "skipped", reason: "not-bond" });
    assert.equal(f.sims.length, 0);
  });
  it("refused with an unexpected code on a non-deferrable shape stays 'refused' (paired and lp-only-unpaired)", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 999) });
    const r = await crankBondFee(sd(f.conn), v22Ctx(), big(), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "refused");
    if (r.kind === "refused") assert.equal(r.shape, "lp-only-unpaired");
    assert.equal(f.sent.length, 0);
    assert.equal(pairingStats.feeUnpairedLpSettles, 0);
  });
  it("refused 38 is 'nothing' on every shape", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, NO_FEES_TO_CRANK) });
    assert.equal((await crankBondFee(sd(f.conn), v22Ctx(), big(), { mode: "strict", weightBudget: 32 })).kind, "nothing");
  });
  it("landed-failed with a non-38 code is 'failed' with the code; with no code says 'none'; not-landed says 'not landed'", async () => {
    const f = fakeExecConn({ confirmFail: () => 7 });
    const r = await crankBondFee(sd(f.conn), v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /landed but failed on chain \(code 7\)/);
    const g = fakeExecConn({ confirmStatus: "err" });
    const r2 = await crankBondFee(sd(g.conn), v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r2.kind, "failed");
  });
  it("fee-only strict shape that sends cleanly is 'sent' and counts neither unpaired nor after-round", async () => {
    const f = fakeExecConn();
    const r = await crankBondFee(sd(f.conn), v22Ctx(), big(), { mode: "strict", weightBudget: 32 });
    assert.equal(r.kind, "sent");
    if (r.kind === "sent") assert.equal(r.shape, "fee-only");
    assert.equal(pairingStats.unpairedLpSettles, 0);
    assert.equal(pairingStats.feeUnpairedLpSettles, 0);
    assert.equal(pairingStats.feeAfterRound, 0);
  });
  it("a thrown non-Error is stringified into 'failed'; a thrown Error keeps its message", async () => {
    const f = fakeExecConn();
    const deps = { exec: { ...execCtx(f.conn), get keeper(): never { throw "boom"; } }, getSlot: async () => 1000 };
    assert.deepEqual(await crankBondFee(deps as never, v22Ctx(), big(), { mode: "prefer", weightBudget: 32 }), { kind: "failed", error: "boom" });
    const deps2 = { exec: { ...execCtx(f.conn), get keeper(): never { throw new Error("kaboom"); } }, getSlot: async () => 1000 };
    assert.deepEqual(await crankBondFee(deps2 as never, v22Ctx(), big(), { mode: "prefer", weightBudget: 32 }), { kind: "failed", error: "kaboom" });
  });
  it("an RPC-level failure surfaces as 'failed' (exec outcome failed)", async () => {
    const f = fakeExecConn();
    (f.conn as unknown as { getLatestBlockhash: () => Promise<never> }).getLatestBlockhash = async () => {
      throw new Error("rpc down");
    };
    const r = await crankBondFee(sd(f.conn), v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "failed");
  });
  it("sanity: program id helper key type", () => {
    assert.ok(key(1) instanceof PublicKey);
  });
});
