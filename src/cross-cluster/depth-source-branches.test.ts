/**
 * Branch coverage for depth-source.ts: every decode rejection, the cache's read-failure / foreign-owner / Token-2022 paths,
 * and the default-arg / unknown-market accessors. Asserts the resulting pin (or null) and the recorded reason.
 * Run with: node --import tsx/esm --test src/cross-cluster/depth-source-branches.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DepthSourceCache, decodeActiveDepthSource, deriveDepthSource, pushDepthOnchainEnabled, DEPTH_SOURCE_ACCOUNT_LEN } from "./depth-source.ts";
import { WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

const k = () => Keypair.generate().publicKey;
const PUMP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MAGIC = 0x5045_5243_5631_3600n;
const PDA = k();

/** A valid active record; `mut` edits the raw buffer (offsets are relative to the 16 B header: body = b.subarray(16)). */
function valid(mut?: (b: Buffer, body: Buffer) => void): Buffer {
  const b = Buffer.alloc(DEPTH_SOURCE_ACCOUNT_LEN);
  b.writeBigUInt64LE(MAGIC, 0);
  b.writeUInt16LE(19, 8);
  b[10] = 16;
  const body = b.subarray(16);
  k().toBuffer().copy(body, 0);
  PUMP.toBuffer().copy(body, 32);
  k().toBuffer().copy(body, 64);
  k().toBuffer().copy(body, 96);
  k().toBuffer().copy(body, 128);
  k().toBuffer().copy(body, 160);
  k().toBuffer().copy(body, 192);
  body.writeBigUInt64LE(7n, 224);
  body.writeUInt16LE(3, 240);
  body[242] = 6;
  body[243] = 9;
  body[244] = 1;
  body[245] = 1;
  body[247] = 1;
  mut?.(b, body);
  return b;
}
const dec = (b: Buffer) => decodeActiveDepthSource(b, PDA);

describe("decodeActiveDepthSource: accepts and rejects", () => {
  it("a valid record decodes to the exact pin fields", () => {
    const pin = dec(valid())!;
    assert.ok(pin);
    assert.equal(pin.assetIndex, 3);
    assert.equal(pin.marketId, 7n);
    assert.ok(pin.ammProgram.equals(PUMP));
    assert.ok(pin.depthSource.equals(PDA));
  });
  it("decodes from a sub-view of a larger buffer (non-zero byteOffset)", () => {
    const rec = valid();
    const big = new Uint8Array(rec.length + 40);
    big.set(rec, 40);
    const pin = dec(big.subarray(40) as unknown as Buffer)!;
    assert.equal(pin.marketId, 7n);
  });
  it("the flag word accepts the known bit 2 alongside active (flags 3) and decimals 18 / depth kind 2 at the limits", () => {
    assert.ok(dec(valid((_b, o) => { o[244] = 3; })));
    assert.ok(dec(valid((_b, o) => { o[242] = 18; o[243] = 18; o[247] = 2; })));
  });
  const reject: Array<[string, (b: Buffer, o: Buffer) => void]> = [
    ["bad magic", (b) => { b.writeBigUInt64LE(MAGIC + 1n, 0); }],
    ["wrong kind", (b) => { b[10] = 15; }],
    ["version byte != 1", (_b, o) => { o[245] = 2; }],
    ["zero market key", (_b, o) => { o.fill(0, 0, 32); }],
    ["non-zero reserved byte", (_b, o) => { o[255] = 1; }],
    ["unknown flag bit", (_b, o) => { o[244] = 1 | 4; }],
    ["cleared (flags 0)", (_b, o) => { o[244] = 0; }],
    ["only a non-active known flag (2)", (_b, o) => { o[244] = 2; }],
    ["zero pool", (_b, o) => { o.fill(0, 64, 96); }],
    ["zero base vault", (_b, o) => { o.fill(0, 96, 128); }],
    ["zero quote vault", (_b, o) => { o.fill(0, 128, 160); }],
    ["zero base mint", (_b, o) => { o.fill(0, 160, 192); }],
    ["zero quote mint", (_b, o) => { o.fill(0, 192, 224); }],
    ["duplicate vaults", (_b, o) => { o.copy(o, 128, 96, 128); }],
    ["duplicate mints", (_b, o) => { o.copy(o, 192, 160, 192); }],
    ["base decimals 19", (_b, o) => { o[242] = 19; }],
    ["quote decimals 19", (_b, o) => { o[243] = 19; }],
    ["pool kind 0", (_b, o) => { o[247] = 0; }],
    ["pool kind 3", (_b, o) => { o[247] = 3; }],
  ];
  for (const [name, mut] of reject) {
    it(`rejects: ${name} -> null`, () => assert.equal(dec(valid(mut)), null));
  }
  it("rejects a wrong-length record (one byte over / under)", () => {
    assert.equal(dec(Buffer.concat([valid(), Buffer.alloc(1)])), null);
    assert.equal(dec(valid().subarray(1)), null);
  });
});

describe("pushDepthOnchainEnabled default env", () => {
  it("reads process.env when no env is passed", () => {
    const keys = ["KEEPER_PUSH_DEPTH", "KEEPER_PUSH_DEPTH_ONCHAIN"] as const;
    const saved = keys.map((x) => process.env[x]);
    try {
      process.env.KEEPER_PUSH_DEPTH = "on";
      process.env.KEEPER_PUSH_DEPTH_ONCHAIN = "on";
      assert.equal(pushDepthOnchainEnabled(), true);
      delete process.env.KEEPER_PUSH_DEPTH_ONCHAIN;
      assert.equal(pushDepthOnchainEnabled(), false);
    } finally {
      keys.forEach((x, i) => (saved[i] === undefined ? delete process.env[x] : (process.env[x] = saved[i])));
    }
  });
});

describe("DepthSourceCache: accessors and refresh edge paths", () => {
  const acct = (owner: PublicKey, len = 165) => ({ data: Buffer.alloc(len), owner, lamports: 1, executable: false });
  const market = k();
  const pda = deriveDepthSource(WRAPPER_PROGRAM_ID, market);
  const pool = k(), bv = k(), qv = k();
  const record = () => valid((_b, o) => { pool.toBuffer().copy(o, 64); bv.toBuffer().copy(o, 96); qv.toBuffer().copy(o, 128); });
  const world = (over: Record<string, ReturnType<typeof acct> | null> = {}) => {
    const m = new Map<string, ReturnType<typeof acct> | null>([
      [pda.toBase58(), { ...acct(WRAPPER_PROGRAM_ID), data: record() }],
      [pool.toBase58(), acct(PUMP, 301)],
      [bv.toBase58(), acct(TOKEN)],
      [qv.toBase58(), acct(TOKEN)],
    ]);
    for (const [key, v] of Object.entries(over)) m.set(key, v);
    return m;
  };
  /** failOn(n): the n-th RPC call (1-based) throws. */
  const conn = (m: Map<string, ReturnType<typeof acct> | null>, failOn = 0) => {
    let n = 0;
    return { async getMultipleAccountsInfo(keys: PublicKey[]) { if (++n === failOn) throw new Error("rpc"); return keys.map((x) => m.get(x.toBase58()) ?? null); } };
  };
  const run = async (c: ReturnType<typeof conn>) => {
    const cache = new DepthSourceCache(60_000, () => 0);
    await cache.refresh(c as never, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    return cache;
  };

  it("unknown market: get -> null, why -> undefined, invalidate is a no-op", () => {
    const c = new DepthSourceCache();
    assert.equal(c.get("nope"), null);
    assert.equal(c.why("nope"), undefined);
    c.invalidate("nope");
    assert.equal(c.get("nope"), null);
  });
  it("default constructor args work (5 min TTL, Date.now)", async () => {
    const c = new DepthSourceCache();
    await c.refresh(conn(world()) as never, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(c.why(market.toBase58()), "ok");
  });
  it("no markets due: no RPC at all", async () => {
    let calls = 0;
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh({ async getMultipleAccountsInfo() { calls++; return []; } } as never, WRAPPER_PROGRAM_ID, []);
    assert.equal(calls, 0);
  });
  it("depth-source read FAILED (RPC throws) -> no pin, 'depth-source read failed' (not 'no depth source')", async () => {
    const c = await run(conn(world(), 1));
    assert.equal(c.get(market.toBase58()), null);
    assert.equal(c.why(market.toBase58()), "depth-source read failed");
  });
  it("depth-source PDA owned by a foreign program -> 'no depth source'", async () => {
    const c = await run(conn(world({ [pda.toBase58()]: { ...acct(k()), data: record() } })));
    assert.equal(c.get(market.toBase58()), null);
    assert.equal(c.why(market.toBase58()), "no depth source");
  });
  it("depth-source record decodes to nothing (zeroed pool) -> 'depth source inactive or invalid'", async () => {
    const bad = valid((_b, o) => { o.fill(0, 64, 96); });
    const c = await run(conn(world({ [pda.toBase58()]: { ...acct(WRAPPER_PROGRAM_ID), data: bad } })));
    assert.equal(c.why(market.toBase58()), "depth source inactive or invalid");
    assert.equal(c.get(market.toBase58()), null);
  });
  it("second read (pool/vaults) FAILED -> no pin, 'pool read failed'", async () => {
    const c = await run(conn(world(), 2));
    assert.equal(c.get(market.toBase58()), null);
    assert.equal(c.why(market.toBase58()), "pool read failed");
  });
  it("Token-2022 vaults are accepted -> pin 'ok'", async () => {
    const c = await run(conn(world({ [bv.toBase58()]: acct(TOKEN22), [qv.toBase58()]: acct(TOKEN22) })));
    const pin = c.get(market.toBase58())!;
    assert.ok(pin && pin.pool.equals(pool) && pin.baseVault.equals(bv) && pin.quoteVault.equals(qv));
    assert.equal(c.why(market.toBase58()), "ok");
  });
  it("a vault owned by a non-token program is refused (each side), and a missing vault too", async () => {
    for (const side of [bv, qv]) {
      const c = await run(conn(world({ [side.toBase58()]: acct(k()) })));
      assert.equal(c.get(market.toBase58()), null);
      assert.equal(c.why(market.toBase58()), "pinned pool/vaults not on the push cluster");
    }
    const c = await run(conn(world({ [qv.toBase58()]: null })));
    assert.equal(c.get(market.toBase58()), null);
  });
  it("mixed batch: one good, one missing PDA, one failing second read are decided independently", async () => {
    const m2 = k(), m3 = k();
    const m = world();
    const cache = new DepthSourceCache(60_000, () => 0);
    await cache.refresh(conn(m) as never, WRAPPER_PROGRAM_ID, [market.toBase58(), m2.toBase58(), m3.toBase58()]);
    assert.equal(cache.why(market.toBase58()), "ok");
    assert.equal(cache.why(m2.toBase58()), "no depth source");
    assert.equal(cache.why(m3.toBase58()), "no depth source");
    assert.ok(cache.get(market.toBase58()));
    assert.equal(cache.get(m2.toBase58()), null);
  });
});
