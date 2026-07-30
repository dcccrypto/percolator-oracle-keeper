/**
 * The keeper's market list, read from Supabase.
 *
 * WHY THIS EXISTS
 * ---------------
 * The list used to live in a Vercel blob, written by a second registration call
 * and polled over HTTP. The `markets` row already carried everything needed, and
 * the keeper was ALREADY subscribed to Supabase Realtime on that table — it just
 * used the notification to go and fetch a different store. This makes the row
 * the source of truth, so `keeper_status='active'` is the single switch that
 * enrolls a market for pricing and retiring one is a column update.
 *
 * `dex_type` is deliberately NOT a column. The keeper derives it from the pool
 * account's owner program, which `readPoolPriceE6` already re-validates on every
 * price read. Storing it would create a second copy that can silently disagree
 * with chain — and a wrong dexType means a wrong price, not a failed read.
 *
 * See percolator-launch/docs/MARKET-REGISTRATION-SPEC-2026-07-30.md.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { detectDexType } from "@percolatorct/sdk";
import type { MarketEntry, DexType } from "./registry.ts";

/** The columns the keeper needs. Everything else on the row is display data. */
export interface DbMarketRow {
  slab_address: string;
  dex_pool_address: string | null;
  symbol: string | null;
  mint_address: string;
  mainnet_ca: string | null;
}

/** Pool address -> DEX type, cached across cycles (a pool never changes owner). */
export type DexCache = Map<string, DexType>;

/**
 * Classify pools by their on-chain owner program.
 *
 * Only pools missing from the cache are fetched, so steady state costs nothing;
 * a newly registered market costs one batched getMultipleAccountsInfo.
 */
export async function classifyPools(
  conn: Connection,
  pools: readonly string[],
  cache: DexCache,
): Promise<DexCache> {
  const unknown = [...new Set(pools)].filter((p) => !cache.has(p));
  for (let i = 0; i < unknown.length; i += 100) {
    const chunk = unknown.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(
      chunk.map((p) => new PublicKey(p)),
      "confirmed",
    );
    infos.forEach((info, j) => {
      if (!info) return;
      const dex = detectDexType(info.owner);
      if (dex) cache.set(chunk[j], dex as DexType);
    });
  }
  return cache;
}

/**
 * Map DB rows to registry entries, dropping anything that cannot be priced.
 *
 * Both drops are deliberate: no pool means there is no price source, and an
 * unclassified pool means we would have to GUESS a dexType. Neither belongs in
 * the registry — the push loop reads it without re-checking these.
 */
export function rowsToEntries(rows: readonly DbMarketRow[], dexByPool: DexCache): MarketEntry[] {
  const out: MarketEntry[] = [];
  for (const r of rows) {
    if (!r.dex_pool_address) continue;
    const dexType = dexByPool.get(r.dex_pool_address);
    if (!dexType) continue;
    const name = r.symbol ?? r.slab_address.slice(0, 8);
    out.push({
      label: `${name}/USDC — ${dexType}`,
      marketAddress: r.slab_address,
      poolAddress: r.dex_pool_address,
      dexType,
      assetIndex: 0,
      symbol: r.symbol ?? undefined,
      collateral: r.mint_address,
    } as MarketEntry);
  }
  return out;
}

export interface FetchActiveConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  network: string;
  mainnetConn: Connection;
  dexCache: DexCache;
}

/**
 * The active market list, or `null` when the query FAILED.
 *
 * The null-vs-empty distinction is load-bearing. Callers reconcile the registry
 * against this result, so returning `[]` for a failed query would retire every
 * market. `[]` means "the query succeeded and there are genuinely none"; `null`
 * means "we learned nothing this cycle — change nothing".
 */
export async function fetchActiveMarkets(cfg: FetchActiveConfig): Promise<MarketEntry[] | null> {
  const url =
    `${cfg.supabaseUrl}/rest/v1/markets` +
    `?select=slab_address,dex_pool_address,symbol,mint_address,mainnet_ca` +
    `&keeper_status=eq.active` +
    `&network=eq.${encodeURIComponent(cfg.network)}` +
    `&dex_pool_address=not.is.null`;

  let rows: DbMarketRow[];
  try {
    const resp = await fetch(url, {
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[db-markets] query failed: HTTP ${resp.status} — registry left unchanged`);
      return null;
    }
    const body: unknown = await resp.json();
    if (!Array.isArray(body)) {
      console.warn("[db-markets] query returned a non-array body — registry left unchanged");
      return null;
    }
    rows = body as DbMarketRow[];
  } catch (err) {
    console.warn(
      `[db-markets] query failed: ${err instanceof Error ? err.message : String(err)} — registry left unchanged`,
    );
    return null;
  }

  // A classification failure is also "we learned nothing": without it every row
  // would be dropped as unclassifiable, which reconcile would read as a mass
  // retirement.
  try {
    const pools = rows.map((r) => r.dex_pool_address).filter((p): p is string => !!p);
    await classifyPools(cfg.mainnetConn, pools, cfg.dexCache);
  } catch (err) {
    console.warn(
      `[db-markets] pool classification failed: ${err instanceof Error ? err.message : String(err)} — registry left unchanged`,
    );
    return null;
  }

  return rowsToEntries(rows, cfg.dexCache);
}
