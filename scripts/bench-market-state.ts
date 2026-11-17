/**
 * Microbenchmark: market-state decoders over a real v2.2 market fixture, as push-deadline runs them per market
 * (decodeTerminalState, marketMode, staleResolveWindow, then pushDeadlineOf). Prints median-of-5 ns per market
 * (one "market" = the three decoders + pushDeadlineOf on the same bytes) and a sha256 of the outputs.
 *
 *   node --import tsx/esm scripts/bench-market-state.ts [ITERS=100000] [fixture=v22-sol-market-v19]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeTerminalState, marketMode, staleResolveWindow } from "../src/cross-cluster/market-state.ts";
import { pushDeadlineOf } from "../src/cross-cluster/push-deadline.ts";

const ITERS = Number(process.argv[2] ?? 100_000);
const name = process.argv[3] ?? "v22-sol-market-v19";
const d = new Uint8Array(Buffer.from(readFileSync(new URL(`../src/cross-cluster/__fixtures__/${name}.b64`, import.meta.url), "utf8").trim(), "base64"));
const SLOT = 511_176_335n;

const once = (): unknown => [decodeTerminalState(d), marketMode(d), staleResolveWindow(d, SLOT), pushDeadlineOf(d, SLOT)];

const decodersOnly = (): unknown => [decodeTerminalState(d), marketMode(d), staleResolveWindow(d, SLOT)];

const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const digest = createHash("sha256").update(json(once())).digest("hex").slice(0, 16);

for (let i = 0; i < 5000; i++) once(); // warm
const runs: number[] = [];
for (let r = 0; r < 5; r++) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) once();
  runs.push(Number(process.hrtime.bigint() - t0) / ITERS);
}
runs.sort((a, b) => a - b);
console.log(`fixture=${name} bytes=${d.length} iters=${ITERS} sha256=${digest}`);
console.log(`ns/market runs: ${runs.map((x) => x.toFixed(0)).join(" ")}`);
console.log(`ns/market median: ${runs[2].toFixed(0)}`);
const r2: number[] = [];
for (let r = 0; r < 5; r++) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) decodersOnly();
  r2.push(Number(process.hrtime.bigint() - t0) / ITERS);
}
r2.sort((a, b) => a - b);
console.log(`ns/market (3 market-state decoders only) median: ${r2[2].toFixed(0)}`);
