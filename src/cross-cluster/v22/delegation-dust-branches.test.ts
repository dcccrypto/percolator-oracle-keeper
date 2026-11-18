import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { V22Positioned } from "./positioned.ts";
import { DUST_COOLDOWN_SLOTS, dustCandidates, freshDustState, sweepDustOnce } from "./dust.ts";
import {
  bondFeeDelegated,
  getSweepDelegate,
  loneLpCrankSuppressedFor,
  setBondFeeDelegated,
  setLoneLpCrankSuppressor,
  setProtectiveTrigger,
  setSweepDelegate,
  triggerProtectiveRound,
} from "./delegation.ts";
import { customAt, execCtx, fakeExecConn, key, pf, v22Ctx } from "./test-helpers.ts";

function positioned(cps: ReturnType<typeof pf>[], minAbs: Record<number, bigint>): V22Positioned {
  const lp = pf(901, 2, { lp: true });
  return { all: [lp, ...cps], counterparties: cps, lp, minLegAbs: new Map(Object.entries(minAbs).map(([k, v]) => [key(Number(k)).toBase58(), v])), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 };
}
const k = (n: number) => key(n).toBase58();

describe("delegation switchboard: absent / installed / throwing", () => {
  beforeEach(() => {
    setSweepDelegate(null);
    setBondFeeDelegated(false);
    setLoneLpCrankSuppressor(null);
    setProtectiveTrigger(null);
  });
  it("nothing installed: every query answers 'do nothing'", () => {
    assert.equal(getSweepDelegate(), null);
    assert.equal(bondFeeDelegated(), false);
    assert.equal(loneLpCrankSuppressedFor("M"), false);
    assert.doesNotThrow(() => triggerProtectiveRound("M"));
  });
  it("installed suppressor decides per market, and clearing it returns to false", () => {
    setLoneLpCrankSuppressor((m) => m === "A");
    assert.equal(loneLpCrankSuppressedFor("A"), true);
    assert.equal(loneLpCrankSuppressedFor("B"), false);
    setLoneLpCrankSuppressor(null);
    assert.equal(loneLpCrankSuppressedFor("A"), false);
  });
  it("protective trigger receives the market; a throwing trigger never breaks the caller", () => {
    const seen: string[] = [];
    setProtectiveTrigger((m) => seen.push(m));
    triggerProtectiveRound("A");
    assert.deepEqual(seen, ["A"]);
    setProtectiveTrigger(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => triggerProtectiveRound("A"));
  });
  it("sweep delegate and bond-fee flag round-trip", () => {
    const d = async () => true as const;
    setSweepDelegate(d);
    assert.equal(getSweepDelegate(), d);
    setSweepDelegate(null);
    assert.equal(getSweepDelegate(), null);
    setBondFeeDelegated(true);
    assert.equal(bondFeeDelegated(), true);
  });
});

describe("dust candidates: exact boundaries", () => {
  it("cool-down equal to now is eligible; one slot later is skipped; one slot earlier is eligible", () => {
    const ctx = v22Ctx({ band: true });
    const now = BigInt(ctx.readSlot);
    const p = positioned([pf(1), pf(2), pf(3)], { 1: 5n, 2: 5n, 3: 5n });
    const st = freshDustState();
    st.cooldownUntil.set(`${ctx.marketAddress}|${k(1)}`, now); // equal -> eligible
    st.cooldownUntil.set(`${ctx.marketAddress}|${k(2)}`, now + 1n); // one above -> skipped
    st.cooldownUntil.set(`${ctx.marketAddress}|${k(3)}`, now - 1n); // one below -> eligible
    assert.deepEqual([...dustCandidates(ctx, p, st, 9)].sort(), [k(1), k(3)].sort());
  });
  it("a portfolio with no known smallest leg is never a candidate", () => {
    const ctx = v22Ctx({ band: true });
    const p = positioned([pf(1), pf(2)], { 2: 7n });
    assert.deepEqual(dustCandidates(ctx, p, freshDustState(), 9), [k(2)]);
  });
  it("orders by smallest leg ascending (both comparator directions), ties by key, and honours max", () => {
    const ctx = v22Ctx({ band: true });
    const p = positioned([pf(1), pf(2), pf(3), pf(4)], { 1: 10n, 2: 9n, 3: 10n, 4: 11n });
    const tied = [k(1), k(3)].sort();
    assert.deepEqual(dustCandidates(ctx, p, freshDustState(), 9), [k(2), ...tied, k(4)]);
    // reversed input order exercises the a>b and a.k>b.k branches too
    const rev = positioned([pf(4), pf(3), pf(2), pf(1)], { 1: 10n, 2: 9n, 3: 10n, 4: 11n });
    assert.deepEqual(dustCandidates(ctx, rev, freshDustState(), 9), [k(2), ...tied, k(4)]);
    assert.deepEqual(dustCandidates(ctx, p, freshDustState(), 1), [k(2)]);
    assert.deepEqual(dustCandidates(ctx, p, freshDustState(), 0), []);
  });
});

describe("sweepDustOnce decisions", () => {
  it("no bound LP portfolio: nothing is simulated or sent", async () => {
    const ctx = { ...v22Ctx({ band: true }), lpPortfolio: null } as ReturnType<typeof v22Ctx>;
    const f = fakeExecConn();
    const r = await sweepDustOnce(execCtx(f.conn), ctx, positioned([pf(1)], { 1: 5n }), freshDustState());
    assert.deepEqual(r, []);
    assert.equal(f.sent.length, 0);
  });
  it("non-band market: nothing is simulated or sent", async () => {
    const f = fakeExecConn();
    const r = await sweepDustOnce(execCtx(f.conn), v22Ctx(), positioned([pf(1)], { 1: 5n }), freshDustState());
    assert.deepEqual(r, []);
    assert.equal(f.sent.length, 0);
  });
  it("a refusal sets the cool-down to readSlot + DUST_COOLDOWN_SLOTS exactly; a clean sim sets none", async () => {
    const ctx = v22Ctx({ band: true });
    const st = freshDustState();
    const bad = fakeExecConn({ simErr: () => customAt(0, 113) });
    const r = await sweepDustOnce(execCtx(bad.conn), ctx, positioned([pf(1)], { 1: 5n }), st);
    assert.equal(r[0].outcome.kind, "refused");
    assert.equal(st.cooldownUntil.get(`${ctx.marketAddress}|${k(1)}`), BigInt(ctx.readSlot) + DUST_COOLDOWN_SLOTS);
    const good = fakeExecConn();
    const st2 = freshDustState();
    const r2 = await sweepDustOnce(execCtx(good.conn), ctx, positioned([pf(1)], { 1: 5n }), st2);
    assert.equal(r2[0].outcome.kind, "sent");
    assert.equal(st2.cooldownUntil.size, 0);
  });
  it("maxPerTick caps how many portfolios are simulated", async () => {
    const ctx = v22Ctx({ band: true });
    const f = fakeExecConn();
    const r = await sweepDustOnce(execCtx(f.conn), ctx, positioned([pf(1), pf(2), pf(3)], { 1: 3n, 2: 2n, 3: 1n }), freshDustState(), 2);
    assert.deepEqual(r.map((x) => x.portfolio), [k(3), k(2)]);
  });
});

describe("sweepDustOnce defensive skip", () => {
  it("a candidate that vanishes from the counterparty list before lookup is skipped, nothing sent", async () => {
    const ctx = v22Ctx({ band: true });
    const p = positioned([pf(1)], { 1: 5n });
    // map() (candidate ranking) sees the portfolio; the later find() does not: the loop must `continue`.
    const cps = p.counterparties.slice();
    (cps as unknown as { find: () => undefined }).find = () => undefined;
    const f = fakeExecConn();
    const r = await sweepDustOnce(execCtx(f.conn), ctx, { ...p, counterparties: cps }, freshDustState());
    assert.deepEqual(r, []);
    assert.equal(f.sent.length, 0);
  });
});

describe("dust tie-break is the key, whatever the input order", () => {
  it("equal legs sort by base58 key for every permutation of four portfolios", () => {
    const ctx = v22Ctx({ band: true });
    const ns = [1, 2, 3, 4];
    const want = ns.map(k).sort();
    const perms = (a: number[]): number[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
    for (const order of perms(ns)) {
      const p = positioned(order.map((n) => pf(n)), { 1: 5n, 2: 5n, 3: 5n, 4: 5n });
      assert.deepEqual(dustCandidates(ctx, p, freshDustState(), 9), want, order.join());
    }
  });
});

describe("dustCandidates on a non-band market", () => {
  it("returns no candidates even with tiny legs", () => {
    assert.deepEqual(dustCandidates(v22Ctx(), positioned([pf(1)], { 1: 1n }), freshDustState(), 9), []);
  });
});
