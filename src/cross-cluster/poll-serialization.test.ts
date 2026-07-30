/**
 * pollOnce must never run concurrently.
 *
 * Two independent callers invoke it: the periodic loop and the Supabase
 * Realtime stream, which fires on ANY `markets` row change — and the indexer
 * writes to that table constantly, so overlap is routine, not theoretical.
 *
 * Concurrency corrupts the registry because reconcileMarkets read-modify-writes
 * it: two runs can both observe a market as missing before either pushes
 * (duplicate entry — and a duplicate in the atomic PushAuthMark batch reverts
 * the whole transaction), and both can increment the same absence counter,
 * tripping the 3-strike guard in ~1.5 rounds instead of 3.
 *
 * This measures overlap at a REAL async boundary: a local HTTP server that
 * holds each request open, counting how many are in flight at once. An earlier
 * version of this test stubbed the connection instead and was vacuous — the
 * fetch failed before the stub was ever touched, so it passed with or without
 * the guard.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/poll-serialization.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pollOnce } from "./register-poll.ts";
import type { Registry } from "./registry.ts";

const state = { live: 0, maxLive: 0, requests: 0 };
let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((_req, res) => {
    state.requests++;
    state.live++;
    state.maxLive = Math.max(state.maxLive, state.live);
    // Hold the request open long enough that a genuinely concurrent second
    // poll would be observed here.
    setTimeout(() => {
      state.live--;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]"); // valid PostgREST response: zero active markets
    }, 40);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function cfg() {
  return {
    registryPath: "/tmp/percolator-poll-serialization-test.json",
    db: {
      supabaseUrl: baseUrl,
      supabaseAnonKey: "test",
      network: "devnet",
      mainnetConn: { getMultipleAccountsInfo: async () => [] } as never,
      dexCache: new Map(),
    },
  } as never;
}

describe("pollOnce serialization", () => {
  it("actually reaches the query (guards against a vacuous test)", async () => {
    const registry: Registry = { markets: [] } as never;
    await pollOnce(registry, cfg());
    assert.ok(state.requests > 0, "the poll never issued a query — test proves nothing");
  });

  it("never runs two poll bodies concurrently", async () => {
    state.maxLive = 0;
    const registry: Registry = { markets: [] } as never;
    const c = cfg();
    await Promise.all([
      pollOnce(registry, c),
      pollOnce(registry, c),
      pollOnce(registry, c),
      pollOnce(registry, c),
    ]);
    assert.equal(state.maxLive, 1, `poll bodies overlapped (maxLive=${state.maxLive})`);
  });

  it("coalesces a burst instead of queueing one poll per caller", async () => {
    const before = state.requests;
    const registry: Registry = { markets: [] } as never;
    const c = cfg();
    await Promise.all(Array.from({ length: 6 }, () => pollOnce(registry, c)));
    const issued = state.requests - before;
    // One in-flight run plus at most one queued follow-up.
    assert.ok(issued <= 2, `expected <=2 queries for a burst of 6, got ${issued}`);
  });

  it("leaves no duplicate entries in the registry under a burst", async () => {
    const registry: Registry = { markets: [] } as never;
    const c = cfg();
    await Promise.all(Array.from({ length: 8 }, () => pollOnce(registry, c)));
    const addrs = registry.markets.map((m) => m.marketAddress);
    assert.equal(new Set(addrs).size, addrs.length, "duplicate entries in registry");
  });
});
