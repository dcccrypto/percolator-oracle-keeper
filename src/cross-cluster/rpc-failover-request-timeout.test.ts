// The per-attempt request deadline in RpcFailover.doFetch, through Node's real fetch against local JSON-RPC servers, so the
// signal / body interaction is undici's own. Deadline 300 ms (1 s where a slow answer must survive it); every wait on a
// possible hang is raced against 2 s. Where a hang on the active endpoint must fail over, the test fires the deadlines
// itself (manualDeadlines): on a loaded machine a real 300 ms one also expired on the fallback's own answer, and the
// fallback then "failed" too. Those tests race against 10 s instead: no deadline is real there, so it only catches a hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Connection, PublicKey } from "@solana/web3.js";
import { RpcFailover, GENESIS_HASH, type RpcFailoverOptions } from "../rpc-failover.ts";

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
/** Resolves once `ok()` holds (polled); race it with `within`. */
const until = async (ok: () => boolean): Promise<void> => {
  while (!ok()) await new Promise((r) => setTimeout(r, 5));
};
/** Request deadlines the test fires itself: none expires until `fire`, which expires them as AbortSignal.timeout would. */
function manualDeadlines() {
  const made: Array<{ ms: number; ctl: AbortController }> = [];
  return {
    made,
    requestDeadline: (ms: number): AbortSignal => {
      const ctl = new AbortController();
      made.push({ ms, ctl });
      return ctl.signal;
    },
    /** Expire every deadline made so far (call it while only the hung attempts are in flight). */
    fire: () => {
      for (const d of made) if (!d.ctl.signal.aborted) d.ctl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    },
  };
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

async function pair(
  behaveP: (method: string) => Behaviour | undefined,
  requestTimeoutMs = 300,
  log: (l: string) => void = () => {},
  behaveF: (method: string) => Behaviour | undefined = () => undefined,
  extra: Partial<RpcFailoverOptions> = {},
) {
  const hits: string[] = [];
  const P = await server("P", hits, behaveP);
  const F = await server("F", hits, behaveF);
  const f = new RpcFailover({ cluster: "devnet", urls: [P.url, F.url], log, requestTimeoutMs, ...extra });
  return { f, hits, P, F, close: () => { P.close(); F.close(); } };
}

test("request deadline: a send the active endpoint never answers goes to the fallback, and status polls follow it", async () => {
  const dl = manualDeadlines();
  const { f, hits, P, close } = await pair((m) => (m === "sendTransaction" ? "hole" : undefined), 300, () => {}, undefined, { requestDeadline: dl.requestDeadline });
  try {
    const sent = f.fetch(P.url, init("sendTransaction")).then((x) => x.text());
    assert.notEqual(await within(until(() => hits.includes("P:sendTransaction")), 10_000), "still pending", hits.join(" "));
    dl.fire(); // P holds the send: its deadline expires
    const r = await within(sent, 10_000);
    assert.match(String(r), /from-F/, `got ${String(r)} | ${hits.join(" ")}`);
    assert.ok(hits.includes("P:sendTransaction"));
    assert.equal(f.snapshot().endpoints[0].consecutiveFailures, 1); // one timeout is not an outage
    const poll = await within(f.fetch(P.url, init("getSignatureStatuses")).then((x) => x.text()), 10_000);
    assert.match(String(poll), /from-F/);
    assert.ok(dl.made.every((d) => d.ms === 300), "every attempt got the configured deadline");
  } finally {
    close();
  }
});

test("request deadline: web3.js getLatestBlockhash is served by the fallback when the active endpoint never answers", async () => {
  const dl = manualDeadlines();
  const { f, hits, P, close } = await pair((m) => (m === "getLatestBlockhash" ? "hole" : undefined), 300, () => {}, undefined, { requestDeadline: dl.requestDeadline });
  try {
    const conn = new Connection(P.url, { commitment: "confirmed", fetch: f.fetch });
    const got = conn.getLatestBlockhash("confirmed");
    assert.notEqual(await within(until(() => hits.includes("P:getLatestBlockhash")), 10_000), "still pending", hits.join(" "));
    dl.fire(); // P holds the request: its deadline expires
    const r = await within(got, 10_000);
    assert.notEqual(r, "still pending");
    assert.equal((r as { blockhash: string }).blockhash, BLOCKHASH);
    assert.ok(dl.made.every((d) => d.ms === 300), "every attempt got the configured deadline");
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
  const dl = manualDeadlines();
  let frozenAt: number | null = null; // the keeper clock stops while the ten time out: none of them can outlive the cooldown
  const { f, hits, P, close } = await pair((m) => (m === "getBalance" ? "hole" : undefined), 300, (l) => lines.push(l), undefined, {
    requestDeadline: dl.requestDeadline,
    now: () => frozenAt ?? Date.now(),
  });
  try {
    await f.fetch(P.url, init("getSlot")); // vet both endpoints first
    const all = Promise.all(Array.from({ length: 10 }, () => f.fetch(P.url, init("getBalance")).then((x) => x.text())));
    const held = () => hits.filter((h) => h === "P:getBalance").length;
    assert.notEqual(await within(until(() => held() === 10), 10_000), "still pending", hits.join(" "));
    assert.equal(dl.made.length, 11); // the getSlot (answered) + the ten P holds; nothing else in flight
    frozenAt = Date.now();
    dl.fire(); // all ten deadlines expire together
    const r = await within(all, 10_000);
    assert.notEqual(r, "still pending");
    for (const t of r as string[]) assert.match(t, /from-F/);
    const downs = lines.filter((l) => /endpoint #0 .* DOWN/.test(l));
    assert.equal(downs.length, 1, downs.join("\n"));
    assert.match(downs[0], /retry in 2s/);
    assert.equal(f.snapshot().endpoints[0].downForMs, 2_000);
    assert.ok(dl.made.every((d) => d.ms === 300), "every attempt got the configured deadline");
  } finally {
    close();
  }
});
