/**
 * Differential: the single-pass multi-asset decoders equal the per-asset reference (multi-asset.legacy-ref.ts)
 * on 1 / 16 / 64 slot markets, random asset lists (incl. out-of-range, duplicates, unsorted) and corrupt accounts.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/multi-asset-plan-equality.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABS_MAX_MARKET_SLOTS, ABS_WRAPPER_VERSION, layoutById, marketAccountLen } from "./market-layout.ts";
import { decodeAssetRefreshStates, decodeMarketRefreshStateFor, sampleAssetAccrual } from "./multi-asset.ts";
import { legacyDecodeAssetRefreshStates, legacyDecodeMarketRefreshStateFor } from "./multi-asset.legacy-ref.ts";

let seed = 987654321;
const rnd = (): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed;
};

function market(slots: number, density: number): Buffer {
  const l = layoutById("v2.2-drift");
  const b = Buffer.alloc(marketAccountLen(l, slots));
  b.writeUInt16LE(l.wrapperVersion, ABS_WRAPPER_VERSION);
  b.writeUInt32LE(slots, ABS_MAX_MARKET_SLOTS);
  for (let i = l.groupOff + 64; i < b.length; i++) if (rnd() % density === 0) b[i] = rnd() & 0xff;
  return b;
}

const same = (x: unknown, y: unknown, msg: string): void => assert.deepEqual(x, y, msg);

describe("multi-asset decoders: single pass == per-asset reference", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", "ansem-market-v18.b64"), "utf8").trim(), "base64"));

  const check = (data: Uint8Array, assets: number[], tag: string): void => {
    same(decodeAssetRefreshStates(data, assets), legacyDecodeAssetRefreshStates(data, assets), `${tag} per-asset ${assets}`);
    let a: unknown, b: unknown;
    try { a = decodeMarketRefreshStateFor(data, assets); } catch (e) { a = (e as Error).message; }
    try { b = legacyDecodeMarketRefreshStateFor(data, assets); } catch (e) { b = (e as Error).message; }
    same(a, b, `${tag} market ${assets}`);
    const s = sampleAssetAccrual(data, assets, 1000n, 5);
    assert.equal(s.assets.length, legacyDecodeAssetRefreshStates(data, assets).length);
  };

  for (const n of [1, 16, 64]) {
    it(`${n} slots, fixed and random asset lists`, () => {
      for (const density of [1, 3, 7, 50]) {
        const data = market(n, density);
        check(data, [0], `n=${n}`);
        check(data, Array.from({ length: n }, (_, i) => i), `n=${n} all`);
        check(data, [], `n=${n} empty`);
        for (let k = 0; k < 40; k++) {
          const cnt = 1 + (rnd() % 16);
          const assets = Array.from({ length: cnt }, () => (rnd() % (n + 4)) - 1); // includes -1 and n..n+2
          check(data, assets, `n=${n} rand`);
        }
      }
    });
  }

  it("real market fixture and corrupt / unknown-layout accounts", () => {
    check(fixture, [0], "fixture");
    check(fixture, [0, 1, 2, 3], "fixture");
    check(new Uint8Array(10), [0, 1], "short");
    check(new Uint8Array(fixture.subarray(0, fixture.length - 1)), [0, 1], "truncated");
    const zeroSlots = market(4, 3);
    zeroSlots.writeUInt32LE(0, ABS_MAX_MARKET_SLOTS);
    check(zeroSlots, [0, 1], "zero slots");
  });

  it("respects a non-zero byteOffset view", () => {
    const data = market(16, 3);
    const padded = Buffer.concat([Buffer.alloc(13, 0xab), data]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 13, data.length);
    same(decodeAssetRefreshStates(view, [0, 5, 15]), legacyDecodeAssetRefreshStates(data, [0, 5, 15]), "offset view");
  });
});
