import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildV22MarketCtx, readBand } from "./market.ts";
import { v22MarketBytes, key } from "./test-helpers.ts";
import { registryBytes } from "../p2b-test-helpers.ts";
import { layoutById } from "../market-layout.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";

function load(registryData: Uint8Array | null) {
  const r = buildV22MarketCtx({ marketAddress: key(900).toBase58(), label: "x", programId: WRAPPER_PROGRAM_ID, data: v22MarketBytes(), readSlot: 1, registryData, vaultLpStateData: null });
  assert.ok(r.ok);
  return r.ok ? r.ctx : (undefined as never);
}

describe("buildV22MarketCtx registry handling", () => {
  it("a healthy registry reads its domain and flags", () => {
    const c = load(registryBytes({ bound: true, domain: 1, ext: true, bond: true }));
    assert.deepEqual([c.registryDomain, c.bound, c.ext, c.bond], [1, true, true, true]);
  });

  it("a registry the SDK cannot parse must not read as bound domain 0 (domain unknown => jobs skip)", () => {
    const bad = Buffer.from(registryBytes({ bound: true, domain: 1, ext: true, bond: true }));
    bad.writeBigUInt64LE(0n, 0); // corrupt magic: parseLpVaultRegistry throws, flag bytes still look valid
    const c = load(new Uint8Array(bad));
    assert.equal(c.bound, false);
    assert.equal(c.ext, false);
    assert.equal(c.bond, false);
  });

  it("readBand ignores currentSlot (lead 1: no time-dependent field) and reads the asked asset slot", () => {
    const data = v22MarketBytes({ slots: 2 });
    const L = layoutById("v2.2-b");
    assert.deepEqual(readBand(data, L, 0, 0n), readBand(data, L, 0, 999_999_999n));
  });
});
