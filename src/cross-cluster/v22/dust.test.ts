import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DUST_COOLDOWN_SLOTS, dustCandidates, freshDustState, sweepDustOnce } from "./dust.ts";
import type { V22Positioned } from "./positioned.ts";
import { customAt, execCtx, fakeExecConn, key, pf, refusePortfolio, v22Ctx } from "./test-helpers.ts";

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const positioned = (legs: Array<[number, bigint | null]>): V22Positioned => {
  const counterparties = legs.map(([n]) => pf(n));
  const minLegAbs = new Map<string, bigint>();
  for (const [n, abs] of legs) if (abs !== null) minLegAbs.set(key(n).toBase58(), abs);
  return { all: counterparties, counterparties, lp: null, minLegAbs, flatAnchor: null, anchorOverrideRejected: null, lpData: null, undecodable: 0 } as unknown as V22Positioned;
};
const band = () => v22Ctx({ band: true });

describe("dust dustCandidates (pure)", () => {
  it("non-band markets have no candidates", () => {
    assert.deepEqual(dustCandidates(v22Ctx(), positioned([[1, 1n]]), freshDustState(), 3), []);
  });
  it("smallest leg first, ties by key, capped by max; portfolios without a leg size are skipped", () => {
    const c = dustCandidates(band(), positioned([[1, 30n], [2, 10n], [3, 20n], [4, null], [5, 10n]]), freshDustState(), 3);
    assert.equal(c.length, 3);
    assert.equal(c.includes(key(4).toBase58()), false);
    assert.equal(c.includes(key(1).toBase58()), false);
    // equal 10n legs: the lexicographically smaller base58 key sorts first
    const tie = [key(2).toBase58(), key(5).toBase58()].sort();
    assert.deepEqual(c.slice(0, 2), tie);
  });
  it("a zero-size active leg is the smallest (not dropped as falsy)", () => {
    const c = dustCandidates(band(), positioned([[1, 5n], [2, 0n]]), freshDustState(), 1);
    assert.deepEqual(c, [key(2).toBase58()]);
  });
  it("u64-scale leg sizes above 2^53 compare exactly", () => {
    const c = dustCandidates(band(), positioned([[1, U64_MAX], [2, U64_MAX - 1n], [3, 2n ** 53n + 1n], [4, 2n ** 53n]]), freshDustState(), 4);
    assert.deepEqual(c, [4, 3, 2, 1].map((n) => key(n).toBase58()));
  });
  it("a portfolio in cool-down is skipped until the slot is reached", () => {
    const ctx = band();
    const st = freshDustState();
    st.cooldownUntil.set(`${ctx.marketAddress}|${key(1).toBase58()}`, BigInt(ctx.readSlot) + 1n);
    assert.deepEqual(dustCandidates(ctx, positioned([[1, 1n], [2, 2n]]), st, 3), [key(2).toBase58()]);
    st.cooldownUntil.set(`${ctx.marketAddress}|${key(1).toBase58()}`, BigInt(ctx.readSlot));
    assert.equal(dustCandidates(ctx, positioned([[1, 1n], [2, 2n]]), st, 3)[0], key(1).toBase58());
  });
  it("max 0 -> nothing", () => {
    assert.deepEqual(dustCandidates(band(), positioned([[1, 1n]]), freshDustState(), 0), []);
  });
});

describe("dust sweepDustOnce", () => {
  it("does nothing off band or with no LP", async () => {
    const f = fakeExecConn();
    assert.deepEqual(await sweepDustOnce(execCtx(f.conn), v22Ctx(), positioned([[1, 1n]]), freshDustState()), []);
    assert.deepEqual(await sweepDustOnce(execCtx(f.conn), v22Ctx({ band: true, lp: null }), positioned([[1, 1n]]), freshDustState()), []);
    assert.equal(f.sims.length, 0);
  });
  it("a clean simulation is sent as tag 118 and the portfolio is NOT cooled down", async () => {
    const ctx = band();
    const f = fakeExecConn();
    const st = freshDustState();
    const r = await sweepDustOnce(execCtx(f.conn), ctx, positioned([[1, 1n]]), st);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome.kind, "sent");
    assert.deepEqual(f.sent.map((s) => s.tags), [[118]]);
    assert.equal(st.cooldownUntil.size, 0);
  });
  it("a refused simulation sends nothing and cools that portfolio down for 9,000 slots", async () => {
    const ctx = band();
    const f = fakeExecConn({ simErr: refusePortfolio(key(1), 22) });
    const st = freshDustState();
    const r = await sweepDustOnce(execCtx(f.conn), ctx, positioned([[1, 1n], [2, 2n]]), st);
    assert.deepEqual(r.map((x) => x.outcome.kind), ["refused", "sent"]);
    assert.equal(f.sent.length, 1);
    assert.equal(st.cooldownUntil.get(`${ctx.marketAddress}|${key(1).toBase58()}`), BigInt(ctx.readSlot) + DUST_COOLDOWN_SLOTS);
    assert.equal(st.cooldownUntil.has(`${ctx.marketAddress}|${key(2).toBase58()}`), false);
    // next tick: the cooled portfolio is not simulated again
    const before = f.sims.length;
    await sweepDustOnce(execCtx(f.conn), ctx, positioned([[1, 1n]]), st);
    assert.equal(f.sims.length, before);
  });
  it("honours maxPerTick", async () => {
    const f = fakeExecConn();
    const r = await sweepDustOnce(execCtx(f.conn), band(), positioned([[1, 1n], [2, 2n], [3, 3n]]), freshDustState(), 2);
    assert.equal(r.length, 2);
  });
  it("a customAt refusal with an unknown code still cools (any refusal)", async () => {
    const ctx = band();
    const f = fakeExecConn({ simErr: () => customAt(0, 9999) });
    const st = freshDustState();
    await sweepDustOnce(execCtx(f.conn), ctx, positioned([[1, 1n]]), st);
    assert.equal(st.cooldownUntil.size, 1);
  });
});
