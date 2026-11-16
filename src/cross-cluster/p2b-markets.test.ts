import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM, registryBytes, vaultLpStateBytes } from "./p2b-test-helpers.ts";
import { readU128, readU64, readVaultMarketSnapshots } from "./p2b-markets.ts";
import type { MarketRef, SnapshotConnection } from "./p2b-markets.ts";

type Acc = { data: Uint8Array } | null;

const ref = (market: PublicKey, label = "m"): MarketRef => ({ marketAddress: market.toBase58(), label, assetIndex: 0 });

/** Fake conn: `answer(keys, callIndex)` gives the account list, or throws. */
function conn(answer: (keys: PublicKey[], call: number) => Acc[]) {
  const calls: PublicKey[][] = [];
  const c: SnapshotConnection = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      calls.push(keys);
      return { context: { slot: 777 }, value: answer(keys, calls.length - 1) } as never;
    },
  };
  return { c, calls };
}

describe("readVaultMarketSnapshots", () => {
  it("reads market + registry + vault_lp_state and reports flags and slot", async () => {
    const market = Keypair.generate().publicKey;
    const lp = Keypair.generate().publicKey;
    const { c, calls } = conn(() => [{ data: new Uint8Array([1, 2, 3]) }, { data: registryBytes({ bound: true, ext: true }) }, { data: vaultLpStateBytes({ lp }) }]);
    const out = await readVaultMarketSnapshots(c, PROGRAM, [ref(market)]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 3);
    assert.ok(calls[0][0].equals(market));
    const s = out.get(market.toBase58())!;
    assert.equal(s.slot, 777);
    assert.deepEqual([...s.marketData!], [1, 2, 3]);
    assert.ok(s.registry);
    assert.equal(s.bound, true);
    assert.equal(s.extFlag, true);
    assert.ok(s.vaultLp!.lpPortfolio.equals(lp));
  });

  it("missing accounts -> nulls and false flags", async () => {
    const market = Keypair.generate().publicKey;
    const { c } = conn(() => [null, null, null]);
    const s = (await readVaultMarketSnapshots(c, PROGRAM, [ref(market)])).get(market.toBase58())!;
    assert.equal(s.marketData, null);
    assert.equal(s.registryData, null);
    assert.equal(s.registry, null);
    assert.equal(s.bound, false);
    assert.equal(s.extFlag, false);
    assert.equal(s.vaultLp, null);
  });

  it("an unparseable registry leaves registry null; an invalid bound byte reads as unbound", async () => {
    const market = Keypair.generate().publicKey;
    const short = { data: new Uint8Array(8) };
    const r1 = (await readVaultMarketSnapshots(conn(() => [null, short, null]).c, PROGRAM, [ref(market)])).get(market.toBase58())!;
    assert.equal(r1.registry, null);
    assert.ok(r1.registryData);
    assert.equal(r1.bound, false);
    assert.equal(r1.extFlag, false);
    const bad = { data: registryBytes({ boundByte: 7 }) };
    const r2 = (await readVaultMarketSnapshots(conn(() => [null, bad, null]).c, PROGRAM, [ref(market)])).get(market.toBase58())!;
    assert.ok(r2.registry, "registry still parses");
    assert.equal(r2.bound, false, "bound flag 7 is invalid -> false");
  });

  it("an invalid market address is skipped; the rest of the chunk is still read in order", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const { c, calls } = conn(() => [{ data: new Uint8Array([1]) }, null, null, { data: new Uint8Array([2]) }, null, null]);
    const out = await readVaultMarketSnapshots(c, PROGRAM, [ref(a), { marketAddress: "not-a-key", label: "bad", assetIndex: 0 }, ref(b)]);
    assert.equal(calls[0].length, 6);
    assert.equal(out.size, 2);
    assert.deepEqual([...out.get(a.toBase58())!.marketData!], [1]);
    assert.deepEqual([...out.get(b.toBase58())!.marketData!], [2]);
  });

  it("all-invalid chunk makes no RPC call; empty input too", async () => {
    const { c, calls } = conn(() => []);
    assert.equal((await readVaultMarketSnapshots(c, PROGRAM, [{ marketAddress: "x", label: "x", assetIndex: 0 }])).size, 0);
    assert.equal((await readVaultMarketSnapshots(c, PROGRAM, [])).size, 0);
    assert.equal(calls.length, 0);
  });

  it("chunks at 33 markets (99 keys); a failed chunk drops only its markets and never throws", async () => {
    const markets = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
    const { c, calls } = conn((keys, call) => {
      if (call === 0) throw new Error("rpc down");
      return keys.map(() => null);
    });
    const out = await readVaultMarketSnapshots(c, PROGRAM, markets.map((m) => ref(m)));
    assert.deepEqual(calls.map((k) => k.length), [99, 21]);
    assert.equal(out.size, 7);
    for (const m of markets.slice(0, 33)) assert.equal(out.has(m.toBase58()), false);
    for (const m of markets.slice(33)) assert.equal(out.has(m.toBase58()), true);
  });
});

describe("readU64 / readU128", () => {
  it("little-endian, honours the byteOffset of a subarray view", () => {
    const buf = new Uint8Array(40);
    const dv = new DataView(buf.buffer);
    dv.setBigUint64(8, 0x0102030405060708n, true);
    dv.setBigUint64(16, 0xffn, true);
    assert.equal(readU64(buf, 8), 0x0102030405060708n);
    assert.equal(readU128(buf, 8), 0x0102030405060708n | (0xffn << 64n));
    assert.equal(readU64(buf.subarray(8), 0), 0x0102030405060708n);
  });
});
