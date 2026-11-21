import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  pollOnce,
  reconcileMarkets,
  startRegisterPollLoop,
  _resetSaveStateForTest,
  ABSENCE_THRESHOLD,
} from "./register-poll.ts";
import type { Registry, MarketEntry } from "./registry.ts";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;
let logs: string[] = [];

function quiet() {
  logs = [];
  const sink = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = sink;
  console.log = sink;
  console.error = sink;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
  console.error = realError;
  _resetSaveStateForTest();
});

const key = () => Keypair.generate().publicKey.toBase58();

function entry(over: Partial<MarketEntry> = {}): MarketEntry {
  return {
    label: "L",
    marketAddress: key(),
    poolAddress: key(),
    dexType: "pumpswap",
    assetIndex: 0,
    symbol: "S",
    collateral: "C",
    ...over,
  } as MarketEntry;
}

function row(slab: string, pool: string, symbol: string | null = "T") {
  return { slab_address: slab, dex_pool_address: pool, symbol, mint_address: pool, mainnet_ca: null };
}

function mkConfig(rows: unknown, pools: string[], extra: Record<string, unknown> = {}) {
  globalThis.fetch = (async () => new Response(JSON.stringify(rows), { status: 200 })) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp2-"));
  return {
    registryPath: path.join(dir, "registry.json"),
    db: {
      supabaseUrl: "http://x",
      supabaseAnonKey: "k",
      network: "devnet",
      caps: { maxTotal: 500, maxPerDeployer: 500 },
      mainnetConn: { getMultipleAccountsInfo: async () => [] } as never,
      dexCache: new Map(pools.map((p) => [p, "pumpswap" as const])),
    },
    ...extra,
  };
}

// ---------------------------------------------------------------- reconcileMarkets

test("reconcile: adds new, leaves identical untouched", () => {
  const a = entry();
  const registry = { markets: [] as MarketEntry[] };
  const abs = new Map<string, number>();
  assert.deepEqual(reconcileMarkets(registry, [a], abs), { added: [a.marketAddress], removed: [], updated: [] });
  assert.deepEqual(reconcileMarkets(registry, [{ ...a }], abs), { added: [], removed: [], updated: [] });
  assert.equal(registry.markets.length, 1);
});

test("reconcile: each binding field change is an update", () => {
  for (const patch of [
    { poolAddress: key() },
    { dexType: "meteora-dlmm" as const },
    { symbol: "Z" },
    { collateral: "Q" },
  ]) {
    const a = entry();
    const registry = { markets: [a] };
    const next = { ...a, ...patch };
    const r = reconcileMarkets(registry, [next], new Map());
    assert.deepEqual(r.updated, [a.marketAddress]);
    assert.equal(registry.markets[0], next);
  }
});

test("reconcile: removal only after threshold consecutive absences; reappearance resets", () => {
  const a = entry();
  const registry = { markets: [a] };
  const abs = new Map<string, number>();
  for (let i = 0; i < ABSENCE_THRESHOLD - 1; i++) {
    assert.deepEqual(reconcileMarkets(registry, [], abs).removed, []);
  }
  assert.equal(abs.get(a.marketAddress), ABSENCE_THRESHOLD - 1);
  reconcileMarkets(registry, [a], abs); // back: counter cleared
  assert.equal(abs.has(a.marketAddress), false);
  for (let i = 0; i < ABSENCE_THRESHOLD - 1; i++) reconcileMarkets(registry, [], abs);
  assert.equal(registry.markets.length, 1);
  const last = reconcileMarkets(registry, [], abs);
  assert.deepEqual(last.removed, [a.marketAddress]);
  assert.equal(registry.markets.length, 0);
  assert.equal(abs.has(a.marketAddress), false);
});

test("reconcile: custom threshold of 1 retires immediately", () => {
  const a = entry();
  const registry = { markets: [a] };
  assert.deepEqual(reconcileMarkets(registry, [], new Map(), 1).removed, [a.marketAddress]);
});

// ---------------------------------------------------------------- pollOnce paths

test("no db config: warns and returns 0", async () => {
  quiet();
  const registry = { markets: [] } as unknown as Registry;
  assert.equal(await pollOnce(registry, { registryPath: "/nonexistent/x.json" }), 0);
  assert.ok(logs.some((l) => l.includes("no db config")));
});

test("failed query (HTTP 500) changes nothing and does not save", async () => {
  quiet();
  const cfg = mkConfig([], []);
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const existing = entry();
  const registry = { markets: [existing] } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 0);
  assert.equal(registry.markets.length, 1);
  assert.equal(fs.existsSync(cfg.registryPath), false);
});

test("wipe-the-board guard: empty result with >=3 local markets is refused", async () => {
  quiet();
  const cfg = mkConfig([], []);
  const registry = { markets: [entry(), entry(), entry()] } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 0);
  assert.equal(registry.markets.length, 3);
  assert.ok(logs.some((l) => l.includes("REFUSING to reconcile")));
});

test("adds a market, logs it, persists to disk", async () => {
  quiet();
  const slab = key();
  const pool = key();
  const cfg = mkConfig([row(slab, pool)], [pool]);
  const registry = { markets: [] } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 1);
  assert.ok(logs.some((l) => l.includes(`added ${slab}`)));
  assert.equal(JSON.parse(fs.readFileSync(cfg.registryPath, "utf8")).markets[0].marketAddress, slab);
});

test("updated and retired bindings are logged and saved", async () => {
  quiet();
  const slab = key();
  const pool = key();
  const gone = entry();
  const cfg = mkConfig([row(slab, pool)], [pool]);
  // local copy of slab has a stale pool; `gone` is absent upstream
  const registry = {
    markets: [entry({ marketAddress: slab, poolAddress: key() }), gone],
  } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 0);
  assert.ok(logs.some((l) => l.includes(`updated binding for ${slab}`)));
  for (let i = 0; i < ABSENCE_THRESHOLD - 1; i++) await pollOnce(registry, cfg);
  assert.ok(logs.some((l) => l.includes(`retired ${gone.marketAddress}`)));
  assert.equal(registry.markets.some((m) => m.marketAddress === gone.marketAddress), false);
  const saved = JSON.parse(fs.readFileSync(cfg.registryPath, "utf8")).markets;
  assert.deepEqual(saved.map((m: MarketEntry) => m.marketAddress), [slab]);
  assert.equal(saved[0].poolAddress, pool);
});

// ---------------------------------------------------------------- owner filter

test("owner filter: admits matching owner, skips retired wrapper, skips missing account", async () => {
  quiet();
  const owner = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const good = key();
  const retired = key();
  const missing = key();
  const pool = key();
  const calls: number[] = [];
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push(keys.length);
      return keys.map((k) => {
        const s = k.toBase58();
        if (s === good) return { owner };
        if (s === retired) return { owner: other };
        return null;
      });
    },
  } as never;
  const cfg = mkConfig(
    [row(good, pool), row(retired, pool), row(missing, pool)],
    [pool],
    { connection, expectedOwner: owner },
  );
  const registry = { markets: [] } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 1);
  assert.deepEqual(registry.markets.map((m) => m.marketAddress), [good]);
  assert.ok(logs.some((l) => l.includes("retired-wrapper market")));
  assert.ok(logs.some((l) => l.includes("not found on-chain")));
  assert.deepEqual(calls, [3]);
});

test("owner filter: RPC failure (Error and non-Error) aborts the cycle unchanged", async () => {
  for (const thrown of [new Error("rpc down"), "plain string"]) {
    quiet();
    const slab = key();
    const pool = key();
    const connection = {
      getMultipleAccountsInfo: async () => {
        throw thrown;
      },
    } as never;
    const cfg = mkConfig([row(slab, pool)], [pool], { connection, expectedOwner: Keypair.generate().publicKey });
    const registry = { markets: [] } as unknown as Registry;
    assert.equal(await pollOnce(registry, cfg), 0);
    assert.equal(registry.markets.length, 0);
    assert.ok(logs.some((l) => l.includes("owner check failed") && l.includes(String(thrown instanceof Error ? thrown.message : thrown))));
  }
});

test("owner filter: >100 markets are chunked into batches of 100", async () => {
  quiet();
  const owner = Keypair.generate().publicKey;
  const pool = key();
  const rows = Array.from({ length: 101 }, () => row(key(), pool));
  const calls: number[] = [];
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push(keys.length);
      return keys.map(() => ({ owner }));
    },
  } as never;
  const cfg = mkConfig(rows, [pool], {
    connection,
    expectedOwner: owner,
  });
  (cfg.db as { caps?: unknown }).caps = { maxTotal: 500, maxPerDeployer: 500 };
  const registry = { markets: [] } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 101);
  assert.deepEqual(calls, [100, 1]);
});

// ---------------------------------------------------------------- serialization

test("pollOnce serializes: a call during a poll queues exactly one re-run", async () => {
  quiet();
  const slab = key();
  const pool = key();
  const cfg = mkConfig([row(slab, pool)], [pool]);
  let fetches = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async () => {
    fetches++;
    if (fetches === 1) await gate;
    return new Response(JSON.stringify([row(slab, pool)]), { status: 200 });
  }) as typeof fetch;
  const registry = { markets: [] } as unknown as Registry;
  const first = pollOnce(registry, cfg);
  const second = pollOnce(registry, cfg);
  const third = pollOnce(registry, cfg);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetches, 1); // re-run must not start while run #1 is in flight
  release();
  await Promise.all([first, second, third]);
  assert.equal(fetches, 2);
  assert.equal(registry.markets.length, 1);
});

// ---------------------------------------------------------------- loop

test("startRegisterPollLoop: polls, survives an unexpected throw, stops on SIGTERM", async () => {
  quiet();
  const pool = key();
  const cfg = mkConfig([], [pool], { intervalMs: 5 });
  let n = 0;
  // A throwing `db` getter makes pollOnce itself reject -> exercises the loop's catch.
  Object.defineProperty(cfg, "db", {
    get() {
      n++;
      if (n === 1) throw new Error("kaboom");
      if (n === 2) throw "str-kaboom";
      process.emit("SIGTERM");
      return undefined;
    },
  });
  const registry = { markets: [] } as unknown as Registry;
  await startRegisterPollLoop(registry, cfg as never);
  assert.ok(logs.some((l) => l.includes("unexpected error: kaboom")));
  assert.ok(logs.some((l) => l.includes("unexpected error: str-kaboom")));
  assert.ok(logs.some((l) => l.includes("[register-poll] stopped.")));
});
