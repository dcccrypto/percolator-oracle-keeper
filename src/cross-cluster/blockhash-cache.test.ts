import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getCachedBlockhash, invalidateBlockhash, resetBlockhashCache } from "./blockhash-cache.js";

beforeEach(() => resetBlockhashCache());

function conn(fetch: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>) {
  let calls = 0;
  return {
    rpcEndpoint: "http://x",
    getLatestBlockhash: async () => { calls++; return fetch(); },
    get calls() { return calls; },
  } as any;
}
const bh = (s: string) => ({ blockhash: s, lastValidBlockHeight: 1 });

test("lead1: fetch in flight during invalidate does not repopulate cache", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const c = conn(async () => { const id = ++n; if (id === 1) await gate; return bh("h" + id); });
  const first = getCachedBlockhash(c, "confirmed", { now: () => 0 });
  invalidateBlockhash(c);
  release();
  await first;
  const next = await getCachedBlockhash(c, "confirmed", { now: () => 1 });
  assert.equal(next.blockhash, "h2");
});

test("lead1b: caller after invalidate does not join the stale inflight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const c = conn(async () => { const id = ++n; if (id === 1) await gate; return bh("h" + id); });
  const first = getCachedBlockhash(c, "confirmed", { now: () => 0 });
  invalidateBlockhash(c);
  const second = await Promise.race([
    getCachedBlockhash(c, "confirmed", { now: () => 1 }),
    new Promise<any>((r) => setTimeout(() => r({ blockhash: "joined-stale-inflight" }), 200)),
  ]);
  assert.equal(second.blockhash, "h2");
  release();
  await first;
});

test("lead2: backwards clock step is a miss", async () => {
  let n = 0;
  const c = conn(async () => bh("h" + ++n));
  await getCachedBlockhash(c, "confirmed", { now: () => 100_000 });
  const v = await getCachedBlockhash(c, "confirmed", { now: () => 50_000 });
  assert.equal(v.blockhash, "h2");
});

test("lead3: slow fetch is aged from its start", async () => {
  let t = 0;
  let n = 0;
  const c = conn(async () => { t += 14_000; return bh("h" + ++n); });
  await getCachedBlockhash(c, "confirmed", { now: () => t });
  t += 2_000; // 16 s after fetch start
  const v = await getCachedBlockhash(c, "confirmed", { now: () => t });
  assert.equal(v.blockhash, "h2");
});

test("lead4 (not a bug): smaller maxAge joining inflight gets a hash fresher than its bound", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const c = conn(async () => { await gate; return bh("h" + ++n); });
  const a = getCachedBlockhash(c, "confirmed", { now: () => 0 });
  const b = getCachedBlockhash(c, "confirmed", { now: () => 5, maxAgeMs: 1 });
  release();
  assert.equal((await a).blockhash, "h1");
  assert.equal((await b).blockhash, "h1");
  assert.equal(c.calls, 1);
});
