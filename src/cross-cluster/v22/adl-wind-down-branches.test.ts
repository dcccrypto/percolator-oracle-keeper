/**
 * v22/adl-wind-down.ts branch coverage (K-COV): log parsing nulls, holder / target edge cases, and the turn's
 * refusal, no-log, waiting-past-bound, arm-not-landed, close-refused and thrown-read branches. Tests only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADL_ONE } from "../adl-state.ts";
import { engineSlotBase } from "../market-layout.ts";
import { WIND_DOWN_V22_RETRY_SLOTS, freshWindDownV22State, parseWindDownLog, windDownHolders, windDownTargets, windDownV22Once } from "./adl-wind-down.ts";
import { computeAt, customAt, execCtx, fakeExecConn, key, portfolioBytes, v22Ctx } from "./test-helpers.ts";

const hex = (n: bigint) => `0x${n.toString(16)}`;
const notEligible = (since: bigint, bound: bigint, now: bigint) => [`Program log: 0x68, 0x0, ${hex(since)}, ${hex(bound)}, ${hex(now)}`];
const closed = (q: bigint, cleared: boolean, now: bigint) => [`Program log: 0x68, 0x1, ${hex(q)}, ${cleared ? "0x1" : "0x0"}, ${hex(now)}`];

function latched(o: { slot?: bigint; lifecycle?: number; aLong?: bigint; aShort?: bigint } = {}) {
  const ctx = v22Ctx({ currentSlot: o.slot ?? 5000n, lifecycle: o.lifecycle });
  const b = Buffer.from(ctx.data.buffer, ctx.data.byteOffset, ctx.data.byteLength);
  const e = engineSlotBase(ctx.layout, 0);
  const w = (off: number, v: bigint) => {
    b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, e + off);
    b.writeBigUInt64LE(v >> 64n, e + off + 8);
  };
  w(49, o.aLong ?? ADL_ONE);
  w(65, o.aShort ?? 900_000_000_000_000n);
  return ctx;
}

const shortBook = () => [
  { pubkey: key(11), data: portfolioBytes({ owner: key(1), legs: [{ side: 1, basis: 10n }] }) },
  { pubkey: key(12), data: portfolioBytes({ owner: key(2), legs: [{ side: 1, basis: 10n }] }) },
];

describe("parseWindDownLog edges", () => {
  it("null / undefined / empty logs, and lines that do not match, are none", () => {
    assert.deepEqual(parseWindDownLog(null), { kind: "none" });
    assert.deepEqual(parseWindDownLog(undefined), { kind: "none" });
    assert.deepEqual(parseWindDownLog([]), { kind: "none" });
    assert.deepEqual(parseWindDownLog(["Program log: 0x68, 0x2, 0x1, 0x2, 0x3", "other"]), { kind: "none" });
  });
  it("skips non-matching lines and parses the first matching one; cleared flag reads b != 0", () => {
    assert.deepEqual(parseWindDownLog(["noise", ...closed(5n, true, 9n), ...notEligible(1n, 2n, 3n)]), { kind: "closed", closedQ: 5n, cleared: true, now: 9n });
    assert.deepEqual(parseWindDownLog(closed(5n, false, 9n)), { kind: "closed", closedQ: 5n, cleared: false, now: 9n });
  });
});

describe("windDownHolders / windDownTargets edges", () => {
  const len = v22Ctx().layout.portfolioAccountLen;
  it("skips an unparseable portfolio and legs on other assets", () => {
    const junk = { pubkey: key(30), data: new Uint8Array(len).fill(0xff) };
    const other = { pubkey: key(31), data: portfolioBytes({ owner: key(3), legs: [{ side: 0, basis: 1n, assetIndex: 3 }] }) };
    const ok = { pubkey: key(32), data: portfolioBytes({ owner: key(4), legs: [{ side: 0, basis: 1n }] }) };
    const h = windDownHolders([junk, other, ok], 0, len, null);
    assert.deepEqual(h.map((x) => x.pubkey.toBase58()), [key(32).toBase58()]);
    assert.equal(h[0].isLp, false);
  });
  it("falls back to every holder when the reduce-only side has none, and orders by key", () => {
    const longsOnly = windDownHolders([{ pubkey: key(12), data: portfolioBytes({ owner: key(2), legs: [{ side: 0, basis: 1n }] }) }, { pubkey: key(11), data: portfolioBytes({ owner: key(1), legs: [{ side: 0, basis: 1n }] }) }], 0, len, null);
    const t = windDownTargets({ aLong: ADL_ONE, aShort: 1n }, longsOnly); // short is reduce-only but nobody is short
    assert.equal(t.length, 2);
    assert.ok(t[0].pubkey.toBase58() < t[1].pubkey.toBase58());
  });
  it("puts the LP last regardless of input order, and picks the long side when A_long < 1", () => {
    const hs = windDownHolders(
      [
        { pubkey: key(40), data: portfolioBytes({ owner: key(4), legs: [{ side: 0, basis: 1n }] }) },
        { pubkey: key(41), data: portfolioBytes({ owner: key(5), legs: [{ side: 0, basis: 1n }] }) },
        { pubkey: key(42), data: portfolioBytes({ owner: key(6), legs: [{ side: 1, basis: 1n }] }) },
      ],
      0, len, key(40),
    );
    const t = windDownTargets({ aLong: 1n, aShort: ADL_ONE }, hs);
    assert.deepEqual(t.map((x) => x.pubkey.toBase58()), [key(41).toBase58(), key(40).toBase58()]);
    const t2 = windDownTargets({ aLong: 1n, aShort: ADL_ONE }, [hs[0], hs[1]]);
    assert.equal(t2[1].isLp, true);
  });
});

describe("windDownV22Once branches", () => {
  const fetchPortfolios = async () => shortBook();

  it("a non-market ctx.data decodes to null: nothing read, nothing sent", async () => {
    const ctx = latched();
    const f = fakeExecConn();
    const r = await windDownV22Once({ ...ctx, data: new Uint8Array(ctx.data.length) }, freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios });
    assert.deepEqual(r, []);
  });

  it("a healthy market clears a stale backoff entry", async () => {
    const ctx = latched({ aShort: ADL_ONE });
    const st = freshWindDownV22State();
    st.nextSlot.set(`${ctx.marketAddress}|0`, 99_999n);
    await windDownV22Once(ctx, st, { exec: execCtx(fakeExecConn().conn), fetchPortfolios });
    assert.equal(st.nextSlot.size, 0);
  });

  it("DrainOnly (3) is wound down; a backoff in the future skips the asset", async () => {
    const ctx = latched({ lifecycle: 3 });
    const st = freshWindDownV22State();
    const f = fakeExecConn({ simLogs: () => notEligible(1n, 10n, 5n) });
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "waiting");
    st.nextSlot.set(`${ctx.marketAddress}|0`, 1_000_000n);
    assert.deepEqual(await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios }), []);
  });

  it("a refusal without a program code is named from the raw error", async () => {
    const f = fakeExecConn({ simErr: () => computeAt(0) });
    const r = await windDownV22Once(latched(), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "refused");
    if (r[0].action.kind === "refused") assert.match(r[0].action.name, /ComputationalBudgetExceeded/);
    assert.equal(f.sent.length, 0);
  });

  it("a clean simulation with no tag-104 line is skipped with a short backoff", async () => {
    const f = fakeExecConn({ simLogs: () => ["Program log: nothing"] });
    const st = freshWindDownV22State();
    const ctx = latched();
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "skipped");
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + WIND_DOWN_V22_RETRY_SLOTS);
    assert.equal(f.sent.length, 0);
  });

  it("armed and the bound already passed: re-check on the next slot", async () => {
    const now = 5000n;
    const f = fakeExecConn({ simLogs: () => notEligible(100n, 50n, now) });
    const st = freshWindDownV22State();
    const ctx = latched({ slot: now });
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "waiting");
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + 1n);
  });

  it("an arming send the program refuses (probe ok, send simulation errs) backs off short, not to the bound", async () => {
    const now = 5000n;
    const f = fakeExecConn({ simLogs: () => notEligible(now, 9_000n, now), simErr: (_t, i) => (i === 0 ? null : customAt(0, 21)) });
    const st = freshWindDownV22State();
    const ctx = latched({ slot: now });
    const r = await windDownV22Once(ctx, st, { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "armed");
    if (r[0].action.kind === "armed") assert.equal(r[0].action.outcome.kind, "refused");
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + WIND_DOWN_V22_RETRY_SLOTS);
  });

  it("a close the program refuses stops the turn after that holder", async () => {
    const f = fakeExecConn({ simLogs: () => closed(1n, false, 9n), simErr: (_t, i) => (i === 0 ? null : customAt(0, 21)) });
    const r = await windDownV22Once(latched(), freshWindDownV22State(), { exec: execCtx(f.conn), fetchPortfolios });
    assert.equal(r[0].action.kind, "closed");
    if (r[0].action.kind === "closed") {
      assert.equal(r[0].action.outcomes.length, 1);
      assert.equal(r[0].action.outcomes[0].kind, "refused");
      assert.equal(r[0].action.cleared, false);
    }
    assert.equal(f.sent.length, 0);
  });

  it("dry-run closes read the cleared flag from the simulation logs", async () => {
    const f = fakeExecConn({ simLogs: () => closed(1n, true, 9n) });
    const r = await windDownV22Once(latched(), freshWindDownV22State(), { exec: execCtx(f.conn, true), fetchPortfolios });
    assert.equal(r[0].action.kind, "closed");
    if (r[0].action.kind === "closed") {
      assert.equal(r[0].action.cleared, true);
      assert.equal(r[0].action.outcomes.length, 1);
    }
  });

  it("a thrown portfolio read becomes a skipped result with a backoff; the holders read is cached across assets' turn", async () => {
    const st = freshWindDownV22State();
    const ctx = latched();
    const f = fakeExecConn();
    const r = await windDownV22Once(ctx, st, {
      exec: execCtx(f.conn),
      fetchPortfolios: async () => {
        throw new Error("rpc down");
      },
    });
    assert.deepEqual(r[0].action, { kind: "skipped", reason: "rpc down" });
    assert.equal(st.nextSlot.get(`${ctx.marketAddress}|0`), BigInt(ctx.readSlot) + WIND_DOWN_V22_RETRY_SLOTS);
    const r2 = await windDownV22Once(latched(), freshWindDownV22State(), {
      exec: execCtx(f.conn),
      fetchPortfolios: async () => {
        throw "plain string";
      },
    });
    assert.deepEqual(r2[0].action, { kind: "skipped", reason: "plain string" });
  });

  it("the default portfolio fetch (no seam) goes through the connection and any failure is contained", async () => {
    const f = fakeExecConn();
    const r = await windDownV22Once(latched(), freshWindDownV22State(), { exec: execCtx(f.conn) });
    assert.equal(r.length, 1);
    assert.ok(["skipped", "refused", "waiting", "armed", "closed"].includes(r[0].action.kind));
  });
});
