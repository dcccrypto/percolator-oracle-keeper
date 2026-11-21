/**
 * Round 2: on-chain DEX depth (PushAuthMark mode 2): pin cache, wire, same-cluster rule, 129 fallback, batch isolation.
 * Run with: node --import tsx/esm --test src/cross-cluster/depth-source.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
  encodePushAuthMark,
  buildPushAuthMarkDexIxV22,
} from "@percolatorct/sdk";
import {
  DepthSourceCache,
  decodeActiveDepthSource,
  deriveDepthSource,
  pushDepthOnchainEnabled,
  DEPTH_SOURCE_ACCOUNT_LEN,
} from "./depth-source.ts";
import type { DexDepthPin } from "./depth-source.ts";
import { encodePushAuthMarkDexMode, encodePushAuthMarkMaybeDepth, resolvePushDepth } from "./push-depth.ts";
import { buildPushAuthMarkIx, pushAuthMarkBatch, WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";
import { nonComputeBudget } from "./test-ix.ts";

const k = () => Keypair.generate().publicKey;
const PUMP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAGIC = 0x5045_5243_5631_3600n;

function pinAccount(o: { active?: boolean; pool: PublicKey; bv: PublicKey; qv: PublicKey; marketId?: bigint; assetIndex?: number; kind?: number }): Buffer {
  const b = Buffer.alloc(DEPTH_SOURCE_ACCOUNT_LEN);
  b.writeBigUInt64LE(MAGIC, 0);
  b.writeUInt16LE(19, 8);
  b[10] = o.kind ?? 16;
  const body = b.subarray(16);
  k().toBuffer().copy(body, 0); // market (non-zero)
  if (o.active !== false) {
    PUMP.toBuffer().copy(body, 32);
    o.pool.toBuffer().copy(body, 64);
    o.bv.toBuffer().copy(body, 96);
    o.qv.toBuffer().copy(body, 128);
    k().toBuffer().copy(body, 160);
    k().toBuffer().copy(body, 192);
    body.writeBigUInt64LE(o.marketId ?? 1n, 224);
    body.writeUInt16LE(o.assetIndex ?? 0, 240);
    body[242] = 6;
    body[243] = 9;
    body[244] = 1;
    body[247] = 1;
  }
  body[245] = 1;
  return b;
}
const acct = (data: Buffer, owner: PublicKey) => ({ data, owner, lamports: 1, executable: false });

/** A fake cluster: address -> account. getMultipleAccountsInfo returns null for anything it does not hold. */
function cluster(accts: Map<string, ReturnType<typeof acct>>, fail = false) {
  let reads = 0;
  return {
    reads: () => reads,
    conn: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        reads++;
        if (fail) throw new Error("rpc down");
        return keys.map((x) => accts.get(x.toBase58()) ?? null);
      },
    },
  };
}

describe("flag", () => {
  it("KEEPER_PUSH_DEPTH_ONCHAIN needs KEEPER_PUSH_DEPTH too; default off", () => {
    assert.equal(pushDepthOnchainEnabled({}), false);
    assert.equal(pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH_ONCHAIN: "on" }), false);
    assert.equal(pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH: "on" }), false);
    assert.equal(pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH: "on", KEEPER_PUSH_DEPTH_ONCHAIN: "1" }), true);
  });
  it("an unrecognised value refuses, whichever flag it is on and even with the other off", () => {
    assert.throws(() => pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH: "on", KEEPER_PUSH_DEPTH_ONCHAIN: "onn" }), /KEEPER_PUSH_DEPTH_ONCHAIN="onn"/);
    assert.throws(() => pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH_ONCHAIN: "yes please" }), /KEEPER_PUSH_DEPTH_ONCHAIN=/);
    assert.throws(() => pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH: "ture", KEEPER_PUSH_DEPTH_ONCHAIN: "on" }), /KEEPER_PUSH_DEPTH="ture"/);
  });
});

describe("wire", () => {
  const args = { assetIndex: 2, marketId: 5n, nowSlot: 99n, markE6: 1_000_000n, observationSequence: 7n };
  it("mode 2 data = the 35 B + [2][0 u64] (44 B); never produced by the mode-1 encoder", () => {
    const d = encodePushAuthMarkDexMode(args);
    assert.equal(d.length, 44);
    assert.deepEqual(d.slice(0, 35), encodePushAuthMark(args));
    assert.equal(d[35], 2);
    assert.deepEqual([...d.slice(36)], [0, 0, 0, 0, 0, 0, 0, 0]);
    // an attested (mode 1) push with depth 0 can never be built: the encoder throws, and resolvePushDepth never yields 0
    assert.throws(() => encodePushAuthMarkMaybeDepth(args, { depthE6: 0n, source: "x" }), RangeError);
    assert.equal(resolvePushDepth(true, 40n), null);
  });
  it("ix: [authority signer][market w][depth_src][pool][base_vault][quote_vault] read-only; no dex = byte-identical 35 B", () => {
    const auth = k(), market = k();
    const pin: DexDepthPin = { depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, market), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 2, marketId: 5n };
    const ix = buildPushAuthMarkIx(auth, market, 2, 5n, 99n, 1_000_000n, 7n, null, pin);
    assert.equal(ix.keys.length, 6);
    assert.deepEqual(ix.keys.map((x) => x.pubkey.toBase58()), [auth, market, pin.depthSource, pin.pool, pin.baseVault, pin.quoteVault].map((x) => x.toBase58()));
    assert.deepEqual(ix.keys.map((x) => [x.isSigner, x.isWritable]), [[true, false], [false, true], [false, false], [false, false], [false, false], [false, false]]);
    assert.deepEqual(new Uint8Array(ix.data), encodePushAuthMarkDexMode(args));
    const off = buildPushAuthMarkIx(auth, market, 2, 5n, 99n, 1_000_000n, 7n);
    assert.equal(off.keys.length, 2);
    assert.deepEqual(new Uint8Array(off.data), encodePushAuthMark(args));
  });
});

describe("parity with the SDK builder", () => {
  it("mode-2 ix == SDK buildPushAuthMarkDexIxV22 (keys, flags, data)", () => {
    const auth = k(), market = k();
    const pin: DexDepthPin = { depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, market), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 2, marketId: 5n };
    const mine = buildPushAuthMarkIx(auth, market, 2, 5n, 99n, 1_000_000n, 7n, null, pin);
    const sdk = buildPushAuthMarkDexIxV22({ programId: WRAPPER_PROGRAM_ID, oracleAuthority: auth, market, push: { assetIndex: 2, marketId: 5n, nowSlot: 99n, markE6: 1_000_000n, observationSequence: 7n }, pool: pin.pool, baseVault: pin.baseVault, quoteVault: pin.quoteVault });
    assert.deepEqual(mine.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]), sdk.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]));
    assert.deepEqual(new Uint8Array(mine.data), new Uint8Array(sdk.data));
  });
});

describe("DepthSourceCache", () => {
  const market = k();
  const pool = k(), bv = k(), qv = k();
  const pda = deriveDepthSource(WRAPPER_PROGRAM_ID, market).toBase58();
  const onCluster = () => new Map([
    [pda, acct(pinAccount({ pool, bv, qv }), WRAPPER_PROGRAM_ID)],
    [pool.toBase58(), acct(Buffer.alloc(301), PUMP)],
    [bv.toBase58(), acct(Buffer.alloc(165), TOKEN)],
    [qv.toBase58(), acct(Buffer.alloc(165), TOKEN)],
  ]);

  it("PDA present + active + pool/vaults on this cluster -> pin", async () => {
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(onCluster()).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    const pin = c.get(market.toBase58());
    assert.ok(pin && pin.pool.equals(pool) && pin.baseVault.equals(bv) && pin.quoteVault.equals(qv));
  });
  it("PDA absent -> null", async () => {
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(new Map()).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(c.get(market.toBase58()), null);
    assert.equal(c.why(market.toBase58()), "no depth source");
  });
  it("PDA inactive (cleared) / wrong kind / short -> null", async () => {
    for (const data of [pinAccount({ active: false, pool, bv, qv }), pinAccount({ pool, bv, qv, kind: 3 }), Buffer.alloc(100)]) {
      const m = onCluster();
      m.set(pda, acct(data, WRAPPER_PROGRAM_ID));
      const c = new DepthSourceCache(60_000, () => 0);
      await c.refresh(cluster(m).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
      assert.equal(c.get(market.toBase58()), null);
    }
    assert.equal(decodeActiveDepthSource(pinAccount({ active: false, pool, bv, qv }), new PublicKey(pda)), null);
  });
  it("CROSS-CLUSTER: pin names a (mainnet) pool that does not exist on the push cluster -> never mode 2", async () => {
    for (const drop of [pool, bv, qv]) {
      const m = onCluster();
      m.delete(drop.toBase58());
      const c = new DepthSourceCache(60_000, () => 0);
      await c.refresh(cluster(m).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
      assert.equal(c.get(market.toBase58()), null);
      assert.equal(c.why(market.toBase58()), "pinned pool/vaults not on the push cluster");
    }
    // pool present but owned by a foreign program (not the pinned AMM)
    const m = onCluster();
    m.set(pool.toBase58(), acct(Buffer.alloc(301), k()));
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(m).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(c.get(market.toBase58()), null);
  });
  it("RPC failure -> no pin (attested path); cached for the TTL, re-read after it or on invalidate", async () => {
    let now = 0;
    const c = new DepthSourceCache(60_000, () => now);
    const cl = cluster(onCluster());
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    const reads = cl.reads();
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(cl.reads(), reads, "within TTL: no RPC");
    c.invalidate(market.toBase58());
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.ok(cl.reads() > reads, "invalidate forces a re-read");
    now = 61_000;
    const r2 = cl.reads();
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.ok(cl.reads() > r2, "after TTL: re-read");
    const bad = new DepthSourceCache(60_000, () => 0);
    await bad.refresh(cluster(onCluster(), true).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(bad.get(market.toBase58()), null);
  });
});

// ── pusher: mode 2 selection, 129 fallback, isolation ────────────────────────
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
function marketAccount(): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, 100n, true);
  return buf;
}
type Ix = { programId: PublicKey; keys: Array<{ pubkey: PublicKey }>; data: Uint8Array };
function chain(refuse129: Set<string>) {
  const simulated: Ix[][] = [];
  const sent: Ix[][] = [];
  return {
    simulated, sent,
    conn: {
      async getMultipleAccountsInfo(pks: PublicKey[]) { return pks.map(() => ({ data: marketAccount() })); },
      async simulateTransaction(tx: { instructions: Ix[] }) {
        const ixs = nonComputeBudget(tx.instructions);
        simulated.push(ixs);
        for (let i = 0; i < ixs.length; i++) {
          if (ixs[i].data.length === 44 && ixs[i].data[35] === 2 && refuse129.has(ixs[i].keys[1].pubkey.toBase58())) {
            return { value: { err: { InstructionError: [i + 1, { Custom: 129 }] } } };
          }
        }
        return { value: { err: null } };
      },
      async sendRawTransaction() { sent.push(simulated[simulated.length - 1]); return `sig${sent.length}`; },
    },
  };
}
const pinFor = (market: string, marketId = 1n): DexDepthPin => ({
  depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, new PublicKey(market)), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 0, marketId,
});
const push = (m: string, extra: object = {}) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n, ...extra });
const DEPTH = { depthE6: 9_852_457_023n, source: "pumpswap-cpmm" };

describe("pusher: mode 2", () => {
  it("flag off / no pin: every ix is the legacy 35 B with 2 accounts (byte identity)", async () => {
    const [a, b] = [k().toBase58(), k().toBase58()];
    const c = chain(new Set());
    const r = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a), push(b)], 100n, BLOCKHASH, false);
    assert.equal(r.count, 2);
    for (const ix of c.sent.flat()) { assert.equal(ix.data.length, 35); assert.equal(ix.keys.length, 2); }
    assert.deepEqual(r.dexPushedMarkets, []);
  });

  it("an active, same-generation pin -> mode 2 (44 B, depth 0, 6 accounts), in its own tx apart from attested markets", async () => {
    const [a, b] = [k().toBase58(), k().toBase58()];
    const c = chain(new Set());
    const r = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH }), push(b, { depth: DEPTH })], 100n, BLOCKHASH, false);
    assert.equal(r.count, 2);
    assert.deepEqual(r.dexPushedMarkets, [a]);
    assert.equal(c.sent.length, 2, "mode-2 and attested markets are never in the same tx");
    const dexTx = c.sent.find((t) => t[0].keys.length === 6)!;
    assert.equal(dexTx[0].data[35], 2);
    assert.deepEqual([...dexTx[0].data.slice(36)], [0, 0, 0, 0, 0, 0, 0, 0]);
    const attTx = c.sent.find((t) => t[0].keys.length === 2)!;
    assert.equal(attTx[0].data.length, 44);
    assert.equal(attTx[0].data[35], 1);
  });

  it("a pin for another generation / asset slot is ignored (attested path)", async () => {
    const a = k().toBase58();
    const c = chain(new Set());
    await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a, 2n), depth: DEPTH })], 100n, BLOCKHASH, false);
    assert.equal(c.sent[0][0].keys.length, 2);
    assert.equal(c.sent[0][0].data[35], 1);
  });

  it("129 on mode 2: that market falls back to mode 1 THIS cycle, no strike/quarantine, logged once, others untouched", async () => {
    const [a, b, d] = [k().toBase58(), k().toBase58(), k().toBase58()];
    const c = chain(new Set([a]));
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      const r = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH }), push(b, { dex: pinFor(b), depth: DEPTH }), push(d, { depth: DEPTH })], 100n, BLOCKHASH, false);
      assert.equal(r.count, 3, "no market lost");
      assert.deepEqual(r.dexRefusedMarkets, [a]);
      assert.deepEqual(r.dexPushedMarkets, [b]);
      const landed = c.sent.flat();
      const ixA = landed.find((ix) => ix.keys[1].pubkey.toBase58() === a)!;
      assert.equal(ixA.keys.length, 2);
      assert.equal(ixA.data[35], 1, "fell back to attested mode 1");
      assert.equal(new DataView(ixA.data.buffer, ixA.data.byteOffset).getBigUint64(36, true), DEPTH.depthE6);
      const ixB = landed.find((ix) => ix.keys[1].pubkey.toBase58() === b)!;
      assert.equal(ixB.data[35], 2, "the other mode-2 market is unaffected");
      // second cycle, still refused: still pushes, but no second log line
      await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH })], 101n, BLOCKHASH, false);
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.filter((w) => w.includes("mode-2 depth refused")).length, 1);
    assert.ok(!warns.some((w) => w.includes("QUARANTINE")));
  });

  it("129 with no attested depth available: falls back to the 35 B form, never a 44 B depth-0 attested push", async () => {
    const a = k().toBase58();
    const c = chain(new Set([a]));
    await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: null })], 100n, BLOCKHASH, false);
    const ix = c.sent.flat().find((x) => x.keys[1].pubkey.toBase58() === a)!;
    assert.equal(ix.data.length, 35);
  });
});

// ── branch coverage: every decoder rejection, refresh outcome and default parameter ──────────────
describe("decodeActiveDepthSource: each structural rejection is its own null, a valid pin decodes", () => {
  const pool = k(), bv = k(), qv = k();
  const ds = k();
  const good = () => pinAccount({ pool, bv, qv, marketId: 7n, assetIndex: 3 });
  const B = 16; // body offset
  const mutate = (f: (b: Buffer) => void): Buffer => { const b = good(); f(b); return b; };

  it("valid record -> the exact pin (source = the pinned pool, same asset slot and generation)", () => {
    const p = decodeActiveDepthSource(good(), ds)!;
    assert.ok(p.depthSource.equals(ds) && p.pool.equals(pool) && p.baseVault.equals(bv) && p.quoteVault.equals(qv) && p.ammProgram.equals(PUMP));
    assert.equal(p.assetIndex, 3);
    assert.equal(p.marketId, 7n);
  });
  it("accepts every in-range edge: decimals 18, mode 2, flags 3 (active + known bit)", () => {
    const p = decodeActiveDepthSource(mutate((b) => { b[B + 242] = 18; b[B + 243] = 18; b[B + 247] = 2; b[B + 244] = 3; }), ds);
    assert.ok(p && p.pool.equals(pool));
  });
  const rejects: Array<[string, (b: Buffer) => void]> = [
    ["bad magic", (b) => b.writeBigUInt64LE(MAGIC + 1n, 0)],
    ["zero market key", (b) => b.fill(0, B, B + 32)],
    ["version != 1", (b) => { b[B + 245] = 2; }],
    ["non-zero reserved byte", (b) => { b[B + 250] = 1; }],
    ["unknown flag bit", (b) => { b[B + 244] = 1 | 4; }],
    ["inactive flag", (b) => { b[B + 244] = 2; }],
    ["zero pool", (b) => b.fill(0, B + 64, B + 96)],
    ["zero base vault", (b) => b.fill(0, B + 96, B + 128)],
    ["zero quote vault", (b) => b.fill(0, B + 128, B + 160)],
    ["zero base mint", (b) => b.fill(0, B + 160, B + 192)],
    ["zero quote mint", (b) => b.fill(0, B + 192, B + 224)],
    ["duplicate vaults", (b) => b.copy(b, B + 128, B + 96, B + 128)],
    ["duplicate mints", (b) => b.copy(b, B + 192, B + 160, B + 192)],
    ["base decimals > 18", (b) => { b[B + 242] = 19; }],
    ["quote decimals > 18", (b) => { b[B + 243] = 19; }],
    ["mode 0", (b) => { b[B + 247] = 0; }],
    ["mode 3", (b) => { b[B + 247] = 3; }],
  ];
  for (const [name, f] of rejects) {
    it(`rejects: ${name}`, () => assert.equal(decodeActiveDepthSource(mutate(f), ds), null));
  }
  it("decodes from a view with a non-zero byteOffset", () => {
    const g = good();
    const padded = new Uint8Array(g.length + 5);
    padded.set(g, 5);
    const p = decodeActiveDepthSource(padded.subarray(5), ds);
    assert.ok(p && p.pool.equals(pool));
  });
});

describe("DepthSourceCache: remaining refresh outcomes", () => {
  const market = k();
  const pool = k(), bv = k(), qv = k();
  const pda = deriveDepthSource(WRAPPER_PROGRAM_ID, market).toBase58();
  const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const base = () => new Map([
    [pda, acct(pinAccount({ pool, bv, qv }), WRAPPER_PROGRAM_ID)],
    [pool.toBase58(), acct(Buffer.alloc(301), PUMP)],
    [bv.toBase58(), acct(Buffer.alloc(165), TOKEN)],
    [qv.toBase58(), acct(Buffer.alloc(165), TOKEN)],
  ]);
  const m = market.toBase58();

  it("first read fails -> no pin, why 'depth-source read failed'", async () => {
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(base(), true).conn, WRAPPER_PROGRAM_ID, [m]);
    assert.equal(c.get(m), null);
    assert.equal(c.why(m), "depth-source read failed");
  });
  it("PDA owned by another program -> 'no depth source'", async () => {
    const x = base();
    x.set(pda, acct(pinAccount({ pool, bv, qv }), k()));
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(x).conn, WRAPPER_PROGRAM_ID, [m]);
    assert.equal(c.get(m), null);
    assert.equal(c.why(m), "no depth source");
  });
  it("invalid record -> 'depth source inactive or invalid'", async () => {
    const x = base();
    x.set(pda, acct(Buffer.alloc(DEPTH_SOURCE_ACCOUNT_LEN), WRAPPER_PROGRAM_ID));
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(x).conn, WRAPPER_PROGRAM_ID, [m]);
    assert.equal(c.why(m), "depth source inactive or invalid");
  });
  it("pool/vault read fails on the second fetch -> 'pool read failed', no pin", async () => {
    let calls = 0;
    const inner = cluster(base());
    const conn = { async getMultipleAccountsInfo(keys: PublicKey[]) { if (++calls === 2) throw new Error("rpc down"); return inner.conn.getMultipleAccountsInfo(keys); } };
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(conn, WRAPPER_PROGRAM_ID, [m]);
    assert.equal(c.get(m), null);
    assert.equal(c.why(m), "pool read failed");
  });
  it("Token-2022 vaults are accepted -> pin, why 'ok'", async () => {
    const x = base();
    x.set(bv.toBase58(), acct(Buffer.alloc(165), T22));
    x.set(qv.toBase58(), acct(Buffer.alloc(165), T22));
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(x).conn, WRAPPER_PROGRAM_ID, [m]);
    assert.ok(c.get(m)?.pool.equals(pool));
    assert.equal(c.why(m), "ok");
  });
  it("a vault owned by a non-token program -> not on the push cluster (either vault)", async () => {
    for (const v of [bv, qv]) {
      const x = base();
      x.set(v.toBase58(), acct(Buffer.alloc(165), k()));
      const c = new DepthSourceCache(60_000, () => 0);
      await c.refresh(cluster(x).conn, WRAPPER_PROGRAM_ID, [m]);
      assert.equal(c.get(m), null);
      assert.equal(c.why(m), "pinned pool/vaults not on the push cluster");
    }
  });
  it("get/why of an unknown market: null/undefined; invalidate of an unknown market is a no-op; empty refresh does no RPC", async () => {
    const c = new DepthSourceCache();
    assert.equal(c.get("nope"), null);
    assert.equal(c.why("nope"), undefined);
    c.invalidate("nope");
    const cl = cluster(base());
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, []);
    assert.equal(cl.reads(), 0);
  });
  it("defaults (5 min TTL, Date.now): a fresh entry is not re-read", async () => {
    const c = new DepthSourceCache();
    const cl = cluster(base());
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [m]);
    const r = cl.reads();
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [m]);
    assert.equal(cl.reads(), r);
    assert.equal(c.why(m), "ok");
  });
  it("one market failing does not stop another from pinning (batch isolation)", async () => {
    const m2 = k();
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(base()).conn, WRAPPER_PROGRAM_ID, [m, m2.toBase58()]);
    assert.equal(c.why(m), "ok");
    assert.equal(c.why(m2.toBase58()), "no depth source");
  });
});

describe("pushDepthOnchainEnabled default env", () => {
  it("reads process.env when no env is passed", () => {
    const keys = ["KEEPER_PUSH_DEPTH", "KEEPER_PUSH_DEPTH_ONCHAIN"] as const;
    const saved = keys.map((x) => process.env[x]);
    try {
      delete process.env.KEEPER_PUSH_DEPTH; delete process.env.KEEPER_PUSH_DEPTH_ONCHAIN;
      assert.equal(pushDepthOnchainEnabled(), false);
      process.env.KEEPER_PUSH_DEPTH = "on"; process.env.KEEPER_PUSH_DEPTH_ONCHAIN = "on";
      assert.equal(pushDepthOnchainEnabled(), true);
    } finally {
      keys.forEach((x, i) => { if (saved[i] === undefined) delete process.env[x]; else process.env[x] = saved[i]; });
    }
  });
});
