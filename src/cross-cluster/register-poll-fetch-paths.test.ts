/**
 * register-poll: the fetch -> guard -> owner-filter -> reconcile path of one poll, driven through pollOnce.
 * Pins the null-on-failure contract (a failed fetch must leave the registry untouched, never retire the board),
 * the wipe-the-board guard, the on-chain owner filter, and the poll loop's stop/isolation behaviour.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { pollOnce, startRegisterPollLoop, _resetSaveStateForTest } from "./register-poll.ts";
import type { Registry, MarketEntry } from "./registry.ts";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  const sink = (m: unknown) => void logs.push(String(m));
  console.warn = sink;
  console.log = sink;
  console.error = sink;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
  console.error = realError;
  _resetSaveStateForTest();
});

const key = () => Keypair.generate().publicKey;
const entry = (addr: string, pool = key().toBase58()): MarketEntry => ({
  label: "L",
  marketAddress: addr,
  poolAddress: pool,
  dexType: "pumpswap",
  assetIndex: 0,
  registeredAt: 0,
});

function mkConfig(rows: unknown[] | (() => Response), extra: Record<string, unknown> = {}) {
  const dexCache = new Map<string, "pumpswap">();
  for (const r of Array.isArray(rows) ? rows : []) {
    dexCache.set((r as { dex_pool_address: string }).dex_pool_address, "pumpswap");
  }
  globalThis.fetch = (async () =>
    typeof rows === "function" ? rows() : new Response(JSON.stringify(rows), { status: 200 })) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpf-"));
  const registryPath = path.join(dir, "registry.json");
  return {
    registryPath,
    db: {
      supabaseUrl: "http://x",
      supabaseAnonKey: "k",
      network: "devnet",
      mainnetConn: { getMultipleAccountsInfo: async () => [] } as never,
      dexCache,
    },
    ...extra,
  };
}
const row = (slab: string, pool: string) => ({
  slab_address: slab,
  dex_pool_address: pool,
  symbol: "T",
  mint_address: pool,
  mainnet_ca: null,
});

test("no db config: returns 0 and leaves the registry alone", async () => {
  const registry = { markets: [entry(key().toBase58())] } as Registry;
  assert.equal(await pollOnce(registry, { registryPath: "/nonexistent/x.json" }), 0);
  assert.equal(registry.markets.length, 1);
  assert.ok(logs.some((l) => l.includes("no db config")));
});

test("a FAILED fetch returns 0 and never retires the board (null, not [])", async () => {
  const markets = [entry(key().toBase58()), entry(key().toBase58()), entry(key().toBase58())];
  const registry = { markets: [...markets] } as Registry;
  const cfg = mkConfig(() => new Response("boom", { status: 503 }));
  // more cycles than the absence threshold: a mistaken [] would have retired all three by now
  for (let i = 0; i < 5; i++) assert.equal(await pollOnce(registry, cfg), 0);
  assert.deepEqual(registry.markets, markets);
  assert.ok(!fs.existsSync(cfg.registryPath), "nothing changed, so nothing is saved");
  assert.ok(logs.some((l) => l.includes("HTTP 503")));
});

test("a thrown fetch also leaves the registry untouched", async () => {
  const registry = { markets: [entry(key().toBase58())] } as Registry;
  const cfg = mkConfig([]);
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.equal(await pollOnce(registry, cfg), 0);
  assert.equal(registry.markets.length, 1);
});

test("wipe-the-board guard: a successful empty result vs 3+ local markets is refused", async () => {
  const markets = [entry(key().toBase58()), entry(key().toBase58()), entry(key().toBase58())];
  const registry = { markets: [...markets] } as Registry;
  const cfg = mkConfig([]);
  for (let i = 0; i < 5; i++) assert.equal(await pollOnce(registry, cfg), 0);
  assert.deepEqual(registry.markets, markets);
  assert.ok(logs.some((l) => l.includes("REFUSING to reconcile")));
});

test("added / updated bindings are logged and persisted", async () => {
  const slab = key().toBase58();
  const pool1 = key().toBase58();
  const registry = { markets: [] } as unknown as Registry;
  const cfg = mkConfig([row(slab, pool1)]);
  assert.equal(await pollOnce(registry, cfg), 1);
  assert.equal(JSON.parse(fs.readFileSync(cfg.registryPath, "utf8")).markets[0].poolAddress, pool1);

  const pool2 = key().toBase58();
  const cfg2 = mkConfig([row(slab, pool2)], { registryPath: cfg.registryPath });
  assert.equal(await pollOnce(registry, cfg2), 0); // updated, not added
  assert.equal(registry.markets[0].poolAddress, pool2);
  assert.ok(logs.some((l) => l.includes(`updated binding for ${slab}`)));
  assert.equal(JSON.parse(fs.readFileSync(cfg.registryPath, "utf8")).markets[0].poolAddress, pool2);
});

test("a market absent for 3 consecutive successful polls is retired and logged", async () => {
  const keep = key().toBase58();
  const gone = key().toBase58();
  const pool = key().toBase58();
  const registry = { markets: [entry(keep, pool), entry(gone)] } as Registry;
  const cfg = mkConfig([row(keep, pool)]);
  await pollOnce(registry, cfg);
  await pollOnce(registry, cfg);
  assert.equal(registry.markets.length, 2);
  await pollOnce(registry, cfg);
  assert.deepEqual(registry.markets.map((m) => m.marketAddress), [keep]);
  assert.ok(logs.some((l) => l.includes(`retired ${gone}`)));
});

test("owner filter: only markets owned by the current wrapper are admitted", async () => {
  const wrapper = key();
  const [ok, retired, missing] = [key(), key(), key()].map((k) => k.toBase58());
  const pool = key().toBase58();
  const rows = [row(ok, pool), row(retired, pool), row(missing, pool)];
  const owners = new Map<string, PublicKey | null>([
    [ok, wrapper],
    [retired, key()],
    [missing, null],
  ]);
  const calls: number[] = [];
  const cfg = mkConfig(rows, {
    expectedOwner: wrapper,
    connection: {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        calls.push(keys.length);
        return keys.map((k) => {
          const o = owners.get(k.toBase58());
          return o ? { owner: o } : null;
        });
      },
    },
  });
  const registry = { markets: [] } as unknown as Registry;
  assert.equal(await pollOnce(registry, cfg), 1);
  assert.deepEqual(registry.markets.map((m) => m.marketAddress), [ok]);
  assert.deepEqual(calls, [3]);
  assert.ok(logs.some((l) => l.includes("not found on-chain")));
  assert.ok(logs.some((l) => l.includes("retired-wrapper market")));
});

test("owner filter: an RPC failure aborts the whole cycle (Error and non-Error)", async () => {
  const slab = key().toBase58();
  const pool = key().toBase58();
  for (const thrown of [new Error("rpc 429"), "plain string"]) {
    const cfg = mkConfig([row(slab, pool)], {
      expectedOwner: key(),
      connection: {
        getMultipleAccountsInfo: async () => {
          throw thrown;
        },
      },
    });
    const registry = { markets: [] } as unknown as Registry;
    assert.equal(await pollOnce(registry, cfg), 0);
    assert.equal(registry.markets.length, 0, "an unverified market must never be added");
    assert.ok(logs.some((l) => l.includes("owner check failed")));
  }
});

test("owner filter chunks getMultipleAccountsInfo at 100 keys", async () => {
  const wrapper = key();
  const pool = key().toBase58();
  const rows = Array.from({ length: 101 }, () => row(key().toBase58(), pool));
  const calls: number[] = [];
  const cfg = mkConfig(rows, {
    expectedOwner: wrapper,
    connection: {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        calls.push(keys.length);
        return keys.map(() => ({ owner: wrapper }));
      },
    },
  });
  (cfg.db as Record<string, unknown>).caps = { maxTotal: 500, maxPerDeployer: 500 }; // defaults would cap at 10
  const registry = { markets: [] } as unknown as Registry;
  await pollOnce(registry, cfg);
  assert.deepEqual(calls, [100, 1]);
  assert.equal(registry.markets.length, 101);
});

test("a call arriving mid-poll queues exactly one follow-up run", async () => {
  let fetches = 0;
  const cfg = mkConfig([]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async () => {
    fetches++;
    if (fetches === 1) await gate;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const registry = { markets: [] } as unknown as Registry;
  const first = pollOnce(registry, cfg);
  const second = pollOnce(registry, cfg);
  const third = pollOnce(registry, cfg);
  release();
  await Promise.all([first, second, third]);
  assert.equal(fetches, 2);
});

test("startRegisterPollLoop polls, isolates a throw, and stops on SIGTERM", async () => {
  const slab = key().toBase58();
  const pool = key().toBase58();
  const cfg = mkConfig([row(slab, pool)], { intervalMs: 5 });
  const registry = { markets: [] } as unknown as Registry;
  const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  let n = 0;
  const okFetch = globalThis.fetch;
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    n++;
    if (n === 1) throw new Error("first cycle blows up");
    if (n === 3) process.emit("SIGTERM");
    return okFetch(...a);
  }) as typeof fetch;
  await startRegisterPollLoop(registry, cfg);
  assert.ok(n >= 3);
  assert.equal(registry.markets.length, 1);
  assert.ok(logs.some((l) => l.includes("stopped.")));
  // remove the handlers the loop installed so later tests are not affected
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const ls = process.listeners(sig);
    for (const l of ls.slice(before[sig])) process.removeListener(sig, l);
  }
});

test("reconcileMarkets defaults its threshold to ABSENCE_THRESHOLD", async () => {
  const { reconcileMarkets, ABSENCE_THRESHOLD } = await import("./register-poll.ts");
  const gone = entry(key().toBase58());
  const registry = { markets: [gone] };
  const absences = new Map<string, number>();
  for (let i = 1; i < ABSENCE_THRESHOLD; i++) {
    assert.deepEqual(reconcileMarkets(registry, [], absences).removed, []);
  }
  assert.deepEqual(reconcileMarkets(registry, [], absences).removed, [gone.marketAddress]);
});
