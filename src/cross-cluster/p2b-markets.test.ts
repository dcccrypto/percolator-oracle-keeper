import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveLpVaultRegistry } from "@percolatorct/sdk";
import { readU64, readU128, readVaultMarketSnapshots } from "./p2b-markets.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";

const refU64 = (d: Uint8Array, off: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
const refU128 = (d: Uint8Array, off: number) => refU64(d, off) | (refU64(d, off + 8) << 64n);

test("readU64/readU128: 10k random buffers match the per-read-DataView reference", () => {
  for (let i = 0; i < 10000; i++) {
    const len = 16 + Math.floor(Math.random() * 64);
    const raw = new Uint8Array(len + 8);
    for (let j = 0; j < raw.length; j++) raw[j] = Math.floor(Math.random() * 256);
    const d = raw.subarray(1 + (i % 7), 1 + (i % 7) + len); // non-zero byteOffset
    const off = Math.floor(Math.random() * (len - 15));
    assert.equal(readU64(d, off), refU64(d, off));
    assert.equal(readU128(d, off), refU128(d, off));
  }
});

test("readU128 known value and out-of-range throws", () => {
  const d = new Uint8Array(16);
  d[0] = 1; d[15] = 0x80;
  assert.equal(readU128(d, 0), 1n | (0x80n << 120n));
  assert.throws(() => readU128(d, 1), RangeError);
});

test("readVaultMarketSnapshots: keys are the derived PDAs, bad address skipped, failed chunk omitted", async () => {
  const programId = Keypair.generate().publicKey;
  const m1 = Keypair.generate().publicKey;
  const seen: PublicKey[][] = [];
  const conn: any = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      seen.push(keys);
      return { context: { slot: 9 }, value: keys.map(() => null) };
    },
  };
  const refs = [
    { marketAddress: m1.toBase58(), label: "a", assetIndex: 0 },
    { marketAddress: "not-a-key", label: "bad", assetIndex: 0 },
  ];
  for (let pass = 0; pass < 2; pass++) { // second pass hits the memo
    const out = await readVaultMarketSnapshots(conn, programId, refs);
    assert.equal(out.size, 1);
    const s = out.get(m1.toBase58())!;
    assert.equal(s.slot, 9);
    assert.equal(s.marketData, null);
    assert.equal(s.vaultLp, null);
    assert.equal(s.bound, false);
    const k = seen[pass];
    assert.equal(k.length, 3);
    assert.ok(k[0].equals(m1));
    assert.ok(k[1].equals(deriveLpVaultRegistry(programId, m1)[0]));
    assert.ok(k[2].equals(deriveVaultLpState(programId, m1)));
  }
  const failing: any = { getMultipleAccountsInfoAndContext: async () => { throw new Error("rpc"); } };
  assert.equal((await readVaultMarketSnapshots(failing, programId, refs)).size, 0);
});

test("readVaultMarketSnapshots: chunks of 33 markets", async () => {
  const programId = Keypair.generate().publicKey;
  const refs = Array.from({ length: 70 }, (_, i) => ({ marketAddress: Keypair.generate().publicKey.toBase58(), label: `${i}`, assetIndex: 0 }));
  const sizes: number[] = [];
  const conn: any = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      sizes.push(keys.length);
      return { context: { slot: 1 }, value: keys.map(() => null) };
    },
  };
  assert.equal((await readVaultMarketSnapshots(conn, programId, refs)).size, 70);
  assert.deepEqual(sizes, [99, 99, 12]);
});
