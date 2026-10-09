/**
 * Capacity cliff: `fetchPushAuthMarkGenerationFields` read every pushable market in ONE
 * getMultipleAccountsInfo. The RPC rejects >100 keys and web3.js does not chunk, so at 101
 * markets the read threw every cycle ("batch push error") and EVERY market's price stopped.
 *
 * The mock connection enforces the real cap (throws above 100 keys), so un-chunked code fails.
 * Each market's bytes carry a unique market_id, so a mis-mapped / re-ordered read is visible.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { V17_MARKET_GROUP_LEN, V17_ASSET_ORACLE_WRAPPER_LEN } from "@percolatorct/sdk";
import { fetchPushAuthMarkGenerationFields, pushAuthMarkBatch, resetTerminalPushLogForTests } from "./auth-mark-pusher.ts";
import { getMultipleAccountsInfoChunked } from "./rpc-chunk.ts";
import { selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SOL = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
const g = selectMarketGroupOffset(SOL);
assert.ok(g.ok);
const MARKET_ID_OFF = (g as { marketGroupOff: number }).marketGroupOff + V17_MARKET_GROUP_LEN + V17_ASSET_ORACLE_WRAPPER_LEN;
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

interface Fake { addr: string; id: bigint }
function fakeMarkets(n: number): Fake[] {
  return Array.from({ length: n }, (_, i) => ({ addr: Keypair.generate().publicKey.toBase58(), id: 1000n + BigInt(i) }));
}
function bytesFor(m: Fake): Buffer {
  const b = Buffer.from(SOL);
  b.writeBigUInt64LE(m.id, MARKET_ID_OFF);
  return b;
}

/** Connection that enforces the RPC's 100-key cap and can fail chosen calls. */
function capConn(markets: Fake[], failCall?: (callIndex: number) => boolean) {
  const byAddr = new Map(markets.map((m) => [m.addr, m]));
  const calls: number[] = [];
  return {
    calls,
    conn: {
      async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
        const idx = calls.length;
        calls.push(pks.length);
        if (pks.length > 100) throw new Error("Too many inputs provided; max 100");
        if (failCall?.(idx)) throw new Error("429 rate limited");
        return pks.map((pk) => ({ data: bytesFor(byAddr.get(pk.toBase58())!) }));
      },
    },
  };
}
const push = (m: Fake) => ({ marketAddress: m.addr, assetIndex: 0, priceE6: 1_000_000n });

describe("generation read is chunked at 100 keys", () => {
  for (const n of [100, 101, 250]) {
    it(`${n} markets: no call exceeds 100 keys; order + address->result mapping preserved`, async () => {
      const ms = fakeMarkets(n);
      const c = capConn(ms);
      const out = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set());
      assert.ok(Math.max(...c.calls) <= 100, `max keys per call ${Math.max(...c.calls)}`);
      assert.equal(c.calls.reduce((a, b) => a + b, 0), n, "every key read exactly once");
      assert.equal(c.calls.length, Math.ceil(n / 100));
      assert.equal(out.size, n);
      for (const m of ms) assert.equal(out.get(`${m.addr}:0`)?.marketId, m.id, "result belongs to ITS market");
    });
  }

  it("a failing chunk affects only its own markets; the others still get fields", async () => {
    const ms = fakeMarkets(250);
    const c = capConn(ms, (i) => i === 1); // second chunk = markets 100..199
    const out = await fetchPushAuthMarkGenerationFields(c.conn as never, ms.map(push), new Set());
    ms.forEach((m, i) => {
      const got = out.get(`${m.addr}:0`);
      if (i >= 100 && i < 200) assert.equal(got, undefined, "failed chunk -> skipped, never stale/guessed");
      else assert.equal(got?.marketId, m.id);
    });
    assert.equal(out.size, 150);
  });

  it("pushAuthMarkBatch with 101 live markets does not throw and pushes all of them", async () => {
    resetTerminalPushLogForTests();
    const ms = fakeMarkets(101);
    const c = capConn(ms);
    const sent: number[] = [];
    const conn = { ...c.conn, async simulateTransaction() { return { value: { err: null } }; }, async sendRawTransaction() { sent.push(1); return "sig"; } };
    const out = await pushAuthMarkBatch(conn as never, Keypair.generate(), ms.map(push), 100n, BLOCKHASH, false);
    assert.equal(out.pushedMarkets.length, 101);
    assert.ok(Math.max(...c.calls) <= 100);
  });

  it("pushAuthMarkBatch: one failed chunk skips only its markets, the rest push", async () => {
    resetTerminalPushLogForTests();
    const ms = fakeMarkets(150);
    const c = capConn(ms, (i) => i === 1); // markets 100..149 unreadable
    const conn = { ...c.conn, async simulateTransaction() { return { value: { err: null } }; }, async sendRawTransaction() { return "sig"; } };
    const out = await pushAuthMarkBatch(conn as never, Keypair.generate(), ms.map(push), 100n, BLOCKHASH, false);
    assert.equal(out.pushedMarkets.length, 100);
    assert.deepEqual(new Set(out.skippedMarkets), new Set(ms.slice(100).map((m) => m.addr)));
  });
});

describe("getMultipleAccountsInfoChunked", () => {
  it("bounds concurrency and reports failures with undefined (unknown) distinct from null (absent)", async () => {
    let live = 0, maxLive = 0, n = 0;
    const conn = {
      async getMultipleAccountsInfo(pks: unknown[]) {
        const me = n++;
        live++; maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        if (me === 2) throw new Error("boom");
        return pks.map(() => null);
      },
    };
    const keys = Array.from({ length: 1000 }, () => Keypair.generate().publicKey);
    const r = await getMultipleAccountsInfoChunked(conn as never, keys, "processed", { concurrency: 3 });
    assert.equal(r.totalChunks, 10);
    assert.equal(r.failedChunks, 1);
    assert.equal(r.failedKeys, 100);
    assert.ok(maxLive <= 3);
    assert.equal(r.infos.filter((i) => i === undefined).length, 100);
    assert.equal(r.infos.filter((i) => i === null).length, 900);
  });
});
