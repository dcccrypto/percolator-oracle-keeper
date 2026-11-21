// Temporary bench: per-cycle readAllPoolPricesE6 (read + decode, steady state, warmed decimals cache).
// Usage: node --expose-gc --import tsx/esm scripts/bench-price-reader.ts [ref|new]
import { buildFixture, mockConn } from "../src/cross-cluster/__fixtures__/price-reader-pools.ts";

const which = process.argv[2] === "ref" ? "ref" : "new";
const mod = which === "ref"
  ? await import("../src/cross-cluster/__fixtures__/price-reader-ref.ts")
  : await import("../src/cross-cluster/price-reader.ts");

const log = console.log, err = console.error, warn = console.warn;
console.log = console.error = console.warn = () => {};

async function run(n: number, cycles: number) {
  const fx = buildFixture(n, 7, true);
  const conn = mockConn(fx, `bench://${which}/${n}`);
  const dec = new Map();
  const call = () => {
    const e6 = new Map<string, bigint>(), e12 = new Map<string, bigint>(), q = new Map<string, bigint>();
    return mod.readAllPoolPricesE6(conn as never, fx.entries as never, dec, undefined, new Map(), e12, q);
  };
  for (let i = 0; i < 30; i++) await call(); // warm JIT + decimals
  (globalThis as { gc?: () => void }).gc?.();
  const h0 = process.memoryUsage().heapUsed;
  let pools = 0;
  const batches: number[] = [];
  for (let b = 0; b < 7; b++) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < cycles; i++) pools = (await call()).size;
    const c = process.cpuUsage(c0);
    batches.push((c.user + c.system) / 1000 / cycles); // CPU ms/cycle: robust to a loaded host
  }
  batches.sort((x, y) => x - y);
  const h1 = process.memoryUsage().heapUsed;
  const ms = batches[0];
  return { n, msPerCycle: +ms.toFixed(3), medianMs: +batches[3].toFixed(3), priced: pools, heapDeltaKB: Math.round((h1 - h0) / 1024) };
}

const out = [];
for (const n of [16, 64]) out.push(await run(n, 150));
console.log = log;
log(which, JSON.stringify(out));
void err; void warn;
