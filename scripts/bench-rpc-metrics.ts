/**
 * Bench for src/cross-cluster/rpc-metrics.ts.
 * Run: node --import tsx/esm scripts/bench-rpc-metrics.ts
 * Fixed seed: 10k "RPC calls" (methodsOfBody + record per method) over 20 methods and 2 endpoints,
 * bodies a mix of ~100 B and ~50 KB (single + a few batches), then 1k snapshot() calls.
 * Prints median-of-5 ops/sec and ns/op per phase.
 */
import * as cur from "../src/cross-cluster/rpc-metrics.ts";
import * as base from "../src/cross-cluster/rpc-metrics.legacy.ts"; // frozen copy of the pre-change implementation
import type { RpcEndpointLabel } from "../src/cross-cluster/rpc-metrics.ts";

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
// CPU time (not wall) so a loaded host does not skew it; base and cur are interleaved.
const cpuNs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) * 1000;
};
let sink = 0;
function once(impl: typeof cur): [number, number] {
  let t = 1_700_000_000_000;
  const m = new impl.RpcMetrics(() => t);
  let t0 = cpuNs();
  for (const c of calls) {
    t += c.dt;
    for (const meth of impl.methodsOfBody(c.body)) m.record(c.ep, meth, c.status);
  }
  const callNs = (cpuNs() - t0) / calls.length;
  t0 = cpuNs();
  for (let i = 0; i < 1000; i++) sink += m.snapshot().totalPerMinute.devnet ?? 0;
  return [callNs, (cpuNs() - t0) / 1000];
}
const res = { base: [[], []] as number[][], cur: [[], []] as number[][] };
once(base);
once(cur); // warm-up
for (let run = 0; run < 5; run++) {
  for (const [name, impl] of [["base", base], ["cur", cur]] as const) {
    const [c, s] = once(impl);
    res[name][0].push(c);
    res[name][1].push(s);
  }
}
const row = (name: string, ns: number) => `${name}: ${ns.toFixed(0)} ns/op, ${Math.round(1e9 / ns).toLocaleString()} ops/s`;
for (const name of ["base", "cur"] as const) {
  console.log(`[${name}] ` + row("methodsOfBody+record (10k calls)", median(res[name][0])));
  console.log(`[${name}] ` + row("snapshot (1k)", median(res[name][1])));
}
if (sink < 0) console.log(sink);
