/**
 * G8 depth input for PushAuthMark: exact math, wire layout, flag-off byte identity, venue gating.
 * Run with: node --import tsx/esm --test src/cross-cluster/push-depth.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { WSOL_MINT, encodePushAuthMark } from "@percolatorct/sdk";
import {
  isqrt,
  plus2PctDepthE6,
  pushDepthEnabled,
  resolvePushDepth,
  encodePushAuthMarkMaybeDepth,
  encodePushAuthMarkDexMode,
  PUSH_AUTH_MARK_LEN,
  PUSH_AUTH_MARK_WITH_DEPTH_LEN,
  DEPTH_SOURCE_PUMPSWAP_CPMM,
} from "./push-depth.ts";
import { buildPushAuthMarkIx } from "./auth-mark-pusher.ts";
import { readAllPoolPricesE6, resetSlotWatermarksForTests } from "./price-reader.ts";

beforeEach(() => resetSlotWatermarksForTests());

const ARGS = { assetIndex: 3, marketId: 7n, nowSlot: 123_456_789n, markE6: 1_234_567n, observationSequence: 42n };

describe("isqrt", () => {
  it("is floor(sqrt(n)) at small, boundary and huge values", () => {
    for (const [n, r] of [[0n, 0n], [1n, 1n], [2n, 1n], [3n, 1n], [4n, 2n], [8n, 2n], [9n, 3n], [10n ** 24n, 10n ** 12n]] as const) {
      assert.equal(isqrt(n), r, `isqrt(${n})`);
    }
    const big = 3n ** 200n + 12345n;
    const r = isqrt(big);
    assert.ok(r * r <= big && (r + 1n) * (r + 1n) > big);
    assert.throws(() => isqrt(-1n), RangeError);
  });
});

describe("plus2PctDepthE6 = floor(R * (1 - 1/sqrt(1.02)))", () => {
  // Hand/high-precision vectors (Decimal, 60 digits): R * 0.00985245702332569...
  const VECTORS: Array<[bigint, bigint]> = [
    [1_000_000n * 1_000_000n, 9_852_457_023n], // 1,000,000 USDC -> 9,852.457023 USDC
    [25_000n * 1_000_000n, 246_311_425n], // $25k reserve -> $246.311425
    [123_456_789n, 1_216_352n],
    [0n, 0n],
    [1n, 0n],
    [100n, 0n], // 0.985 floors to 0
    [102n, 1n], // 1.0049 -> 1
  ];
  for (const [r, want] of VECTORS) {
    it(`R=${r} -> ${want}`, () => assert.equal(plus2PctDepthE6(r), want));
  }

  it("is the exact floor: depth <= true value < depth + 1 (integer inequality, no float)", () => {
    // true = R - R*sqrt(50/51). depth = floor(true)  <=>  (R-depth)^2 * 51 >= 50 R^2  and  (R-depth+1)^2 * 51 < 50 R^2 ... checked via m = R - depth
    for (const r of [1n, 7n, 101n, 102n, 999_999n, 10n ** 9n, 25_000_000_000n, 10n ** 12n + 1n, 10n ** 15n, (1n << 63n) + 12345n]) {
      const d = plus2PctDepthE6(r);
      const m = r - d; // = ceil(R*sqrt(50/51))
      assert.ok(51n * m * m >= 50n * r * r, `m too small for R=${r}`);
      assert.ok(m === 0n || 51n * (m - 1n) * (m - 1n) < 50n * r * r, `m not minimal for R=${r}`);
    }
  });

  it("never overstates the exact real-valued depth, and is monotone", () => {
    let prev = 0n;
    for (let r = 0n; r < 5000n; r += 7n) {
      const d = plus2PctDepthE6(r);
      assert.ok(d >= prev);
      assert.ok(d * 1_000_000_000n <= r * 9_852_457_024n); // true factor is 0.009852457023325...
      prev = d;
    }
  });
  it("rejects a negative reserve", () => assert.throws(() => plus2PctDepthE6(-1n), RangeError));
});

describe("KEEPER_PUSH_DEPTH flag", () => {
  it("defaults OFF; explicit words turn it on or off; anything else refuses (a typo is never a silent OFF)", () => {
    assert.equal(pushDepthEnabled({}), false);
    for (const v of ["", "0", "off", "false", "no", "OFF"]) assert.equal(pushDepthEnabled({ KEEPER_PUSH_DEPTH: v }), false, v);
    for (const v of ["1", "true", "TRUE", " on ", "yes"]) assert.equal(pushDepthEnabled({ KEEPER_PUSH_DEPTH: v }), true, v);
    for (const v of ["2", "maybe", "onn", "enabled"]) assert.throws(() => pushDepthEnabled({ KEEPER_PUSH_DEPTH: v }), /KEEPER_PUSH_DEPTH="/, v);
  });
});

describe("resolvePushDepth", () => {
  it("flag off -> null even with a reserve", () => assert.equal(resolvePushDepth(false, 10n ** 12n), null));
  it("no reserve / zero reserve / zero depth -> null (no guess)", () => {
    assert.equal(resolvePushDepth(true, undefined), null);
    assert.equal(resolvePushDepth(true, 0n), null);
    assert.equal(resolvePushDepth(true, 50n), null);
  });
  it("on + reserve -> attested CPMM depth", () => {
    assert.deepEqual(resolvePushDepth(true, 10n ** 12n), { depthE6: 9_852_457_023n, source: DEPTH_SOURCE_PUMPSWAP_CPMM });
  });
});

describe("PushAuthMark wire", () => {
  it("no depth: byte-identical to the SDK 35 B encoding (flag-off identity)", () => {
    const legacy = encodePushAuthMark(ARGS);
    assert.equal(legacy.length, 35);
    assert.deepEqual(encodePushAuthMarkMaybeDepth(ARGS), legacy);
    assert.deepEqual(encodePushAuthMarkMaybeDepth(ARGS, null), legacy);
    const ix = buildPushAuthMarkIx(Keypair.generate().publicKey, Keypair.generate().publicKey, 3, 7n, 123_456_789n, 1_234_567n, 42n);
    assert.deepEqual(new Uint8Array(ix.data), legacy);
    const ixNull = buildPushAuthMarkIx(Keypair.generate().publicKey, Keypair.generate().publicKey, 3, 7n, 123_456_789n, 1_234_567n, 42n, null);
    assert.deepEqual(new Uint8Array(ixNull.data), legacy);
  });

  it("with depth: 44 B = the 35 B + [mode 1][depth u64 LE]", () => {
    const d = { depthE6: 0x0102030405060708n, source: DEPTH_SOURCE_PUMPSWAP_CPMM };
    const data = encodePushAuthMarkMaybeDepth(ARGS, d);
    assert.equal(data.length, 44);
    assert.deepEqual(data.slice(0, 35), encodePushAuthMark(ARGS));
    assert.equal(data[0], 63);
    assert.equal(data[35], 1);
    assert.deepEqual([...data.slice(36)], [8, 7, 6, 5, 4, 3, 2, 1]);
    // field offsets of the 35 B head: [63][u16 asset][u64 market][u64 now][u64 mark][u64 seq]
    const dv = new DataView(data.buffer, data.byteOffset);
    assert.equal(dv.getUint16(1, true), 3);
    assert.equal(dv.getBigUint64(3, true), 7n);
    assert.equal(dv.getBigUint64(11, true), 123_456_789n);
    assert.equal(dv.getBigUint64(19, true), 1_234_567n);
    assert.equal(dv.getBigUint64(27, true), 42n);
    const ix = buildPushAuthMarkIx(Keypair.generate().publicKey, Keypair.generate().publicKey, 3, 7n, 123_456_789n, 1_234_567n, 42n, d);
    assert.deepEqual(new Uint8Array(ix.data), data);
  });

  it("refuses a zero or over-u64 depth instead of sending it", () => {
    assert.throws(() => encodePushAuthMarkMaybeDepth(ARGS, { depthE6: 0n, source: "x" }), RangeError);
    assert.throws(() => encodePushAuthMarkMaybeDepth(ARGS, { depthE6: 1n << 64n, source: "x" }), RangeError);
  });
});

// ── price-reader: which venues expose a quote reserve ────────────────────────
const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_E6 = 117_753_929n;
const mint = Keypair.generate().publicKey;
const baseVault = Keypair.generate().publicKey;
const quoteVault = Keypair.generate().publicKey;
function pumpPool(quoteMint: PublicKey): Buffer {
  const b = Buffer.alloc(301);
  mint.toBuffer().copy(b, 43);
  quoteMint.toBuffer().copy(b, 75);
  baseVault.toBuffer().copy(b, 139);
  quoteVault.toBuffer().copy(b, 171);
  return b;
}
function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}
function raydiumSolUsd(): Buffer {
  const b = Buffer.alloc(300);
  WSOL_MINT.toBuffer().copy(b, 73);
  USDC.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  const target = (SOL_E6 << 128n) / 1_000_000_000n;
  const x = isqrt(target);
  b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(x >> 64n, 261);
  return b;
}
const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });

describe("quote reserves exposed by the price reader", () => {
  it("USDC-quoted pumpswap: reserve = quote vault in USD e6; CLMM exposes none", async () => {
    const poolP = Keypair.generate().publicKey.toBase58();
    const poolC = Keypair.generate().publicKey.toBase58();
    let call = 0;
    const conn = {
      rpcEndpoint: "https://ep-depth-1",
      getMultipleAccountsInfoAndContext: () =>
        Promise.resolve(
          ctx(
            call++ === 0
              ? [
                  { owner: PUMPSWAP_OWNER, data: pumpPool(USDC) },
                  { owner: RAYDIUM_CLMM_OWNER, data: raydiumSolUsd() },
                ]
              : [{ data: vault(1_000_000_000_000n) }, { data: vault(1_000_000_000_000n) }],
          ),
        ),
    } as unknown as Connection;
    const reserves = new Map<string, bigint>();
    const out = await readAllPoolPricesE6(
      conn,
      [
        { poolAddress: poolP, dexType: "pumpswap", label: "P", symbol: "P" },
        { poolAddress: poolC, dexType: "raydium-clmm", label: "SOL/USDC", symbol: "SOL/USDC" },
      ],
      new Map([[poolP, { base: 6, quote: 6 }]]),
      undefined,
      undefined,
      undefined,
      reserves,
    );
    assert.ok((out.get(poolC) ?? 0n) > 0n);
    assert.ok((out.get(poolP) ?? 0n) > 0n);
    assert.equal(reserves.get(poolP), 1_000_000_000_000n); // 1,000,000 USDC
    assert.equal(reserves.has(poolC), false); // not constant-product -> no depth, ever
    assert.deepEqual(resolvePushDepth(true, reserves.get(poolP)), { depthE6: 9_852_457_023n, source: DEPTH_SOURCE_PUMPSWAP_CPMM });
    assert.equal(resolvePushDepth(true, reserves.get(poolC)), null);
  });

  it("WSOL-quoted pumpswap converts the reserve with the same SOL/USD rate as the price", async () => {
    const solPool = Keypair.generate().publicKey.toBase58();
    const catPool = Keypair.generate().publicKey.toBase58();
    let call = 0;
    const QUOTE = 245_409_236_912n; // 245.4 SOL, 9dp
    const conn = {
      rpcEndpoint: "https://ep-depth-2",
      getMultipleAccountsInfoAndContext: () =>
        Promise.resolve(
          ctx(
            call++ === 0
              ? [
                  { owner: RAYDIUM_CLMM_OWNER, data: raydiumSolUsd() },
                  { owner: PUMPSWAP_OWNER, data: pumpPool(WSOL_MINT) },
                ]
              : [{ data: vault(135_682_102_366_305n) }, { data: vault(QUOTE) }],
          ),
        ),
    } as unknown as Connection;
    const reserves = new Map<string, bigint>();
    const out = await readAllPoolPricesE6(
      conn,
      [
        { poolAddress: solPool, dexType: "raydium-clmm", label: "SOL/USDC", symbol: "SOL/USDC" },
        { poolAddress: catPool, dexType: "pumpswap", label: "CAT", symbol: "CAT" },
      ],
      new Map([[catPool, { base: 6, quote: 9 }]]),
      undefined,
      undefined,
      undefined,
      reserves,
    );
    const sol = out.get(solPool)!;
    assert.equal(reserves.get(catPool), (QUOTE * sol) / 1_000_000_000n);
    assert.equal(reserves.has(solPool), false);
  });

  it("an unreadable vault yields a price skip and no reserve (35 B form)", async () => {
    const pool = Keypair.generate().publicKey.toBase58();
    let call = 0;
    const conn = {
      rpcEndpoint: "https://ep-depth-3",
      getMultipleAccountsInfoAndContext: () =>
        Promise.resolve(ctx(call++ === 0 ? [{ owner: PUMPSWAP_OWNER, data: pumpPool(USDC) }] : [null, null])),
    } as unknown as Connection;
    const reserves = new Map<string, bigint>();
    await readAllPoolPricesE6(conn, [{ poolAddress: pool, dexType: "pumpswap", label: "P", symbol: "P" }], new Map([[pool, { base: 6, quote: 6 }]]), undefined, undefined, undefined, reserves);
    assert.equal(reserves.size, 0);
  });
});

describe("isqrt / plus2PctDepthE6 against a BigInt reference", () => {
  // Independent reference: binary search for the largest r with r*r <= n.
  const refSqrt = (n: bigint): bigint => {
    let lo = 0n;
    let hi = 1n << BigInt(Math.floor(n.toString(2).length / 2) + 2);
    while (lo < hi) {
      const mid = (lo + hi + 1n) >> 1n;
      if (mid * mid <= n) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  };

  it("isqrt equals floor(sqrt(n)) for small values, perfect squares and their neighbours", () => {
    const inputs: bigint[] = [0n, 1n, 2n, 3n, 4n, (1n << 64n) - 1n, 1n << 64n, 1n << 128n, (1n << 128n) - 1n, (1n << 128n) + 1n];
    for (const r of [5n, 9n, 10n, 1000n, 123456789n, (1n << 32n) - 1n, 1n << 32n, (1n << 64n) + 12345n]) inputs.push(r * r - 1n, r * r, r * r + 1n);
    for (const n of inputs) assert.equal(isqrt(n), refSqrt(n), `isqrt(${n})`);
    assert.equal(isqrt(0n), 0n);
    assert.equal(isqrt(1n), 1n);
    assert.equal(isqrt(2n), 1n);
    assert.equal(isqrt(3n), 1n);
    assert.equal(isqrt(4n), 2n);
    assert.equal(isqrt((1n << 64n) - 1n), (1n << 32n) - 1n);
    assert.equal(isqrt(1n << 128n), 1n << 64n);
  });

  it("isqrt rejects a negative input with RangeError", () => {
    assert.throws(() => isqrt(-1n), RangeError);
    assert.throws(() => isqrt(-(1n << 100n)), RangeError);
  });

  it("plus2PctDepthE6 = r - m, m the smallest integer with 51*m^2 >= 50*r^2", () => {
    const rs: bigint[] = [1n, 2n, 3n, 7n, 50n, 51n, 100n, 999n, 1_000_000n, 25_000_000_000n, 123_456_789_012n, (1n << 64n) - 1n];
    for (let r = 1n; r <= 200n; r++) rs.push(r);
    for (const r of rs) {
      const target = 50n * r * r;
      let m = 0n; // reference: linear/binary search of the definition, not the production correction loops
      let lo = 0n;
      let hi = r;
      while (lo < hi) {
        const mid = (lo + hi) >> 1n;
        if (51n * mid * mid >= target) hi = mid;
        else lo = mid + 1n;
      }
      m = lo;
      assert.ok(51n * m * m >= target, `m satisfies the inequality for r=${r}`);
      assert.ok(m === 0n || 51n * (m - 1n) * (m - 1n) < target, `m-1 does not for r=${r}`);
      assert.equal(plus2PctDepthE6(r), r - m, `depth(${r})`);
    }
  });

  it("plus2PctDepthE6: zero reserve is 0n, negative throws RangeError", () => {
    assert.equal(plus2PctDepthE6(0n), 0n);
    assert.throws(() => plus2PctDepthE6(-1n), RangeError);
  });
});

describe("encodePushAuthMarkDexMode", () => {
  it("is the SDK 35 B + [mode 2][depth 0 u64] (44 B), and the 35 B prefix is byte-identical to the SDK", () => {
    const args = ARGS;
    const base = encodePushAuthMark(args);
    const out = encodePushAuthMarkDexMode(args);
    assert.equal(out.length, PUSH_AUTH_MARK_WITH_DEPTH_LEN);
    assert.deepEqual(out.subarray(0, PUSH_AUTH_MARK_LEN), base);
    assert.equal(out[PUSH_AUTH_MARK_LEN], 2);
    assert.deepEqual([...out.subarray(PUSH_AUTH_MARK_LEN + 1)], new Array(8).fill(0));
  });
});
