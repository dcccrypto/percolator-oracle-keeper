/**
 * v22/adl-wind-down.ts: tag 104 on close-only v2.2 assets (instr104 2026-11-05).
 * Pure log parsing / holder / target selection, then the turn against the shared fake connection: healthy market sends
 * nothing; an unarmed episode is armed once; an armed episode waits (no simulation until the bound); an eligible episode
 * closes the reduce-only side (vault LP last, stops when ADL clears); refusals send nothing; dry-run sends nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
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
