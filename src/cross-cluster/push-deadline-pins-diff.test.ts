/**
 * Differential test: the one-DataView / single-detectLayout `decodeBandPins` must return exactly what the previous
 * implementation (per-slot `decodeMarketRefreshState`, a new DataView per read) returned, on >= 10k randomized buffers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABS_MAX_MARKET_SLOTS, assetSlotsOff, detectLayout, engineSlotBase, marketAccountLen } from "./market-layout.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import { V22_ASSET_BAND_OFF, V22_CONFIG_OFF } from "./v22/market.ts";
import { decodeBandPins, pushDeadlineOf } from "./push-deadline.ts";

type Pin = ReturnType<typeof decodeBandPins>[number];

const u64 = (d: Uint8Array, off: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);

/** Verbatim copy of the pre-optimisation implementation. */
function referenceDecodeBandPins(d: Uint8Array, readSlot: bigint): Pin[] {
  const det = detectLayout(d);
  if (!det.known || det.layout.id !== "v2.2-b") return [];
  const layout = det.layout;
  const g = layout.groupOff;
  const bandBps = u64(d, g + V22_CONFIG_OFF.bandBps);
  if (bandBps === 0n) return [];
  const maxPinSlots = u64(d, g + V22_CONFIG_OFF.bandMaxPinSlots);
  const out: Pin[] = [];
  for (let i = 0; i < det.slots; i++) {
    const lifecycle = decodeMarketRefreshState(d, i).lifecycle;
    if (lifecycle !== 2 && lifecycle !== 3) continue;
    const e = engineSlotBase(layout, i);
    if (u64(d, e + V22_ASSET_BAND_OFF.epoch) === 0n) continue;
    const sinceSlot = u64(d, e + V22_ASSET_BAND_OFF.pinSinceSlot);
    if (sinceSlot === 0n) continue;
    const durationSlots = readSlot > sinceSlot ? readSlot - sinceSlot : 0n;
    const expired = durationSlots > maxPinSlots;
    const remaining = expired ? 0n : maxPinSlots - durationSlots;
    out.push({ assetIndex: i, sinceSlot, durationSlots, maxPinSlots, remaining, expired });
  }
  return out.sort((a, b) => (a.remaining < b.remaining ? -1 : a.remaining > b.remaining ? 1 : 0));
}

const here = dirname(fileURLToPath(import.meta.url));
const src = new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", "swordcat-t-live-v22.b64"), "utf8").trim(), "base64"));
const L = (() => {
  const det = detectLayout(src);
  assert.ok(det.known);
  return det.layout;
})();

// xorshift32: deterministic, so a failure reproduces.
let state = 0x9e3779b9;
const rnd = (): number => {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
};
const rnd64 = (): bigint => (BigInt(rnd()) << 32n) | BigInt(rnd());
/** Small values (so pins / maxPin / readSlot interact) mixed with full-range u64s and zero. */
const pick64 = (): bigint => {
  const k = rnd() % 4;
  return k === 0 ? 0n : k === 1 ? BigInt(rnd() % 20_000) : k === 2 ? BigInt(1_000 + (rnd() % 20_000)) : rnd64();
};

function randomMarket(slots: number): Uint8Array {
  const d = new Uint8Array(marketAccountLen(L, slots));
  d.set(src.subarray(0, assetSlotsOff(L)));
  const dv = new DataView(d.buffer);
  dv.setUint32(ABS_MAX_MARKET_SLOTS, slots, true);
  for (let i = 0; i < slots; i++) d.set(src.subarray(assetSlotsOff(L)), assetSlotsOff(L) + i * L.slotStride);
  dv.setBigUint64(L.groupOff + V22_CONFIG_OFF.bandBps, rnd() % 5 === 0 ? 0n : BigInt(1 + (rnd() % 1000)), true);
  dv.setBigUint64(L.groupOff + V22_CONFIG_OFF.bandMaxPinSlots, pick64(), true);
  for (let i = 0; i < slots; i++) {
    const e = engineSlotBase(L, i);
    d[e + L.asset.lifecycle] = rnd() % 6; // 0..5: Active (2) / DrainOnly (3) and the rest
    dv.setBigUint64(e + V22_ASSET_BAND_OFF.epoch, rnd() % 3 === 0 ? 0n : pick64() || 1n, true);
    dv.setBigUint64(e + V22_ASSET_BAND_OFF.pinSinceSlot, pick64(), true);
  }
  return d;
}

const show = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

describe("decodeBandPins differential vs the pre-optimisation implementation", () => {
  it("0 mismatches over 12,000 randomized buffers (1..8 slots, random lifecycle / epoch / pin / maxPin / readSlot)", () => {
    let mismatches = 0;
    let withPins = 0;
    for (let n = 0; n < 12_000; n++) {
      const d = randomMarket(1 + (rnd() % 8));
      const readSlot = pick64();
      const want = show(referenceDecodeBandPins(d, readSlot));
      const got = show(decodeBandPins(d, readSlot));
      if (want !== got) mismatches++;
      if (want !== "[]") withPins++;
      // the full evaluation goes through decodeBandPins: it must not throw either
      pushDeadlineOf(d, readSlot);
    }
    assert.equal(mismatches, 0);
    assert.ok(withPins > 3_000, `generator must exercise the pin path (${withPins} buffers had pins)`);
  });

  it("matches on undecodable input (too short, unknown length, zero slots, non-band) and on the real fixtures", () => {
    const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array(10), src.subarray(0, 1000), src.slice(0, src.length - 1), new Uint8Array(src.length + 5), src];
    const zero = src.slice();
    new DataView(zero.buffer).setUint32(ABS_MAX_MARKET_SLOTS, 0, true);
    cases.push(zero);
    for (const f of ["swordcat-c4-resolved-v22", "v22-cap4b-market-v19-5assets", "v22-sol-market-v19"]) {
      cases.push(new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${f}.b64`), "utf8").trim(), "base64")));
    }
    for (const d of cases) for (const s of [0n, 511_176_335n, 511_363_300n, 2n ** 63n]) assert.equal(show(decodeBandPins(d, s)), show(referenceDecodeBandPins(d, s)));
  });

  it("matches on a view into a larger ArrayBuffer (non-zero byteOffset)", () => {
    for (let n = 0; n < 200; n++) {
      const d = randomMarket(1 + (rnd() % 4));
      const big = new Uint8Array(d.length + 64);
      big.set(d, 37);
      const view = big.subarray(37, 37 + d.length);
      const readSlot = pick64();
      assert.equal(show(decodeBandPins(view, readSlot)), show(referenceDecodeBandPins(d, readSlot)));
    }
  });
});
