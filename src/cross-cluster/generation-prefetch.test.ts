/**
 * PERF (v22-keep-1113): the push cycle starts its generation read (market_id / observation_sequence slab bytes) at the
 * top of the cycle, concurrently with the mainnet price read, and hands the promise to pushAuthMarkBatch.
 *
 * Pins: a covering prefetch replaces the pusher's own read (no second RPC call) and yields exactly the fields a fresh
 * read yields; a prefetch that does not cover a pushed market falls back to a fresh read; the local nonce watermark is
 * still applied at parse time (a push sent AFTER the prefetch started is never re-proposed); failures are counted over
 * the pushed markets only; startGenerationRead never leaks an unhandledRejection.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/generation-prefetch.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { V17_MARKET_GROUP_LEN, V17_ASSET_ORACLE_WRAPPER_LEN } from "@percolatorct/sdk";
import {
  fetchPushAuthMarkGenerationFields,
  pushAuthMarkBatch,
  readGenerationAccounts,
  resetTerminalPushLogForTests,
} from "./auth-mark-pusher.ts";
import { startGenerationRead } from "./keeper-loop.ts";
import { selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SOL = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
const g = selectMarketGroupOffset(SOL);
assert.ok(g.ok);
const MARKET_ID_OFF = (g as { marketGroupOff: number }).marketGroupOff + V17_MARKET_GROUP_LEN + V17_ASSET_ORACLE_WRAPPER_LEN;
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

interface Fake { addr: string; id: bigint }
const fakeMarkets = (n: number): Fake[] =>
  Array.from({ length: n }, (_, i) => ({ addr: Keypair.generate().publicKey.toBase58(), id: 7000n + BigInt(i) }));
function bytesFor(m: Fake): Buffer {
  const b = Buffer.from(SOL);
  b.writeBigUInt64LE(m.id, MARKET_ID_OFF);
  return b;
}
function conn(markets: Fake[], opts: { fail?: boolean } = {}) {
  const byAddr = new Map(markets.map((m) => [m.addr, m]));
  const reads: string[][] = [];
  const sent: number[] = [];
  return {
    reads,
    sent,
    conn: {
      async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
        reads.push(pks.map((p) => p.toBase58()));
        if (opts.fail) throw new Error("429 rate limited");
        return pks.map((pk) => {
          const m = byAddr.get(pk.toBase58());
          return m ? { data: bytesFor(m) } : null;
        });
      },
      async simulateTransaction() {
        return { value: { err: null } };
      },
      async sendRawTransaction() {
        sent.push(1);
        return "sig" + sent.length;
      },
    },
  };
}
const push = (m: Fake) => ({ marketAddress: m.addr, assetIndex: 0, priceE6: 1_000_000n });

describe("generation read prefetch", () => {
  it("a covering prefetch is used as-is: one read in total, same fields as a fresh read", async () => {
    const ms = fakeMarkets(6);
    const fresh = conn(ms);
    const want = await fetchPushAuthMarkGenerationFields(fresh.conn as never, ms.map(push), new Set());
    const c = conn(ms);
    const pre = readGenerationAccounts(c.conn, ms.map((m) => m.addr));
    const got = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set(), undefined, pre);
    assert.equal(c.reads.length, 1, "no second read");
    assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort());
    for (const m of ms) assert.equal(got.get(`${m.addr}:0`)?.marketId, m.id);
  });

  it("a prefetch that does not cover a pushed market falls back to a fresh read of the pushed set", async () => {
    const ms = fakeMarkets(4);
    const c = conn(ms);
    const pre = readGenerationAccounts(c.conn, ms.slice(0, 3).map((m) => m.addr));
    const got = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set(), undefined, pre);
    assert.equal(c.reads.length, 2);
    assert.deepEqual(new Set(c.reads[1]), new Set(ms.map((m) => m.addr)));
    assert.equal(got.size, 4);
  });

  it("the prefetch may cover MORE markets than are pushed; only the pushed ones are returned / classified", async () => {
    const ms = fakeMarkets(5);
    const c = conn(ms);
    const pre = readGenerationAccounts(c.conn, ms.map((m) => m.addr));
    const terminal = new Set<string>();
    const got = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.slice(0, 2).map(push), terminal, undefined, pre);
    assert.deepEqual([...got.keys()].sort(), ms.slice(0, 2).map((m) => `${m.addr}:0`).sort());
    assert.equal(terminal.size, 0);
    assert.equal(c.reads.length, 1);
  });

  it("failed chunk: the pushed markets are skipped (never guessed); a missing account is not counted as failed", async () => {
    const ms = fakeMarkets(3);
    const c = conn(ms, { fail: true });
    const read = await readGenerationAccounts(c.conn, ms.map((m) => m.addr));
    assert.equal(read.failed.size, 3);
    assert.equal(read.failedChunks, 1);
    const got = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set(), undefined, Promise.resolve(read));
    assert.equal(got.size, 0);
    const missing = conn([]);
    const r2 = await readGenerationAccounts(missing.conn, [ms[0].addr]);
    assert.equal(r2.failed.size, 0);
    assert.equal(r2.dataByAddr.size, 0);
  });

  it("pushAuthMarkBatch with a prefetch: one generation read, and the nonce watermark of a push sent after the prefetch started still applies", async () => {
    resetTerminalPushLogForTests();
    const ms = fakeMarkets(3);
    const c = conn(ms);
    const kp = Keypair.generate();
    // cycle 1 pushes (reserves its nonces locally)
    const first = await pushAuthMarkBatch(c.conn as never, kp, ms.map(push), 100n, BLOCKHASH, false, { cycle: 1 });
    assert.equal(first.pushedMarkets.length, 3);
    const seq1 = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set());
    // cycle 2: prefetch taken (chain still shows the pre-cycle-1 value), then pushed
    const before = c.reads.length;
    const pre = startGenerationRead(c.conn, ms.map((m) => m.addr));
    const second = await pushAuthMarkBatch(c.conn as never, kp, ms.map(push), 101n, BLOCKHASH, false, { cycle: 2, generationRead: pre });
    assert.equal(second.pushedMarkets.length, 3);
    assert.equal(c.reads.length - before, 1, "the prefetch is the only generation read of cycle 2");
    const seq2 = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set());
    for (const m of ms) {
      const k = `${m.addr}:0`;
      assert.ok(seq2.get(k)!.observationSequence > seq1.get(k)!.observationSequence, "strictly above what cycle 2 sent");
    }
  });

  it("startGenerationRead: nothing to read -> undefined; a rejection never becomes an unhandledRejection", async () => {
    assert.equal(startGenerationRead(conn([]).conn, []), undefined);
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const bad = startGenerationRead(conn([]).conn, ["not-a-base58-key!"]);
      assert.ok(bad);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(unhandled, []);
      await assert.rejects(bad!);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});
