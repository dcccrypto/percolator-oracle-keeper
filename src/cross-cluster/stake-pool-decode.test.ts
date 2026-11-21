/**
 * stake-pool-decode.test.ts — per-version decode of decodeStakePoolAnyVersion.
 * Layouts follow the SDK decoders (decodeStakePool v1..v4, decodeStakePoolV5): fixed prefix is_initialized@0, slab@8,
 * admin@40, collateral_mint@72, lp_mint@104, vault@136, total_lp_supply@176, percolator_program@224, pool_mode@280;
 * `_reserved` starts @288 (v1, 352 B) or @320 (v2 384 B, v3 392 B, v4 408 B, v5 480 B) with the 8-byte "SPOOL_V1"
 * discriminator and the version byte at _reserved[8]. v5 is also exercised on the captured devnet account bytes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  decodeStakePoolAnyVersion,
  isStakePoolV5,
  STAKE_POOL_VERSION_OFF,
} from "./stake-pool-decode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));

const DISC = Buffer.from("SPOOL_V1");
const pk = (seed: number) => new PublicKey(Buffer.alloc(32, seed));

function build(size: number, version: number, opts: { init?: number; mode?: number; lp?: bigint } = {}): Uint8Array {
  const b = Buffer.alloc(size);
  b[0] = opts.init ?? 1;
  pk(1).toBuffer().copy(b, 8);
  pk(2).toBuffer().copy(b, 40);
  pk(3).toBuffer().copy(b, 72);
  pk(4).toBuffer().copy(b, 104);
  pk(5).toBuffer().copy(b, 136);
  b.writeBigUInt64LE(opts.lp ?? 123456789n, 176);
  pk(6).toBuffer().copy(b, 224);
  b[280] = opts.mode ?? 0;
  const res = size === 352 ? 288 : 320;
  DISC.copy(b, res);
  b[res + 8] = version;
  return new Uint8Array(b);
}

const LEGACY: Array<[string, number, number]> = [
  ["v1", 352, 1],
  ["v2", 384, 2],
  ["v3", 392, 3],
  ["v4", 408, 4],
];

describe("decodeStakePoolAnyVersion: legacy v1..v4", () => {
  for (const [name, size, ver] of LEGACY) {
    it(`${name} (${size} B) decodes every consumed field via the legacy decoder`, () => {
      const d = build(size, ver, { mode: 1, lp: 42n });
      assert.equal(isStakePoolV5(d), false);
      const p = decodeStakePoolAnyVersion(d);
      assert.equal(p.version, ver);
      assert.equal(p.isInitialized, true);
      assert.equal(p.slab.toBase58(), pk(1).toBase58());
      assert.equal(p.admin.toBase58(), pk(2).toBase58());
      assert.equal(p.collateralMint.toBase58(), pk(3).toBase58());
      assert.equal(p.vault.toBase58(), pk(5).toBase58());
      assert.equal(p.percolatorProgram.toBase58(), pk(6).toBase58());
      assert.equal(p.poolMode, 1);
      assert.equal(p.totalLpSupply, 42n);
      assert.equal(p.riskMode, undefined);
    });
    it(`${name}: is_initialized = 0 and = 2 both read as not initialized`, () => {
      assert.equal(decodeStakePoolAnyVersion(build(size, ver, { init: 0 })).isInitialized, false);
      assert.equal(decodeStakePoolAnyVersion(build(size, ver, { init: 2 })).isInitialized, false);
    });
    it(`${name}: wrong version byte throws (never a guess)`, () => {
      assert.throws(() => decodeStakePoolAnyVersion(build(size, ver === 4 ? 3 : 4)));
    });
  }

  it("a legacy-length pool whose version byte is 5 is not misread as v5 (too short) and throws", () => {
    const d = build(408, 5);
    assert.equal(isStakePoolV5(d), false);
    assert.throws(() => decodeStakePoolAnyVersion(d), /unsupported version/);
  });
});

describe("decodeStakePoolAnyVersion: v5", () => {
  it("captured devnet v5 pool: every field, riskMode set", () => {
    const d = fx("v22-sol-stake-pool-v5");
    assert.equal(d.length, 480);
    assert.equal(isStakePoolV5(d), true);
    const p = decodeStakePoolAnyVersion(d);
    assert.equal(p.version, 5);
    assert.equal(p.isInitialized, true);
    assert.equal(p.poolMode, 0);
    assert.ok(p.totalLpSupply >= 1000n);
    assert.ok(p.riskMode === 1 || p.riskMode === 2);
    assert.equal(p.slab.toBase58(), new PublicKey(d.subarray(8, 40)).toBase58());
    assert.equal(p.admin.toBase58(), new PublicKey(d.subarray(40, 72)).toBase58());
    assert.equal(p.vault.toBase58(), new PublicKey(d.subarray(136, 168)).toBase58());
    assert.equal(p.percolatorProgram.toBase58(), new PublicKey(d.subarray(224, 256)).toBase58());
  });

  it("synthetic v5 buffer: fields + riskMode at 408; is_initialized 0/2 read false", () => {
    const d = build(480, 5, { mode: 0, lp: 7n });
    d[408] = 2;
    assert.equal(STAKE_POOL_VERSION_OFF, 328);
    const p = decodeStakePoolAnyVersion(d);
    assert.equal(p.version, 5);
    assert.equal(p.riskMode, 2);
    assert.equal(p.totalLpSupply, 7n);
    assert.equal(p.collateralMint.toBase58(), pk(3).toBase58());
    assert.equal(decodeStakePoolAnyVersion(build(480, 5, { init: 0 })).isInitialized, false);
    assert.equal(decodeStakePoolAnyVersion(build(480, 5, { init: 2 })).isInitialized, false);
  });

  it("oversized account (>480 B) with version 5 still decodes as v5", () => {
    const d = new Uint8Array(512);
    d.set(build(480, 5));
    assert.equal(decodeStakePoolAnyVersion(d).version, 5);
  });

  it("v5-length bytes with version 6, or version 5 without the discriminator, throw (no garbage)", () => {
    assert.throws(() => decodeStakePoolAnyVersion(build(480, 6)));
    const d = build(480, 5);
    d.fill(0, 320, 328);
    assert.throws(() => decodeStakePoolAnyVersion(d));
  });

  it("v5-length account whose version byte is 4 goes to the legacy path (v4 prefix is shared)", () => {
    const p = decodeStakePoolAnyVersion(build(480, 4));
    assert.equal(p.version, 4);
    assert.equal(p.riskMode, undefined);
  });
});
