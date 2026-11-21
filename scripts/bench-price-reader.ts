/**
 * Bench: readAllPoolPricesE6 over N=50/200/1000 entries with a fake Connection (recorded-style pool bytes).
 * Reports median ms/cycle over 20 cycles and PublicKey constructions / toBase58 calls per cycle.
 * Usage: npx tsx scripts/bench-price-reader.ts [--dump]   (--dump prints the output checksum + skipReasons digest)
 */
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readAllPoolPricesE6, resetSlotWatermarksForTests } from "../src/cross-cluster/price-reader.ts";
import { buildBoard, fakeConn } from "../src/cross-cluster/price-reader-fixture.ts";

let ctorCount = 0;
let b58Count = 0;
// Constructor assigns this._bn; count via a setter on the prototype.
Object.defineProperty(PublicKey.prototype, "_bn", {
  configurable: true,
  set(v) { ctorCount++; Object.defineProperty(this, "_bn", { value: v, writable: true, configurable: true, enumerable: true }); },
});
const origB58 = PublicKey.prototype.toBase58;
PublicKey.prototype.toBase58 = function (this: PublicKey) { b58Count++; return origB58.call(this); };

const CYCLES = 20;
console.error = () => {}; console.warn = () => {};

for (const n of [50, 200, 1000]) {
  const { accts, entries, dec, refPool } = buildBoard(n);
  const conn = fakeConn(accts, `https://bench-${n}`);
  const times: number[] = [];
  let ctors = 0, b58s = 0, digest = "";
  for (let c = -2; c < CYCLES; c++) {
    resetSlotWatermarksForTests();
    const skip = new Map<string, string>(), e12 = new Map<string, bigint>(), qr = new Map<string, bigint>();
    ctorCount = 0; b58Count = 0;
    const t0 = process.hrtime.bigint();
    const out = await readAllPoolPricesE6(conn, entries, dec, refPool, skip, e12, qr);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (c >= 0) { times.push(ms); ctors = ctorCount; b58s = b58Count; }
    if (c === 0) digest = createHash("sha256").update(JSON.stringify([[...out], [...skip], [...e12], [...qr]], (_, v) => typeof v === "bigint" ? v.toString() : v)).digest("hex").slice(0, 16);
  }
  times.sort((a, b) => a - b);
  process.stdout.write(`N=${n} entries=${entries.length} median=${times[times.length >> 1].toFixed(2)}ms/cycle PublicKey ctor=${ctors}/cycle toBase58=${b58s}/cycle outputDigest=${digest}\n`);
}
