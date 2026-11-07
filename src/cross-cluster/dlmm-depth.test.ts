/**
 * Meteora DLMM +-2% executable depth (observe-only). Run: node --import tsx/esm --test src/cross-cluster/dlmm-depth.test.ts
 * Synthetic pools are built here from the lb_clmm layout with an INDEPENDENT float price; the closed-form / brute-force
 * expectations use floats, the implementation uses bigint Q64.64.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { computeDexSpotPriceE6 } from "@percolatorct/sdk";
import {
  BIN_ARRAY_LEN,
  BINS_PER_ARRAY,
  binArrayAddress,
  binArrayIndexOf,
  computeDlmmDepth,
  planDlmmBinArrays,
  priceQ64,
} from "./dlmm-depth.ts";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const disc = (n: string) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8);
const Q64 = 2 ** 64;

function poolBytes(o: { activeId: number; binStep: number; x?: PublicKey; y?: PublicKey }): Buffer {
  const b = Buffer.alloc(904);
  disc("LbPair").copy(b, 0);
  b.writeInt32LE(o.activeId, 76);
  b.writeUInt16LE(o.binStep, 80);
  (o.x ?? Keypair.generate().publicKey).toBuffer().copy(b, 88);
  (o.y ?? USDC).toBuffer().copy(b, 120);
  return b;
}
/** A bin array at `index`; `fill(id)` gives the bin's [x, y] atoms. Stored price = independent float price. */
function binArray(pool: PublicKey, index: number, binStep: number, fill: (id: number) => [bigint, bigint]): Buffer {
  const b = Buffer.alloc(BIN_ARRAY_LEN);
  disc("BinArray").copy(b, 0);
  b.writeBigInt64LE(BigInt(index), 8);
  b[16] = 1;
  pool.toBuffer().copy(b, 24);
  for (let j = 0; j < BINS_PER_ARRAY; j++) {
    const id = index * BINS_PER_ARRAY + j;
    const o = 56 + j * 144;
    const [x, y] = fill(id);
    b.writeBigUInt64LE(x, o);
    b.writeBigUInt64LE(y, o + 8);
    const p = BigInt(Math.floor(Math.pow(1 + binStep / 1e4, id) * Q64));
    b.writeBigUInt64LE(p & ((1n << 64n) - 1n), o + 16);
    b.writeBigUInt64LE(p >> 64n, o + 24);
  }
  return b;
}
const dec = { base: 9, quote: 6 };

describe("bin array addressing", () => {
  it("floors toward -infinity for negative ids and matches the lb_clmm seeds", () => {
    assert.equal(binArrayIndexOf(0), 0);
    assert.equal(binArrayIndexOf(69), 0);
    assert.equal(binArrayIndexOf(70), 1);
    assert.equal(binArrayIndexOf(-1), -1);
    assert.equal(binArrayIndexOf(-70), -1);
    assert.equal(binArrayIndexOf(-71), -2);
    // Real mainnet pool: SOL/USDC's active-bin array address is a live account (fixture below proves it by decoding).
    const pool = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    const fx = JSON.parse(readFileSync(new URL("./__fixtures__/dlmm/sol-usdc.json", import.meta.url), "utf8"));
    for (const a of fx.binArrays) assert.equal(binArrayAddress(pool, a.index).toBase58(), a.address);
  });
});

describe("priceQ64", () => {
  it("matches a float price within 1e-12 for positive and negative ids", () => {
    for (const [id, step] of [[0, 25], [100, 25], [-100, 25], [-8000, 10], [4000, 100]] as const) {
      const got = Number(priceQ64(id, step)) / Q64;
      const want = Math.pow(1 + step / 1e4, id);
      assert.ok(Math.abs(got - want) / want < 1e-12, `${id}/${step}: ${got} vs ${want}`);
    }
  });
});

describe("planDlmmBinArrays", () => {
  it("bin ranges are the exact +2%/-2% ids (closed form), arrays follow", () => {
    // step 25 bps: ln(1.02)/ln(1.0025) = 7.93 -> 7 bins up; ln(1/0.98)/ln(1.0025) = 8.09 -> 8 bins down
    const p = planDlmmBinArrays(poolBytes({ activeId: 68, binStep: 25 }));
    assert.ok(p.ok);
    assert.equal(p.binsUp, 7);
    assert.equal(p.binsDown, 8);
    assert.deepEqual(p.indexes, [0, 1]); // ids 60..75
  });
  it("negative ids", () => {
    const p = planDlmmBinArrays(poolBytes({ activeId: -3, binStep: 25 }));
    assert.ok(p.ok);
    assert.deepEqual(p.indexes, [-1, 0]); // ids -11..4
  });
  it("refuses a wrong discriminator, a short account, binStep 0 and absurd values", () => {
    const good = poolBytes({ activeId: 1, binStep: 25 });
    const bad = Buffer.from(good); bad[0] ^= 1;
    assert.equal(planDlmmBinArrays(bad).ok, false);
    assert.equal(planDlmmBinArrays(good.subarray(0, 200)).ok, false);
    assert.equal(planDlmmBinArrays(poolBytes({ activeId: 1, binStep: 0 })).ok, false);
    assert.equal(planDlmmBinArrays(poolBytes({ activeId: 600000, binStep: 25 })).ok, false);
    assert.equal(planDlmmBinArrays(poolBytes({ activeId: 1, binStep: 10001 })).ok, false);
  });
});

describe("computeDlmmDepth, synthetic uniform liquidity vs closed form / brute force", () => {
  const pool = Keypair.generate().publicKey;
  const step = 25;
  const activeId = 68;
  const UNIT = 1_000_000_000n; // 1e9 atoms in every X bin above/at active and every Y bin below/at active
  const fill = (id: number): [bigint, bigint] => [id >= activeId ? UNIT : 0n, id <= activeId ? UNIT : 0n];
  const arrays = (): Map<number, Uint8Array | null> =>
    new Map([[0, binArray(pool, 0, step, fill)], [1, binArray(pool, 1, step, fill)]]);
  const data = poolBytes({ activeId, binStep: step });

  it("ask = sum of x*price over active..+7, bid = sum of y over -8..active (brute force, floats)", () => {
    const r = computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: arrays(), decimals: dec });
    assert.ok(r.ok, r.ok ? "" : r.reason);
    let ask = 0, bid = 0;
    const p0 = Math.pow(1 + step / 1e4, activeId);
    for (let id = 0; id < 200; id++) {
      const pr = Math.pow(1 + step / 1e4, id);
      if (id >= activeId && pr <= p0 * 1.02) ask += Number(UNIT) * pr;
      if (id <= activeId && pr >= p0 * 0.98) bid += Number(UNIT);
    }
    const d = r.depth;
    assert.equal(d.bidQuoteAtoms, 9n * UNIT); // active + 8 below
    assert.ok(Math.abs(Number(d.askQuoteAtoms) - ask) / ask < 1e-9, `${d.askQuoteAtoms} vs ${ask}`);
    // USD stable quote with 6 decimals: atoms/1e6 = USD, e6 = atoms; rounded down
    assert.equal(d.bidUsdE6, d.bidQuoteAtoms);
    assert.equal(d.askUsdE6, d.askQuoteAtoms);
    assert.equal(d.minUsdE6, d.askUsdE6 < d.bidUsdE6 ? d.askUsdE6 : d.bidUsdE6);
    assert.deepEqual(d.binArrays, [0, 1]);
  });

  it("the active bin counts only its own side: ask uses X, bid uses Y", () => {
    const only = (id: number): [bigint, bigint] => (id === activeId ? [5_000_000n, 7_000_000n] : [0n, 0n]);
    const m = new Map<number, Uint8Array | null>([[0, binArray(pool, 0, step, only)], [1, binArray(pool, 1, step, only)]]);
    const r = computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: dec });
    assert.ok(r.ok);
    assert.equal(r.depth.bidQuoteAtoms, 7_000_000n);
    const want = Math.floor(5_000_000 * Math.pow(1 + step / 1e4, activeId));
    assert.ok(Math.abs(Number(r.depth.askQuoteAtoms) - want) <= 1);
  });

  it("liquidity just outside the 2% window is not counted", () => {
    const out = (id: number): [bigint, bigint] => [id === activeId + 8 ? UNIT : 0n, id === activeId - 9 ? UNIT : 0n];
    const m = new Map<number, Uint8Array | null>([[0, binArray(pool, 0, step, out)], [1, binArray(pool, 1, step, out)]]);
    const r = computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: dec });
    assert.ok(r.ok);
    assert.equal(r.depth.askQuoteAtoms, 0n);
    assert.equal(r.depth.bidQuoteAtoms, 0n);
  });

  it("a missing bin array covering the range -> refusal (null), never a partial sum", () => {
    const m = arrays(); m.set(1, null);
    const r = computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: dec });
    assert.equal(r.ok, false);
    const m2 = arrays(); m2.delete(0);
    assert.equal(computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m2, decimals: dec }).ok, false);
  });

  it("layout checks fail closed: wrong lb_pair, wrong index, wrong disc, short, stored price off", () => {
    const tamper = (f: (b: Buffer) => void) => {
      const m = arrays(); const b = Buffer.from(m.get(1)!); f(b); m.set(1, b);
      return computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: dec }).ok;
    };
    assert.equal(tamper((b) => { b[24] ^= 1; }), false);
    assert.equal(tamper((b) => { b.writeBigInt64LE(5n, 8); }), false);
    assert.equal(tamper((b) => { b[0] ^= 1; }), false);
    // a bin with liquidity whose stored price is 1% off the bin-step price
    assert.equal(tamper((b) => { b.writeBigUInt64LE(b.readBigUInt64LE(56 + 3 * 144 + 24) + 1n, 56 + 3 * 144 + 24); b[56 + 3 * 144 + 24 + 7] ^= 1; }), false);
    const m = arrays(); m.set(1, m.get(1)!.subarray(0, 5000));
    assert.equal(computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: dec }).ok, false);
    const wrongPool = Keypair.generate().publicKey;
    assert.equal(computeDlmmDepth({ lbPair: wrongPool, poolData: data, binArrays: arrays(), decimals: dec }).ok, false);
  });

  it("unknown / out-of-range decimals -> refusal", () => {
    for (const d of [undefined, { base: -1, quote: 6 }, { base: 9, quote: 25 }, { base: 1.5, quote: 6 }]) {
      assert.equal(computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: arrays(), decimals: d as never }).ok, false);
    }
  });

  it("a quote that is neither USD stable nor WSOL is refused", () => {
    const odd = poolBytes({ activeId, binStep: step, y: Keypair.generate().publicKey });
    const r = computeDlmmDepth({ lbPair: pool, poolData: odd, binArrays: arrays(), decimals: dec });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /quote/i);
  });

  it("WSOL quote converts with the SOL/USD rate (rounded down); without a rate -> refusal", () => {
    const w = poolBytes({ activeId, binStep: step, y: WSOL });
    const d9 = { base: 6, quote: 9 };
    const r = computeDlmmDepth({ lbPair: pool, poolData: w, binArrays: arrays(), decimals: d9, solPriceE6: 150_123_456n });
    assert.ok(r.ok);
    // bid: 9 bins x 1e9 lamports = 9 SOL * $150.123456 = $1351.111104
    assert.equal(r.depth.bidQuoteAtoms, 9_000_000_000n);
    assert.equal(r.depth.bidUsdE6, 1_351_111_104n);
    assert.equal(computeDlmmDepth({ lbPair: pool, poolData: w, binArrays: arrays(), decimals: d9 }).ok, false);
    assert.equal(computeDlmmDepth({ lbPair: pool, poolData: w, binArrays: arrays(), decimals: d9, solPriceE6: 0n }).ok, false);
  });

  it("a USD result that does not fit a u64 -> refusal", () => {
    const huge = (id: number): [bigint, bigint] => [0n, id <= activeId ? (1n << 64n) - 1n : 0n];
    const m = new Map<number, Uint8Array | null>([[0, binArray(pool, 0, step, huge)], [1, binArray(pool, 1, step, huge)]]);
    const r = computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: dec });
    assert.equal(r.ok, false);
  });
});

/** [bid, ask] USD e6 at the capture slots; independently recomputed by the PR #262 reviewer (exact integer bin walk). */
const PINNED: Record<string, [bigint, bigint]> = {
  "sol-usdc.json": [277_415_463_261n, 405_111_879_296n],
  "pengu.json": [8_348_663_275n, 9_342_004_749n],
};

describe("computeDlmmDepth on captured MAINNET pools", () => {
  const load = (f: string) => {
    const fx = JSON.parse(readFileSync(new URL(`./__fixtures__/dlmm/${f}`, import.meta.url), "utf8"));
    const m = new Map<number, Uint8Array | null>();
    for (const a of fx.binArrays) m.set(a.index, a.data ? new Uint8Array(Buffer.from(a.data, "base64")) : null);
    return { fx, pool: new PublicKey(fx.pool), data: new Uint8Array(Buffer.from(fx.poolData, "base64")), m };
  };
  for (const [file, label, slot] of [["sol-usdc.json", "SOL/USDC 5rCf1DM8", 466602787], ["pengu.json", "PENGU DdMA1cHc", 466602807]] as const) {
    it(`${label}: slot ${slot}, spot matches the price-reader DLMM price, depth is sane and equals an independent float walk`, () => {
      const { fx, pool, data, m } = load(file);
      assert.equal(fx.slot, slot);
      const d = { base: fx.baseDecimals, quote: fx.quoteDecimals };
      const plan = planDlmmBinArrays(data);
      assert.ok(plan.ok);
      for (const i of plan.indexes) assert.ok(m.get(i), `fixture lacks array ${i}`);
      const r = computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: d });
      assert.ok(r.ok, r.ok ? "" : r.reason);
      const sdk = Number(computeDexSpotPriceE6("meteora-dlmm", data, undefined, d));
      const mine = Number(r.depth.spotQuotePerBaseE6);
      assert.ok(Math.abs(mine - sdk) / sdk < 1e-5, `spot ${mine} vs sdk ${sdk}`);
      // independent walk straight off the bytes (floats, stored price)
      const buf = Buffer.from(data);
      const active = buf.readInt32LE(76);
      const bs = buf.readUInt16LE(80);
      const bin = (id: number) => {
        const a = Buffer.from(m.get(binArrayIndexOf(id))!);
        const o = 56 + (((id % 70) + 70) % 70) * 144;
        const price = (Number(a.readBigUInt64LE(o + 24)) * 2 ** 64 + Number(a.readBigUInt64LE(o + 16))) / Q64;
        return { x: Number(a.readBigUInt64LE(o)), y: Number(a.readBigUInt64LE(o + 8)), price };
      };
      const p0 = bin(active).price;
      let ask = 0, bid = 0;
      for (let id = active - 400; id <= active + 400; id++) {
        const pr = Math.pow(1 + bs / 1e4, id - active) * p0;
        if (!m.get(binArrayIndexOf(id))) continue;
        const b = bin(id);
        if (id >= active && pr <= p0 * 1.02) ask += b.x * b.price;
        if (id <= active && pr >= p0 * 0.98) bid += b.y;
      }
      assert.ok(Math.abs(Number(r.depth.askQuoteAtoms) - ask) / Math.max(ask, 1) < 1e-6, `ask ${r.depth.askQuoteAtoms} vs ${ask}`);
      assert.ok(Math.abs(Number(r.depth.bidQuoteAtoms) - bid) / Math.max(bid, 1) < 1e-6, `bid ${r.depth.bidQuoteAtoms} vs ${bid}`);
      assert.ok(r.depth.bidUsdE6 > 0n && r.depth.askUsdE6 > 0n);
      assert.equal(r.depth.minUsdE6, r.depth.bidUsdE6 < r.depth.askUsdE6 ? r.depth.bidUsdE6 : r.depth.askUsdE6);
      const pin = PINNED[file];
      assert.deepEqual([r.depth.bidUsdE6, r.depth.askUsdE6], pin, `pinned e6 figures for ${label}`);
      console.log(`[fixture ${label} slot ${slot}] activeId=${r.depth.activeId} binStep=${r.depth.binStep} spot=${r.depth.spotQuotePerBaseE6} bid=$${Number(r.depth.bidUsdE6) / 1e6} ask=$${Number(r.depth.askUsdE6) / 1e6} min=$${Number(r.depth.minUsdE6) / 1e6} arrays=${r.depth.binArrays}`);
    });
  }
  it("removing a needed array from a real pool -> null", () => {
    const { fx, pool, data, m } = load("sol-usdc.json");
    const plan = planDlmmBinArrays(data);
    assert.ok(plan.ok);
    m.delete(plan.indexes[0]);
    assert.equal(computeDlmmDepth({ lbPair: pool, poolData: data, binArrays: m, decimals: { base: fx.baseDecimals, quote: fx.quoteDecimals } }).ok, false);
  });
});
