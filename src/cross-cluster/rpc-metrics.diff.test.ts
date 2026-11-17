import { test } from "node:test";
import assert from "node:assert/strict";
import * as cur from "./rpc-metrics.ts";
import * as old from "./rpc-metrics.legacy.ts";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBody(r: () => number): unknown {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const m = () => `m${Math.floor(r() * 12)}`;
  const one = () =>
    pick([
      () => `{"jsonrpc":"2.0","id":"1","method":"${m()}","params":[]}`,
      () => `{"method" : "${m()}","params":["x"]}`,
      () => `{"params":["\\"method\\":\\"phantom\\""],"method":"${m()}"}`, // a value mentioning method first
      () => `{"method":"bad-name!","params":[],"x":{"method":"${m()}"}}`, // first hit not a valid name
      () => `{"method":5}`,
      () => `no method here ${"z".repeat(Math.floor(r() * 500))}`,
      () => `{"jsonrpc":"2.0","method":"${m()}","params":["${"A".repeat(Math.floor(r() * 3000))}"]}`,
    ])();
  const k = r();
  if (k < 0.04) return undefined;
  if (k < 0.07) return 42;
  if (k < 0.1) return "";
  if (k < 0.3) return `[${Array.from({ length: 1 + Math.floor(r() * 4) }, one).join(",")}]`;
  if (k < 0.35) return ` [${one()}]`; // leading space: not a batch by the existing rule
  return one();
}

test("differential: methodsOfBody identical to legacy on random bodies", () => {
  const r = rng(7);
  for (let i = 0; i < 5000; i++) {
    const b = randomBody(r);
    assert.deepEqual(cur.methodsOfBody(b), old.methodsOfBody(b), String(b));
  }
});

test("differential: snapshot() identical to legacy over a random call stream", () => {
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    let t = seed === 3 ? 100 : 1_700_000_000_000;
    const a = new cur.RpcMetrics(() => t);
    const b = new old.RpcMetrics(() => t);
    const eps = ["devnet", "mainnet"] as const;
    for (let i = 0; i < 6000; i++) {
      // mostly small steps, sometimes jumps past the 60 s / 300 s windows, sub-second ticks too
      const j = r();
      t += j < 0.7 ? Math.floor(r() * 400) : j < 0.97 ? Math.floor(r() * 20_000) : Math.floor(r() * 700_000);
      const body = randomBody(r);
      const status = ((x) => (x < 0.05 ? 429 : x < 0.1 ? 0 : 200))(r());
      const ep = eps[Math.floor(r() * 2)];
      for (const m of cur.methodsOfBody(body)) a.record(ep, m, status);
      for (const m of old.methodsOfBody(body)) b.record(ep, m, status);
      if (i % 50 === 0) assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
    }
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
    t += 3_000_000; // everything aged out
    assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
  }
});
