import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getCachedBlockhash, invalidateBlockhash, resetBlockhashCache } from "./blockhash-cache.ts";
import { crankOneMarket, freshCrankMarketState, readMarketsForCycle } from "./recovery-cranker.ts";
import { makeSharedCloseScan, CLOSE_PROGRESS_OFF, CLOSE_PROGRESS_LEN } from "./bankrupt-close-watch.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("blockhash cache", () => {
  beforeEach(() => resetBlockhashCache());
  const mk = () => {
    let n = 0;
    return { calls: () => n, conn: { rpcEndpoint: "http://x", async getLatestBlockhash() { n++; return { blockhash: `bh${n}`, lastValidBlockHeight: n }; } } };
  };
  it("serves a fresh entry without a call, refetches once it is older than the max age", async () => {
    const m = mk();
    let t = 1000;
    const now = () => t;
    assert.equal((await getCachedBlockhash(m.conn, "processed", { now })).blockhash, "bh1");
    t += 14_000;
    assert.equal((await getCachedBlockhash(m.conn, "processed", { now })).blockhash, "bh1");
    t += 2_000;
    assert.equal((await getCachedBlockhash(m.conn, "processed", { now })).blockhash, "bh2");
    assert.equal(m.calls(), 2);
  });
  it("71 concurrent callers share ONE in-flight fetch", async () => {
    const m = mk();
    const all = await Promise.all(Array.from({ length: 71 }, () => getCachedBlockhash(m.conn, "processed")));
    assert.equal(m.calls(), 1);
    assert.ok(all.every((b) => b.blockhash === "bh1"));
  });
  it("commitments are cached separately; invalidate forces a refetch; a failed fetch is not cached", async () => {
    const m = mk();
    await getCachedBlockhash(m.conn, "processed");
    await getCachedBlockhash(m.conn, "confirmed");
    assert.equal(m.calls(), 2);
    invalidateBlockhash(m.conn);
    await getCachedBlockhash(m.conn, "processed");
    assert.equal(m.calls(), 3);
    resetBlockhashCache();
    let fail = true;
    const flaky = { rpcEndpoint: "http://y", async getLatestBlockhash() { if (fail) throw new Error("429"); return { blockhash: "ok", lastValidBlockHeight: 1 }; } };
    await assert.rejects(getCachedBlockhash(flaky, "processed"));
    fail = false;
    assert.equal((await getCachedBlockhash(flaky, "processed")).blockhash, "ok");
  });
});

describe("readMarketsForCycle: one getMultipleAccounts per 100 markets instead of one getAccountInfo per market", () => {
  const keys = Array.from({ length: 150 }, () => Keypair.generate().publicKey.toBase58());
  const acct = (n: number) => ({ data: Buffer.from([n]), owner: PublicKey.default, lamports: 1, executable: false });
  it("two calls for 150 markets, slot attached, null accounts absent, terminal markets skipped", async () => {
    const sizes: number[] = [];
    const conn = {
      async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
        sizes.push(ks.length);
        return { context: { slot: 77 }, value: ks.map((_, i) => (i === 3 ? null : acct(i))) };
      },
    };
    const states = new Map([[keys[0], { ...freshCrankMarketState(), terminal: true }]]);
    const out = await readMarketsForCycle(conn, keys.map((marketAddress) => ({ marketAddress })), states);
    assert.deepEqual(sizes, [100, 49]); // 150 minus the terminal one
    assert.equal(out.has(keys[0]), false);
    assert.equal(out.get(keys[1])?.context.slot, 77);
    assert.equal(out.size, 149 - 2); // one null per chunk
  });
  it("a failed chunk leaves its markets absent (they fall back to their own read); the other chunk is unaffected", async () => {
    let call = 0;
    const conn = {
      async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
        if (call++ === 0) throw new Error("429");
        return { context: { slot: 5 }, value: ks.map(() => acct(1)) };
      },
    };
    const out = await readMarketsForCycle(conn, keys.map((marketAddress) => ({ marketAddress })), new Map());
    assert.equal(out.size, 50);
    assert.equal(out.has(keys[0]), false);
    assert.equal(out.has(keys[120]), true);
  });
});

describe("crankOneMarket with a prefetched read", () => {
  const SOL = new PublicKey("11111111111111111111111111111112");
  const LP = Keypair.generate().publicKey;
  const BYTES = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
  const ENGINE_SLOT = decodeMarketRefreshState(new Uint8Array(BYTES)).currentSlot;
  const entry = { marketAddress: SOL.toBase58(), label: "SOL", lpPortfolio: LP.toBase58() };
  const mkConn = () => {
    const calls = { read: 0, bh: 0 };
    return {
      calls,
      conn: {
        rpcEndpoint: "http://crank-test",
        async getAccountInfoAndContext() { calls.read++; return { context: { slot: Number(ENGINE_SLOT) + 1 }, value: { data: BYTES, owner: SOL, lamports: 1, executable: false } }; },
        async getProgramAccounts() { return []; },
        async getLatestBlockhash() { calls.bh++; return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
        async simulateTransaction() { return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [] } }; },
        async sendRawTransaction() { return "sig"; },
      },
    };
  };
  it("uses the prefetched account (no per-market read) and the shared blockhash", async () => {
    resetBlockhashCache();
    const c = mkConn();
    const pre = { value: { data: BYTES, owner: SOL, lamports: 1, executable: false }, context: { slot: Number(ENGINE_SLOT) + 1 } };
    await crankOneMarket(c.conn as never, Keypair.generate(), entry, freshCrankMarketState(), false, pre);
    await crankOneMarket(c.conn as never, Keypair.generate(), entry, freshCrankMarketState(), false, pre);
    assert.equal(c.calls.read, 0);
    assert.equal(c.calls.bh, 1, "two cranks, one blockhash fetch");
  });
  it("no prefetch (or a null one) falls back to the per-market read exactly as before", async () => {
    resetBlockhashCache();
    const c = mkConn();
    await crankOneMarket(c.conn as never, Keypair.generate(), entry, freshCrankMarketState(), false);
    await crankOneMarket(c.conn as never, Keypair.generate(), entry, freshCrankMarketState(), false, null);
    assert.equal(c.calls.read, 2);
  });
});

describe("makeSharedCloseScan: one getProgramAccounts for every market", () => {
  const A = Keypair.generate().publicKey;
  const B = Keypair.generate().publicKey;
  const C = Keypair.generate().publicKey;
  const SLICE = CLOSE_PROGRESS_OFF + CLOSE_PROGRESS_LEN - 16;
  const row = (market: PublicKey) => {
    const d = Buffer.alloc(SLICE);
    market.toBuffer().copy(d, 0);
    d[CLOSE_PROGRESS_OFF - 16] = 1;
    return { pubkey: Keypair.generate().publicKey, account: { data: d } };
  };
  it("splits by market, hands each market the close-progress block, and reuses the scan within the ttl", async () => {
    let calls = 0;
    let filters: unknown[] = [];
    const conn = {
      async getProgramAccounts(_p: PublicKey, o: { filters: unknown[] }) { calls++; filters = o.filters; return [row(A), row(A), row(B)]; },
    };
    let t = 0;
    const scan = makeSharedCloseScan(90_000, () => t);
    const pid = Keypair.generate().publicKey;
    const [a, b, c] = await Promise.all([scan.forMarket(conn as never, pid, A), scan.forMarket(conn as never, pid, B), scan.forMarket(conn as never, pid, C)]);
    assert.equal(calls, 1);
    assert.deepEqual([a.length, b.length, c.length], [2, 1, 0]);
    assert.equal(a[0].account.data.length, CLOSE_PROGRESS_LEN);
    assert.equal(a[0].account.data[0], 1, "active byte lands at the start of the 184-byte block");
    assert.equal((filters as Array<{ memcmp?: { offset: number } }>).some((f) => f.memcmp?.offset === 16), false, "no per-market memcmp");
    t += 60_000;
    await scan.forMarket(conn as never, pid, A);
    assert.equal(calls, 1);
    t += 40_000;
    await scan.forMarket(conn as never, pid, A);
    assert.equal(calls, 2, "refetched after the ttl");
  });
});

import { WSOL_MINT } from "@percolatorct/sdk";
import type { Connection } from "@solana/web3.js";
import { readAllPoolPricesE6, resetSlotWatermarksForTests } from "./price-reader.ts";

describe("SOL/USD reference pool rides in the pool batch (no standalone getAccountInfo per cycle)", () => {
  const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const SOL_E6 = 117_753_929n;
  const mint = Keypair.generate().publicKey;
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const pump = (): Buffer => {
    const b = Buffer.alloc(301);
    mint.toBuffer().copy(b, 43);
    WSOL_MINT.toBuffer().copy(b, 75);
    bv.toBuffer().copy(b, 139);
    qv.toBuffer().copy(b, 171);
    return b;
  };
  const vault = (n: bigint): Buffer => { const b = Buffer.alloc(165); b.writeBigUInt64LE(n, 64); return b; };
  const ray = (): Buffer => {
    const b = Buffer.alloc(300);
    WSOL_MINT.toBuffer().copy(b, 73);
    USDC.toBuffer().copy(b, 105);
    b[233] = 9; b[234] = 6;
    const target = (SOL_E6 << 128n) / 1_000_000_000n;
    let x = target, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + target / x) / 2n; }
    b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
    b.writeBigUInt64LE(x >> 64n, 261);
    return b;
  };
  it("same prices, one fewer RPC call per cycle", async () => {
    resetSlotWatermarksForTests();
    const refPool = Keypair.generate().publicKey.toBase58();
    const cat = Keypair.generate().publicKey.toBase58();
    const calls = { gma: 0, gai: 0, firstBatchKeys: 0 };
    const conn = {
      rpcEndpoint: "https://ep-ref-merge",
      getAccountInfoAndContext: () => { calls.gai++; return Promise.resolve({ context: { slot: 1 }, value: { owner: RAYDIUM_CLMM_OWNER, data: ray() } }); },
      getMultipleAccountsInfoAndContext: (keys: PublicKey[]) => {
        calls.gma++;
        if (calls.gma === 1) {
          calls.firstBatchKeys = keys.length;
          return Promise.resolve({ context: { slot: 1 }, value: [{ owner: PUMPSWAP_OWNER, data: pump() }, { owner: RAYDIUM_CLMM_OWNER, data: ray() }] });
        }
        return Promise.resolve({ context: { slot: 1 }, value: [{ data: vault(135_682_102_366_305n) }, { data: vault(245_409_236_912n) }] });
      },
    } as unknown as Connection;
    const out = await readAllPoolPricesE6(
      conn,
      [{ poolAddress: cat, dexType: "pumpswap", label: "CAT/USDC", symbol: "CAT" }],
      new Map([[cat, { base: 6, quote: 9 }]]),
      refPool,
    );
    assert.equal(calls.gai, 0);
    assert.equal(calls.firstBatchKeys, 2, "the pool plus the reference");
    assert.equal(out.get(cat), (245_409_236_912n * 1_000_000n * SOL_E6) / (135_682_102_366_305n * 1_000_000_000n));
  });
});
