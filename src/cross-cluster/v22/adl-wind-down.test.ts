/**
 * v22/adl-wind-down.ts: tag 104 on close-only v2.2 assets (instr104 2026-11-05).
 * Pure log parsing / holder / target selection, then the turn against the shared fake connection: healthy market sends
 * nothing; an unarmed episode is armed once; an armed episode waits (no simulation until the bound); an eligible episode
 * closes the reduce-only side (vault LP last, stops when ADL clears); refusals send nothing; dry-run sends nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { ExecOutcome } from "./exec.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { V22Loop } from "./loop.ts";
import { ADL_ONE } from "../adl-state.ts";
import { engineSlotBase } from "../market-layout.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { WIND_DOWN_V22_RETRY_SLOTS, freshWindDownV22State, parseWindDownLog, windDownHolders, windDownTargets, windDownV22Once } from "./adl-wind-down.ts";
import { customAt, execCtx, fakeExecConn, fakeLoopConn, key, portfolioBytes, registryBytes, v22Ctx, vaultLpStateBytes, LAYOUT_V22 } from "./test-helpers.ts";

const hex = (n: bigint) => `0x${n.toString(16)}`;
const notEligible = (since: bigint, bound: bigint, now: bigint) => [`Program log: 0x68, 0x0, ${hex(since)}, ${hex(bound)}, ${hex(now)}`];
const closed = (q: bigint, cleared: boolean, now: bigint) => [`Program log: 0x68, 0x1, ${hex(q)}, ${cleared ? "0x1" : "0x0"}, ${hex(now)}`];

const A_LATCHED = 934_933_587_102_193n; // devnet SOL a_short, 2026-11-05

function latchedCtx(o: { aLong?: bigint; aShort?: bigint; slot?: bigint; lifecycle?: number } = {}) {
  const ctx = v22Ctx({ currentSlot: o.slot ?? 519_085_747n, lifecycle: o.lifecycle });
  const b = Buffer.from(ctx.data.buffer, ctx.data.byteOffset, ctx.data.byteLength);
  const e = engineSlotBase(ctx.layout, 0);
  const w128 = (off: number, v: bigint) => {
    b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, e + off);
    b.writeBigUInt64LE(v >> 64n, e + off + 8);
  };
  w128(49, o.aLong ?? ADL_ONE);
  w128(65, o.aShort ?? A_LATCHED);
  w128(289, 7_124_739n);
  w128(305, 7_124_739n);
  return ctx;
}

// The devnet SOL book on 2026-11-05: 2 longs, 2 user shorts + the vault LP short.
const LP = key(901);
const book = () => [
  { pubkey: key(11), data: portfolioBytes({ owner: key(1), legs: [{ side: 0, basis: 100n }] }) },
  { pubkey: key(12), data: portfolioBytes({ owner: key(2), legs: [{ side: 0, basis: 100n }] }) },
  { pubkey: LP, data: portfolioBytes({ owner: key(3), legs: [{ side: 1, basis: 120n }], matcher: true }) },
  { pubkey: key(14), data: portfolioBytes({ owner: key(4), legs: [{ side: 1, basis: 40n }] }) },
  { pubkey: key(15), data: portfolioBytes({ owner: key(5), legs: [{ side: 1, basis: 40n }] }) },
  { pubkey: key(16), data: portfolioBytes({ owner: key(6) }) }, // flat
  { pubkey: key(17), data: new Uint8Array(9_563) }, // a v2.1-length account: ignored
];

describe("parseWindDownLog", () => {
  it("reads the not-eligible and closed lines; anything else is none", () => {
    assert.deepEqual(parseWindDownLog(notEligible(519_085_747n, 9_000n, 519_085_747n)), { kind: "not-eligible", since: 519_085_747n, bound: 9_000n, now: 519_085_747n });
    assert.deepEqual(parseWindDownLog(["noise", ...closed(40n, true, 7n)]), { kind: "closed", closedQ: 40n, cleared: true, now: 7n });
    // the exact line the deployed devnet wrapper printed in the read-only simulation on SOL
    assert.equal(parseWindDownLog(["Program log: 0x68, 0x0, 0x1ef09eb3, 0x2328, 0x1ef09eb3"]).kind, "not-eligible");
    assert.equal(parseWindDownLog(["Program log: 0x67, 0x0, 0x1, 0x2, 0x3"]).kind, "none");
    assert.equal(parseWindDownLog(null).kind, "none");
  });
});

describe("holders and targets", () => {
  it("keeps v2.2-length portfolios with a leg on the asset; marks the vault LP", () => {
    const h = windDownHolders(book(), 0, LAYOUT_V22.portfolio.accountLen, LP);
    assert.equal(h.length, 5);
    assert.equal(h.filter((x) => x.isLp).length, 1);
    assert.equal(windDownHolders(book(), 1, LAYOUT_V22.portfolio.accountLen, LP).length, 0);
  });
  it("targets the side whose A < 1, vault LP last", () => {
    const h = windDownHolders(book(), 0, LAYOUT_V22.portfolio.accountLen, LP);
    const t = windDownTargets({ aLong: ADL_ONE, aShort: A_LATCHED }, h);
    assert.deepEqual(t.map((x) => x.shortLegs), [1, 1, 1]);
    assert.ok(t[2].pubkey.equals(LP));
    const tl = windDownTargets({ aLong: A_LATCHED, aShort: ADL_ONE }, h);
    assert.deepEqual(tl.map((x) => x.longLegs), [1, 1]);
  });
});

describe("windDownV22Once", () => {
  const fetchPortfolios = async () => book();

  it("healthy market (A = 1 both sides): no read, no simulation, no send", async () => {
    const f = fakeExecConn();
    let reads = 0;
    const r = await windDownV22Once(latchedCtx({ aShort: ADL_ONE }), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios: async () => (reads++, book()) });
    assert.deepEqual(r, []);
    assert.equal(reads + f.sims.length + f.sent.length, 0);
  });

  it("unarmed episode (since == now): sends ONE tag 104 to arm it, then sleeps until since + bound", async () => {
    const now = 519_085_747n;
    const f = fakeExecConn({ simLogs: () => notEligible(now, 9_000n, now) });
    const st = freshWindDownV22State();
    const ctx = latchedCtx({ slot: now });
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "armed");
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].tags, [104]);
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), now + 9_000n);
    // next tick, same slot: nothing at all
    const again = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.deepEqual(again, []);
    assert.equal(f.sent.length, 1);
  });

  it("armed and waiting (since < now): simulates, sends nothing, sleeps until the bound", async () => {
    const now = 519_090_000n;
    const since = 519_085_747n;
    const f = fakeExecConn({ simLogs: () => notEligible(since, 9_000n, now) });
    const st = freshWindDownV22State();
    const ctx = latchedCtx({ slot: now });
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.deepEqual(r[0].action, { kind: "waiting", since, eligibleAtSlot: since + 9_000n });
    assert.equal(f.sent.length, 0);
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), since + 9_000n);
  });

  it("expired: closes the reduce-only (short) side, users first, vault LP last, stops when ADL clears", async () => {
    let n = 0;
    // probe + 3 closes (each simulateAndSend simulates once); the third close clears ADL
    const f = fakeExecConn({ simLogs: () => (n++ < 3 ? closed(40n, false, 9n) : closed(120n, true, 9n)) });
    const ctx = latchedCtx();
    const r = await windDownV22Once(ctx, freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "closed");
    assert.equal(f.sent.length, 3);
    assert.ok(f.sent.every((s) => s.tags[0] === 104));
    assert.equal(f.sent[2].keys[0][2], LP.toBase58()); // [2] = target portfolio: the LP is closed last
    if (r[0].action.kind === "closed") assert.equal(r[0].action.cleared, true);
  });

  it("caps closes per turn", async () => {
    const f = fakeExecConn({ simLogs: () => closed(40n, false, 9n) });
    await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios, maxClosesPerTurn: 1 });
    assert.equal(f.sent.length, 1);
  });

  it("a refusal (27 stale mark) sends nothing and retries after a short backoff", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 27) });
    const st = freshWindDownV22State();
    const ctx = latchedCtx();
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.deepEqual(r[0].action, { kind: "refused", name: "Custom(27)" });
    assert.equal(f.sent.length, 0);
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + WIND_DOWN_V22_RETRY_SLOTS);
  });

  it("dry-run: arms nothing on chain", async () => {
    const now = 519_085_747n;
    const f = fakeExecConn({ simLogs: () => notEligible(now, 9_000n, now) });
    const r = await windDownV22Once(latchedCtx({ slot: now }), freshWindDownV22State(), { exec: execCtx(f.conn, true), fetchPortfolios });
    assert.equal(r[0].action.kind, "armed");
    if (r[0].action.kind === "armed") assert.equal(r[0].action.outcome.kind, "dry-run");
    assert.equal(f.sent.length, 0);
  });

  it("no holders / non-Active asset: nothing sent", async () => {
    const f = fakeExecConn({ simLogs: () => closed(1n, true, 1n) });
    const r = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios: async () => [] });
    assert.deepEqual(r[0].action, { kind: "skipped", reason: "no holders" });
    const r2 = await windDownV22Once(latchedCtx({ lifecycle: 4 }), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios });
    assert.deepEqual(r2, []);
    assert.equal(f.sent.length + f.sims.length, 0);
    // Recovery (5): engine adl_wind_down_eligible -> require_asset_live_reducible accepts Active/DrainOnly only (tag 104 would be refused)
    const r3 = await windDownV22Once(latchedCtx({ lifecycle: 5 }), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios });
    assert.deepEqual(r3, []);
    assert.equal(f.sent.length + f.sims.length, 0);
  });
});

describe("parseWindDownLog edge cases", () => {
  it("skips non-matching and non 0/1 flag lines, takes the first matching line, tolerates case and trailing space", () => {
    assert.deepEqual(parseWindDownLog(["Program log: 0x68, 0x2, 0x1, 0x2, 0x3", "Program log: 0x68, 0x1, 0xAB, 0x0, 0xFF  "]), { kind: "closed", closedQ: 0xabn, cleared: false, now: 0xffn });
    assert.equal(parseWindDownLog(["Program log: 0x68, 0x0, 0x1, 0x2, 0x3", "Program log: 0x68, 0x1, 0x9, 0x1, 0x9"]).kind, "not-eligible");
    assert.equal(parseWindDownLog([]).kind, "none");
    assert.equal(parseWindDownLog(undefined).kind, "none");
  });
});

describe("windDownTargets ordering", () => {
  const h = (k: number, o: { long?: number; short?: number; lp?: boolean } = {}) => ({ pubkey: key(k), portfolioId: BigInt(k), positionEpoch: 0n, longLegs: o.long ?? 0, shortLegs: o.short ?? 0, isLp: o.lp ?? false });
  const order = (t: ReturnType<typeof windDownTargets>) => t.map((x) => x.pubkey.toBase58());
  const latched = { aLong: ADL_ONE, aShort: A_LATCHED };

  it("sorts users by base58 pubkey regardless of input order, LP last even when its key sorts first", () => {
    const hs = [h(30, { short: 1 }), h(31, { short: 1, lp: true }), h(20, { short: 1 }), h(40, { short: 1 })];
    const want = [key(20), key(30), key(40)].map((k) => k.toBase58()).sort();
    want.push(key(31).toBase58());
    assert.deepEqual(order(windDownTargets(latched, hs)), want);
    assert.deepEqual(order(windDownTargets(latched, [...hs].reverse())), want);
    // LP key made lexicographically smallest of all: still last
    const lowLp = [h(30, { short: 1 }), h(20, { short: 1, lp: true })];
    const t = windDownTargets(latched, lowLp);
    assert.ok(t[1].isLp && !t[0].isLp);
  });
  it("only the reduce-only side's holders; the long side is left alone", () => {
    const hs = [h(1, { long: 1 }), h(2, { short: 1 }), h(3, { long: 1 })];
    assert.deepEqual(order(windDownTargets(latched, hs)), [key(2).toBase58()]);
    assert.deepEqual(order(windDownTargets({ aLong: A_LATCHED, aShort: ADL_ONE }, hs)), [key(1), key(3)].map((k) => k.toBase58()).sort());
  });
  it("both sides latched: the side with fewer holders; a tie picks long", () => {
    const hs = [h(1, { long: 1 }), h(2, { short: 1 }), h(3, { short: 1 })];
    assert.deepEqual(order(windDownTargets({ aLong: A_LATCHED, aShort: A_LATCHED }, hs)), [key(1).toBase58()]);
    const tie = [h(1, { long: 1 }), h(2, { short: 1 })];
    assert.deepEqual(order(windDownTargets({ aLong: A_LATCHED, aShort: A_LATCHED }, tie)), [key(1).toBase58()]);
  });
  it("reduce-only side has no holders: falls back to ALL holders (still LP last, key order)", () => {
    const hs = [h(5, { long: 1, lp: true }), h(3, { long: 1 }), h(4, { long: 1 })];
    const t = windDownTargets(latched, hs); // short side latched but nobody is short
    assert.equal(t.length, 3);
    assert.ok(t[2].isLp);
    assert.deepEqual(order(t.slice(0, 2)), [key(3), key(4)].map((k) => k.toBase58()).sort());
    assert.deepEqual(windDownTargets(latched, []), []);
  });
  it("a portfolio with both legs on the asset counts on both sides", () => {
    const hs = [h(1, { long: 1, short: 1 }), h(2, { short: 1 })];
    assert.equal(windDownTargets(latched, hs).length, 2);
    assert.equal(windDownTargets({ aLong: A_LATCHED, aShort: ADL_ONE }, hs).length, 1);
  });
});

describe("windDownV22Once: mint, close order, send outcomes", () => {
  const fetchPortfolios = async () => book();
  const mintBytes = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  const mintKey = new PublicKey(mintBytes);
  const sentOutcome = (logs: string[]): ExecOutcome => ({ kind: "sent", signature: "s", landed: "landed", failCode: null, landedSlot: 1, unitsConsumed: 1, logs });
  const sendRecorder = (fn: (i: number) => ExecOutcome | Error) => {
    const calls: Array<{ portfolio: string; mint: string; label: string }> = [];
    const send = async (_e: unknown, ixs: Array<{ keys: Array<{ pubkey: PublicKey }> }>, o: { label: string }) => {
      calls.push({ portfolio: ixs[0].keys[2].pubkey.toBase58(), mint: ixs[0].keys[3].pubkey.toBase58(), label: o.label });
      const r = fn(calls.length - 1);
      if (r instanceof Error) throw r;
      return r;
    };
    return { calls, send: send as never };
  };
  const eligible = () => fakeExecConn({ simLogs: () => closed(40n, false, 9n) });
  const expectOrder = [key(14), key(15)].map((k) => k.toBase58()).sort().concat(LP.toBase58());

  it("reads collateral_mint from market config offset 48 for tag 104 account [3]", async () => {
    const ctx = latchedCtx();
    ctx.data.set(mintBytes, 48);
    const f = eligible();
    const rec = sendRecorder(() => sentOutcome(closed(1n, true, 1n)));
    await windDownV22Once(ctx, freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios, send: rec.send, maxClosesPerTurn: 1 });
    assert.equal(rec.calls[0].mint, mintKey.toBase58());
    assert.equal(f.sims[0].keys[0][3], mintKey.toBase58()); // the probe carries it too
  });

  it("closes users then the vault LP in order, with LP label; sent outcomes without clear keep going to the cap", async () => {
    const rec = sendRecorder(() => sentOutcome(closed(1n, false, 1n)));
    const st = freshWindDownV22State();
    const ctx = latchedCtx();
    const r = await windDownV22Once(ctx, st, { exec: execCtx(eligible().conn), fetchPortfolios, send: rec.send, maxClosesPerTurn: 10 });
    assert.deepEqual(rec.calls.map((c) => c.portfolio), expectOrder);
    assert.ok(rec.calls[2].label.endsWith(" (vault LP)"));
    assert.ok(!rec.calls[0].label.includes("vault LP"));
    const a = r[0].action;
    assert.ok(a.kind === "closed" && a.outcomes.length === 3 && a.cleared === false);
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + 1n);
  });

  it("default cap is 3 closes", async () => {
    const book5 = [...book(), { pubkey: key(18), data: portfolioBytes({ owner: key(8), legs: [{ side: 1, basis: 40n }] }) }];
    const rec = sendRecorder(() => sentOutcome(closed(1n, false, 1n)));
    await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(eligible().conn), fetchPortfolios: async () => book5, send: rec.send });
    assert.equal(rec.calls.length, 3);
    assert.ok(!rec.calls.some((c) => c.portfolio === LP.toBase58())); // 3 users first; LP is 4th and not reached
  });

  it("dry-run outcomes are parsed like sent ones: a dry-run clear stops the turn", async () => {
    let i = 0;
    const rec = sendRecorder(() => ({ kind: "dry-run", unitsConsumed: 1, ixCount: 1, logs: i++ === 1 ? closed(1n, true, 1n) : closed(1n, false, 1n) }));
    const r = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(eligible().conn), fetchPortfolios, send: rec.send });
    assert.equal(rec.calls.length, 2);
    const a = r[0].action;
    assert.ok(a.kind === "closed" && a.cleared && a.outcomes.every((o) => o.kind === "dry-run"));
  });

  it("real dry-run exec: closes simulate every target, send none", async () => {
    const f = eligible();
    const r = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(f.conn, true), fetchPortfolios, maxClosesPerTurn: 10 });
    assert.equal(f.sent.length, 0);
    const a = r[0].action;
    assert.ok(a.kind === "closed" && a.outcomes.length === 3 && a.outcomes.every((o) => o.kind === "dry-run"));
  });

  it("a refused close stops the turn after that holder (the remaining holders wait for the next turn)", async () => {
    const refused: ExecOutcome = { kind: "refused", code: 21, index: 0, name: "Custom(21)", expected: true, logs: closed(1n, true, 1n) };
    const rec = sendRecorder((i) => (i === 0 ? sentOutcome(closed(1n, false, 1n)) : refused));
    const r = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(eligible().conn), fetchPortfolios, send: rec.send, maxClosesPerTurn: 10 });
    assert.equal(rec.calls.length, 2);
    const a = r[0].action;
    // refused logs are never read as a clear
    assert.ok(a.kind === "closed" && a.outcomes.map((o) => o.kind).join() === "sent,refused" && a.cleared === false);
  });

  for (const bad of [{ kind: "held", reason: "x" }, { kind: "failed", error: "boom" }] as ExecOutcome[]) {
    it(`a ${bad.kind} close stops the turn`, async () => {
      const rec = sendRecorder(() => bad);
      const r = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(eligible().conn), fetchPortfolios, send: rec.send, maxClosesPerTurn: 10 });
      assert.equal(rec.calls.length, 1);
      assert.ok(r[0].action.kind === "closed" && r[0].action.outcomes.length === 1);
    });
  }

  it("a thrown send is contained: skipped with its message, short backoff, next asset/turn unaffected", async () => {
    const rec = sendRecorder((i) => (i === 1 ? new Error("rpc exploded") : sentOutcome(closed(1n, false, 1n))));
    const st = freshWindDownV22State();
    const ctx = latchedCtx();
    const r = await windDownV22Once(ctx, st, { exec: execCtx(eligible().conn), fetchPortfolios, send: rec.send, maxClosesPerTurn: 10 });
    assert.equal(rec.calls.length, 2);
    assert.deepEqual(r[0].action, { kind: "skipped", reason: "rpc exploded" });
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + WIND_DOWN_V22_RETRY_SLOTS);
    // non-Error throw is stringified
    const r2 = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(eligible().conn), fetchPortfolios, send: (async () => { throw "plain string"; }) as never });
    assert.deepEqual(r2[0].action, { kind: "skipped", reason: "plain string" });
  });

  it("arming outcome: a landed arm sleeps to since+bound, a non-landed one backs off", async () => {
    const now = 519_085_747n;
    const mk = (o: ExecOutcome) => sendRecorder(() => o);
    const ctx1 = latchedCtx({ slot: now });
    const st1 = freshWindDownV22State();
    const f = fakeExecConn({ simLogs: () => notEligible(now, 9_000n, now) });
    await windDownV22Once(ctx1, st1, { exec: execCtx(f.conn), fetchPortfolios, send: mk({ ...(sentOutcome([]) as object), landed: "not-landed" } as ExecOutcome).send });
    assert.equal(st1.nextSlot.get(`${ctx1.marketAddress}|0`), now + WIND_DOWN_V22_RETRY_SLOTS);
    const st2 = freshWindDownV22State();
    await windDownV22Once(ctx1, st2, { exec: execCtx(f.conn), fetchPortfolios, send: mk({ kind: "refused", code: 21, index: 0, name: "x", expected: true, logs: [] }).send });
    assert.equal(st2.nextSlot.get(`${ctx1.marketAddress}|0`), now + WIND_DOWN_V22_RETRY_SLOTS);
  });

  it("probe edge cases: no tag-104 log skips with backoff; non-custom sim error is named from JSON; waiting past the bound sleeps one slot", async () => {
    const st = freshWindDownV22State();
    const ctx = latchedCtx();
    const f0 = fakeExecConn({ simLogs: () => [] });
    const r0 = await windDownV22Once(ctx, st, { exec: execCtx(f0.conn), fetchPortfolios });
    assert.ok(r0[0].action.kind === "skipped" && r0[0].action.reason.includes("no tag-104 log"));
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + WIND_DOWN_V22_RETRY_SLOTS);
    const f1 = fakeExecConn({ simErr: () => "AccountNotFound" as never });
    const r1 = await windDownV22Once(latchedCtx(), freshWindDownV22State(), { exec: execCtx(f1.conn), fetchPortfolios });
    assert.deepEqual(r1[0].action, { kind: "refused", name: '"AccountNotFound"' });
    const now = 519_100_000n;
    const f2 = fakeExecConn({ simLogs: () => notEligible(now - 20_000n, 9_000n, now) });
    const st2 = freshWindDownV22State();
    const ctx2 = latchedCtx({ slot: now });
    await windDownV22Once(ctx2, st2, { exec: execCtx(f2.conn), fetchPortfolios });
    assert.equal(st2.nextSlot.get(`${ctx2.marketAddress}|0`), now + 1n);
  });

  it("holders are fetched once per turn and cached across assets; the fetch receives the market and portfolio length", async () => {
    const ctx = latchedCtx();
    let args: unknown[] = [];
    let n = 0;
    await windDownV22Once(ctx, freshWindDownV22State(), { exec: execCtx(fakeExecConn({ simLogs: () => [] }).conn), fetchPortfolios: async (...a) => ((args = a), n++, book()) });
    assert.equal(n, 1);
    assert.ok((args[0] as PublicKey).equals(ctx.market) && args[1] === ctx.layout.portfolioAccountLen);
  });
});

describe("KEEPER_V22_ADL_WIND_DOWN", () => {
  it("is OFF by default, its own flag, strict", () => {
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on" }).adlWindDown, false);
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_ADL_WIND_DOWN: "on" }).adlWindDown, true);
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_ADL_WIND_DOWN: "maybe" }));
  });
});

describe("V22Loop wiring", () => {
  async function tickWith(env: Record<string, string>) {
    const now = 519_085_747n;
    const ctx = latchedCtx({ slot: now });
    const f = fakeLoopConn({ readSlot: Number(now), market: ctx.data, registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(LP, 0n), portfolios: book(), simLogs: (d) => (d.tags[0] === 104 ? notEligible(now, 9_000n, now) : []) });
    const lines: string[] = [];
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: ctx.marketAddress, label: "SOL/T" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", ...env }), dryRun: false, log: (l) => lines.push(l) });
    await loop.tick();
    return { f, lines };
  }
  it("flag on: a latched NON-band market gets its arming tag 104 from the tick", async () => {
    const r = await tickWith({ KEEPER_V22_ADL_WIND_DOWN: "on" });
    assert.equal(r.f.sent.filter((s) => s.tags[0] === 104).length, 1, r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.includes("[v22][adl-104]") && l.includes("arming")), r.lines.join("\n"));
  });
  it("NEGATIVE CONTROL: flag unset -> no tag 104 simulated or sent", async () => {
    const r = await tickWith({});
    assert.equal(r.f.sims.filter((s) => s.tags[0] === 104).length + r.f.sent.filter((s) => s.tags[0] === 104).length, 0);
  });
});
