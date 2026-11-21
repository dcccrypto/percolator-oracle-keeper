/**
 * Differential test: adl-state.ts (decodeAdlState / adlHealthOf) vs the SDK's decoder of the same fields.
 *
 * Rust offsets (engine feat/v22-engine-rc23-2026-10-22, src/v16.rs:8770 `AssetStateV16Account`, packed POD, field order):
 *   market_id u64 @0, retired_slot u64 @8, lifecycle u8 @16, raw_oracle_target_price @17, effective_price @25,
 *   fund_px_last @33, slot_last @41, a_long u128 @49, a_short u128 @65, k_long @81, k_short @97, f_long_num @113,
 *   f_short_num @129, kf_epoch_long @145, kf_epoch_short @153, k_epoch_start_long @161, _short @177,
 *   f_epoch_start_long_num @193, _short @209, b_long_num @225, b_short_num @241, b_epoch_start_long_num @257,
 *   _short @273, oi_eff_long_q u128 @289, oi_eff_short_q u128 @305.
 * The SDK (feat/v22-sdk-growth, src/abi/layout.ts LAYOUT_V22 assetState) carries oiEffLongQ 289 / oiEffShortQ 305 and
 * reads them in parseMarketGroupV17OI (slab.ts). The SDK has NO a_long / a_short / lifecycle decoder, so those three
 * are checked against the SDK's own geometry (resolveMarketGeometry().engineOff) + the Rust offsets above.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/adl-state-diff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarketGroupV17OI, resolveMarketGeometry } from "@percolatorct/sdk";
import { ADL_ONE, adlFraction, adlHealth, adlHealthOf, decodeAdlState } from "./adl-state.ts";

// Rust offsets (v16.rs:8770 field order), restated independently of adl-state.ts.
const R_LIFECYCLE = 16;
const R_A_LONG = 49;
const R_A_SHORT = 65;
const R_OI_LONG = 289;
const R_OI_SHORT = 305;

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "__fixtures__");
const rd = (n: string) => new Uint8Array(Buffer.from(readFileSync(join(dir, n), "utf8").trim(), "base64"));
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const r128 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true) | (dv(d).getBigUint64(o + 8, true) << 64n);
const w128 = (d: Uint8Array, o: number, x: bigint) => { dv(d).setBigUint64(o, x & 0xffff_ffff_ffff_ffffn, true); dv(d).setBigUint64(o + 8, x >> 64n, true); };

function v19Markets(): Array<[string, Uint8Array]> {
  const out: Array<[string, Uint8Array]> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".b64")) continue;
    const d = rd(f);
    if (d.length < 16) continue;
    if (dv(d).getBigUint64(0, true) !== 0x5045_5243_5631_3600n || dv(d).getUint16(8, true) !== 19 || d[10] !== 1) continue;
    out.push([f, d]);
  }
  return out;
}

type Ref = { slots: number; assets: Array<{ lifecycle: number; aLong: bigint; aShort: bigint; oiLong: bigint; oiShort: bigint }> } | "throws";

/** The SDK side: SDK geometry + SDK OI parser + Rust offsets for a / lifecycle. */
function sdkRef(d: Uint8Array): Ref {
  try {
    const g = resolveMarketGeometry(d, { parser: "adl-state-diff", strictLength: false });
    const oi = parseMarketGroupV17OI(d);
    const byIdx = new Map(oi.assets.map((a) => [a.assetIndex, a]));
    const assets = [];
    for (let i = 0; i < g.slotCount; i++) {
      const base = g.engineOff(i);
      const o = byIdx.get(i);
      assets.push({
        lifecycle: d[base + R_LIFECYCLE],
        aLong: r128(d, base + R_A_LONG),
        aShort: r128(d, base + R_A_SHORT),
        oiLong: o?.oiEffLongQ ?? 0n,
        oiShort: o?.oiEffShortQ ?? 0n,
      });
    }
    return { slots: g.slotCount, assets };
  } catch {
    return "throws";
  }
}

/** Compare keeper vs SDK for every asset. Returns the number of asset comparisons made. */
function compare(name: string, d: Uint8Array): number {
  const ref = sdkRef(d);
  if (ref === "throws") {
    assert.throws(() => decodeAdlState(d), /./, `${name}: SDK refuses, keeper must too`);
    return 0;
  }
  let n = 0;
  const expectAssets: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ref.slots; i++) {
    const a: { lifecycle: number; aLong: bigint; aShort: bigint; oiLong: bigint; oiShort: bigint } = ref.assets[i]!;
    const k = decodeAdlState(d, i)!;
    assert.deepEqual(
      [k.aLong, k.aShort, k.oiEffLong, k.oiEffShort, k.reduceOnly],
      [a.aLong, a.aShort, a.oiLong, a.oiShort, a.aLong !== ADL_ONE || a.aShort !== ADL_ONE],
      `${name} asset ${i}`,
    );
    n++;
    if (a.lifecycle !== 0) expectAssets.push({ asset: i, ...adlHealth(k) });
  }
  for (let i = 0; i < ref.slots; i++) {
    const h = adlHealthOf(d, i);
    assert.deepEqual(h.adl, adlHealth(decodeAdlState(d, i)!), `${name} adl ${i}`);
    if (ref.slots > 1) assert.deepEqual(h.adlAssets, expectAssets, `${name} adlAssets ${i}`);
    else assert.equal(h.adlAssets, undefined);
  }
  assert.throws(() => decodeAdlState(d, ref.slots), RangeError);
  return n;
}

// deterministic PRNG (xorshift32)
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
function rand128(r: () => number): bigint {
  const mode = r() % 4;
  if (mode === 0) return ADL_ONE;
  if (mode === 1) return BigInt(r()) % (ADL_ONE + 1n);
  let x = 0n;
  for (let i = 0; i < 4; i++) x = (x << 32n) | BigInt(r());
  return mode === 2 ? x : x >> BigInt(r() % 128);
}

describe("adl-state vs SDK decoder (differential)", () => {
  const fixtures = v19Markets();

  it("finds real VERSION 19 market fixtures", () => {
    assert.ok(fixtures.length >= 5, `only ${fixtures.length}`);
  });

  it("every real VERSION 19 fixture, every asset: identical output", () => {
    let cmp = 0;
    for (const [name, d] of fixtures) cmp += compare(name, d);
    assert.ok(cmp >= fixtures.length - 3, `${cmp} asset comparisons`);
    console.log(`real fixtures: ${fixtures.length} files, ${cmp} asset comparisons`);
  });

  it(">= 2000 random-value fixtures written at the Rust offsets, every asset index: identical output", () => {
    const r = rng(0x5eed1234);
    let made = 0;
    let cmp = 0;
    const readable = fixtures.filter(([, d]) => sdkRef(d) !== "throws");
    assert.ok(readable.length > 0);
    while (made < 2000) {
      const [name, base] = readable[made % readable.length];
      const d = new Uint8Array(base);
      const ref = sdkRef(d);
      if (ref === "throws") continue;
      const g = resolveMarketGeometry(d, { parser: "adl-state-diff", strictLength: false });
      for (let i = 0; i < g.slotCount; i++) {
        const b = g.engineOff(i);
        w128(d, b + R_A_LONG, rand128(r));
        w128(d, b + R_A_SHORT, rand128(r));
        w128(d, b + R_OI_LONG, rand128(r));
        w128(d, b + R_OI_SHORT, rand128(r));
        d[b + R_LIFECYCLE] = r() % 6;
      }
      cmp += compare(`${name}#${made}`, d);
      made++;
    }
    assert.equal(made, 2000);
    console.log(`random fixtures: ${made}, ${cmp} asset comparisons`);
  });

  it("neighbour bytes do not leak: writing only a_long/a_short moves only aLong/aShort", () => {
    const [, base] = fixtures.find(([, d]) => sdkRef(d) !== "throws")!;
    const d = new Uint8Array(base);
    const g = resolveMarketGeometry(d, { parser: "adl-state-diff", strictLength: false });
    const before = decodeAdlState(d, 0)!;
    w128(d, g.engineOff(0) + R_A_LONG, 7n);
    const after = decodeAdlState(d, 0)!;
    assert.equal(after.aLong, 7n);
    assert.deepEqual([after.aShort, after.oiEffLong, after.oiEffShort], [before.aShort, before.oiEffLong, before.oiEffShort]);
    assert.equal(adlFraction(ADL_ONE), "1.000000");
  });
});
