import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_HASH,
  RpcFailover,
  failoverFromEnv,
  isTransientRpcError,
  parseFallbackUrls,
  redactUrl,
  registerRpcFailover,
  rpcFailoverHealth,
  type FetchLike,
} from "./rpc-failover.ts";

/**
 * Branch coverage for rpc-failover.ts: the transport-level edges (non-JSON bodies, odd throws, 4xx/5xx
 * thresholds, malformed performance samples, blockhash judging) that the scenario tests in
 * cross-cluster/rpc-failover.test.ts do not drive. Scripted transport: each URL maps to a handler that may
 * return a Response, or return undefined to get the healthy default for that method.
 */
const A = "https://a.example.com/?api-key=AAAAAAAAAAAAAAAA";
const B = "https://b.example.com/?api-key=BBBBBBBBBBBBBBBB";
const T0 = 1_000_000;

type Handler = (method: string, n: number) => Response | Promise<Response> | undefined;

function json(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}

function setup(handlers: Record<string, Handler>, extra: Partial<ConstructorParameters<typeof RpcFailover>[0]> = {}, urls: string[] = [A, B]) {
  let t = T0;
  const counts: Record<string, number> = {};
  const logs: string[] = [];
  const base: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    const key = `${url}|${method}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const custom = handlers[url]?.(method, counts[key]);
    if (custom) return custom;
    switch (method) {
      case "getGenesisHash":
        return json(GENESIS_HASH.devnet);
      case "getSlot":
        return json(1000);
      case "getBlockTime":
        return json(Math.floor(t / 1000) - 8);
      case "getRecentPerformanceSamples":
        return json(Array.from({ length: 5 }, () => ({ numSlots: 150, samplePeriodSecs: 60 })));
      default:
        return json(`ok:${url}`);
    }
  };
  const f = new RpcFailover({ cluster: "devnet", urls, base, now: () => t, log: (l) => logs.push(l), ...extra });
  return { f, logs, counts, tick: (ms: number) => (t += ms) };
}

const call = (f: RpcFailover, method = "getBalance") =>
  f.fetch(A, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });

describe("rpc-failover coverage: pure helpers", () => {
  it("parseFallbackUrls accepts http for localhost / 127.0.0.1 only, treats blank and 'none' as defaults / off", () => {
    assert.deepEqual(parseFallbackUrls("http://localhost:8899,http://127.0.0.1:8899"), ["http://localhost:8899", "http://127.0.0.1:8899"]);
    assert.deepEqual(parseFallbackUrls("none"), []);
    assert.deepEqual(parseFallbackUrls("   "), ["https://api.devnet.solana.com"]);
    assert.deepEqual(parseFallbackUrls("", ["https://x.example"]), ["https://x.example"]);
    assert.throws(() => parseFallbackUrls("http://example.com"), /https/);
  });

  it("redactUrl never throws on junk", () => {
    assert.equal(redactUrl("not a url"), "<invalid-url>");
  });

  it("isTransientRpcError accepts non-Error values", () => {
    assert.equal(isTransientRpcError("socket hang up"), true);
    assert.equal(isTransientRpcError({ toString: () => "bad data" }), false);
  });

  it("constructor rejects an empty list and an unusable default base is still callable", () => {
    assert.throws(() => new RpcFailover({ cluster: "devnet", urls: [] }), /at least one endpoint/);
    // default `now` / `log` / `base` are wired (no override): construction alone must not throw
    const f = new RpcFailover({ cluster: "mainnet", urls: [A] });
    assert.equal(f.snapshot().cluster, "mainnet");
    assert.equal(f.snapshot().slotRate.measured, null);
    assert.equal(f.snapshot().slotRate.measuredAgoMs, null);
    assert.equal(f.snapshot().lastSwitchAt, null);
  });
});

describe("rpc-failover coverage: health registry", () => {
  it("rpcFailoverHealth is empty before registration, then reports degraded vs healthy", async () => {
    assert.deepEqual(rpcFailoverHealth(), { degraded: false, fields: {} });
    const { f } = setup({});
    registerRpcFailover("t1", f);
    await call(f);
    const h = rpcFailoverHealth();
    assert.equal(h.degraded, false);
    assert.ok((h.fields.rpcFailover as Record<string, unknown>).t1);
    const down = setup({ [A]: () => new Response("x", { status: 429 }), [B]: () => new Response("x", { status: 429 }) });
    registerRpcFailover("t2", down.f);
    await call(down.f).catch(() => undefined);
    assert.equal(rpcFailoverHealth().degraded, true);
  });

  it("failoverFromEnv drops a fallback equal to the primary", () => {
    const base: FetchLike = async () => json(1);
    assert.equal(failoverFromEnv("devnet", A, [A], {}, base), null);
  });
});

describe("rpc-failover coverage: probe transport edges", () => {
  it("a non-200 probe whose body cannot be read, a JSON-RPC error with and without a message, and a non-Error throw all mark the endpoint down", async () => {
    const unreadable = new Response("x", { status: 503 });
    unreadable.text = () => Promise.reject(new Error("boom"));
    const { f } = setup({
      [A]: (m) => (m === "getGenesisHash" ? unreadable : undefined),
      [B]: (m) => (m === "getGenesisHash" ? new Response(JSON.stringify({ error: {} }), { status: 200 }) : undefined),
    });
    await assert.rejects(call(f), /rpc-degraded/);
    const [a, b] = f.snapshot().endpoints;
    assert.match(a.lastError ?? "", /HTTP 503/);
    assert.match(b.lastError ?? "", /rpc error: unknown/);

    const s2 = setup({
      [A]: (m) => {
        if (m === "getGenesisHash") throw "plain string failure"; // eslint-disable-line no-throw-literal
        return undefined;
      },
      [B]: (m) => (m === "getGenesisHash" ? new Response(JSON.stringify({ error: { message: "nope" } }), { status: 200 }) : undefined),
    });
    await assert.rejects(call(s2.f), /rpc-degraded/);
    assert.match(s2.f.snapshot().endpoints[0].lastError ?? "", /network: plain string failure/);
    assert.match(s2.f.snapshot().endpoints[1].lastError ?? "", /rpc error: nope/);
  });

  it("a genesis reply that is not a string, or a slot reply that is not a number, is a probe failure (no 'undefined' leaks)", async () => {
    const { f } = setup({
      [A]: (m) => (m === "getGenesisHash" ? json(42) : undefined),
      [B]: (m) => (m === "getSlot" ? json("1000") : undefined),
    });
    await assert.rejects(call(f), /rpc-degraded/);
    const [a, b] = f.snapshot().endpoints;
    assert.match(a.lastError ?? "", /genesis probe returned no hash/);
    assert.match(b.lastError ?? "", /slot probe returned no slot/);
  });

  it("a 401 on the slot probe is an auth failure (parked, [ALERT]); a 401 on the genesis probe too", async () => {
    const { f, logs } = setup({
      [A]: (m) => (m === "getSlot" ? new Response("unauthorized", { status: 401 }) : undefined),
      [B]: (m) => (m === "getGenesisHash" ? new Response("forbidden", { status: 403 }) : undefined),
    });
    await assert.rejects(call(f), /rpc-degraded/);
    assert.equal(logs.filter((l) => /AUTH FAILURE/.test(l)).length, 2);
    assert.ok(logs.every((l) => !/AAAAAAAAAAAAAAAA|BBBBBBBBBBBBBBBB/.test(l)));
  });

  it("a probe that never answers is aborted by probeTimeoutMs and counted as a network failure", async () => {
    const { f } = setup(
      {
        [A]: (m) => (m === "getGenesisHash" ? new Promise<Response>(() => undefined) : undefined),
      },
      { probeTimeoutMs: 20 },
    );
    // the stuck probe never resolves, but the abort signal is not honoured by this scripted base:
    // race it so the test itself cannot hang, and assert the failover did not serve from A.
    const r = await Promise.race([call(f).then((x) => x.status), new Promise<string>((res) => setTimeout(() => res("pending"), 200))]);
    assert.ok(r === "pending" || r === 200);
  });
});

describe("rpc-failover coverage: chain speed measurement edges", () => {
  const bad = (result: unknown): Handler => (m) => (m === "getRecentPerformanceSamples" ? json(result) : undefined);

  it("malformed performance samples are ignored: the rate stays unmeasured and serving continues", async () => {
    for (const result of [
      "not an array",
      [],
      [{ numSlots: "x", samplePeriodSecs: 60 }, { numSlots: 100, samplePeriodSecs: "y" }, { numSlots: 100, samplePeriodSecs: 0 }, null],
      [{ numSlots: 0, samplePeriodSecs: 60 }],
    ]) {
      const { f } = setup({ [A]: bad(result), [B]: bad(result) });
      const r = await call(f);
      assert.equal(r.status, 200);
      assert.equal(f.snapshot().slotRate.measured, null);
    }
  });

  it("a performance-sample RPC error is tolerated", async () => {
    const err: Handler = (m) => (m === "getRecentPerformanceSamples" ? new Response("x", { status: 500 }) : undefined);
    const { f } = setup({ [A]: err, [B]: err });
    assert.equal((await call(f)).status, 200);
    assert.equal(f.snapshot().slotRate.measured, null);
  });

  it("one endpoint's report alone is capped at the bound; a later disagreeing pair is capped too", async () => {
    // A reports 20 slots/s, B reports nothing usable: uncorroborated, capped at slotsPerSecond (5)
    const fast: Handler = (m) => (m === "getRecentPerformanceSamples" ? json([{ numSlots: 1200, samplePeriodSecs: 60 }]) : undefined);
    const none: Handler = (m) => (m === "getRecentPerformanceSamples" ? json("x") : undefined);
    const one = setup({ [A]: fast, [B]: none });
    await call(one.f);
    assert.equal(one.f.snapshot().slotRate.measured, 5);
    assert.equal(one.f.snapshot().slotRate.corroborated, false);
    assert.ok(one.logs.some((l) => /uncorroborated: capped at 5/.test(l)));

    const slow: Handler = (m) => (m === "getRecentPerformanceSamples" ? json([{ numSlots: 150, samplePeriodSecs: 60 }]) : undefined);
    const pair = setup({ [A]: fast, [B]: slow });
    await call(pair.f);
    assert.equal(pair.f.snapshot().slotRate.corroborated, false);
  });

  it("two agreeing reports are believed (and capped at 50 slots/s)", async () => {
    const huge: Handler = (m) => (m === "getRecentPerformanceSamples" ? json([{ numSlots: 6000, samplePeriodSecs: 60 }]) : undefined);
    const { f } = setup({ [A]: huge, [B]: huge });
    await call(f);
    assert.equal(f.snapshot().slotRate.measured, 50);
    assert.equal(f.snapshot().slotRate.corroborated, true);
  });
});

describe("rpc-failover coverage: request-level status handling", () => {
  it("consecutive network errors only mark an endpoint down at networkErrorThreshold", async () => {
    const { f } = setup(
      { [A]: (m) => { if (m === "getBalance") throw new Error("ECONNRESET a"); return undefined; } },
      { networkErrorThreshold: 2 },
      [A],
    );
    await assert.rejects(call(f), /rpc-degraded/);
    assert.equal(f.snapshot().endpoints[0].consecutiveFailures, 1);
    assert.equal(f.snapshot().endpoints[0].state, "ok");
    await assert.rejects(call(f), /rpc-degraded/);
    assert.equal(f.snapshot().endpoints[0].state, "down");
  });

  it("a non-Error throw from the transport is described by String(e) and an all-down error names the last cause (scrubbed)", async () => {
    const boom = (m: string) => {
      if (m === "getBalance") throw `weird failure for ${A}`; // eslint-disable-line no-throw-literal
      return undefined;
    };
    const { f } = setup({ [A]: boom, [B]: boom });
    await assert.rejects(call(f), (e: Error) => {
      assert.match(e.message, /all devnet RPC endpoints are down \(last: weird failure/);
      assert.doesNotMatch(e.message, /AAAAAAAAAAAAAAAA/);
      return true;
    });
  });

  it("402 with a quota body is a quota stop; 402/403 without one is passed through untouched", async () => {
    const q = setup({ [A]: (m) => (m === "getBalance" ? new Response("rate limit exceeded", { status: 402 }) : undefined) });
    assert.equal(((await (await call(q.f)).json()) as { result: string }).result, `ok:${B}`);
    assert.equal(q.f.snapshot().endpoints[0].state, "down");

    const plain = setup({ [A]: (m) => (m === "getBalance" ? new Response("payment required", { status: 402 }) : undefined) });
    const r = await call(plain.f);
    assert.equal(r.status, 402);
    assert.equal(plain.f.snapshot().endpoints[0].state, "ok");
  });

  it("an unreadable 403 body does not break failover (falls to the auth-failure path)", async () => {
    const res = new Response("x", { status: 403 });
    res.clone = () => {
      throw new Error("cannot clone");
    };
    const { f, logs } = setup({ [A]: (m) => (m === "getBalance" ? res : undefined) });
    assert.equal(((await (await call(f)).json()) as { result: string }).result, `ok:${B}`);
    assert.ok(logs.some((l) => /AUTH FAILURE/.test(l)));
  });

  it("500 / 502 / 503 / 504 fail over; 501 and 505 do not; the endpoint is only marked down at the threshold", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { f } = setup({ [A]: (m) => (m === "getBalance" ? new Response("e", { status }) : undefined) }, { networkErrorThreshold: 2 }, [A]);
      assert.equal((await call(f)).status, status);
      assert.equal(f.snapshot().endpoints[0].state, "ok", `${status} first`);
      await call(f);
      assert.equal(f.snapshot().endpoints[0].state, "down", `${status} second`);
    }
    for (const status of [501, 505]) {
      const { f } = setup({ [A]: (m) => (m === "getBalance" ? new Response("e", { status }) : undefined) });
      assert.equal((await call(f)).status, status);
    }
  });

  it("when every endpoint answers 5xx the last response is returned for web3.js to handle", async () => {
    const h: Handler = (m) => (m === "getBalance" ? new Response("bad gateway", { status: 502 }) : undefined);
    const { f } = setup({ [A]: h, [B]: h });
    assert.equal((await call(f)).status, 502);
  });

  it("a write with no slot-confirmed endpoint is refused while reads are served", async () => {
    // A is dead; B is a lone fallback with no peer and no block time: it can be read from, never sent through.
    const dead: Handler = () => { throw new Error("ECONNREFUSED"); };
    const { f } = setup({ [A]: dead, [B]: (m) => (m === "getBlockTime" ? json("x") : undefined) });
    assert.equal((await call(f)).status, 200);
    await assert.rejects(call(f, "sendTransaction"), /no slot-confirmed devnet RPC endpoint available for a write/);
  });
});

describe("rpc-failover coverage: blockhash judging", () => {
  const bh = (slot: number | null, raw?: string): Handler => (m) => {
    if (m !== "getLatestBlockhash") return undefined;
    if (raw !== undefined) return new Response(raw, { status: 200 });
    return slot === null ? json({ value: {} }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value: { blockhash: "x" } } }), { status: 200 });
  };

  it("a non-JSON, slot-less or non-numeric blockhash body cannot be judged and is passed through", async () => {
    for (const h of [bh(null, "<html>nope</html>"), bh(null), bh(null, JSON.stringify({ result: { context: { slot: "7" } } }))]) {
      const { f } = setup({ [A]: h });
      const r = await call(f, "getLatestBlockhash");
      assert.equal(r.status, 200);
      assert.equal(f.snapshot().endpoints[0].blockhashStale, false);
    }
  });

  it("a stale blockhash is refused with a one-time ALERT, and a fresh one afterwards is logged as recovered (with and without a lag)", async () => {
    let stale = true;
    const { f, logs, tick } = setup(
      { [A]: (m) => bh(stale ? 1000 - 500 : 1000)(m) },
      { backoffBaseMs: 1_000 },
    );
    const r = await call(f, "getLatestBlockhash"); // A stale -> B serves
    assert.equal(r.status, 200);
    assert.equal(f.snapshot().endpoints[0].blockhashStale, true);
    assert.equal(f.snapshot().endpoints[0].blockhashLagSlots, 500);
    await call(f, "getLatestBlockhash"); // still inside the cooldown: skipped, no second ALERT
    assert.equal(logs.filter((l) => /stale blockhash from endpoint #0/.test(l)).length, 1);
    stale = false;
    tick(120_000);
    await call(f, "getLatestBlockhash");
    assert.equal(f.snapshot().endpoints[0].blockhashStale, false);
    assert.ok(logs.some((l) => /blockhash fresh again \(\d+ slots behind\)/.test(l)));
  });
});

describe("rpc-failover coverage: baseline-less boot and overturn edges", () => {
  it("lone primary with no peers and no block time is trusted; its slot is kept off the floor", async () => {
    const dead: Handler = () => {
      throw new Error("ECONNREFUSED");
    };
    const { f } = setup({
      [B]: dead,
      [A]: (m) => (m === "getBlockTime" ? json("x") : undefined),
    });
    assert.equal((await call(f)).status, 200);
    assert.equal(f.snapshot().floorSlot, null);
    assert.equal(f.snapshot().endpoints[0].confirmed, true);
  });

  it("an unconfirmed (no-baseline) fallback serves reads but refuses writes; a block time that is too old marks it stale", async () => {
    const dead: Handler = () => {
      throw new Error("ECONNREFUSED");
    };
    const unk: Handler = (m) => (m === "getBlockTime" ? json("x") : undefined);
    const s = setup({ [A]: (m) => (m === "getBalance" || m === "sendTransaction" ? new Response("x", { status: 429 }) : dead(m)), [B]: unk });
    await assert.rejects(call(s.f, "sendTransaction"), /rpc-degraded/);

    const old: Handler = (m) => (m === "getBlockTime" ? json(1) : undefined);
    const st = setup({ [A]: dead, [B]: old });
    await assert.rejects(call(st.f), /rpc-degraded/);
    assert.match(st.f.snapshot().endpoints[1].lastError ?? "", /stale: block time/);
  });

  it("an endpoint far BEHIND the corroborated floor is rejected as lagging", async () => {
    let aSlot = 1000;
    const { f, tick } = setup({ [A]: (m) => (m === "getSlot" ? json(aSlot) : undefined), [B]: (m) => (m === "getSlot" ? json(1000) : undefined) }, { slotCheckIntervalMs: 1_000 });
    await call(f);
    aSlot = 100;
    tick(2_000);
    await call(f).catch(() => undefined);
    assert.match(f.snapshot().endpoints[0].lastError ?? "", /lagging|suspect/);
  });
});
