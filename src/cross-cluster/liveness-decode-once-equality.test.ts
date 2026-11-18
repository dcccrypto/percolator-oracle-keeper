/**
 * Differential: the detect-once livenessRepairsFor / single-DataView decodeLivenessState vs the frozen old code
 * (liveness-repair.legacy-ref.ts) on randomised market bytes, including thrown errors. 0 mismatches required.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeLivenessState } from "./liveness-repair.ts";
import { decodeLivenessState as oldDecode, legacyLivenessRepairsFor } from "./liveness-repair.legacy-ref.ts";
import { livenessRepairsFor } from "./v22/loop.ts";
import { livenessOffsetsFor } from "./liveness-repair.ts";
import { detectLayout } from "./market-layout.ts";
import { v22MarketBytes } from "./v22/test-helpers.ts";

let seed = 0x9e3779b9;
const rnd = (): number => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };

function outcome<T>(f: () => T): { ok: true; v: T } | { ok: false; msg: string; name: string } {
  try { return { ok: true, v: f() }; } catch (e) { return { ok: false, msg: (e as Error).message, name: (e as Error).name }; }
}

/** Randomise the bytes of every asset slot's liveness-relevant region (and a sprinkling of anywhere), keep the header. */
function randomMarket(slots: number): Uint8Array {
  const base = Buffer.from(v22MarketBytes({ slots, currentSlot: 50_000n }));
  const det = detectLayout(base);
  assert.ok(det.known);
  for (let i = 0; i < slots; i++) {
    const o = livenessOffsetsFor(det.layout, i)!;
    for (const off of [o.backingLong, o.backingShort]) {
      base[o.engineBase + off + 96] = rnd() % 4;
      base.writeBigUInt64LE(BigInt(rnd() % 3 === 0 ? 49_000 + (rnd() % 2_000) : rnd()) , o.engineBase + off + 88);
    }
    for (const off of [o.modeLong, o.modeShort]) base[o.engineBase + off] = rnd() % 4;
    for (const off of [o.storedPosLong, o.storedPosShort, o.staleLong, o.staleShort, o.pendingOblLong, o.pendingOblShort, o.barrierLong, o.barrierShort]) {
      if (rnd() % 2) base.writeBigUInt64LE((BigInt(rnd()) << 32n) | BigInt(rnd()), o.engineBase + off);
    }
  }
  return new Uint8Array(base);
}

describe("liveness decode-once: differential vs frozen old code", () => {
  it("livenessRepairsFor: 600 random markets (1-8 slots, ctx.slots over/under the real count), deep-equal", () => {
    let mismatches = 0;
    for (let n = 0; n < 600; n++) {
      const real = 1 + (rnd() % 8);
      let data = randomMarket(real);
      const mode = rnd() % 6;
      if (mode === 1) data = data.subarray(0, data.length - 1 - (rnd() % 3000)); // truncated -> unknown layout / short
      if (mode === 2) { const c = Buffer.from(data); c.writeUInt16LE(1 + (rnd() % 40), 8); data = new Uint8Array(c); } // random VERSION
      if (mode === 3) { const c = Buffer.from(data); c.writeUInt32LE(rnd() % 12, 8 + 0 + 0 + 0 + 0) ; data = new Uint8Array(c); } // header noise
      if (mode === 4) data = new Uint8Array(Buffer.concat([Buffer.alloc(3), Buffer.from(data)])).subarray(3); // nonzero byteOffset
      const ctx = { data, readSlot: rnd() % 3 === 0 ? 50_000 : 49_000 + (rnd() % 3000), slots: Math.max(0, real + (rnd() % 5) - 2) };
      const a = outcome(() => livenessRepairsFor(ctx));
      const b = outcome(() => legacyLivenessRepairsFor(ctx));
      try { assert.deepEqual(a, b); } catch { mismatches++; }
    }
    assert.equal(mismatches, 0);
  });
  it("non-integer readSlot (BigInt throws) matches", () => {
    const ctx = { data: randomMarket(3), readSlot: 1.5, slots: 3 };
    assert.deepEqual(outcome(() => livenessRepairsFor(ctx)), outcome(() => legacyLivenessRepairsFor(ctx)));
  });
  it("decodeLivenessState: 600 random markets / asset indices incl. out-of-range and short buffers, states and errors deep-equal", () => {
    let mismatches = 0;
    for (let n = 0; n < 600; n++) {
      let data = randomMarket(1 + (rnd() % 8));
      if (rnd() % 5 === 0) data = data.subarray(0, data.length - 1 - (rnd() % 4000));
      const idx = rnd() % 12;
      const a = outcome(() => decodeLivenessState(data, idx));
      const b = outcome(() => oldDecode(data, idx));
      try { assert.deepEqual(a, b); } catch { mismatches++; }
    }
    assert.equal(mismatches, 0);
  });
});
