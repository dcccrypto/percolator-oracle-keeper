import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { allJobCounters, resetJobCounters } from "./exec.ts";
import { FEE_78_WEIGHT, bondFeeSkipReason, buildBondCrankFeesIx, crankBondFee, planBondFee } from "./fee-bond.ts";
import { portfolioWeight } from "./settle-pairing.ts";
import type { V22Positioned } from "./positioned.ts";
import { fakeExecConn, execCtx, key, pf, v22Ctx } from "./test-helpers.ts";

beforeEach(() => resetJobCounters());
void allJobCounters;

const sd = (conn: Parameters<typeof execCtx>[0]) => ({ exec: execCtx(conn, false), getSlot: async () => 1000 });

function positioned(cps: ReturnType<typeof pf>[], lp = pf(901, 2, { lp: true })): V22Positioned {
  return { all: [lp, ...cps], counterparties: cps, lp, minLegAbs: new Map(), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 };
}

describe("fee-bond: buildBondCrankFeesIx", () => {
  it("throws when the market has no vault LP portfolio (line 35)", () => {
    assert.throws(() => buildBondCrankFeesIx(v22Ctx({ lp: null }), key(1)), /bond tag 78 needs the vault LP portfolio/);
  });
});

describe("fee-bond: bondFeeSkipReason", () => {
  it("returns null for a complete bond ctx and the first failing reason otherwise", () => {
    assert.equal(bondFeeSkipReason(v22Ctx()), null);
    assert.equal(bondFeeSkipReason(v22Ctx({ bond: false })), "not-bond");
    assert.equal(bondFeeSkipReason(v22Ctx({ bound: false })), "not-bound");
    assert.equal(bondFeeSkipReason(v22Ctx({ ext: false })), "no-ext");
    assert.equal(bondFeeSkipReason(v22Ctx({ lp: null })), "no-lp");
  });
});

describe("fee-bond: planBondFee weight budget (positioned && w <= weightBudget)", () => {
  const ctx = v22Ctx();
  const cps = [pf(1), pf(2)];
  const pos = positioned(cps);
  const w = cps.reduce((n, p) => n + portfolioWeight(p), 0) + portfolioWeight(pos.lp!) + FEE_78_WEIGHT;

  it("w == budget is paired: [LP crank, refresh x2, 78]", () => {
    const p = planBondFee(ctx, key(1), pos, "strict", w);
    assert.equal(p.shape, "paired");
    assert.deepEqual(p.ixs.map((i) => i.data[0]), [5, 5, 5, 78]);
    assert.equal(p.tx.settlesLp, true);
    assert.equal(p.tx.refresh.length, 2);
    assert.match(p.note, new RegExp(`weight ${w}/${w}`));
  });
  it("w > budget by one: strict -> fee-only [78]; prefer -> lp-only-unpaired [LP crank, 78]", () => {
    const s = planBondFee(ctx, key(1), pos, "strict", w - 1);
    assert.equal(s.shape, "fee-only");
    assert.deepEqual(s.ixs.map((i) => i.data[0]), [78]);
    assert.equal(s.tx.settlesLp, false);
    assert.match(s.note, /^strict: weight/);
    const pr = planBondFee(ctx, key(1), pos, "prefer", w - 1);
    assert.equal(pr.shape, "lp-only-unpaired");
    assert.deepEqual(pr.ixs.map((i) => i.data[0]), [5, 78]);
    assert.match(pr.note, /COUNTED/);
  });
  it("positioned == null never pairs, even when the default weight fits the budget", () => {
    const s = planBondFee(ctx, key(1), null, "strict", 1000);
    assert.equal(s.shape, "fee-only");
    assert.deepEqual(s.ixs.map((i) => i.data[0]), [78]);
    assert.equal(planBondFee(ctx, key(1), null, "prefer", 1000).shape, "lp-only-unpaired");
  });
  it("afterRound goes alone as 78; pairing off is [LP crank, 78]", () => {
    const a = planBondFee(ctx, key(1), pos, "prefer", 1000, { afterRound: true });
    assert.equal(a.shape, "after-round");
    assert.deepEqual(a.ixs.map((i) => i.data[0]), [78]);
    assert.deepEqual(planBondFee(ctx, key(1), pos, "off", 1000).ixs.map((i) => i.data[0]), [5, 78]);
  });
  it("counterparties are ordered heaviest first", () => {
    const light = pf(1, 1);
    const heavy = pf(3, 2);
    assert.ok(portfolioWeight(heavy) > portfolioWeight(light));
    const p = planBondFee(ctx, key(1), positioned([light, heavy]), "prefer", 1000);
    assert.equal(p.shape, "paired");
    assert.deepEqual(p.tx.refresh.map((r) => r.pubkey.toBase58()), [heavy.pubkey.toBase58(), light.pubkey.toBase58()]);
  });
});

describe("fee-bond: crankBondFee catch (line 152)", () => {
  it("skips without touching the exec context when the ctx is not a bond market", async () => {
    const r = await crankBondFee({} as never, v22Ctx({ bond: false }), null, { mode: "prefer", weightBudget: 32 });
    assert.deepEqual(r, { kind: "skipped", reason: "not-bond" });
  });
  it("an Error thrown while planning/running becomes kind=failed with its message", async () => {
    const deps = { exec: { get keeper(): never { throw new Error("keeper boom"); } }, getSlot: async () => 1 } as never;
    const r = await crankBondFee(deps, v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.deepEqual(r, { kind: "failed", error: "keeper boom" });
  });
  it("a non-Error throw is stringified", async () => {
    const deps = { exec: { get keeper(): never { throw "plain string"; } }, getSlot: async () => 1 } as never;
    const r = await crankBondFee(deps, v22Ctx(), null, { mode: "strict", weightBudget: 32 });
    assert.deepEqual(r, { kind: "failed", error: "plain string" });
  });
  it("a healthy run reports the planned shape", async () => {
    const f = fakeExecConn();
    const r = await crankBondFee(sd(f.conn), v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 1000 });
    assert.equal(r.kind, "sent");
    assert.equal(r.kind === "sent" && r.shape, "paired");
    assert.deepEqual(f.sent[0].tags, [5, 5, 78]);
  });
});
