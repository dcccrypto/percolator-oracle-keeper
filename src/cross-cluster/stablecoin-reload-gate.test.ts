/**
 * r8: stablecoin gate on the registry.json hot reload (the only admission path of the v2.2 devnet keeper, where register-poll is disabled).
 * Run with: node --import tsx/esm --test src/cross-cluster/stablecoin-reload-gate.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { reloadRegistryOnce, startRegistryReloadLoop } from "./registry-reload.ts";
import { classifyNewRow, reloadRegistryGated, resetStablecoinReloadLogState, warnBootStablecoinRows } from "./stablecoin-reload-gate.ts";
import type { MarketEntry, Registry } from "./registry.ts";

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USD1 = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");
const SUSD = new PublicKey("susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const MEME = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

const pumpPool = (base: PublicKey, quote: PublicKey): Buffer => {
  const b = Buffer.alloc(301);
  base.toBuffer().copy(b, 43);
  quote.toBuffer().copy(b, 75);
  Keypair.generate().publicKey.toBuffer().copy(b, 139);
  Keypair.generate().publicKey.toBuffer().copy(b, 171);
  return b;
};

/** A mainnet connection double: records every call, and has no send method at all. */
function fakeConn(pools: Map<string, { owner: PublicKey; data: Buffer } | null>, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    getAccountInfo: async (k: PublicKey) => {
      calls.push(k.toBase58());
      if (opts.fail) throw new Error("rpc down");
      const v = pools.get(k.toBase58());
      return v ? { owner: v.owner, data: v.data, lamports: 1, executable: false } : null;
    },
  };
}

const kp = () => Keypair.generate().publicKey.toBase58();
const row = (label: string, pool: string, extra: Partial<MarketEntry> = {}): MarketEntry =>
  ({ label, marketAddress: kp(), poolAddress: pool, dexType: "pumpswap", assetIndex: 0, ...extra }) as MarketEntry;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stable-reload-"));
let n = 0;
const write = (markets: unknown[]): string => {
  const p = path.join(tmp, `r${n++}.json`);
  fs.writeFileSync(p, JSON.stringify({ version: 1, description: "d", markets }));
  return p;
};
const lines: string[] = [];
const origWarn = console.warn;
beforeEach(() => {
  resetStablecoinReloadLogState();
  lines.length = 0;
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
});
const restore = () => { console.warn = origWarn; };

describe("classifyNewRow", () => {
  const stablePool = kp(), memePool = kp(), bothPool = kp(), quoteOnlyPool = kp(), badOwner = kp();
  const pools = new Map<string, { owner: PublicKey; data: Buffer } | null>([
    [stablePool, { owner: PUMPSWAP_OWNER, data: pumpPool(SUSD, WSOL) }],
    [memePool, { owner: PUMPSWAP_OWNER, data: pumpPool(MEME, USDC) }],
    [bothPool, { owner: PUMPSWAP_OWNER, data: pumpPool(USD1, USDC) }],
    [quoteOnlyPool, { owner: PUMPSWAP_OWNER, data: pumpPool(MEME, USD1) }],
    [badOwner, { owner: Keypair.generate().publicKey, data: pumpPool(MEME, USDC) }],
  ]);
  it("mainnet_ca stablecoin: refused with no RPC; non-stable mainnet_ca: ok with no RPC", async () => {
    const c = fakeConn(pools);
    const v = await classifyNewRow(row("a", memePool, { mainnetCa: USD1.toBase58() }), c);
    assert.equal(v.kind, "refuse");
    assert.equal((await classifyNewRow(row("b", stablePool, { mainnetCa: MEME.toBase58() }), c)).kind, "ok");
    assert.deepEqual(c.calls, []);
  });
  it("pool-only: stable base refused; meme base / USDC quote ok; stable quote with a non-stable base ok; both sides stable refused", async () => {
    const c = fakeConn(pools);
    const s = await classifyNewRow(row("s", stablePool), c);
    assert.deepEqual([s.kind, s.kind === "refuse" ? s.mint : "", s.kind === "refuse" ? s.ticker : ""], ["refuse", SUSD.toBase58(), "sUSD"]);
    assert.equal((await classifyNewRow(row("m", memePool), c)).kind, "ok");
    assert.equal((await classifyNewRow(row("q", quoteOnlyPool), c)).kind, "ok");
    const b = await classifyNewRow(row("b", bothPool), c);
    assert.equal(b.kind, "refuse");
    assert.match(b.kind === "refuse" ? b.why : "", /BOTH sides/);
  });
  it("unresolvable (rpc failure, missing pool, wrong owner, no conn) is held", async () => {
    assert.equal((await classifyNewRow(row("f", memePool), fakeConn(pools, { fail: true }))).kind, "held");
    assert.equal((await classifyNewRow(row("x", kp()), fakeConn(pools))).kind, "held");
    assert.equal((await classifyNewRow(row("o", badOwner), fakeConn(pools))).kind, "held");
    assert.equal((await classifyNewRow(row("n", memePool), undefined)).kind, "held");
  });
  it("multi-asset row: one stable pool asset refuses the row", async () => {
    const entry = { label: "ma", marketAddress: kp(), dexType: "pumpswap", assetIndex: 0, assets: [
      { assetIndex: 0, source: "pool", poolAddress: memePool, dexType: "pumpswap" },
      { assetIndex: 1, source: "pool", poolAddress: stablePool, dexType: "pumpswap" },
      { assetIndex: 2, source: "fixed", fixedPriceE6: "1000000" },
    ] } as unknown as MarketEntry;
    assert.equal((await classifyNewRow(entry, fakeConn(pools))).kind, "refuse");
  });
});

describe("reloadRegistryGated", () => {
  const stablePool = kp(), memePool = kp(), bothPool = kp();
  const pools = new Map<string, { owner: PublicKey; data: Buffer } | null>([
    [stablePool, { owner: PUMPSWAP_OWNER, data: pumpPool(SUSD, WSOL) }],
    [memePool, { owner: PUMPSWAP_OWNER, data: pumpPool(MEME, USDC) }],
    [bothPool, { owner: PUMPSWAP_OWNER, data: pumpPool(USD1, USDC) }],
  ]);
  const base = row("BASE", memePool);
  const reg = (m: MarketEntry[]): Registry => ({ version: 1, description: "d", markets: [...m] });

  it("refuses a NEW stablecoin row (logged with [stablecoin-refusal], address, mint, ticker), admits the others", async () => {
    const stable = row("STABLE", stablePool), fresh = row("FRESH", memePool);
    const r = reg([base]);
    const out = await reloadRegistryGated(r, write([base, stable, fresh]), { conn: fakeConn(pools) });
    restore();
    assert.deepEqual(out, { added: 1, removed: 0, updated: 0 });
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE", "FRESH"]);
    const l = lines.find((x) => x.includes("[stablecoin-refusal]") && x.includes("REFUSING"));
    assert.ok(l && l.includes(stable.marketAddress) && l.includes(SUSD.toBase58()) && l.includes("ticker=sUSD"), String(l));
  });
  it("refuses a pool with both sides stable", async () => {
    const r = reg([base]);
    await reloadRegistryGated(r, write([base, row("BOTH", bothPool)]), { conn: fakeConn(pools) });
    restore();
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE"]);
  });
  it("never evicts a tracked stablecoin market and still updates it", async () => {
    const stable = row("STABLE", stablePool);
    const r = reg([base, stable]);
    const out = await reloadRegistryGated(r, write([base, { ...stable, label: "STABLE2" }]), { conn: fakeConn(pools) });
    restore();
    assert.deepEqual(out, { added: 0, removed: 0, updated: 1 });
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE", "STABLE2"]);
  });
  it("unresolvable: held out of memory, logged, re-evaluated and admitted on the next reload; nothing evicted meanwhile", async () => {
    const fresh = row("FRESH", memePool);
    const r = reg([base]);
    const p = write([base, fresh]);
    const out1 = await reloadRegistryGated(r, p, { conn: fakeConn(pools, { fail: true }) });
    assert.deepEqual(out1, { added: 0, removed: 0, updated: 0 });
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE"]);
    assert.ok(lines.some((x) => x.includes("[stablecoin-refusal]") && x.includes("HOLDING") && x.includes(fresh.marketAddress)));
    const out2 = await reloadRegistryGated(r, p, { conn: fakeConn(pools) });
    restore();
    assert.deepEqual(out2, { added: 1, removed: 0, updated: 0 });
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE", "FRESH"]);
  });
  it("other rows still prune normally while a row is held", async () => {
    const gone = row("GONE", memePool);
    const r = reg([base, gone]);
    const out = await reloadRegistryGated(r, write([base, row("HELD", memePool)]), { conn: fakeConn(pools, { fail: true }) });
    restore();
    assert.deepEqual(out, { added: 0, removed: 1, updated: 0 });
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE"]);
  });
  it("never throws and never blanks: bad json, empty list while tracked", async () => {
    const r = reg([base]);
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{nope");
    assert.deepEqual(await reloadRegistryGated(r, bad, { conn: fakeConn(pools) }), { added: 0, removed: 0, updated: 0 });
    assert.deepEqual(await reloadRegistryGated(r, write([]), { conn: fakeConn(pools) }), { added: 0, removed: 0, updated: 0 });
    assert.deepEqual(await reloadRegistryGated(r, path.join(tmp, "missing.json"), {}), { added: 0, removed: 0, updated: 0 });
    restore();
    assert.deepEqual(r.markets.map((m) => m.label), ["BASE"]);
  });
  it("a refused row.s log line is not repeated every reload", async () => {
    const stable = row("STABLE", stablePool);
    const p = write([base, stable]);
    const r = reg([base]);
    await reloadRegistryGated(r, p, { conn: fakeConn(pools) });
    const first = lines.filter((x) => x.includes("REFUSING")).length;
    await reloadRegistryGated(r, p, { conn: fakeConn(pools) });
    restore();
    assert.equal(first, 1);
    assert.equal(lines.filter((x) => x.includes("REFUSING")).length, 1);
  });
});

describe("flag off: byte-for-byte the old admission", () => {
  it("reloadRegistryOnce admits a stablecoin-pool row without any gate (sync, no RPC)", () => {
    const stable = row("STABLE", kp(), { mainnetCa: USD1.toBase58() });
    const r: Registry = { version: 1, description: "d", markets: [] };
    assert.deepEqual(reloadRegistryOnce(r, write([stable])), { added: 1, removed: 0, updated: 0 });
    assert.equal(r.markets.length, 1);
  });
  it("the loop uses the gate only when KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS=1", async () => {
    const stable = row("STABLE", kp(), { mainnetCa: USD1.toBase58() });
    const p = write([stable]);
    const runOnce = async (flag: string | undefined): Promise<number> => {
      if (flag === undefined) delete process.env.KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS; else process.env.KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS = flag;
      const r: Registry = { version: 1, description: "d", markets: [] };
      const done = startRegistryReloadLoop(r, { registryPath: p, intervalMs: 60, mainnetConn: fakeConn(new Map()) });
      await new Promise((res) => setTimeout(res, 150));
      process.emit("SIGTERM");
      await done;
      return r.markets.length;
    };
    try {
      assert.equal(await runOnce(undefined), 1);
      assert.equal(await runOnce("1"), 0);
    } finally {
      delete process.env.KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS;
      restore();
    }
  });
});

describe("boot: rows are treated as tracked, one warning per stablecoin row when the flag is on", () => {
  it("warns once per stable row, keeps every row, silent with the flag off", async () => {
    const stablePool = kp(), memePool = kp();
    const pools = new Map<string, { owner: PublicKey; data: Buffer } | null>([
      [stablePool, { owner: PUMPSWAP_OWNER, data: pumpPool(SUSD, WSOL) }],
      [memePool, { owner: PUMPSWAP_OWNER, data: pumpPool(MEME, USDC) }],
    ]);
    const r: Registry = { version: 1, description: "d", markets: [row("S", stablePool), row("M", memePool)] };
    assert.equal(await warnBootStablecoinRows(r, fakeConn(pools), {}), 0);
    assert.equal(lines.length, 0);
    assert.equal(await warnBootStablecoinRows(r, fakeConn(pools), { KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS: "1" }), 1);
    restore();
    assert.equal(lines.filter((x) => x.includes("[stablecoin-refusal]") && x.includes("boot")).length, 1);
    assert.equal(r.markets.length, 2);
  });
});
