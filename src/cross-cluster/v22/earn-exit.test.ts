/**
 * earn-exit.ts (KEEPER_V22_EARN_EXIT) branch coverage: gate reasons, selection / ordering / undecodable, the node-side
 * account fetch, cooldown rotation after a refusal or failure, per-tick cap, bound vs non-bound builds. Offline: fake conn only.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_KIND, deriveLpVaultRegistry, redemptionDataSizesV22 } from "@percolatorct/sdk";
import { allJobCounters, resetJobCounters } from "./exec.ts";
import { EARN_EXIT_COOLDOWN_SLOTS, bookIsLossCurrent, executeKeeperExits, fetchRedemptionRequests, freshEarnExitState, selectKeeperRequests } from "./earn-exit.ts";
import { customAt, execCtx, fakeExecConn, key, v22Ctx } from "./test-helpers.ts";

beforeEach(() => resetJobCounters());

function request(registry: PublicKey, o: { keeperOk?: boolean; floor?: bigint; slot?: bigint; extended?: boolean; redeemer?: number } = {}): Uint8Array {
  const b = Buffer.alloc(o.extended === false ? 112 : 128);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(19, 8);
  b[10] = 6;
  Buffer.from(registry.toBytes()).copy(b, 16);
  Buffer.from(key(o.redeemer ?? 321).toBytes()).copy(b, 48);
  b.writeBigUInt64LE(77n, 80);
  b.writeBigUInt64LE(o.slot ?? 1000n, 96);
  b[104] = 1;
  if (o.extended !== false) {
    b.writeBigUInt64LE(o.floor ?? 5n, 112);
    b[120] = o.keeperOk === false ? 0 : 1;
  }
  return new Uint8Array(b);
}
const regOf = (ctx: ReturnType<typeof v22Ctx>) => deriveLpVaultRegistry(ctx.programId, ctx.market)[0];

describe("earn-exit: bookIsLossCurrent reasons", () => {
  it("ok book -> {ok:true, reason:null}", () => {
    assert.deepEqual(bookIsLossCurrent(v22Ctx()), { ok: true, reason: null });
  });
  it("multi-asset names the slot count", () => {
    const g = bookIsLossCurrent(v22Ctx({ slots: 3 }));
    assert.equal(g.ok, false);
    assert.match(g.reason ?? "", /multi-asset market \(3 slots\)/);
  });
  it("loss_stale_active refuses first", () => {
    const ctx = v22Ctx();
    const g = bookIsLossCurrent({ slots: 1, refresh: { ...ctx.refresh, lossStaleActive: true } });
    assert.deepEqual(g, { ok: false, reason: "loss_stale_active" });
  });
  it("a stale SHORT cohort alone refuses (the staleLong || staleShort second arm)", () => {
    const ctx = v22Ctx();
    const g = bookIsLossCurrent({ slots: 1, refresh: { ...ctx.refresh, staleLong: 0n, staleShort: 4n } });
    assert.equal(g.ok, false);
    assert.match(g.reason ?? "", /stale cohort 0L\/4S/);
  });
  it("an asset behind the market clock refuses with the accrual reason", () => {
    const ctx = v22Ctx();
    const g = bookIsLossCurrent({ slots: 1, refresh: { ...ctx.refresh, contributesToLossStale: true, slotLast: 100n, currentSlot: 5000n } });
    assert.deepEqual(g, { ok: false, reason: "asset not accrued to the market clock" });
  });
});

describe("earn-exit: selectKeeperRequests", () => {
  it("empty input -> empty", () => {
    assert.deepEqual(selectKeeperRequests([], regOf(v22Ctx())), []);
  });
  it("undecodable bytes are skipped, not thrown", () => {
    const reg = regOf(v22Ctx());
    const sel = selectKeeperRequests([{ pubkey: key(1), data: new Uint8Array(3) }, { pubkey: key(2), data: request(reg) }], reg);
    assert.deepEqual(sel.map((s) => s.pubkey.toBase58()), [key(2).toBase58()]);
  });
  it("the skip predicate drops a request before decode", () => {
    const reg = regOf(v22Ctx());
    const sel = selectKeeperRequests([{ pubkey: key(1), data: request(reg) }, { pubkey: key(2), data: request(reg) }], reg, (pk) => pk.equals(key(1)));
    assert.deepEqual(sel.map((s) => s.pubkey.toBase58()), [key(2).toBase58()]);
  });
  it("sorted oldest request first (both comparator directions and a tie)", () => {
    const reg = regOf(v22Ctx());
    const sel = selectKeeperRequests(
      [
        { pubkey: key(1), data: request(reg, { slot: 300n }) },
        { pubkey: key(2), data: request(reg, { slot: 100n }) },
        { pubkey: key(3), data: request(reg, { slot: 200n }) },
        { pubkey: key(4), data: request(reg, { slot: 200n }) },
      ],
      reg,
    );
    assert.deepEqual(sel.map((s) => s.req.requestSlot), [100n, 200n, 200n, 300n]);
    assert.equal(sel[0].pubkey.toBase58(), key(2).toBase58());
  });
});

describe("earn-exit: fetchRedemptionRequests", () => {
  it("filters on the node by extended size, LpRedemption kind and this market's registry; maps accounts", async () => {
    const ctx = v22Ctx();
    const calls: Array<{ programId: PublicKey; cfg: { filters: Array<Record<string, unknown>> } }> = [];
    const data = Buffer.from([1, 2, 3]);
    const conn = {
      async getProgramAccounts(programId: PublicKey, cfg: { filters: Array<Record<string, unknown>> }) {
        calls.push({ programId, cfg });
        return [{ pubkey: key(5), account: { data } }];
      },
    };
    const out = await fetchRedemptionRequests(conn as never, ctx);
    assert.equal(out.length, 1);
    assert.ok(out[0].pubkey.equals(key(5)));
    assert.deepEqual([...out[0].data], [1, 2, 3]);
    assert.ok(calls[0].programId.equals(ctx.programId));
    const f = calls[0].cfg.filters;
    assert.equal(f.length, 3);
    assert.deepEqual(f[0], { dataSize: redemptionDataSizesV22()[1] });
    assert.equal((f[1].memcmp as { bytes: string }).bytes, Buffer.from([ACCOUNT_KIND.LpRedemption]).toString("base64"));
    assert.equal((f[2].memcmp as { bytes: string }).bytes, regOf(ctx).toBase58());
  });
  it("no accounts -> empty list; an RPC error propagates to the caller", async () => {
    const ctx = v22Ctx();
    assert.deepEqual(await fetchRedemptionRequests({ getProgramAccounts: async () => [] } as never, ctx), []);
    await assert.rejects(fetchRedemptionRequests({ getProgramAccounts: async () => { throw new Error("rpc 429"); } } as never, ctx), /rpc 429/);
  });
});

describe("earn-exit: executeKeeperExits", () => {
  it("empty request list on an open gate: no RPC, no outcomes", async () => {
    const f = fakeExecConn();
    const r = await executeKeeperExits(execCtx(f.conn), v22Ctx(), []);
    assert.equal(r.gate.ok, true);
    assert.deepEqual(r.outcomes, []);
    assert.equal(f.sims.length + f.sent.length, 0);
  });
  it("a gated book returns the reason and never touches the connection", async () => {
    const f = fakeExecConn();
    const ctx = v22Ctx({ slots: 2 });
    const r = await executeKeeperExits(execCtx(f.conn), ctx, [{ pubkey: key(1), data: request(regOf(ctx)) }]);
    assert.equal(r.gate.ok, false);
    assert.deepEqual(r.outcomes, []);
    assert.equal(f.sims.length, 0);
  });
  it("maxPerTick caps and takes the oldest first", async () => {
    const ctx = v22Ctx();
    const reg = regOf(ctx);
    const f = fakeExecConn();
    const reqs = [3, 1, 2].map((n) => ({ pubkey: key(n), data: request(reg, { slot: BigInt(n * 10) }) }));
    const r = await executeKeeperExits(execCtx(f.conn), ctx, reqs, 2);
    assert.deepEqual(r.outcomes.map((o) => o.redemption), [key(1).toBase58(), key(2).toBase58()]);
    assert.equal(f.sent.length, 2);
  });
  it("a refused request enters cooldown and is rotated past on the next tick; it returns after the cooldown", async () => {
    const ctx = v22Ctx();
    const reg = regOf(ctx);
    const reqs = [
      { pubkey: key(1), data: request(reg, { slot: 10n }) },
      { pubkey: key(2), data: request(reg, { slot: 20n }) },
    ];
    const f = fakeExecConn({ simErr: (d, i) => (i === 0 ? customAt(0, 117) : null) });
    const st = freshEarnExitState();
    const t1 = await executeKeeperExits(execCtx(f.conn), ctx, reqs, 1, st);
    assert.equal(t1.outcomes[0].outcome.kind, "refused");
    assert.equal(st.cooldownUntil.get(key(1).toBase58()), BigInt(ctx.readSlot) + EARN_EXIT_COOLDOWN_SLOTS);
    assert.equal(allJobCounters()["earn-exit-77"].expected, 1);
    const t2 = await executeKeeperExits(execCtx(f.conn), ctx, reqs, 1, st);
    assert.deepEqual(t2.outcomes.map((o) => o.redemption), [key(2).toBase58()]);
    assert.equal(t2.outcomes[0].outcome.kind, "sent");
    // key(2) was sent, so it is NOT in cooldown
    assert.equal(st.cooldownUntil.has(key(2).toBase58()), false);
    // once the read slot passes the cooldown, request 1 is eligible again
    const later = v22Ctx({ currentSlot: 5000n + EARN_EXIT_COOLDOWN_SLOTS });
    const t3 = await executeKeeperExits(execCtx(fakeExecConn().conn), later, reqs, 1, st);
    assert.deepEqual(t3.outcomes.map((o) => o.redemption), [key(1).toBase58()]);
  });
  it("a simulate RPC error is a `failed` outcome (never thrown) and also cools the request down", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn();
    (f.conn as unknown as { simulateTransaction: () => Promise<never> }).simulateTransaction = async () => {
      throw new Error("fetch failed");
    };
    const st = freshEarnExitState();
    const r = await executeKeeperExits(execCtx(f.conn), ctx, [{ pubkey: key(1), data: request(regOf(ctx)) }], 2, st);
    assert.equal(r.outcomes[0].outcome.kind, "failed");
    assert.equal(f.sent.length, 0);
    assert.equal(st.cooldownUntil.has(key(1).toBase58()), true);
    assert.equal(allJobCounters()["earn-exit-77"].failed, 1);
  });
  it("an unexpected refusal code (not 117/118) is counted as a refusal, not expected, and cools down", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn({ simErr: () => customAt(0, 120) });
    const st = freshEarnExitState();
    await executeKeeperExits(execCtx(f.conn), ctx, [{ pubkey: key(1), data: request(regOf(ctx)) }], 2, st);
    const c = allJobCounters()["earn-exit-77"];
    assert.equal(c.refused, 1);
    assert.equal(c.expected, 0);
    assert.equal(st.cooldownUntil.has(key(1).toBase58()), true);
  });
  it("dry-run: simulated, nothing sent, and NO cooldown set (the request stays eligible)", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn();
    const st = freshEarnExitState();
    const r = await executeKeeperExits(execCtx(f.conn, true), ctx, [{ pubkey: key(1), data: request(regOf(ctx)) }], 2, st);
    assert.equal(r.outcomes[0].outcome.kind, "dry-run");
    assert.equal(f.sims.length, 1);
    assert.equal(f.sent.length, 0);
    assert.equal(st.cooldownUntil.size, 0);
  });
  it("bound market with a known LP appends the bound LP portfolio to the account list; unbound / no-LP does not", async () => {
    const reg = regOf(v22Ctx());
    const lpKey = key(901).toBase58();
    const bound = fakeExecConn();
    await executeKeeperExits(execCtx(bound.conn), v22Ctx({ bound: true }), [{ pubkey: key(1), data: request(reg) }]);
    assert.ok(bound.sent[0].keys[0].includes(lpKey));
    const unbound = fakeExecConn();
    await executeKeeperExits(execCtx(unbound.conn), v22Ctx({ bound: false }), [{ pubkey: key(1), data: request(reg) }]);
    assert.equal(unbound.sent[0].keys[0].includes(lpKey), false);
    const noLp = fakeExecConn();
    await executeKeeperExits(execCtx(noLp.conn), v22Ctx({ bound: true, lp: null }), [{ pubkey: key(1), data: request(reg) }]);
    assert.equal(noLp.sent[0].keys[0].includes(lpKey), false);
  });
});
