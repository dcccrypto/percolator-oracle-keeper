import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { getMultipleAccountsInfoChunked, MAX_ACCOUNTS_PER_RPC } from "./rpc-chunk.js";

const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);
const acct = (i: number) => ({ lamports: i, data: Buffer.alloc(0), owner: keys(1)[0], executable: false }) as any;

function conn(fail: (call: number) => boolean = () => false) {
  const sizes: number[] = [];
  return {
    sizes,
    getMultipleAccountsInfo: async (ks: any[]) => {
      const call = sizes.length;
      sizes.push(ks.length);
      if (fail(call)) throw new Error("rpc down");
      return ks.map((_, i) => acct(call * 1000 + i));
    },
  };
}

test("chunks at 100, preserves order, reports totals", async () => {
  const c = conn();
  const r = await getMultipleAccountsInfoChunked(c as any, keys(250), "confirmed");
  assert.deepEqual(c.sizes.sort(), [100, 100, 50]);
  assert.equal(r.totalChunks, 3);
  assert.equal(r.failedChunks, 0);
  assert.equal(r.infos.length, 250);
  assert.ok(r.infos.every((x) => x !== undefined));
});

test("chunkSize above the RPC cap is clamped", async () => {
  const c = conn();
  await getMultipleAccountsInfoChunked(c as any, keys(150), "confirmed", { chunkSize: 500 });
  assert.ok(c.sizes.every((s) => s <= MAX_ACCOUNTS_PER_RPC));
});

test("failed chunk isolated: its keys undefined, others intact", async () => {
  const c = conn((n) => n === 1);
  const r = await getMultipleAccountsInfoChunked(c as any, keys(30), "confirmed", { chunkSize: 10, concurrency: 1 });
  assert.equal(r.failedChunks, 1);
  assert.equal(r.failedKeys, 10);
  assert.ok(r.infos.slice(10, 20).every((x) => x === undefined));
  assert.ok(r.infos.slice(0, 10).every((x) => x !== undefined));
  assert.ok(r.infos.slice(20).every((x) => x !== undefined));
});

test("short read counts as failed chunk", async () => {
  const c = { getMultipleAccountsInfo: async () => [null] };
  const r = await getMultipleAccountsInfoChunked(c as any, keys(3), "confirmed");
  assert.equal(r.failedChunks, 1);
  assert.equal(r.failedKeys, 3);
  assert.ok(r.infos.every((x) => x === undefined));
});

test("empty input issues nothing", async () => {
  const c = conn();
  const r = await getMultipleAccountsInfoChunked(c as any, [], "confirmed");
  assert.deepEqual(r, { infos: [], failedChunks: 0, failedKeys: 0, totalChunks: 0 });
  assert.equal(c.sizes.length, 0);
});

test("null (missing account) is preserved distinct from undefined", async () => {
  const c = { getMultipleAccountsInfo: async (ks: any[]) => ks.map(() => null) };
  const r = await getMultipleAccountsInfoChunked(c as any, keys(2), "confirmed");
  assert.deepEqual(r.infos, [null, null]);
});

test("LEAD 4a: NaN chunkSize must not silently return UNKNOWN keys with failedChunks 0", async () => {
  const c = conn();
  const r = await getMultipleAccountsInfoChunked(c as any, keys(5), "confirmed", { chunkSize: NaN });
  assert.ok(r.infos.every((x) => x !== undefined), "all keys resolved");
  assert.equal(r.failedChunks, 0);
});

test("LEAD 4b: NaN concurrency must still fetch every chunk", async () => {
  const c = conn();
  const r = await getMultipleAccountsInfoChunked(c as any, keys(5), "confirmed", { concurrency: NaN });
  assert.ok(r.infos.every((x) => x !== undefined), "all keys resolved");
});
