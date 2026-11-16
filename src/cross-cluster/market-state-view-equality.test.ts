/**
 * Perf change (one DataView per buffer): market-state.ts must return exactly what the previous per-read-DataView
 * implementation (market-state.legacy-ref.ts, frozen copy of the pre-change module) returns, on every fixture,
 * every mutated mode / stale-window variant, and every truncation, including after the bytes are mutated in place.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";
import * as cur from "./market-state.ts";
import * as old from "./market-state.legacy-ref.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "__fixtures__");
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".b64"))
  .map((f) => ({ name: f, bytes: new Uint8Array(Buffer.from(readFileSync(join(dir, f), "utf8").trim(), "base64")) }));

const SLOTS = [0n, 1n, 511_176_335n, 2n ** 63n];

function same(name: string, d: Uint8Array): void {
  assert.deepEqual(cur.decodeTerminalState(d), old.decodeTerminalState(d), `${name} decodeTerminalState`);
  assert.equal(cur.marketMode(d), old.marketMode(d), `${name} marketMode`);
  assert.equal(cur.isLiveMarket(d), old.isLiveMarket(d), `${name} isLiveMarket`);
  assert.equal(cur.isTerminalMarket(d), old.isTerminalMarket(d), `${name} isTerminalMarket`);
  for (const s of SLOTS) assert.deepEqual(cur.staleResolveWindow(d, s), old.staleResolveWindow(d, s), `${name} staleResolveWindow@${s}`);
}

describe("market-state one-DataView-per-buffer equals the per-read-DataView original", () => {
  it("has fixtures to compare", () => assert.ok(fixtures.length > 20));

  it("every fixture, identical for all decoders", () => {
    let decoded = 0;
    for (const f of fixtures) {
      same(f.name, f.bytes);
      if (old.decodeTerminalState(f.bytes) !== null) decoded++;
    }
    assert.ok(decoded >= 10, `only ${decoded} fixtures decode as markets`);
  });

  it("mode / stale-window mutations, applied in place (cached view must see the writes)", () => {
    for (const f of fixtures) {
      if (old.decodeTerminalState(f.bytes) === null) continue;
      const d = f.bytes.slice();
      const v = new DataView(d.buffer);
      same(f.name + " base", d);
      const modeOff = v.getUint16(8, true) === 19 ? 592 + 674 : V17_MARKET_GROUP_OFF + 626;
      for (const mode of [0, 1, 2, 3]) {
        d[modeOff] = mode;
        same(`${f.name} mode=${mode}`, d);
      }
      for (const stale of [0n, 1n, 9000n, 2n ** 64n - 1n]) {
        v.setBigUint64(16 + 136, stale, true);
        for (const last of [0n, 511_176_000n, 2n ** 64n - 1n]) {
          v.setBigUint64(16 + 152, last, true);
          same(`${f.name} stale=${stale} last=${last}`, d);
        }
      }
      d[10] = 8;
      same(`${f.name} kind=8`, d);
      d[10] = 3;
      same(`${f.name} kind=3`, d);
    }
  });

  it("truncations and subarray views with a byte offset", () => {
    for (const f of fixtures) {
      if (old.decodeTerminalState(f.bytes) === null) continue;
      for (const n of [0, 8, 15, 16, 17, 600, 1397, 1398, 1399, f.bytes.length - 1, f.bytes.length]) {
        if (n < 0 || n > f.bytes.length) continue;
        same(`${f.name} len=${n}`, f.bytes.subarray(0, n));
      }
      const padded = new Uint8Array(f.bytes.length + 13);
      padded.set(f.bytes, 13);
      same(`${f.name} offset13`, padded.subarray(13));
    }
  });

  it("alternating buffers keep their own views", () => {
    const a = fixtures.find((f) => f.name === "v22-sol-market-v19.b64")!.bytes.slice();
    const b = fixtures.find((f) => f.name === "swordcat-c4-resolved-v22.b64")!.bytes.slice();
    for (let i = 0; i < 4; i++) {
      same("a", a);
      same("b", b);
    }
    assert.notDeepEqual(cur.decodeTerminalState(a), cur.decodeTerminalState(b));
  });
});
