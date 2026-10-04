import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTickBodies, createTickPublisher, TICK_MAX_PER_REQUEST, type TickInput } from "./tick-publisher.ts";
import { publishLandedTicks } from "./keeper-loop.ts";

const inp = (n: number, oracle: bigint | null = 5n): TickInput => ({
  marketAddress: `M${n}`, assetIndex: n, markE6: 1_234_567n + BigInt(n), oracleE6: oracle,
});
const tick = () => new Promise((r) => setTimeout(r, 5));

test("builder: bigint -> decimal strings, null oracle, slot as number", () => {
  const [b] = buildTickBodies([inp(1), inp(2, null), inp(3, 0n)], 99n, 1000, 2000);
  assert.equal(b.v, 1);
  assert.equal(b.src, "keeper");
  assert.equal(b.sentMs, 2000);
  assert.deepEqual(b.ticks[0], { slab: "M1", assetIndex: 1, slot: 99, landedMs: 1000, markE6: "1234568", oracleE6: "5" });
  assert.equal(b.ticks[1].oracleE6, null);
  assert.equal(b.ticks[2].oracleE6, null);
});

test("builder: chunks at 200 and skips non-positive marks", () => {
  const many = Array.from({ length: 450 }, (_, i) => inp(i));
  const bodies = buildTickBodies([...many, { ...inp(999), markE6: 0n }], 1, 1, 1);
  assert.deepEqual(bodies.map((b) => b.ticks.length), [TICK_MAX_PER_REQUEST, TICK_MAX_PER_REQUEST, 50]);
  assert.deepEqual(buildTickBodies([], 1, 1, 1), []);
});

test("publisher: no-op when env unset", async () => {
  let calls = 0;
  const p = createTickPublisher({ url: "", key: "", fetchImpl: (async () => { calls++; return new Response("ok"); }) as typeof fetch });
  p.publish([inp(1)], 1, 1);
  await tick();
  assert.equal(p.enabled, false);
  assert.equal(calls, 0);
  assert.equal(p.counters().sent, 0);
});

test("publisher: posts bearer + body, counts sent", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const p = createTickPublisher({ url: "https://x/ticks", key: "sekrit", fetchImpl: (async (u: string, init: RequestInit) => { seen = { url: u, init }; return new Response("ok"); }) as unknown as typeof fetch });
  p.publish([inp(1), inp(2)], 7n, 10);
  await tick();
  assert.equal(seen!.url, "https://x/ticks");
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h.authorization, "Bearer sekrit");
  assert.equal(h["content-type"], "application/json");
  assert.equal(JSON.parse(seen!.init.body as string).ticks.length, 2);
  assert.equal(p.counters().sent, 2);
  assert.notEqual(p.counters().lastOkMs, null);
});

test("publisher: single in-flight, second batch dropped and counted", async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((r) => (release = r));
  const p = createTickPublisher({ url: "u", key: "k", fetchImpl: (async () => { calls++; await gate; return new Response("ok"); }) as typeof fetch });
  p.publish([inp(1)], 1, 1);
  p.publish([inp(2), inp(3)], 2, 2);
  assert.equal(calls, 1);
  assert.equal(p.counters().dropped, 2);
  release();
  await tick();
  p.publish([inp(4)], 3, 3); // free again
  await tick();
  assert.equal(calls, 2);
});

test("publisher: errors, HTTP failures and timeouts are swallowed, counted, key never logged", async () => {
  const logs: string[] = [];
  let mode = 0;
  const f = (async (_u: string, init: RequestInit) => {
    if (mode === 0) throw new Error("boom sekrit");
    if (mode === 1) return new Response("no", { status: 500 });
    return new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))));
  }) as unknown as typeof fetch;
  let t = 0;
  const p = createTickPublisher({ url: "u", key: "sekrit", timeoutMs: 20, fetchImpl: f, now: () => (t += 61_000), log: (m) => logs.push(m) });
  for (mode = 0; mode < 3; mode++) {
    assert.doesNotThrow(() => p.publish([inp(1)], 1, 1));
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.equal(p.counters().failed, 3);
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l) => !l.includes("sekrit")));
});

test("publisher: log is rate limited to one line per 60s", async () => {
  const logs: string[] = [];
  const p = createTickPublisher({ url: "u", key: "k", now: () => 5, log: (m) => logs.push(m), fetchImpl: (async () => { throw new Error("x"); }) as typeof fetch });
  for (let i = 0; i < 4; i++) { p.publish([inp(1)], 1, 1); await tick(); }
  assert.equal(p.counters().failed, 4);
  assert.ok(logs.length <= 1);
});

test("keeper-loop landed path: only landed markets reach the publisher, with raw oracle", () => {
  const got: TickInput[][] = [];
  const pub = { enabled: true, counters: () => ({ enabled: true, sent: 0, dropped: 0, failed: 0, lastOkMs: null }), publish: (i: ReadonlyArray<TickInput>) => { got.push([...i]); } };
  const pushes = [
    { marketAddress: "A", assetIndex: 0, priceE6: 100n },
    { marketAddress: "B", assetIndex: 1, priceE6: 200n }, // dropped from batch
    { marketAddress: "C", assetIndex: 2, priceE6: 300n }, // terminal
  ];
  const raw = new Map([["A", 90n], ["C", 1n]]);
  publishLandedTicks(pub, pushes, { pushedMarkets: ["A", "C"], terminalMarkets: ["C"], signature: "sig" }, (m) => raw.get(m) ?? null, 5n, 1);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], [{ marketAddress: "A", assetIndex: 0, markE6: 100n, oracleE6: 90n }]);
  publishLandedTicks(pub, pushes, { pushedMarkets: ["A"], signature: null }, () => null, 5n, 1);
  assert.equal(got.length, 1, "no signature => nothing landed => no publish");
  const boom = { ...pub, publish: () => { throw new Error("x"); } };
  assert.doesNotThrow(() => publishLandedTicks(boom, pushes, { pushedMarkets: ["A"], signature: "s" }, () => null, 5n, 1));
});
