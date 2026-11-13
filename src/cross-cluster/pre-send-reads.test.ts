/**
 * PERF (v22-keep-1113): startPreSendReads — the push cycle's devnet reads (processed slot, cached blockhash, a due
 * wallet-balance read) start together with the mainnet price read instead of serially behind it.
 *
 * Pins: all reads are started immediately and concurrently; the same commitments are used; the balance read follows
 * the same due-rule as before; a rejected read never becomes an unhandledRejection but still throws where awaited.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/pre-send-reads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { startPreSendReads } from "./keeper-loop.ts";
import { invalidateBlockhash } from "./blockhash-cache.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";

type Call = { method: string; arg: unknown; at: number };

function fakeConn(endpoint: string, opts: { slotErr?: Error; delayMs?: number } = {}) {
  const calls: Call[] = [];
  const t0 = Date.now();
  const later = <T>(v: T, err?: Error): Promise<T> =>
    new Promise((res, rej) => setTimeout(() => (err ? rej(err) : res(v)), opts.delayMs ?? 20));
  const conn = {
    rpcEndpoint: endpoint,
    getSlot: (c: unknown) => {
      calls.push({ method: "getSlot", arg: c, at: Date.now() - t0 });
      return later(123, opts.slotErr);
    },
    getLatestBlockhash: (c: unknown) => {
      calls.push({ method: "getLatestBlockhash", arg: c, at: Date.now() - t0 });
      return later({ blockhash: "bh", lastValidBlockHeight: 9 });
    },
    getBalance: (_pk: unknown, c: unknown) => {
      calls.push({ method: "getBalance", arg: c, at: Date.now() - t0 });
      return later(5_000_000_000);
    },
  };
  return { conn: conn as never, calls };
}

describe("startPreSendReads", () => {
  const payer = Keypair.generate().publicKey;

  it("starts the slot, blockhash and due balance reads at once, with the old commitments", async () => {
    const { conn, calls } = fakeConn("http://pre-send-1", { delayMs: 50 });
    const wallet = createWalletBalanceState(); // lastCheckAt 0 -> due
    const r = startPreSendReads(conn, payer, wallet, 60_000, 1_000_000);
    // concurrent: after a few microtask turns (no read has resolved yet: each takes 50 ms) all three are in flight
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(calls.length, 3, "all reads started before any resolved");
    const [slot, bh, lamports] = await Promise.all([r.slot, r.blockhash, r.balance!.lamports]);
    assert.equal(slot, 123);
    assert.deepEqual(bh, { blockhash: "bh", lastValidBlockHeight: 9 });
    assert.equal(lamports, 5_000_000_000);
    assert.equal(r.balance!.nowMs, 1_000_000);
    assert.deepEqual(calls.map((c) => [c.method, c.arg]).sort(), [["getBalance", "confirmed"], ["getLatestBlockhash", "processed"], ["getSlot", "processed"]]);
    invalidateBlockhash(conn);
  });

  it("skips the balance read when it is not due (same rule as shouldRefreshBalance)", async () => {
    const { conn, calls } = fakeConn("http://pre-send-2");
    const wallet = { ...createWalletBalanceState(), lastCheckAt: 1_000_000 - 10_000 };
    const r = startPreSendReads(conn, payer, wallet, 60_000, 1_000_000);
    assert.equal(r.balance, null);
    await Promise.all([r.slot, r.blockhash]);
    assert.ok(!calls.some((c) => c.method === "getBalance"));
    invalidateBlockhash(conn);
  });

  it("a rejected read is not an unhandledRejection when dropped, and still throws when awaited", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const boom = new Error("rpc down");
      const dropped = startPreSendReads(fakeConn("http://pre-send-3", { slotErr: boom }).conn, payer, createWalletBalanceState(), 60_000);
      void dropped; // a cycle that returns early never awaits it
      const awaited = startPreSendReads(fakeConn("http://pre-send-4", { slotErr: boom }).conn, payer, createWalletBalanceState(), 60_000);
      await assert.rejects(awaited.slot, /rpc down/);
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a synchronous throw from the connection becomes a rejection, not a throw out of the cycle's first line", async () => {
    const conn = {
      rpcEndpoint: "http://pre-send-5",
      getSlot: () => {
        throw new Error("sync boom");
      },
      getLatestBlockhash: async () => ({ blockhash: "bh", lastValidBlockHeight: 1 }),
      getBalance: async () => 1,
    } as never;
    const r = startPreSendReads(conn, payer, createWalletBalanceState(), 60_000);
    await assert.rejects(r.slot, /sync boom/);
    invalidateBlockhash(conn);
  });
});
