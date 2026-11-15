/**
 * Branch coverage for the keeper's market-list admission path: which markets
 * get priced (and therefore pushed/cranked) and which are held out.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/db-markets-branches.test.ts
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM_ID, METEORA_DLMM_PROGRAM_ID } from "@percolatorct/sdk";
import {
  capMarketRows,
  classifyPools,
  fetchActiveMarkets,
  keeperMarketCapsFromEnv,
  rowsToEntries,
  DEFAULT_KEEPER_MAX_MARKETS,
  DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER,
  type DbMarketRow,
  type DexCache,
} from "./db-markets.ts";
import type { DexType } from "./registry.ts";

const key = () => Keypair.generate().publicKey.toBase58();

const mk = (over: Partial<DbMarketRow> = {}): DbMarketRow => ({
  slab_address: key(),
  dex_pool_address: key(),
  symbol: "T",
  mint_address: "MINT",
  mainnet_ca: null,
  ...over,
});

/** Fake connection returning `owners[i]` (or null) for the i-th requested pool. */
function fakeConn(ownerFor: (addr: string) => PublicKey | null, calls: string[][] = []): Connection {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.push(keys.map((k) => k.toBase58()));
      return keys.map((k) => {
        const o = ownerFor(k.toBase58());
        return o ? { owner: o } : null;
      });
    },
  } as unknown as Connection;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("classifyPools", () => {
  it("skips missing accounts and unknown owners, caches known ones, fetches only unknown pools", async () => {
    const [pump, meteora, missing, other, cached] = [key(), key(), key(), key(), key()];
    const calls: string[][] = [];
    const conn = fakeConn((a) => {
      if (a === pump) return PUMPSWAP_PROGRAM_ID;
      if (a === meteora) return METEORA_DLMM_PROGRAM_ID;
      if (a === other) return Keypair.generate().publicKey; // not a DEX program
      return null; // missing
    }, calls);
    const cache: DexCache = new Map<string, DexType>([[cached, "pumpswap"]]);
    await classifyPools(conn, [pump, meteora, missing, other, cached, pump], cache);
    assert.equal(cache.get(pump), "pumpswap");
    assert.equal(cache.get(meteora), "meteora-dlmm");
    assert.equal(cache.has(missing), false);
    assert.equal(cache.has(other), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(new Set(calls[0]), new Set([pump, meteora, missing, other]));
  });

  it("batches in chunks of 100 and makes no RPC call when everything is cached", async () => {
    const pools = Array.from({ length: 250 }, key);
    const calls: string[][] = [];
    const cache: DexCache = new Map();
    await classifyPools(fakeConn(() => PUMPSWAP_PROGRAM_ID, calls), pools, cache);
    assert.deepEqual(calls.map((c) => c.length), [100, 100, 50]);
    await classifyPools(fakeConn(() => PUMPSWAP_PROGRAM_ID, calls), pools, cache);
    assert.equal(calls.length, 3);
  });
});

describe("rowsToEntries", () => {
  it("carries mainnet_ca through and warns about an unclassified market only once", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => void warns.push(String(m));
    try {
      const bad = mk({ slab_address: "UNCLASSIFIED_ONCE_SLAB" });
      rowsToEntries([bad], new Map());
      rowsToEntries([bad], new Map());
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.filter((w) => w.includes("UNCLASSI")).length, 1);

    const r = mk({ mainnet_ca: "CA1", symbol: null });
    const out = rowsToEntries([r], new Map<string, DexType>([[r.dex_pool_address!, "pumpswap"]]));
    assert.equal((out[0] as { mainnetCa?: string }).mainnetCa, "CA1");
    assert.equal(out[0].symbol, undefined);
  });
});

describe("keeperMarketCapsFromEnv", () => {
  it("uses defaults when unset or invalid, and honours valid positive integers", () => {
    const d = { maxTotal: DEFAULT_KEEPER_MAX_MARKETS, maxPerDeployer: DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER };
    assert.deepEqual(keeperMarketCapsFromEnv({}), d);
    for (const bad of ["0", "-3", "1.5", "abc", ""]) {
      assert.deepEqual(
        keeperMarketCapsFromEnv({ KEEPER_MAX_MARKETS: bad, KEEPER_MAX_MARKETS_PER_DEPLOYER: bad }),
        d,
        `value ${JSON.stringify(bad)}`,
      );
    }
    assert.deepEqual(
      keeperMarketCapsFromEnv({ KEEPER_MAX_MARKETS: " 7 ", KEEPER_MAX_MARKETS_PER_DEPLOYER: "2" }),
      { maxTotal: 7, maxPerDeployer: 2 },
    );
  });

  it("reads process.env when no env is passed", () => {
    const saved = process.env.KEEPER_MAX_MARKETS;
    process.env.KEEPER_MAX_MARKETS = "13";
    try {
      assert.equal(keeperMarketCapsFromEnv().maxTotal, 13);
    } finally {
      if (saved === undefined) delete process.env.KEEPER_MAX_MARKETS;
      else process.env.KEEPER_MAX_MARKETS = saved;
    }
  });
});

describe("capMarketRows", () => {
  it("keeps the oldest markets, sorts undated/invalid dates last, breaks ties by slab", () => {
    const rows = [
      mk({ slab_address: "D", created_at: null }),
      mk({ slab_address: "C", created_at: "not-a-date" }),
      mk({ slab_address: "B", created_at: "2026-01-02T00:00:00Z" }),
      mk({ slab_address: "A", created_at: "2026-01-02T00:00:00Z" }),
      mk({ slab_address: "OLD", created_at: "2026-01-01T00:00:00Z" }),
    ];
    const { kept } = capMarketRows(rows, { maxTotal: 100, maxPerDeployer: 100 });
    assert.deepEqual(kept.map((r) => r.slab_address), ["OLD", "A", "B", "C", "D"]);
  });

  it("caps by total ceiling and per-deployer ceiling; unpriceable rows pass uncounted", () => {
    const t = (n: number) => `2026-01-0${n}T00:00:00Z`;
    const rows = [
      mk({ slab_address: "UNP", created_at: t(1), deployer: "X" }),
      mk({ slab_address: "X1", created_at: t(2), deployer: "X" }),
      mk({ slab_address: "X2", created_at: t(3), deployer: "X" }), // per-deployer cap
      mk({ slab_address: "N1", created_at: t(4), deployer: null }), // unknown deployer
      mk({ slab_address: "Y1", created_at: t(5), deployer: "Y" }), // total cap (2 priced already)
    ];
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => void warns.push(String(m));
    let res;
    try {
      res = capMarketRows(rows, { maxTotal: 2, maxPerDeployer: 1 }, (r) => r.slab_address !== "UNP");
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(res.kept.map((r) => r.slab_address), ["UNP", "X1", "N1"]);
    assert.deepEqual(res.capped.map((r) => r.slab_address), ["X2", "Y1"]);
    assert.ok(warns.some((w) => w.includes("per-deployer ceiling")));
    assert.ok(warns.some((w) => w.includes("market ceiling")));
  });

  it("names an unknown deployer in the warning when the row has none", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => void warns.push(String(m));
    try {
      capMarketRows(
        [mk({ slab_address: "NODEP1", created_at: "2026-02-01T00:00:00Z" }), mk({ slab_address: "NODEP2", created_at: "2026-02-02T00:00:00Z" })],
        { maxTotal: 10, maxPerDeployer: 1 },
      );
    } finally {
      console.warn = orig;
    }
    assert.ok(warns.some((w) => w.includes("for unknown")));
  });
});

describe("fetchActiveMarkets", () => {
  const cfg = (conn: Connection, over: Record<string, unknown> = {}) => ({
    supabaseUrl: "http://sb.test",
    supabaseAnonKey: "anon",
    network: "dev net",
    mainnetConn: conn,
    dexCache: new Map<string, DexType>() as DexCache,
    caps: { maxTotal: 50, maxPerDeployer: 50 },
    ...over,
  });
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      return await f();
    } finally {
      console.warn = orig;
    }
  };
  const respond = (init: { ok?: boolean; status?: number; body?: unknown; json?: () => Promise<unknown> }) => {
    globalThis.fetch = (async () => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: init.json ?? (async () => init.body),
    })) as unknown as typeof fetch;
  };

  it("returns null (leave registry unchanged) on HTTP error, non-array body, fetch throw, non-Error throw", async () => {
    const conn = fakeConn(() => PUMPSWAP_PROGRAM_ID);
    respond({ ok: false, status: 503 });
    assert.equal(await quiet(() => fetchActiveMarkets(cfg(conn))), null);
    respond({ body: { error: "x" } });
    assert.equal(await quiet(() => fetchActiveMarkets(cfg(conn))), null);
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    assert.equal(await quiet(() => fetchActiveMarkets(cfg(conn))), null);
    globalThis.fetch = (async () => {
      throw "string-failure";
    }) as unknown as typeof fetch;
    assert.equal(await quiet(() => fetchActiveMarkets(cfg(conn))), null);
  });

  it("returns null when pool classification throws (Error and non-Error)", async () => {
    const row = mk();
    respond({ body: [row] });
    for (const thrown of [new Error("rpc down"), "plain"]) {
      const conn = {
        getMultipleAccountsInfo: async () => {
          throw thrown;
        },
      } as unknown as Connection;
      assert.equal(await quiet(() => fetchActiveMarkets(cfg(conn))), null);
    }
  });

  it("returns [] for a successful empty query, and entries only for classified, uncapped rows", async () => {
    const conn = fakeConn((a) => (a === good.dex_pool_address ? PUMPSWAP_PROGRAM_ID : null));
    const good = mk({ slab_address: "GOOD", created_at: "2026-01-01T00:00:00Z" });
    const unclassified = mk({ slab_address: "NOCLASS", created_at: "2026-01-02T00:00:00Z" });
    const noPool = mk({ slab_address: "NOPOOL", dex_pool_address: null, created_at: "2026-01-03T00:00:00Z" });

    respond({ body: [] });
    assert.deepEqual(await fetchActiveMarkets(cfg(conn)), []);

    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (u: string, i: RequestInit) => {
      seenUrl = u;
      seenInit = i;
      return { ok: true, status: 200, json: async () => [good, unclassified, noPool] };
    }) as unknown as typeof fetch;
    const out = await quiet(() => fetchActiveMarkets(cfg(conn)));
    assert.deepEqual(out?.map((e) => e.marketAddress), ["GOOD"]);
    assert.match(seenUrl, /keeper_status=eq\.active/);
    assert.match(seenUrl, /network=eq\.dev%20net/);
    assert.equal((seenInit?.headers as Record<string, string>).apikey, "anon");
  });

  it("falls back to env-derived caps when none are given", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      mk({ slab_address: `S${i}`, created_at: `2026-01-0${i + 1}T00:00:00Z`, deployer: "D" }),
    );
    const conn = fakeConn(() => PUMPSWAP_PROGRAM_ID);
    respond({ body: rows });
    const saved = process.env.KEEPER_MAX_MARKETS_PER_DEPLOYER;
    process.env.KEEPER_MAX_MARKETS_PER_DEPLOYER = "2";
    try {
      const out = await quiet(() => fetchActiveMarkets(cfg(conn, { caps: undefined })));
      assert.deepEqual(out?.map((e) => e.marketAddress), ["S0", "S1"]);
    } finally {
      if (saved === undefined) delete process.env.KEEPER_MAX_MARKETS_PER_DEPLOYER;
      else process.env.KEEPER_MAX_MARKETS_PER_DEPLOYER = saved;
    }
  });
});
