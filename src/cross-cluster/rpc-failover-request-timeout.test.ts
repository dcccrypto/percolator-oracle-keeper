// The per-attempt request deadline in RpcFailover.doFetch, through Node's real fetch against local JSON-RPC servers, so the
// signal / body interaction is undici's own. Deadline 300 ms (1 s where a slow answer must survive it); every wait on a
// possible hang is raced against 2 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Connection, PublicKey } from "@solana/web3.js";
import { RpcFailover, GENESIS_HASH } from "../rpc-failover.ts";

/** What a server does with one JSON-RPC method: answer (default), never answer, stall after headers, answer slowly, or HTTP 500. */
type Behaviour = "hole" | "stall-body" | "slow-body" | "slow-headers" | "500";
const BLOCKHASH = "11111111111111111111111111111111";

async function server(name: string, hits: string[], behave: (method: string) => Behaviour | undefined = () => undefined) {
  const t0 = Date.now();
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}") as { id: number; method: string };
      hits.push(`${name}:${b.method}`);
      const how = behave(b.method);
      if (how === "hole") return; // accept, never answer
      if (how === "500") return void res.writeHead(500, { "Content-Type": "text/plain" }).end("Internal server error");
      const slot = 1_000_000 + Math.floor((Date.now() - t0) / 400);
      const result =
        b.method === "getGenesisHash" ? GENESIS_HASH.devnet
        : b.method === "getSlot" ? slot
        : b.method === "getBlockTime" ? Math.floor(Date.now() / 1000) - 8
        : b.method === "getRecentPerformanceSamples" ? [{ numSlots: 150, samplePeriodSecs: 60 }]
        : b.method === "getLatestBlockhash" ? { context: { slot }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 10 } }
        : `from-${name}`;
      const text = JSON.stringify({ jsonrpc: "2.0", id: b.id, result });
      const head = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) };
      if (how === "slow-headers") return void setTimeout(() => res.writeHead(200, head).end(text), 150);
      if (how === "stall-body" || how === "slow-body") {
        res.writeHead(200, head);
        res.write(text.slice(0, 5));
        if (how === "slow-body") setTimeout(() => res.end(text.slice(5)), 150);
        return;
      }
      res.writeHead(200, head).end(text);
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, close: () => { s.closeAllConnections(); s.close(); } };
}

const init = (method: string, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  ...(signal ? { signal } : {}),
});
const within = <T>(p: Promise<T>, ms = 2_000): Promise<T | "still pending"> =>
  Promise.race([p, new Promise<"still pending">((r) => setTimeout(() => r("still pending"), ms))]);
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

async function pair(
  behaveP: (method: string) => Behaviour | undefined,
  requestTimeoutMs = 300,
  log: (l: string) => void = () => {},
  behaveF: (method: string) => Behaviour | undefined = () => undefined,
) {
  const hits: string[] = [];
  const P = await server("P", hits, behaveP);
  const F = await server("F", hits, behaveF);
  const f = new RpcFailover({ cluster: "devnet", urls: [P.url, F.url], log, requestTimeoutMs });
  return { f, hits, P, F, close: () => { P.close(); F.close(); } };
}

test("request deadline: a send the active endpoint never answers goes to the fallback, and status polls follow it", async () => {
  const { f, hits, P, close } = await pair((m) => (m === "sendTransaction" ? "hole" : undefined));
  try {
    const r = await within(f.fetch(P.url, init("sendTransaction")).then((x) => x.text()));
    assert.match(String(r), /from-F/, `got ${String(r)} | ${hits.join(" ")}`);
    assert.ok(hits.includes("P:sendTransaction"));
    assert.equal(f.snapshot().endpoints[0].consecutiveFailures, 1); // one timeout is not an outage
    const poll = await within(f.fetch(P.url, init("getSignatureStatuses")).then((x) => x.text()));
    assert.match(String(poll), /from-F/);
  } finally {
    close();
  }
});

test("request deadline: web3.js getLatestBlockhash is served by the fallback when the active endpoint never answers", async () => {
  const { f, P, close } = await pair((m) => (m === "getLatestBlockhash" ? "hole" : undefined));
  try {
    const conn = new Connection(P.url, { commitment: "confirmed", fetch: f.fetch });
    const r = await within(conn.getLatestBlockhash("confirmed"));
    assert.notEqual(r, "still pending");
    assert.equal((r as { blockhash: string }).blockhash, BLOCKHASH);
  } finally {
    close();
  }
});

test("request deadline: a body that stops after the headers is cut at the deadline, not at undici's 300 s", async () => {
  const { f, P, close } = await pair((m) => (m === "getBalance" ? "stall-body" : undefined));
  try {
    const res = await f.fetch(P.url, init("getBalance")); // headers arrived: web3.js would now read the body itself
    const r = await within(settle(res.text()));
    assert.notEqual(r, "still pending");
    assert.equal(r !== "still pending" && !r.ok && (r.e as Error).name, "TimeoutError");
  } finally {
    close();
  }
});

test("request deadline: a body that finishes inside the deadline is read in full", async () => {
  const { f, hits, P, close } = await pair((m) => (m === "getBalance" ? "slow-body" : undefined), 1_000);
  try {
    assert.match(await (await f.fetch(P.url, init("getBalance"))).text(), /from-P/);
    assert.ok(!hits.includes("F:getBalance"));
  } finally {
    close();
  }
});

test("request deadline: a slow answer inside the deadline stays on the active endpoint and counts nothing", async () => {
  const { f, hits, P, close } = await pair((m) => (m === "getProgramAccounts" ? "slow-headers" : undefined), 1_000);
  try {
    assert.match(await (await f.fetch(P.url, init("getProgramAccounts"))).text(), /from-P/);
    assert.ok(!hits.includes("F:getProgramAccounts"));
    assert.equal(f.snapshot().endpoints[0].consecutiveFailures, 0);
    assert.equal(f.snapshot().activeIndex, 0);
  } finally {
    close();
  }
});

test("request deadline: the caller's own abort is rethrown, not retried on the fallback, not counted", async () => {
  const { f, hits, P, close } = await pair((m) => (m === "getBalance" ? "hole" : undefined), 5_000);
  try {
    const r = await within(settle(f.fetch(P.url, init("getBalance", AbortSignal.timeout(200)))));
    assert.notEqual(r, "still pending");
    assert.ok(r !== "still pending" && !r.ok, "the caller cancelled: the call must reject");
    assert.ok(!hits.includes("F:getBalance"), hits.join(" "));
    assert.equal(f.snapshot().endpoints[0].consecutiveFailures, 0);
    assert.equal(f.snapshot().activeIndex, 0);
  } finally {
    close();
  }
});

test("request deadline: a 500 kept while the next endpoint times out still reaches the caller as a 500, body readable", async () => {
  const { f, P, close } = await pair((m) => (m === "getBalance" ? "500" : undefined), 300, () => {}, (m) => (m === "getBalance" ? "hole" : undefined));
  try {
    const res = await within(f.fetch(P.url, init("getBalance")));
    assert.notEqual(res, "still pending");
    assert.equal((res as Response).status, 500);
    const body = await within(settle((res as Response).text()));
    assert.deepEqual(body, { ok: true, v: "Internal server error" });
    // what web3.js reports for the same call: the 500, not a timeout (a timeout would hide it from 5xx-aware retries)
    const conn = new Connection(P.url, { commitment: "confirmed", fetch: f.fetch });
    const r = await within(settle(conn.getBalance(new PublicKey(GENESIS_HASH.devnet))));
    assert.ok(r !== "still pending" && !r.ok);
    assert.match(String((r as { e: unknown }).e), /500/);
    assert.doesNotMatch(String((r as { e: unknown }).e), /timeout/i);
  } finally {
    close();
  }
});

test("request deadline: ten requests timing out together mark the endpoint down once, with the base cooldown", async () => {
  const lines: string[] = [];
  const { f, P, close } = await pair((m) => (m === "getBalance" ? "hole" : undefined), 300, (l) => lines.push(l));
  try {
    await f.fetch(P.url, init("getSlot")); // vet both endpoints first
    const r = await within(Promise.all(Array.from({ length: 10 }, () => f.fetch(P.url, init("getBalance")).then((x) => x.text()))));
    assert.notEqual(r, "still pending");
    for (const t of r as string[]) assert.match(t, /from-F/);
    const downs = lines.filter((l) => /endpoint #0 .* DOWN/.test(l));
    assert.equal(downs.length, 1, downs.join("\n"));
    assert.match(downs[0], /retry in 2s/);
    assert.ok(f.snapshot().endpoints[0].downForMs <= 2_000);
  } finally {
    close();
  }
});
