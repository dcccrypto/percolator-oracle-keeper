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
  const t0 = process.hrtime.bigint();
  let pools = 0;
  for (let i = 0; i < cycles; i++) pools = (await call()).size;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / cycles;
  const h1 = process.memoryUsage().heapUsed;
  return { n, msPerCycle: +ms.toFixed(3), priced: pools, heapDeltaKB: Math.round((h1 - h0) / 1024) };
}

const out = [];
for (const n of [16, 64]) out.push(await run(n, 300));
console.log = log;
log(which, JSON.stringify(out));
void err; void warn;
