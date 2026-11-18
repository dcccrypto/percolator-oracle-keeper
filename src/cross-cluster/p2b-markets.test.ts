import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readVaultMarketSnapshots, readU64, readU128 } from "./p2b-markets.ts";
import type { MarketRef } from "./p2b-markets.ts";
import { PROGRAM, registryBytes, vaultLpStateBytes, patchedMarket, deriveLpVaultRegistry, deriveVaultLpState } from "./p2b-test-helpers.ts";

const ref = (addr: string, i = 0): MarketRef => ({ marketAddress: addr, label: `m${i}`, assetIndex: 0 });
const acct = (data: Uint8Array) => ({ data: Buffer.from(data), executable: false, lamports: 1, owner: PROGRAM });

type Calls = PublicKey[][];
function conn(fn: (keys: PublicKey[]) => Array<ReturnType<typeof acct> | null>, calls: Calls = [], slot = 77) {
  return {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      calls.push(keys);
      return { context: { slot }, value: fn(keys) };
    },
  } as never;
}

describe("readVaultMarketSnapshots", () => {
  it("returns an empty map for no markets and makes no RPC call", async () => {
    const calls: Calls = [];
    const out = await readVaultMarketSnapshots(conn(() => [], calls), PROGRAM, []);
    assert.equal(out.size, 0);
    assert.equal(calls.length, 0);
  });

  it("skips a bad market address and makes no RPC call when every address is bad", async () => {
    const calls: Calls = [];
    const out = await readVaultMarketSnapshots(conn(() => [], calls), PROGRAM, [ref("not-a-pubkey")]);
    assert.equal(out.size, 0);
    assert.equal(calls.length, 0);
  });

  it("keeps good markets aligned when a bad address sits between them", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const calls: Calls = [];
    const aData = patchedMarket();
    const c = conn((keys) => keys.map((k) => (k.equals(a) ? acct(aData) : null)), calls);
    const out = await readVaultMarketSnapshots(c, PROGRAM, [ref(a.toBase58(), 0), ref("bad", 1), ref(b.toBase58(), 2)]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 6);
    assert.deepEqual([...out.keys()], [a.toBase58(), b.toBase58()]);
    assert.equal(out.get(a.toBase58())!.marketData!.length, aData.length);
    assert.equal(out.get(b.toBase58())!.marketData, null);
    assert.equal(out.get(b.toBase58())!.slot, 77);
  });

  it("missing registry and vault_lp_state: nulls and false flags", async () => {
    const m = Keypair.generate().publicKey;
    const out = await readVaultMarketSnapshots(conn((k) => k.map(() => null)), PROGRAM, [ref(m.toBase58())]);
    const s = out.get(m.toBase58())!;
    assert.equal(s.marketData, null);
    assert.equal(s.registryData, null);
    assert.equal(s.registry, null);
    assert.equal(s.bound, false);
    assert.equal(s.extFlag, false);
    assert.equal(s.vaultLp, null);
    assert.ok(s.market.equals(m));
  });

  it("queries market, registry PDA, vault_lp_state PDA in that order and decodes all three", async () => {
    const m = Keypair.generate().publicKey;
    const lp = Keypair.generate().publicKey;
    const calls: Calls = [];
    const reg = registryBytes({ bound: true, ext: true });
    const vl = vaultLpStateBytes({ lp });
    const out = await readVaultMarketSnapshots(
      conn(() => [acct(patchedMarket()), acct(reg), acct(vl)], calls),
      PROGRAM,
      [ref(m.toBase58())],
    );
    assert.ok(calls[0][0].equals(m));
    assert.ok(calls[0][1].equals(deriveLpVaultRegistry(PROGRAM, m)[0]));
    assert.ok(calls[0][2].equals(deriveVaultLpState(PROGRAM, m)));
    const s = out.get(m.toBase58())!;
    assert.ok(s.registry);
    assert.equal(s.bound, true);
    assert.equal(s.extFlag, true);
    assert.ok(s.vaultLp);
    assert.ok(s.vaultLp!.lpPortfolio.equals(lp));
  });

  it("unparseable registry: registry null, flags still read from the bytes", async () => {
    const m = Keypair.generate().publicKey;
    const short = new Uint8Array(200).fill(0); // too short/garbage for the parser
    short[160] = 1;
    short[161] = 1;
    const out = await readVaultMarketSnapshots(conn(() => [null, acct(short), null]), PROGRAM, [ref(m.toBase58())]);
    const s = out.get(m.toBase58())!;
    assert.equal(s.registry, null);
    assert.equal(s.bound, true);
    assert.equal(s.extFlag, true);
  });

  it("invalid bound byte: bound false (never throws), registry still parsed", async () => {
    const m = Keypair.generate().publicKey;
    const out = await readVaultMarketSnapshots(
      conn(() => [null, acct(registryBytes({ boundByte: 7 })), null]),
      PROGRAM,
      [ref(m.toBase58())],
    );
    const s = out.get(m.toBase58())!;
    assert.equal(s.bound, false);
    assert.ok(s.registry);
  });

  it("duplicate refs: one entry per address, last one wins, both queried", async () => {
    const m = Keypair.generate().publicKey;
    const calls: Calls = [];
    const out = await readVaultMarketSnapshots(
      conn((k) => k.map(() => null), calls),
      PROGRAM,
      [{ marketAddress: m.toBase58(), label: "first", assetIndex: 0 }, { marketAddress: m.toBase58(), label: "second", assetIndex: 1 }],
    );
    assert.equal(calls[0].length, 6);
    assert.equal(out.size, 1);
    assert.equal(out.get(m.toBase58())!.ref.label, "second");
  });

  it("a thrown chunk leaves its markets out, other chunks survive", async () => {
    const ms = Array.from({ length: 34 }, () => Keypair.generate().publicKey);
    let n = 0;
    const c = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        n++;
        if (n === 1) throw new Error("rpc down");
        return { context: { slot: 5 }, value: keys.map(() => null) };
      },
    } as never;
    const out = await readVaultMarketSnapshots(c, PROGRAM, ms.map((p, i) => ref(p.toBase58(), i)));
    assert.equal(n, 2);
    assert.equal(out.size, 1);
    assert.ok(out.has(ms[33].toBase58()));
  });

  it("chunks at 33 markets (99 keys) per RPC", async () => {
    const ms = Array.from({ length: 67 }, () => Keypair.generate().publicKey);
    const calls: Calls = [];
    const out = await readVaultMarketSnapshots(conn((k) => k.map(() => null), calls), PROGRAM, ms.map((p, i) => ref(p.toBase58(), i)));
    assert.deepEqual(calls.map((c) => c.length), [99, 99, 3]);
    assert.equal(out.size, 67);
  });
});

describe("readU64 / readU128", () => {
  it("reads little-endian values at an offset, honouring the view's byteOffset", () => {
    const buf = new Uint8Array(40);
    const dv = new DataView(buf.buffer);
    dv.setBigUint64(8, 0x0102030405060708n, true);
    dv.setBigUint64(16, 0xaan, true);
    dv.setBigUint64(24, 3n, true);
    const view = buf.subarray(8);
    assert.equal(readU64(view, 0), 0x0102030405060708n);
    assert.equal(readU128(view, 8), 0xaan | (3n << 64n));
  });
});
