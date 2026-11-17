import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCachedBlockhash,
  invalidateBlockhash,
  resetBlockhashCache,
  BLOCKHASH_MAX_AGE_MS,
} from "./blockhash-cache.js";

type Res = { blockhash: string; lastValidBlockHeight: number };
function mkConn(endpoint = "http://a") {
  const waiters: Array<(r: Res) => void> = [];
  let calls = 0;
  return {
    rpcEndpoint: endpoint,
    get calls() {
      return calls;
    },
    resolveNext(r: Res) {
      waiters.shift()!(r);
    },
    getLatestBlockhash: () => {
      calls++;
      return new Promise<Res>((res) => waiters.push(res));
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => resetBlockhashCache());

test("caches within maxAge, refetches after", async () => {
  const c = mkConn();
  let t = 1000;
  const p = getCachedBlockhash(c as any, "confirmed", { now: () => t });
  c.resolveNext({ blockhash: "h1", lastValidBlockHeight: 1 });
  assert.equal((await p).blockhash, "h1");
  t += BLOCKHASH_MAX_AGE_MS;
  assert.equal((await getCachedBlockhash(c as any, "confirmed", { now: () => t })).blockhash, "h1");
  assert.equal(c.calls, 1);
  t += 1;
  const p2 = getCachedBlockhash(c as any, "confirmed", { now: () => t });
  c.resolveNext({ blockhash: "h2", lastValidBlockHeight: 2 });
  assert.equal((await p2).blockhash, "h2");
});

test("concurrent misses share one fetch; failure is not cached", async () => {
  const c = {
    rpcEndpoint: "x",
    n: 0,
    getLatestBlockhash() {
      this.n++;
      return Promise.reject(new Error("boom"));
    },
  };
  const a = getCachedBlockhash(c as any, "confirmed");
  const b = getCachedBlockhash(c as any, "confirmed");
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(c.n, 1);
  await assert.rejects(getCachedBlockhash(c as any, "confirmed"));
  assert.equal(c.n, 2);
});

test("LEAD 1: fetch in flight at invalidate must not re-cache a pre-invalidate hash", async () => {
  const c = mkConn();
  const old = getCachedBlockhash(c as any, "confirmed");
  invalidateBlockhash(c as any);
  // caller after the invalidate must get a NEW fetch, not the old in-flight one
  const fresh = getCachedBlockhash(c as any, "confirmed");
  assert.equal(c.calls, 2);
  c.resolveNext({ blockhash: "stale", lastValidBlockHeight: 1 });
  c.resolveNext({ blockhash: "fresh", lastValidBlockHeight: 2 });
  await old;
  assert.equal((await fresh).blockhash, "fresh");
  // the stale landing must not have overwritten the cache
  assert.equal((await getCachedBlockhash(c as any, "confirmed")).blockhash, "fresh");
});

test("LEAD 1b: invalidate with only a stale fetch in flight leaves cache empty", async () => {
  const c = mkConn();
  const old = getCachedBlockhash(c as any, "confirmed");
  invalidateBlockhash(c as any);
  c.resolveNext({ blockhash: "stale", lastValidBlockHeight: 1 });
  await old;
  const next = getCachedBlockhash(c as any, "confirmed");
  await tick();
  assert.equal(c.calls, 2, "stale hash must not be served from cache");
  c.resolveNext({ blockhash: "fresh", lastValidBlockHeight: 2 });
  assert.equal((await next).blockhash, "fresh");
});

test("LEAD 2: age is measured from fetch start, not from when the slow RPC returned", async () => {
  const c = mkConn();
  let t = 0;
  const p = getCachedBlockhash(c as any, "confirmed", { now: () => t });
  t = 14_000; // slow RPC: hash was observed ~14 s ago by the time it lands
  c.resolveNext({ blockhash: "h1", lastValidBlockHeight: 1 });
  await p;
  t = 16_000; // 16 s after fetch start -> older than the 15 s maxAge
  const p2 = getCachedBlockhash(c as any, "confirmed", { now: () => t });
  await tick();
  assert.equal(c.calls, 2, "hash older than maxAge must be refetched");
  c.resolveNext({ blockhash: "h2", lastValidBlockHeight: 2 });
  await p2;
});

test("LEAD 3: smaller-maxAge caller joining an in-flight fetch is fine (not a bug)", async () => {
  // The in-flight fetch started no earlier than this caller's miss, so its result is as fresh
  // as a private fetch would be minus RPC latency. Pin the sharing behaviour.
  const c = mkConn();
  const a = getCachedBlockhash(c as any, "confirmed", { maxAgeMs: 15_000 });
  const b = getCachedBlockhash(c as any, "confirmed", { maxAgeMs: 1 });
  assert.equal(c.calls, 1);
  c.resolveNext({ blockhash: "h", lastValidBlockHeight: 1 });
  assert.equal((await a).blockhash, "h");
  assert.equal((await b).blockhash, "h");
});

test("invalidate only drops the matching endpoint, all commitments", async () => {
  const a = mkConn("http://a");
  const b = mkConn("http://b");
  for (const [c, cm] of [[a, "confirmed"], [a, "finalized"], [b, "confirmed"]] as const) {
    const p = getCachedBlockhash(c as any, cm);
    c.resolveNext({ blockhash: "x", lastValidBlockHeight: 1 });
    await p;
  }
  invalidateBlockhash(a as any);
  await getCachedBlockhash(b as any, "confirmed");
  assert.equal(b.calls, 1);
  const p = getCachedBlockhash(a as any, "confirmed");
  assert.equal(a.calls, 3);
  a.resolveNext({ blockhash: "y", lastValidBlockHeight: 2 });
  await p;
});
