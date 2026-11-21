import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_HASH,
  RpcFailover,
  isTransientRpcError,
  preflightStampSha,
  redactText,
  redactUrl,
  registerRpcFailover,
  rpcFailoverHealth,
  type FetchLike,
} from "../rpc-failover.ts";

// Scripted transport, no real network: every request goes to `handler`.
const A = "https://a.example.com/";
const B = "https://b.example.com/";
const json = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });

type Handler = (url: string, method: string, n: number) => Response | Promise<Response>;

function mk(handler: Handler, urls: string[], extra: Partial<ConstructorParameters<typeof RpcFailover>[0]> = {}) {
  let t = 1_000_000;
  const counts = new Map<string, number>();
  const base: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    const key = `${url}|${method}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return handler(url, method, n);
  };
  const logs: string[] = [];
  const f = new RpcFailover({ cluster: "devnet", urls, base, now: () => t, log: (l) => logs.push(l), ...extra });
  return { f, logs, tick: (ms: number) => (t += ms), now: () => t };
}

let blockNow = () => 1_000_000;
const healthy: Handler = (_u, m) => {
  if (m === "getGenesisHash") return json(GENESIS_HASH.devnet);
  if (m === "getSlot") return json(5000);
  if (m === "getBlockTime") return json(Math.floor(blockNow() / 1000) - 8);
  if (m === "getRecentPerformanceSamples") return json([{ numSlots: 150, samplePeriodSecs: 60 }]);
  return json("ok");
};

const call = (f: RpcFailover, method = "getBalance") =>
  f.fetch(A, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });

describe("rpc-failover branches: construction and helpers", () => {
  it("requires at least one URL", () => {
    assert.throws(() => new RpcFailover({ cluster: "devnet", urls: [] }), /at least one endpoint/);
  });

  it("defaults: uses the global fetch (stubbed here) and Date.now", async () => {
    const orig = globalThis.fetch;
    const seen: string[] = [];
    blockNow = () => Date.now();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      seen.push(`${String(input)}|${method}`);
      return healthy(String(input), method, 1);
    }) as typeof fetch;
    try {
      const f = new RpcFailover({ cluster: "devnet", urls: [A], log: () => {} });
      const r = await call(f);
      assert.equal(r.status, 200);
      assert.ok(seen.some((s) => s === `${A}|getBalance`));
    } finally {
      globalThis.fetch = orig;
      blockNow = () => 1_000_000;
    }
  });

  it("redactUrl on garbage never throws; redactText skips non-URL known entries", () => {
    assert.equal(redactUrl("not a url"), "<invalid-url>");
    assert.equal(redactText("boom not-a-url here", ["not-a-url"]), "boom <invalid-url> here");
  });

  it("isTransientRpcError accepts non-Error values", () => {
    assert.equal(isTransientRpcError("503 service unavailable"), true);
    assert.equal(isTransientRpcError({ nope: 1 }), false);
  });

  it("preflightStampSha binds registry, program id and genesis", () => {
    const a = preflightStampSha(new Uint8Array([1, 2]), "prog", "gen");
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, preflightStampSha(new Uint8Array([1, 2]), "prog2", "gen"));
    assert.notEqual(a, preflightStampSha(new Uint8Array([1, 2]), "prog", "gen2"));
    assert.notEqual(a, preflightStampSha(new Uint8Array([1, 3]), "prog", "gen"));
  });

  it("rpcFailoverHealth: degraded only when a registered failover reports rpc-degraded", async () => {
    assert.equal(rpcFailoverHealth().degraded, false); // empty registry
    const ok = mk(healthy, [A]);
    await call(ok.f);
    registerRpcFailover("branches-test-ok", ok.f);
    assert.equal(rpcFailoverHealth().degraded, false);
    // NB: the registry has no unregister; entries persist for the rest of this file (own process under node --test)
    const down = mk(() => new Response("nope", { status: 429 }), [A]);
    await call(down.f).catch(() => {});
    registerRpcFailover("branches-test-down", down.f);
    const h = rpcFailoverHealth();
    assert.equal(h.degraded, true);
    assert.ok("branches-test-down" in (h.fields.rpcFailover as Record<string, unknown>));
  });
});

describe("rpc-failover branches: probe failures", () => {
  it("non-200 probe whose body cannot be read still records the HTTP status", async () => {
    const bad = {
      status: 503,
      text: () => Promise.reject(new Error("body stream broke")),
      json: () => Promise.reject(new Error("no")),
    } as unknown as Response;
    const { f } = mk((u, m, n) => (u === A ? bad : healthy(u, m, n)), [A, B]);
    const r = await call(f);
    assert.equal(r.status, 200);
    const e = f.snapshot().endpoints[0];
    assert.equal(e.state, "down");
    assert.match(e.lastError ?? "", /HTTP 503/);
  });

  it("getSlot returning a non-number marks the endpoint down and the fallback serves", async () => {
    const { f } = mk((u, m, n) => (u === A && m === "getSlot" ? json("not-a-slot") : healthy(u, m, n)), [A, B]);
    const r = await call(f);
    assert.equal(r.status, 200);
    const s = f.snapshot();
    assert.equal(s.endpoints[0].state, "down");
    assert.match(s.endpoints[0].lastError ?? "", /no slot/);
    assert.equal(s.activeIndex, 1);
  });

  it("JSON-RPC error on the probe is reported as an rpc error", async () => {
    const { f } = mk(
      (u, m, n) => (u === A && m === "getSlot" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), { status: 200 }) : healthy(u, m, n)),
      [A, B],
    );
    await call(f);
    assert.match(f.snapshot().endpoints[0].lastError ?? "", /rpc error: unknown/);
  });
});

describe("rpc-failover branches: all down, recovery, non-retryable", () => {
  it("all endpoints down: fails fast with rpc-degraded, then recovers after the cooldown", async () => {
    let up = false;
    const { f, tick } = mk((u, m, n) => (up ? healthy(u, m, n) : new Response("slow down", { status: 429 })), [A, B], {
      backoffBaseMs: 1000,
      primaryRetryMs: 1000,
    });
    await assert.rejects(call(f), /rpc-degraded/);
    assert.equal(f.snapshot().reason, "all-endpoints-down");
    await assert.rejects(call(f), /rpc-degraded/); // cooldown: still fails fast
    up = true;
    tick(60_000);
    const r3 = await call(f);
    assert.equal(r3.status, 200);
    assert.equal(f.snapshot().status, "ok");
  });

  it("all endpoints down by network error throws rpc-degraded with a redacted last error", async () => {
    const { f } = mk(() => Promise.reject(new Error("ECONNRESET https://a.example.com/?api-key=SECRETSECRET123")), [A, B]);
    await assert.rejects(call(f), (e: Error) => {
      assert.match(e.message, /rpc-degraded: all devnet RPC endpoints are down/);
      assert.ok(!e.message.includes("SECRETSECRET123"));
      assert.equal(isTransientRpcError(e), true);
      return true;
    });
  });

  it("a 400 from a healthy endpoint is returned as-is (not retryable, no failover)", async () => {
    const { f } = mk((u, m, n) => (m === "getBalance" ? new Response("bad request", { status: 400 }) : healthy(u, m, n)), [A, B]);
    const r = await call(f);
    assert.equal(r.status, 400);
    assert.equal(f.snapshot().activeIndex, 0);
  });

  it("402 whose body cannot be read is not mistaken for quota; 403 without quota text is an auth failure", async () => {
    class Unreadable extends Response {
      override clone(): Response {
        throw new Error("cannot clone");
      }
    }
    const { f } = mk((u, m, n) => (u === A && m === "getBalance" ? new Unreadable("x", { status: 402 }) : healthy(u, m, n)), [A, B]);
    const r = await call(f);
    assert.equal(r.status, 402);
    assert.equal(f.snapshot().activeIndex, 0);
    assert.equal(f.snapshot().endpoints[0].state, "ok");
    const g = mk((u, m, n) => (u === A && m === "getBalance" ? new Response("forbidden", { status: 403 }) : healthy(u, m, n)), [A, B]);
    assert.equal((await call(g.f)).status, 200);
    assert.match(g.f.snapshot().endpoints[0].lastError ?? "", /403|auth/i);
  });

  it("a 502 fails over; a blockhash reply that is not JSON is passed through unjudged", async () => {
    const { f } = mk((u, m, n) => (u === A && m === "getBalance" ? new Response("oops", { status: 502 }) : healthy(u, m, n)), [A, B]);
    assert.equal((await call(f)).status, 200);
    const bh = mk((u, m, n) => (m === "getLatestBlockhash" ? new Response("<html>not json</html>", { status: 200 }) : healthy(u, m, n)), [A, B]);
    const r = await call(bh.f, "getLatestBlockhash");
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "<html>not json</html>");
  });

  it("a blockhash reply without a numeric context slot is passed through unjudged", async () => {
    const { f } = mk((u, m, n) => (m === "getLatestBlockhash" ? json({ value: { blockhash: "x" } }) : healthy(u, m, n)), [A, B]);
    const r = await call(f, "getLatestBlockhash");
    assert.equal(r.status, 200);
  });
});

describe("rpc-failover branches: chain speed measurement", () => {
  it("malformed or empty performance samples leave the rate unmeasured", async () => {
    const samples: unknown[] = [
      "not-an-array",
      [{ numSlots: "x", samplePeriodSecs: 60 }, { numSlots: 10, samplePeriodSecs: 0 }, null],
      [],
    ];
    for (const s of samples) {
      const { f } = mk((u, m, n) => (m === "getRecentPerformanceSamples" ? json(s) : healthy(u, m, n)), [A, B]);
      await call(f);
      assert.equal(f.snapshot().slotRate.measured, null);
    }
  });

  it("a failing samples call leaves the rate unmeasured, and a measured rate is not re-measured before the refresh age", async () => {
    let sampleCalls = 0;
    const { f, tick } = mk(
      (u, m, n) => {
        if (m === "getRecentPerformanceSamples") {
          sampleCalls++;
          return json([{ numSlots: 150, samplePeriodSecs: 60 }]);
        }
        return healthy(u, m, n);
      },
      [A, B],
      { slotCheckIntervalMs: 1000 },
    );
    await call(f);
    const first = sampleCalls;
    tick(2000);
    await call(f);
    assert.ok(first > 0);
    assert.equal(sampleCalls, first, "no re-measure inside rateRefreshMs");
    assert.equal(f.snapshot().slotRate.measured, 2.5);

    const err = mk((u, m, n) => (m === "getRecentPerformanceSamples" ? new Response("no", { status: 500 }) : healthy(u, m, n)), [A, B]);
    await call(err.f);
    assert.equal(err.f.snapshot().slotRate.measured, null);
  });
});
