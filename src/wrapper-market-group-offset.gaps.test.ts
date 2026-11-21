/**
 * Coverage gaps in wrapper-market-group-offset.ts: assetSlotOffset, the VERSION 19 geometry row, the
 * exact too-short boundary, and the module-load guard that refuses a stale SDK LAYOUT_V22.
 */
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { V17_MAGIC } from "@percolatorct/sdk";
import {
  assetSlotOffset,
  selectMarketGroupOffset,
  HEADER_VERSION_OFF,
  MARKET_GEOMETRY_BY_VERSION,
  V19_MARKET_GROUP_OFF,
  V19_MARKET_GROUP_LEN,
  V19_MARKET_ASSET_SLOT_LEN,
  VERSION_19,
} from "./wrapper-market-group-offset.ts";

function header(version: number, len = 64): Uint8Array {
  const buf = new Uint8Array(len);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, V17_MAGIC, true);
  dv.setUint16(HEADER_VERSION_OFF, version, true);
  return buf;
}

describe("wrapper-market-group-offset gaps", () => {
  it("assetSlotOffset = group off + group len + index * stride", () => {
    const g = MARKET_GEOMETRY_BY_VERSION[VERSION_19]!;
    assert.equal(assetSlotOffset(g, 0), V19_MARKET_GROUP_OFF + V19_MARKET_GROUP_LEN);
    assert.equal(assetSlotOffset(g, 3), V19_MARKET_GROUP_OFF + V19_MARKET_GROUP_LEN + 3 * V19_MARKET_ASSET_SLOT_LEN);
    assert.equal(assetSlotOffset({ marketGroupOff: 10, marketGroupLen: 20, assetSlotStride: 5, wrapperSlotLen: 1 }, 2), 40);
  });

  it("VERSION 19 resolves to its own geometry, not v2.1's", () => {
    const r = selectMarketGroupOffset(header(VERSION_19));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.marketGroupLen, V19_MARKET_GROUP_LEN);
      assert.equal(r.assetSlotStride, V19_MARKET_ASSET_SLOT_LEN);
    }
  });

  it("a 9-byte buffer is too-short, a 10-byte one reaches the VERSION field", () => {
    assert.deepEqual(selectMarketGroupOffset(new Uint8Array(9)), { ok: false, reason: "too-short" });
    // 10 bytes: magic is readable only with >= 8 bytes, version with 10; magic zero -> bad-magic, not too-short.
    const r = selectMarketGroupOffset(new Uint8Array(10));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "bad-magic");
  });

  it("module load throws when the pinned SDK LAYOUT_V22 is not VERSION 19", () => {
    // mock.module needs --experimental-test-module-mocks, which the suite command does not pass, so run the
    // check in a child node process (NODE_V8_COVERAGE is dropped for the child: its partial run would corrupt the parent's file coverage).
    const child = fileURLToPath(new URL("./wrapper-market-group-offset.stale-guard.fixture.mjs", import.meta.url));
    const r = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx/esm", child], {
      encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: mkdtempSync(join(tmpdir(), "stale-guard-cov-")) },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /GUARD_THREW LAYOUT_V22 is VERSION 18, keeper expects 19/);
  });
});
