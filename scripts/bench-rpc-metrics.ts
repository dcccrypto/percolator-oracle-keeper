/**
 * Bench for src/cross-cluster/rpc-metrics.ts.
 * Run: node --import tsx/esm scripts/bench-rpc-metrics.ts
 * Fixed seed: 10k "RPC calls" (methodsOfBody + record per method) over 20 methods and 2 endpoints,
 * bodies a mix of ~100 B and ~50 KB (single + a few batches), then 1k snapshot() calls.
 * Prints median-of-5 ops/sec and ns/op per phase.
 */
import { RpcMetrics, methodsOfBody, type RpcEndpointLabel } from "../src/cross-cluster/rpc-metrics.ts";

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

const METHODS = Array.from({ length: 20 }, (_, i) => `method${i}`);
const EPS: RpcEndpointLabel[] = ["devnet", "mainnet"];
const r = rng(42);
const pad = (n: number) => "A".repeat(n);
const calls: { ep: RpcEndpointLabel; body: string; status: number; dt: number }[] = [];
for (let i = 0; i < 10_000; i++) {
  const m = METHODS[Math.floor(r() * 20)];
  const big = r() < 0.3;
  const single = `{"jsonrpc":"2.0","id":"${i}","method":"${m}","params":["${pad(big ? 50_000 : 40)}"]}`;
  const body = r() < 0.05 ? `[${single},${single.replace(m, METHODS[Math.floor(r() * 20)])}]` : single;
  const x = r();
  calls.push({ ep: EPS[Math.floor(r() * 2)], body, status: x < 0.03 ? 429 : x < 0.05 ? 0 : 200, dt: Math.floor(r() * 40) });
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const callNs: number[] = [];
const snapNs: number[] = [];
let sink = 0;
for (let run = 0; run < 5; run++) {
  let t = 1_700_000_000_000;
  const m = new RpcMetrics(() => t);
  let t0 = process.hrtime.bigint();
  for (const c of calls) {
    t += c.dt;
    for (const meth of methodsOfBody(c.body)) m.record(c.ep, meth, c.status);
  }
  callNs.push(Number(process.hrtime.bigint() - t0) / calls.length);
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) sink += m.snapshot().totalPerMinute.devnet ?? 0;
  snapNs.push(Number(process.hrtime.bigint() - t0) / 1000);
}
const row = (name: string, ns: number) => `${name}: ${ns.toFixed(0)} ns/op, ${Math.round(1e9 / ns).toLocaleString()} ops/s`;
console.log(row("methodsOfBody+record (10k calls)", median(callNs)));
console.log(row("snapshot (1k)", median(snapNs)));
if (sink < 0) console.log(sink);
