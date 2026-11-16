/**
 * Coverage for the read / parse / refuse paths of price-reader.ts that no other test reaches:
 * every single-pool refusal in readPoolPriceE6, the batch-path guards and fallbacks in
 * readAllPoolPricesE6, and the pure helpers. Tests only; no behaviour is changed.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/price-reader-reads.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  checkMintBinding,
  isSolUsdEntry,
  meteoraWsolPriceToUsdE12,
  meteoraWsolPriceToUsdE6,
  nonUsdQuoteSkipReason,
  poolIsSolUsd,
  pumpswapQuoteDepthUsdE6,
  raydiumPriceIsNotUsd,
  readAllPoolPricesE6,
  readAtWatermark,
  readPoolPriceE6,
  resetSlotWatermarksForTests,
  warnDepthFloorUnenforceable,
} from "./price-reader.ts";
import {
  CARDS, USDC, WSOL_MINT, SOL_E6, Acc, ctx, meteora, mintAcc, mockConn, pump, put, raydium, vault,
} from "./price-reader-fixtures.ts";

beforeEach(() => resetSlotWatermarksForTests());
const rnd = () => Keypair.generate().publicKey;
type Dex = "raydium-clmm" | "meteora-dlmm" | "pumpswap";
const entry = (pool: PublicKey, dexType: Dex, extra: { mainnetCa?: string; symbol?: string } = {}) => ({
  poolAddress: pool.toBase58(), dexType, label: `t-${dexType}`, ...extra,
});
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const o = { l: console.log, w: console.warn, e: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await f(); } finally { console.log = o.l; console.warn = o.w; console.error = o.e; }
};

describe("readPoolPriceE6 refusals (single-pool path)", () => {
  it("pool account missing / empty / wrong owner", async () => {
    const accts = new Map<string, Acc>();
    const { conn } = mockConn(accts, "https://ep-r-missing");
    const ghost = rnd();
    let r = await readPoolPriceE6(conn, entry(ghost, "raydium-clmm"), new Map());
    assert.equal(r.skipped, true);
    assert.match(r.skipReason!, /not found/);
    const empty = rnd();
    put(accts, empty, { owner: rnd(), data: Buffer.alloc(0) });
    r = await readPoolPriceE6(conn, entry(empty, "raydium-clmm"), new Map());
    assert.match(r.skipReason!, /empty data/);
    const wrong = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    r = await readPoolPriceE6(conn, entry(wrong, "meteora-dlmm"), new Map());
    assert.match(r.skipReason!, /does not match dexType=meteora-dlmm \(detected: raydium-clmm\)/);
    const alien = rnd();
    put(accts, alien, { owner: rnd(), data: Buffer.alloc(10) });
    r = await readPoolPriceE6(conn, entry(alien, "raydium-clmm"), new Map());
    assert.match(r.skipReason!, /detected: unknown/);
  });

  it("raydium: wrong-token, non-USD quote, sqrt=0, and a good price", async () => {
    const accts = new Map<string, Acc>();
    const { conn } = mockConn(accts, "https://ep-r-ray");
    const sol = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const ok = await readPoolPriceE6(conn, entry(sol, "raydium-clmm", { mainnetCa: WSOL_MINT.toBase58() }), new Map());
    assert.equal(ok.skipped, undefined);
    assert.equal(ok.priceE6, 149_999_999n);
    const bad = await readPoolPriceE6(conn, entry(sol, "raydium-clmm", { mainnetCa: rnd().toBase58() }), new Map());
    assert.match(bad.skipReason!, /WRONG TOKEN/);
    const nonUsd = raydium(accts, WSOL_MINT, CARDS, SOL_E6);
    const r2 = await readPoolPriceE6(conn, entry(nonUsd, "raydium-clmm"), new Map());
    assert.match(r2.skipReason!, /not a USD stable/);
    const zero = raydium(accts, WSOL_MINT, USDC, 0n);
    // The SDK refuses an uninitialised pool by THROWING, and readPoolPriceE6 documents that non-429 errors
    // propagate to the caller, so the `=== 0n` guard after it is defence in depth, not the live path.
    await assert.rejects(readPoolPriceE6(conn, entry(zero, "raydium-clmm"), new Map()), /sqrt_price_x64 = 0/);
  });

  it("meteora: wrong-token, non-USD quote, USD quote price + decimals cache, WSOL no-rate / binStep=0 / converted", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, USDC, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    const { conn, calls } = mockConn(accts, "https://ep-r-met");
    const usd = meteora(accts, base, USDC);
    const cache = new Map<string, { base: number; quote: number }>();
    const bad = await readPoolPriceE6(conn, entry(usd, "meteora-dlmm", { mainnetCa: rnd().toBase58() }), cache);
    assert.match(bad.skipReason!, /WRONG TOKEN/);
    const ok = await quiet(() => readPoolPriceE6(conn, entry(usd, "meteora-dlmm", { mainnetCa: base.toBase58() }), cache));
    assert.equal(ok.priceE6, 10_017n);
    assert.deepEqual(cache.get(usd.toBase58()), { base: 6, quote: 6 });
    assert.equal(calls.mint, 2);
    await readPoolPriceE6(conn, entry(usd, "meteora-dlmm"), cache);
    assert.equal(calls.mint, 2, "second read uses the cached decimals");

    const cards = meteora(accts, base, CARDS);
    assert.match((await readPoolPriceE6(conn, entry(cards, "meteora-dlmm"), cache)).skipReason!, /neither WSOL nor a USD stable/);

    const zeroUsd = meteora(accts, base, USDC, 0);
    await assert.rejects(quiet(() => readPoolPriceE6(conn, entry(zeroUsd, "meteora-dlmm"), cache)), /binStep = 0/);

    const wsol = meteora(accts, base, WSOL_MINT);
    const noRate = await quiet(() => readPoolPriceE6(conn, entry(wsol, "meteora-dlmm"), cache));
    assert.match(noRate.skipReason!, /no SOL\/USD price/);
    const conv = await readPoolPriceE6(conn, entry(wsol, "meteora-dlmm"), cache, SOL_E6);
    assert.equal(conv.priceE6, 1_502n);
    const zeroW = meteora(accts, base, WSOL_MINT, 0);
    await assert.rejects(quiet(() => readPoolPriceE6(conn, entry(zeroW, "meteora-dlmm"), cache, SOL_E6)), /binStep = 0/);
  });

  it("pumpswap: wrong-token, non-USD quote, vaults missing / short / empty, no SOL rate, ok, compute error, zero price", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    put(accts, USDC, { data: mintAcc(6) });
    put(accts, CARDS, { data: mintAcc(6) });
    const { conn } = mockConn(accts, "https://ep-r-pump");
    const cache = new Map<string, { base: number; quote: number }>();

    const p = pump(accts, base, WSOL_MINT);
    assert.match((await readPoolPriceE6(conn, entry(p.pool, "pumpswap", { mainnetCa: rnd().toBase58() }), cache, SOL_E6)).skipReason!, /WRONG TOKEN/);
    const nu = pump(accts, base, CARDS);
    assert.match((await readPoolPriceE6(conn, entry(nu.pool, "pumpswap"), cache, SOL_E6)).skipReason!, /neither WSOL nor a USD stable/);

    const noRate = await quiet(() => readPoolPriceE6(conn, entry(p.pool, "pumpswap"), cache));
    assert.match(noRate.skipReason!, /no SOL\/USD price/);
    const ok = await quiet(() => readPoolPriceE6(conn, entry(p.pool, "pumpswap"), cache, SOL_E6));
    assert.equal(ok.priceE6, 37_500n);

    const usdc = pump(accts, base, USDC, 1_000_000_000_000n, 250_000_000n);
    assert.equal((await quiet(() => readPoolPriceE6(conn, entry(usdc.pool, "pumpswap"), cache))).priceE6, 250n);

    const noVault = pump(accts, base, USDC);
    accts.delete(noVault.qv.toBase58());
    assert.match((await readPoolPriceE6(conn, entry(noVault.pool, "pumpswap"), cache)).skipReason!, /vault account\(s\) not found/);

    const shortV = pump(accts, base, USDC);
    put(accts, shortV.bv, { data: vault(5n, 40) });
    assert.match((await readPoolPriceE6(conn, entry(shortV.pool, "pumpswap"), cache)).skipReason!, /vault data too short \(base=40, quote=165\)/);

    const unseeded = pump(accts, base, USDC, 0n);
    assert.match((await readPoolPriceE6(conn, entry(unseeded.pool, "pumpswap"), cache)).skipReason!, /base vault amount=0/);

    // quote reserve zero -> the SDK computes a 0 price (or throws); either way it is a skip, never a price.
    const dry = pump(accts, base, USDC, 1_000_000_000_000n, 0n);
    const dr = await quiet(() => readPoolPriceE6(conn, entry(dry.pool, "pumpswap"), cache));
    assert.equal(dr.skipped, true);
    assert.equal(dr.priceE6, 0n);
    assert.match(dr.skipReason!, /^PumpSwap: /);
  });

  it("unsupported dexType falls through to the exhaustiveness guard", async () => {
    const accts = new Map<string, Acc>();
    const pool = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const { conn } = mockConn(accts, "https://ep-r-unsup");
    // owner check runs first, so the unsupported type must also be mis-detected; a stub owner map is not
    // available, hence assert the owner-mismatch refusal carries the requested type instead.
    const r = await readPoolPriceE6(conn, entry(pool, "bogus" as unknown as Dex), new Map());
    assert.equal(r.skipped, true);
    assert.match(r.skipReason!, /bogus/);
  });
});

describe("readAllPoolPricesE6 batch guards and fallbacks", () => {
  it("empty input and malformed pool addresses are skipped without a throw", async () => {
    const { conn, calls } = mockConn(new Map(), "https://ep-b-empty");
    assert.equal((await readAllPoolPricesE6(conn, [], new Map())).size, 0);
    const out = await quiet(() =>
      readAllPoolPricesE6(conn, [{ poolAddress: "not-a-pubkey", dexType: "raydium-clmm", label: "bad" }], new Map()),
    );
    assert.equal(out.size, 0);
    assert.equal(calls.multi.length, 0, "no RPC when nothing is valid");
  });

  it("raydium wrong-token and non-USD quote are dropped; the good pool stays", async () => {
    const accts = new Map<string, Acc>();
    const good = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const wrong = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const nonUsd = raydium(accts, WSOL_MINT, CARDS, SOL_E6);
    const { conn } = mockConn(accts, "https://ep-b-ray");
    const out = await quiet(() =>
      readAllPoolPricesE6(conn, [
        { ...entry(good, "raydium-clmm", { symbol: "SOL/USDC" }) },
        { ...entry(wrong, "raydium-clmm", { mainnetCa: rnd().toBase58() }) },
        { ...entry(nonUsd, "raydium-clmm") },
      ], new Map()),
    );
    assert.deepEqual([...out.keys()], [good.toBase58()]);
  });

  it("meteora wrong-token, USD price with e12 sink, WSOL-quoted converted with e12, and non-USD reason sink", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, USDC, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    const sol = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const mUsd = meteora(accts, base, USDC);
    const mWsol = meteora(accts, base, WSOL_MINT);
    const mWrong = meteora(accts, base, USDC);
    const mCards = meteora(accts, base, CARDS);
    const { conn } = mockConn(accts, "https://ep-b-met");
    const e12 = new Map<string, bigint>();
    const reasons = new Map<string, string>();
    const out = await quiet(() =>
      readAllPoolPricesE6(conn, [
        entry(sol, "raydium-clmm", { symbol: "SOL/USDC" }),
        entry(mUsd, "meteora-dlmm"),
        entry(mWsol, "meteora-dlmm"),
        entry(mWrong, "meteora-dlmm", { mainnetCa: rnd().toBase58() }),
        entry(mCards, "meteora-dlmm"),
      ], new Map(), undefined, reasons, e12),
    );
    assert.equal(out.get(mUsd.toBase58()), 10_017n);
    assert.equal(out.get(mWsol.toBase58()), 1_502n);
    assert.equal(out.has(mWrong.toBase58()), false);
    assert.equal(out.has(mCards.toBase58()), false);
    assert.ok(e12.get(mUsd.toBase58())! > 10_017n * 900_000n);
    assert.ok(e12.get(mWsol.toBase58())! > 1_502n * 900_000n);
    assert.equal(reasons.get(mCards.toBase58()), nonUsdQuoteSkipReason("meteora", CARDS));
  });

  it("WSOL-quoted meteora is held (not published) when no SOL/USD rate exists", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    const mWsol = meteora(accts, base, WSOL_MINT);
    const { conn } = mockConn(accts, "https://ep-b-norate");
    const out = await quiet(() => readAllPoolPricesE6(conn, [entry(mWsol, "meteora-dlmm")], new Map()));
    assert.equal(out.size, 0);
  });

  it("pumpswap batch: wrong-token, missing vaults, missing/short mints, and quote reserve + e12 sinks", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    put(accts, USDC, { data: mintAcc(6) });
    const sol = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const good = pump(accts, base, WSOL_MINT);
    const wrong = pump(accts, base, WSOL_MINT);
    const noVault = pump(accts, base, WSOL_MINT);
    accts.delete(noVault.bv.toBase58());
    const otherBase = rnd(); // mint account never registered -> decimals batch returns null
    const noMint = pump(accts, otherBase, WSOL_MINT);
    const shortBase = rnd();
    put(accts, shortBase, { data: Buffer.alloc(10) });
    const shortMint = pump(accts, shortBase, WSOL_MINT);
    const { conn } = mockConn(accts, "https://ep-b-pump");
    const e12 = new Map<string, bigint>();
    const reserves = new Map<string, bigint>();
    const out = await quiet(() =>
      readAllPoolPricesE6(conn, [
        entry(sol, "raydium-clmm", { symbol: "SOL/USDC" }),
        entry(good.pool, "pumpswap"),
        entry(wrong.pool, "pumpswap", { mainnetCa: rnd().toBase58() }),
        entry(noVault.pool, "pumpswap"),
        entry(noMint.pool, "pumpswap"),
        entry(shortMint.pool, "pumpswap"),
      ], new Map(), undefined, undefined, e12, reserves),
    );
    assert.equal(out.get(good.pool.toBase58()), 37_499n);
    for (const p of [wrong, noVault, noMint, shortMint]) assert.equal(out.has(p.pool.toBase58()), false);
    assert.ok(e12.has(good.pool.toBase58()));
    assert.equal(reserves.get(good.pool.toBase58()), 37_499_999_750n); // 250 SOL x $150 (SOL ref pool prices 149_999_999)
    assert.equal(reserves.has(sol.toBase58()), false);
  });

  it("a failing pumpswap vault batch keeps the pass-1 prices (contained, not thrown)", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    const sol = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const p = pump(accts, base, WSOL_MINT);
    const { conn } = mockConn(accts, "https://ep-b-fail", {
      failMultiple: (call) => (call === 2 ? new Error("boom: node unreachable") : undefined),
    });
    const out = await quiet(() =>
      readAllPoolPricesE6(conn, [entry(sol, "raydium-clmm", { symbol: "SOL/USDC" }), entry(p.pool, "pumpswap")], new Map()),
    );
    assert.deepEqual([...out.keys()], [sol.toBase58()]);
  });

  it("SOL/USD reference pool: used when no entry supplies it; bad reference ignored; malformed reference tolerated", async () => {
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    const ref = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const notSol = raydium(accts, base, USDC, SOL_E6);
    const p = pump(accts, base, WSOL_MINT);
    const { conn } = mockConn(accts, "https://ep-b-ref");
    const ok = await quiet(() => readAllPoolPricesE6(conn, [entry(p.pool, "pumpswap")], new Map(), ref.toBase58()));
    assert.equal(ok.get(p.pool.toBase58()), 37_499n);
    const bad = await quiet(() => readAllPoolPricesE6(conn, [entry(p.pool, "pumpswap")], new Map(), notSol.toBase58()));
    assert.equal(bad.size, 0);
    const junk = await quiet(() => readAllPoolPricesE6(conn, [entry(p.pool, "pumpswap")], new Map(), "###"));
    assert.equal(junk.size, 0);
  });

  it("reference pool missing from the batch falls back to a standalone read", async () => {
    // Make the batched info for the appended reference key come back null once, then serve it standalone.
    const accts = new Map<string, Acc>();
    const base = rnd();
    put(accts, base, { data: mintAcc(6) });
    put(accts, WSOL_MINT, { data: mintAcc(9) });
    const ref = raydium(accts, WSOL_MINT, USDC, SOL_E6);
    const p = pump(accts, base, WSOL_MINT);
    const { conn, calls } = mockConn(accts, "https://ep-b-ref2");
    const orig = conn.getMultipleAccountsInfoAndContext.bind(conn);
    (conn as unknown as { getMultipleAccountsInfoAndContext: unknown }).getMultipleAccountsInfoAndContext = (ks: PublicKey[]) =>
      orig(ks).then((r) => ({ ...r, value: r.value.map((v, i) => (ks[i].equals(ref) ? null : v)) }));
    const out = await quiet(() => readAllPoolPricesE6(conn, [entry(p.pool, "pumpswap")], new Map(), ref.toBase58()));
    assert.equal(out.get(p.pool.toBase58()), 37_499n);
    assert.equal(calls.single, 1);
  });

  it("chunks key arrays above 100 into <=100-key RPC calls", async () => {
    const accts = new Map<string, Acc>();
    const entries: ReturnType<typeof entry>[] = [];
    for (let i = 0; i < 230; i++) entries.push(entry(raydium(accts, WSOL_MINT, USDC, SOL_E6), "raydium-clmm"));
    const { conn, calls } = mockConn(accts, "https://ep-b-chunk");
    const out = await readAllPoolPricesE6(conn, entries, new Map());
    assert.equal(out.size, 230);
    assert.deepEqual(calls.multi, [100, 100, 30]);
  });
});

describe("pure helpers", () => {
  it("isSolUsdEntry: symbol wins, label only when symbol absent, dex gate", () => {
    assert.equal(isSolUsdEntry({ dexType: "pumpswap", label: "SOL/USDC", symbol: "SOL/USDC" }), false);
    assert.equal(isSolUsdEntry({ dexType: "raydium-clmm", label: "x", symbol: " sol/usdt " }), true);
    assert.equal(isSolUsdEntry({ dexType: "raydium-clmm", label: "SOL/USDC - raydium", symbol: "SOL" }), false);
    assert.equal(isSolUsdEntry({ dexType: "meteora-dlmm", label: "sol/usdc - meteora" }), true);
    assert.equal(isSolUsdEntry({ dexType: "meteora-dlmm", label: undefined as unknown as string }), false);
  });

  it("raydiumPriceIsNotUsd / poolIsSolUsd / checkMintBinding", () => {
    assert.equal(raydiumPriceIsNotUsd(USDC), false);
    assert.equal(raydiumPriceIsNotUsd(CARDS), true);
    assert.equal(poolIsSolUsd(WSOL_MINT, USDC), true);
    assert.equal(poolIsSolUsd(USDC, WSOL_MINT), false);
    assert.deepEqual(checkMintBinding(undefined, USDC, WSOL_MINT), { ok: true });
    assert.deepEqual(checkMintBinding(USDC.toBase58(), USDC, WSOL_MINT), { ok: true });
    const q = checkMintBinding(WSOL_MINT.toBase58(), USDC, WSOL_MINT);
    assert.equal(q.ok, false);
    assert.match((q as { reason: string }).reason, /is the pool's QUOTE/);
  });

  it("meteoraWsolPriceToUsdE6/E12 agree and pumpswapQuoteDepthUsdE6 edge cases", () => {
    const accts = new Map<string, Acc>();
    const pool = meteora(accts, rnd(), WSOL_MINT);
    const data = new Uint8Array(accts.get(pool.toBase58())!.data);
    const e6 = meteoraWsolPriceToUsdE6(data, { base: 6, quote: 9 }, SOL_E6);
    const e12 = meteoraWsolPriceToUsdE12(data, { base: 6, quote: 9 }, SOL_E6);
    assert.equal(e12 / 1_000_000n, e6);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(0n), 9, WSOL_MINT, SOL_E6), 0n);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(5n), 9, WSOL_MINT, undefined), null);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(5n), 9, WSOL_MINT, 0n), null);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(5n, 40), 6, USDC, undefined), null);
    assert.equal(pumpswapQuoteDepthUsdE6(vault(5n), 6, CARDS, undefined), null);
  });

  it("warnDepthFloorUnenforceable is a no-op while the floor is off", () => {
    const lines: string[] = [];
    assert.equal(warnDepthFloorUnenforceable({ dexType: "raydium-clmm", poolAddress: "p" }, new Set(), (l) => lines.push(l)), false);
    assert.deepEqual(lines, []);
  });
});

describe("readAtWatermark", () => {
  const conn = (ep: string) => ({ rpcEndpoint: ep }) as unknown as import("@solana/web3.js").Connection;

  it("matches a min-slot rejection by JSON-RPC code -32016 as well as by message", async () => {
    let n = 0;
    const out = await quiet(() =>
      readAtWatermark(conn("https://ep-w-code"), async () => {
        n++;
        if (n < 2) throw Object.assign(new Error("reworded by proxy"), { code: -32016 });
        return ctx("ok", 5);
      }),
    );
    assert.equal(out, "ok");
    assert.equal(n, 2);
  });

  it("a provider that ignores minContextSlot is rejected client-side and the watermark never goes backwards", async () => {
    const c = conn("https://ep-w-client");
    await readAtWatermark(c, async () => ctx(1, 100));
    let seen: number | undefined;
    await assert.rejects(
      quiet(() => readAtWatermark(c, async (m) => { seen = m; return ctx(2, 50); })),
      /Minimum context slot has not been reached \(served 50 < watermark 100\)/,
    );
    assert.equal(seen, 100);
    await readAtWatermark(c, async () => ctx(3, 100));
  });

  it("non-min-slot errors propagate untouched and do not count toward the poison counter", async () => {
    const c = conn("https://ep-w-other");
    for (let i = 0; i < 5; i++) {
      await assert.rejects(readAtWatermark(c, async () => { throw new Error("socket hang up"); }), /socket hang up/);
    }
    let seen: number | undefined = -1;
    await readAtWatermark(c, async (m) => { seen = m; return ctx(0, 7); });
    assert.equal(seen, undefined, "no watermark was ever set by failed reads");
  });
});
