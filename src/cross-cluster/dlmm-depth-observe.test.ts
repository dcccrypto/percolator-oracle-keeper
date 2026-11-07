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
