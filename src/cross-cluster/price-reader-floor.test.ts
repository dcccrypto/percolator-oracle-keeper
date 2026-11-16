/**
 * The liquidity floor (MIN_POOL_LIQUIDITY_USD, read once at module load) on both read paths of
 * price-reader.ts: the single-pool refusal and the batch refusal, plus the #212 "unenforceable"
 * warning. The env var is set BEFORE a dynamic import, so this file runs the module with a $1,000
 * floor; the default-off behaviour is covered by the other price-reader tests.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/price-reader-floor.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { USDC, WSOL_MINT, Acc, meteora, mintAcc, mockConn, pump, put, raydium, SOL_E6 } from "./price-reader-fixtures.ts";

process.env.MIN_POOL_LIQUIDITY_USD = "1000";
const pr = await import("./price-reader.ts");
const rnd = () => Keypair.generate().publicKey;
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const o = { l: console.log, w: console.warn, e: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await f(); } finally { console.log = o.l; console.warn = o.w; console.error = o.e; }
};

describe("liquidity floor ($1,000)", () => {
  it("is parsed from the env", () => {
    assert.equal(pr.MIN_POOL_LIQUIDITY_USD_E6, 1_000_000_000n);
  });

  it("single-pool path refuses a thin pool, quoting its depth, and prices a deep one", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, USDC, { data: mintAcc(6) });
    const thin = pump(accts, base, USDC, 1_000_000_000_000n, 250_000_000n); // $250
    const deep = pump(accts, base, USDC, 1_000_000_000_000n, 5_000_000_000n); // $5,000
    const { conn } = mockConn(accts, "https://ep-f-single");
    const cache = new Map<string, { base: number; quote: number }>();
    const e = (p: { pool: import("@solana/web3.js").PublicKey }) => ({
      poolAddress: p.pool.toBase58(), dexType: "pumpswap" as const, label: "t",
    });
    const t = await quiet(() => pr.readPoolPriceE6(conn, e(thin), cache));
    assert.equal(t.skipped, true);
    assert.match(t.skipReason!, /below the liquidity floor \(depth=\$250\.00 < \$1000\.00\)/);
    const d = await quiet(() => pr.readPoolPriceE6(conn, e(deep), cache));
    assert.equal(d.skipped, undefined);
    assert.equal(d.priceE6, 5_000n);
  });

  it("single-pool path: an unmeasurable depth (WSOL quote, no SOL rate) is refused as 'unknown'... after the no-rate guard", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    const p = pump(accts, base, WSOL_MINT);
    const { conn } = mockConn(accts, "https://ep-f-unknown");
    // No rate: refused by the earlier no-rate guard (the floor never sees an unconvertible quote).
    const r = await quiet(() => pr.readPoolPriceE6(conn, { poolAddress: p.pool.toBase58(), dexType: "pumpswap", label: "t" }, new Map()));
    assert.match(r.skipReason!, /no SOL\/USD price/);
    // With a rate, 250 SOL x $150 = $37,500 clears the floor.
    const ok = await quiet(() => pr.readPoolPriceE6(conn, { poolAddress: p.pool.toBase58(), dexType: "pumpswap", label: "t" }, new Map(), SOL_E6));
    assert.equal(ok.priceE6, 37_500n);
  });

  it("batch path drops thin pools (floor) and publishes deep ones", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, USDC, { data: mintAcc(6) });
    const thin = pump(accts, base, USDC, 1_000_000_000_000n, 250_000_000n);
    const deep = pump(accts, base, USDC, 1_000_000_000_000n, 5_000_000_000n);
    const { conn } = mockConn(accts, "https://ep-f-batch");
    const reserves = new Map<string, bigint>();
    const out = await quiet(() =>
      pr.readAllPoolPricesE6(conn, [
        { poolAddress: thin.pool.toBase58(), dexType: "pumpswap", label: "thin" },
        { poolAddress: deep.pool.toBase58(), dexType: "pumpswap", label: "deep" },
      ], new Map(), undefined, undefined, undefined, reserves),
    );
    assert.equal(out.has(thin.pool.toBase58()), false);
    assert.equal(out.get(deep.pool.toBase58()), 5_000n);
    assert.equal(reserves.get(deep.pool.toBase58()), 5_000_000_000n);
  });

  it("#212: warns once per non-pumpswap pool that the floor cannot apply; pumpswap never warns", () => {
    const lines: string[] = [];
    const warned = new Set<string>();
    const log = (l: string) => lines.push(l);
    const ray = { dexType: "raydium-clmm", poolAddress: "poolA", label: "SOL/USDC" };
    assert.equal(pr.warnDepthFloorUnenforceable(ray, warned, log), true);
    assert.equal(pr.warnDepthFloorUnenforceable(ray, warned, log), false, "once per pool");
    assert.equal(pr.warnDepthFloorUnenforceable({ dexType: "meteora-dlmm", poolAddress: "poolB" }, warned, log), true);
    assert.equal(pr.warnDepthFloorUnenforceable({ dexType: "pumpswap", poolAddress: "poolC" }, warned, log), false);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /SOL\/USDC \(raydium-clmm\).*\$1000\.00 floor does not apply/);
    assert.match(lines[1], /poolB \(meteora-dlmm\)/);
  });

  it("the default logger and the shared warned-set are used when none are passed (readPoolPriceE6 on a raydium pool)", async () => {
    const accts = new Map<string, Acc>();
    const pool = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const mpool = meteora(accts, rnd(), USDC);
    put(accts, USDC, { data: mintAcc(6) });
    const { conn } = mockConn(accts, "https://ep-f-default");
    const lines: string[] = [];
    const ow = console.warn;
    console.warn = (l: string) => { lines.push(String(l)); };
    try {
      await pr.readPoolPriceE6(conn, { poolAddress: pool.toBase58(), dexType: "raydium-clmm", label: "R" }, new Map());
      await pr.readPoolPriceE6(conn, { poolAddress: pool.toBase58(), dexType: "raydium-clmm", label: "R" }, new Map());
    } finally { console.warn = ow; }
    void mpool;
    assert.equal(lines.filter((l) => l.includes("NOT ENFORCEABLE")).length, 1);
  });
});
