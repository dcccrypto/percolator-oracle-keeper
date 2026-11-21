/**
 * KEEPER_DEPTH_OBSERVE_DLMM: flag parsing, no RPC when OFF, the /health observation shape, and the proof that the push
 * bytes of a DLMM market are identical with the flag ON and OFF. Run: node --import tsx/esm --test src/cross-cluster/dlmm-depth-observe.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodePushAuthMark } from "@percolatorct/sdk";
import { DLMM_PROGRAM_ID, binArrayAddress } from "./dlmm-depth.ts";
import {
  DlmmDepthObserver,
  dlmmDepthObserveEnabled,
  observeDlmmDepth,
  startDlmmDepthObservation,
} from "./dlmm-depth-observe.ts";
import { encodePushAuthMarkMaybeDepth, resolvePushDepth } from "./push-depth.ts";
import { buildPushAuthMarkIx } from "./auth-mark-pusher.ts";

const fx = JSON.parse(readFileSync(new URL("./__fixtures__/dlmm/sol-usdc.json", import.meta.url), "utf8"));
const POOL = new PublicKey(fx.pool);
const acct = (b64: string) => ({ owner: DLMM_PROGRAM_ID, data: Buffer.from(b64, "base64"), lamports: 1, executable: false });
function fakeConn(missing: number[] = []) {
  const calls: PublicKey[][] = [];
  const byKey = new Map<string, ReturnType<typeof acct> | null>([[POOL.toBase58(), acct(fx.poolData)]]);
  for (const a of fx.binArrays) byKey.set(a.address, missing.includes(a.index) ? null : acct(a.data));
  return {
    calls,
    conn: { getMultipleAccountsInfo: async (keys: PublicKey[]) => { calls.push(keys); return keys.map((k) => byKey.get(k.toBase58()) ?? null); } },
  };
}
const dec = { base: fx.baseDecimals, quote: fx.quoteDecimals };
const unit = { key: "mkt", dexType: "meteora-dlmm", source: "pool", poolAddress: fx.pool };

describe("KEEPER_DEPTH_OBSERVE_DLMM flag", () => {
  it("default OFF; on/off words parse; an unknown value throws", () => {
    assert.equal(dlmmDepthObserveEnabled({}), false);
    assert.equal(dlmmDepthObserveEnabled({ KEEPER_DEPTH_OBSERVE_DLMM: "" }), false);
    for (const v of ["on", "1", "true", "yes", "ON"]) assert.equal(dlmmDepthObserveEnabled({ KEEPER_DEPTH_OBSERVE_DLMM: v }), true);
    for (const v of ["off", "0", "false", "no"]) assert.equal(dlmmDepthObserveEnabled({ KEEPER_DEPTH_OBSERVE_DLMM: v }), false);
    assert.throws(() => dlmmDepthObserveEnabled({ KEEPER_DEPTH_OBSERVE_DLMM: "maybe" }));
  });
});

describe("flag OFF means no extra RPC and no state", () => {
  it("startDlmmDepthObservation(false) never touches the connection", async () => {
    const f = fakeConn();
    const o = new DlmmDepthObserver(0);
    startDlmmDepthObservation(false, o, f.conn, [unit], () => dec, undefined, 1000);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 0);
    assert.equal(o.get("mkt"), undefined);
  });
  it("ON: two reads (pool; pool + arrays), result stored, and throttled per interval", async () => {
    const f = fakeConn();
    const o = new DlmmDepthObserver(60_000);
    await o.observe(f.conn, [unit], () => dec, undefined, 1000);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].length, 1);
    assert.equal(f.calls[1].length, 3); // pool + the 2 SOL arrays
    const got = o.get("mkt")!;
    assert.ok("minUsdE6" in got);
    await o.observe(f.conn, [unit], () => dec, undefined, 1000 + 59_000);
    assert.equal(f.calls.length, 2); // throttled
    await o.observe(f.conn, [unit], () => dec, undefined, 1000 + 61_000);
    assert.equal(f.calls.length, 4);
  });
  it("a market that leaves the unit list is pruned (obs + throttle state), so churn cannot grow the maps", async () => {
    const f = fakeConn();
    const o = new DlmmDepthObserver(60_000);
    await o.observe(f.conn, [unit], () => dec, undefined, 1000);
    assert.ok(o.get("mkt"));
    await o.observe(f.conn, [], () => dec, undefined, 1001);
    assert.equal(o.get("mkt"), undefined);
    assert.deepEqual(o.sizes(), { obs: 0, lastStart: 0, inFlight: 0 });
    await o.observe(f.conn, [unit], () => dec, undefined, 1002); // back: observed afresh, not throttled by a stale stamp
    assert.equal(f.calls.length, 4);
  });
  it("only meteora-dlmm pool units are observed", async () => {
    const f = fakeConn();
    const o = new DlmmDepthObserver(0);
    await o.observe(f.conn, [{ ...unit, dexType: "pumpswap" }, { ...unit, dexType: "raydium-clmm" }, { ...unit, source: "fixed" }], () => dec, undefined, 1);
    assert.equal(f.calls.length, 0);
  });
});

describe("observation shape", () => {
  it("success = { bidUsdE6, askUsdE6, minUsdE6, binArrays, at }; values are decimal strings", async () => {
    const f = fakeConn();
    const r = await observeDlmmDepth(f.conn, fx.pool, dec, undefined, 42);
    assert.ok("minUsdE6" in r);
    if (!("minUsdE6" in r)) return;
    assert.equal(r.at, 42);
    assert.match(r.bidUsdE6, /^\d+$/);
    assert.equal(r.minUsdE6, (BigInt(r.bidUsdE6) < BigInt(r.askUsdE6) ? r.bidUsdE6 : r.askUsdE6));
    assert.deepEqual(r.binArrays, [-87, -86]);
  });
  it("a missing bin array -> { error }, never numbers", async () => {
    const r = await observeDlmmDepth(fakeConn([-86]).conn, fx.pool, dec, undefined, 1);
    assert.ok("error" in r);
    assert.ok(!("bidUsdE6" in r));
  });
  it("unknown decimals, a foreign-owned pool, an RPC failure -> { error }", async () => {
    assert.ok("error" in (await observeDlmmDepth(fakeConn().conn, fx.pool, undefined, undefined, 1)));
    const foreign = { getMultipleAccountsInfo: async (k: PublicKey[]) => k.map(() => ({ owner: Keypair.generate().publicKey, data: Buffer.alloc(904), lamports: 1, executable: false })) };
    assert.ok("error" in (await observeDlmmDepth(foreign, fx.pool, dec, undefined, 1)));
    const boom = { getMultipleAccountsInfo: async () => { throw new Error("429"); } };
    const r = await observeDlmmDepth(boom, fx.pool, dec, undefined, 1);
    assert.ok("error" in r);
  });
});

/** A conn whose Nth call (0-based) is answered by `script[N]`; later calls fall back to the plain fixture. */
function scriptedConn(script: Array<(keys: PublicKey[]) => Array<ReturnType<typeof acct> | null>>) {
  const base = fakeConn();
  let n = 0;
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => { const s = script[n++]; return s ? s(keys) : base.conn.getMultipleAccountsInfo(keys); } };
}
const poolBytes = () => Buffer.from(fx.poolData, "base64");
const withActiveId = (delta: number) => {
  const b = Buffer.from(poolBytes());
  b.writeInt32LE(b.readInt32LE(76) + delta, 76);
  return { owner: DLMM_PROGRAM_ID, data: b, lamports: 1, executable: false };
};
const AT = 7;

describe("observation error branches carry exact reasons (never numbers)", () => {
  it("first read: pool account null -> missing/not-owned error", async () => {
    const conn = scriptedConn([() => [null]]);
    const r = await observeDlmmDepth(conn, fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "pool account missing or not owned by the DLMM program", at: AT });
  });
  it("first read: pool data too short -> the planner's reason is surfaced", async () => {
    const short = { owner: DLMM_PROGRAM_ID, data: Buffer.alloc(10), lamports: 1, executable: false };
    const r = await observeDlmmDepth(scriptedConn([() => [short]]), fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "LbPair too short (want 904) (10)", at: AT });
  });
  it("second read: pool null -> 'missing on the second read'", async () => {
    const conn = scriptedConn([() => [acct(fx.poolData)], (k) => k.map(() => null)]);
    const r = await observeDlmmDepth(conn, fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "pool account missing on the second read", at: AT });
  });
  it("second read: pool foreign-owned -> 'missing on the second read'", async () => {
    const foreign = { owner: Keypair.generate().publicKey, data: poolBytes(), lamports: 1, executable: false };
    const conn = scriptedConn([() => [acct(fx.poolData)], (k) => k.map(() => foreign)]);
    const r = await observeDlmmDepth(conn, fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "pool account missing on the second read", at: AT });
  });
  it("second read: pool corrupted between reads -> planner reason on the second plan", async () => {
    const corrupt = { owner: DLMM_PROGRAM_ID, data: Buffer.alloc(5), lamports: 1, executable: false };
    const conn = scriptedConn([() => [acct(fx.poolData)], (k) => k.map(() => corrupt)]);
    const r = await observeDlmmDepth(conn, fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "LbPair too short (want 904) (5)", at: AT });
  });
  it("second read: active bin moved a whole array -> 'active bin moved' retry error", async () => {
    const plain = fakeConn();
    // Second call: real arrays, but the pool account now has an active id 70 bins higher (one array further).
    let n = 0;
    const moving = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        n++;
        const infos = await plain.conn.getMultipleAccountsInfo(keys);
        if (n === 2) infos[0] = withActiveId(70);
        return infos;
      },
    };
    const r = await observeDlmmDepth(moving, fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "active bin moved between reads; retry next interval", at: AT });
  });
  it("a foreign-owned bin array is treated as missing -> computeDlmmDepth refuses with 'bin array -86 missing'", async () => {
    const f = fakeConn();
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        const infos = await f.conn.getMultipleAccountsInfo(keys);
        if (keys.length > 1) infos[infos.length - 1] = { owner: Keypair.generate().publicKey, data: infos[infos.length - 1]!.data, lamports: 1, executable: false };
        return infos;
      },
    };
    const r = await observeDlmmDepth(conn, fx.pool, dec, undefined, AT);
    assert.deepEqual(r, { error: "bin array -86 missing", at: AT });
  });
  it("computeDlmmDepth refusal (unknown decimals) is surfaced verbatim", async () => {
    const r = await observeDlmmDepth(fakeConn().conn, fx.pool, undefined, undefined, AT);
    assert.deepEqual(r, { error: "token decimals unknown", at: AT });
  });
  it("an invalid pool address (PublicKey throws) -> error, no RPC", async () => {
    const f = fakeConn();
    const r = await observeDlmmDepth(f.conn, "not-a-pubkey", dec, undefined, AT);
    assert.ok("error" in r && r.error.length > 0 && r.at === AT);
    assert.equal(f.calls.length, 0);
  });
  it("a non-Error throw is stringified; the message is cut to 160 chars", async () => {
    const r1 = await observeDlmmDepth({ getMultipleAccountsInfo: async () => { throw "plain string"; } }, fx.pool, dec, undefined, AT);
    assert.deepEqual(r1, { error: "plain string", at: AT });
    const r2 = await observeDlmmDepth({ getMultipleAccountsInfo: async () => { throw new Error("x".repeat(500)); } }, fx.pool, dec, undefined, AT);
    assert.deepEqual(r2, { error: "x".repeat(160), at: AT });
  });
  it("success values equal the exact depth the fixture produces and stay decimal strings", async () => {
    const a = await observeDlmmDepth(fakeConn().conn, fx.pool, dec, undefined, AT);
    assert.deepEqual(a, { bidUsdE6: "277415463261", askUsdE6: "405111879296", minUsdE6: "277415463261", binArrays: [-87, -86], at: AT });
  });
});

describe("DlmmDepthObserver in-flight / error handling", () => {
  it("a key already in flight is skipped (no second RPC) and the first observation still lands", async () => {
    const f = fakeConn();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { getMultipleAccountsInfo: async (k: PublicKey[]) => { await gate; return f.conn.getMultipleAccountsInfo(k); } };
    const o = new DlmmDepthObserver(0);
    const first = o.observe(slow, [unit], () => dec, undefined, 1);
    await o.observe(slow, [unit], () => dec, undefined, 2); // same key while the first is pending
    assert.equal(f.calls.length, 0);
    release();
    await first;
    assert.equal(f.calls.length, 2);
    const got = o.get("mkt")!;
    assert.equal(got.at, 1);
  });
  it("an RPC failure is stored as an { error } observation, and the key is released for the next interval", async () => {
    const o = new DlmmDepthObserver(0);
    await o.observe({ getMultipleAccountsInfo: async () => { throw new Error("429"); } }, [unit], () => dec, undefined, 5);
    assert.deepEqual(o.get("mkt"), { error: "429", at: 5 });
    await o.observe(fakeConn().conn, [unit], () => dec, undefined, 6);
    assert.ok("minUsdE6" in o.get("mkt")!);
  });
  it("decimalsOf throwing rejects observe() but releases the in-flight key", async () => {
    const o = new DlmmDepthObserver(0);
    await assert.rejects(() => o.observe(fakeConn().conn, [unit], () => { throw new Error("no decimals"); }, undefined, 1), /no decimals/);
    await o.observe(fakeConn().conn, [unit], () => dec, undefined, 2);
    assert.ok("minUsdE6" in o.get("mkt")!);
  });
  it("startDlmmDepthObservation(true) swallows a rejection and warns with the cut message (Error and non-Error)", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => { warns.push(String(m)); };
    try {
      startDlmmDepthObservation(true, new DlmmDepthObserver(0), fakeConn().conn, [unit], () => { throw new Error("y".repeat(300)); }, undefined, 1);
      startDlmmDepthObservation(true, new DlmmDepthObserver(0), fakeConn().conn, [unit], () => { throw "raw"; }, undefined, 1);
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(warns.sort(), [`[dlmm-depth] observe failed: ${"y".repeat(100)}`, "[dlmm-depth] observe failed: raw"].sort());
  });
  it("startDlmmDepthObservation(true) populates the observer without being awaited", async () => {
    const f = fakeConn();
    const o = new DlmmDepthObserver(0);
    startDlmmDepthObservation(true, o, f.conn, [unit], () => dec, undefined, 9);
    assert.equal(o.get("mkt"), undefined); // not yet: fire-and-forget
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(o.get("mkt")!.at, 9);
  });
});

describe("observe-only: push bytes are unchanged", () => {
  const args: Parameters<typeof encodePushAuthMark>[0] = { assetIndex: 0, marketId: 7n, nowSlot: 123n, markE6: 89_679_082n, observationSequence: 9n };
  it("resolvePushDepth is null for a DLMM market (no CPMM reserve), flag on or off, observation or not", async () => {
    const o = new DlmmDepthObserver(0);
    await o.observe(fakeConn().conn, [unit], () => dec, undefined, 1);
    assert.ok(o.get("mkt"));
    assert.equal(resolvePushDepth(true, undefined), null);
    assert.equal(resolvePushDepth(false, undefined), null);
  });
  it("PushAuthMark bytes for a DLMM market are byte-identical with KEEPER_DEPTH_OBSERVE_DLMM ON and OFF", async () => {
    const auth = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const build = () => ({
      raw: Buffer.from(encodePushAuthMarkMaybeDepth(args, resolvePushDepth(true, undefined))),
      sdk: Buffer.from(encodePushAuthMark(args)),
      ix: buildPushAuthMarkIx(auth, market, 0, 7n, 123n, 89_679_082n, 9n, resolvePushDepth(true, undefined)),
    });
    const prev = process.env.KEEPER_DEPTH_OBSERVE_DLMM;
    try {
      delete process.env.KEEPER_DEPTH_OBSERVE_DLMM;
      const off = build();
      process.env.KEEPER_DEPTH_OBSERVE_DLMM = "on";
      assert.equal(dlmmDepthObserveEnabled(), true);
      const o = new DlmmDepthObserver(0);
      await o.observe(fakeConn().conn, [unit], () => dec, undefined, 1); // observation fully populated while ON
      const on = build();
      assert.ok(on.raw.equals(off.raw));
      assert.ok(on.raw.equals(on.sdk)); // and it is the SDK's 35 B form, no depth tail
      assert.equal(on.raw.length, 35);
      assert.ok(Buffer.from(on.ix.data).equals(Buffer.from(off.ix.data)));
      assert.deepEqual(on.ix.keys.map((k) => k.pubkey.toBase58()), off.ix.keys.map((k) => k.pubkey.toBase58()));
    } finally {
      if (prev === undefined) delete process.env.KEEPER_DEPTH_OBSERVE_DLMM; else process.env.KEEPER_DEPTH_OBSERVE_DLMM = prev;
    }
  });
  it("structural guard: the observe path never imports or calls the push-depth encoder", () => {
    for (const f of ["dlmm-depth.ts", "dlmm-depth-observe.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      assert.ok(!/push-depth|resolvePushDepth|encodePushAuthMark|PushDepth/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${f} must not touch the push path`);
    }
  });
  it("binArrayAddress is deterministic", () => {
    assert.equal(binArrayAddress(POOL, -87).toBase58(), fx.binArrays[2].address);
  });
});

describe("M-1: a bad KEEPER_DEPTH_OBSERVE_DLMM refuses the START, never a per-cycle throw", () => {
  const src = readFileSync(new URL("./keeper-loop.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("the flag is parsed in startup (before the main loop), once", () => {
    const calls = code.match(/dlmmDepthObserveEnabled\(\)/g) ?? [];
    assert.equal(calls.length, 1);
    assert.ok(code.indexOf("dlmmDepthObserveEnabled()") < code.indexOf("while (!stopping)"), "must be parsed before the main loop");
  });
  it("runCycle does not re-parse it (it reads the value parsed at startup)", () => {
    const start = code.indexOf("async function runCycle(");
    const end = code.indexOf("\nasync function ", start + 10);
    const body = code.slice(start, end > start ? end : undefined);
    assert.ok(body.includes("startDlmmDepthObservation("));
    assert.ok(!body.includes("dlmmDepthObserveEnabled"));
  });
  it("an invalid value throws from the parser (so the startup call refuses the start)", () => {
    for (const v of ["disabled", "2", "enabled"]) assert.throws(() => dlmmDepthObserveEnabled({ KEEPER_DEPTH_OBSERVE_DLMM: v }));
  });
});
