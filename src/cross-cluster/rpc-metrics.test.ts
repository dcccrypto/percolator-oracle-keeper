import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcMetrics, countingFetch, methodsOfBody } from "./rpc-metrics.ts";

test("methodsOfBody: single request names its method once, batch names each", () => {
  assert.deepEqual(methodsOfBody('{"jsonrpc":"2.0","id":"x","method":"getSlot","params":[{"commitment":"processed"}]}'), ["getSlot"]);
  assert.deepEqual(
    methodsOfBody('[{"jsonrpc":"2.0","id":"1","method":"getAccountInfo","params":[]},{"jsonrpc":"2.0","id":"2","method":"getBalance","params":[]}]'),
    ["getAccountInfo", "getBalance"],
  );
  assert.deepEqual(methodsOfBody(undefined), ["<non-string-body>"]);
  assert.deepEqual(methodsOfBody("garbage"), ["<unknown>"]);
});

test("a base64 payload containing the text method cannot create a phantom method", () => {
  const body = '{"jsonrpc":"2.0","id":"1","method":"sendTransaction","params":["\\"method\\":\\"getSlot\\""]}';
  assert.deepEqual(methodsOfBody(body), ["sendTransaction"]);
});

test("counts per method over the trailing windows and ages out", () => {
  let t = 1_000_000_000_000;
  const m = new RpcMetrics(() => t);
  for (let i = 0; i < 30; i++) m.record("devnet", "simulateTransaction", 200);
  m.record("mainnet", "getMultipleAccounts", 200);
  m.record("devnet", "getAccountInfo", 429);
  m.record("devnet", "getAccountInfo", 0);
  let s = m.snapshot();
  assert.equal(s.perMinute.devnet.simulateTransaction, 30);
  assert.equal(s.perMinute.mainnet.getMultipleAccounts, 1);
  assert.equal(s.rateLimited.devnet.getAccountInfo, 1);
  assert.equal(s.failed.devnet.getAccountInfo, 1);
  assert.equal(s.totalPerMinute.devnet, 32);
  t += 61_000;
  s = m.snapshot();
  assert.equal(s.perMinute.devnet.simulateTransaction, 0, "outside the 60 s window");
  assert.equal(s.perSecond5m.devnet.simulateTransaction, Math.round((30 / 300) * 100) / 100);
  assert.equal(s.totals.devnet.simulateTransaction, 30, "totals never age out");
  t += 300_000;
  assert.equal(m.snapshot().perSecond5m.devnet.simulateTransaction, 0);
});

test("countingFetch counts every attempt (a 429 retry is a separate request) and passes the response through untouched", async () => {
  const m = new RpcMetrics();
  const statuses = [429, 429, 200];
  const base = async (): Promise<Response> => new Response("{}", { status: statuses.shift() });
  const f = countingFetch("devnet", m, base);
  const body = '{"jsonrpc":"2.0","id":"1","method":"getAccountInfo","params":[]}';
  const rs = [await f("http://x", { body }), await f("http://x", { body }), await f("http://x", { body })];
  assert.deepEqual(rs.map((r) => r.status), [429, 429, 200]);
  const s = m.snapshot();
  assert.equal(s.totals.devnet.getAccountInfo, 3);
  assert.equal(s.rateLimited.devnet.getAccountInfo, 2);
});

test("countingFetch records a thrown fetch as failed and rethrows the same error", async () => {
  const m = new RpcMetrics();
  const boom = new Error("socket hang up");
  const f = countingFetch("mainnet", m, async () => {
    throw boom;
  });
  await assert.rejects(f("http://x", { body: '{"method":"getSlot"}' }), (e) => e === boom);
  assert.equal(m.snapshot().failed.mainnet.getSlot, 1);
});
