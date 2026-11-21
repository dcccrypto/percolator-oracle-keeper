/**
 * Bench: decodeBandPins and the full pushDeadlineOf evaluation on v2.2-b market buffers of 1, 8 and 32 asset slots
 * (every slot Active, band-configured and pinned: the worst case for the per-slot loop).
 *
 * Run: npx tsx bench/push-deadline.bench.ts   (5 runs, median ns/op printed)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABS_MAX_MARKET_SLOTS, assetSlotsOff, detectLayout, engineSlotBase, marketAccountLen } from "../src/cross-cluster/market-layout.ts";
import { V22_ASSET_BAND_OFF, V22_CONFIG_OFF } from "../src/cross-cluster/v22/market.ts";
import { decodeBandPins, pushDeadlineOf } from "../src/cross-cluster/push-deadline.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(here, "..", "src", "cross-cluster", "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));

/** A Live, band-configured v2.2-b market with `slots` asset slots, every slot Active and pinned. */
export function buildMarket(slots: number): Uint8Array {
  const src = fixture("swordcat-t-live-v22");
  const det = detectLayout(src);
  if (!det.known) throw new Error("fixture layout unknown");
  const L = det.layout;
  const d = new Uint8Array(marketAccountLen(L, slots));
  d.set(src.subarray(0, marketAccountLen(L, 1)));
  const dv = new DataView(d.buffer);
  dv.setUint32(ABS_MAX_MARKET_SLOTS, slots, true);
  const slot0 = src.subarray(assetSlotsOff(L), marketAccountLen(L, 1));
  for (let i = 1; i < slots; i++) d.set(slot0, assetSlotsOff(L) + i * L.slotStride);
  dv.setBigUint64(L.groupOff + V22_CONFIG_OFF.bandBps, 500n, true);
  dv.setBigUint64(L.groupOff + V22_CONFIG_OFF.bandMaxPinSlots, 9_000n, true);
  for (let i = 0; i < slots; i++) {
    const e = engineSlotBase(L, i);
    d[e + L.asset.lifecycle] = 2; // Active
    dv.setBigUint64(e + V22_ASSET_BAND_OFF.epoch, 7n, true);
    dv.setBigUint64(e + V22_ASSET_BAND_OFF.pinSinceSlot, 1_000_000n + BigInt(i) * 37n, true);
  }
  return d;
}

/** Time-boxed: warm up ~100 ms, then run batches for ~300 ms; returns ns/op. */
function nsPerOp(fn: () => unknown): number {
  const warmEnd = performance.now() + 100;
  while (performance.now() < warmEnd) fn();
  let ops = 0;
  const t0 = process.hrtime.bigint();
  const end = performance.now() + 300;
  while (performance.now() < end) {
    for (let i = 0; i < 20; i++) fn();
    ops += 20;
  }
  return Number(process.hrtime.bigint() - t0) / ops;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const READ_SLOT = 1_004_000n;
  const RUNS = 5;
  console.log("slots  fn                 median ns/op   (runs)");
  for (const slots of [1, 8, 32]) {
    const buf = buildMarket(slots);
    for (const [name, fn] of [
      ["decodeBandPins", () => decodeBandPins(buf, READ_SLOT)],
      ["pushDeadlineOf", () => pushDeadlineOf(buf, READ_SLOT)],
    ] as const) {
      const runs = Array.from({ length: RUNS }, () => nsPerOp(fn));
      console.log(`${String(slots).padStart(5)}  ${name.padEnd(16)}  ${median(runs).toFixed(0).padStart(10)}     (${runs.map((r) => r.toFixed(0)).join(", ")})`);
    }
  }
}
