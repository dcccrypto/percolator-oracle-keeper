/**
 * cross-cluster/stablecoin-reload-gate.ts
 *
 * Stablecoin-underlying admission gate for the registry.json HOT RELOAD (registry-reload.ts).
 *
 * Why: the v2.2 devnet keeper runs without SUPABASE_* / REGISTER_SOURCE_URL, so register-poll is disabled and the hot reload is its
 * only admission path. Its rows carry no mainnet_ca, so the register-poll refusal (#264, mainnet_ca only, fail-open) would do nothing.
 *
 * Gated by KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS=1 (the same flag as register-poll). With the flag OFF none of this runs and
 * reloadRegistryOnce is byte-for-byte the old path.
 *
 * Applies ONLY to rows that are NEW at reload (address not tracked in memory). Tracked rows are never evicted and keep updating.
 * Underlying resolution per price source (single-asset row, or each pool-sourced asset of a multi-asset row):
 *   1. mainnet_ca present -> that mint (no RPC). Listed stablecoin -> REFUSE.
 *   2. otherwise read the MAINNET pool account (one getAccountInfo, read-only) and decode it with the SDK's parseDexPool for its dexType.
 *      The BASE mint is the underlying (the quote side is the collateral / quote). REFUSE when the base is a listed stablecoin, or when
 *      BOTH sides are listed stablecoins.
 *   3. Unresolvable (RPC failure, missing account, wrong owner, unknown layout) -> HOLD: the row is left out of memory and re-evaluated on
 *      the next reload (fail closed with retry). Logged.
 * No transaction is ever sent from here: the only I/O is the read of the pool account.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { detectDexType, parseDexPool } from "@percolatorct/sdk";
import type { Registry, MarketEntry, DexType } from "./registry.ts";
import { applyOnDisk, readRegistryForReload } from "./registry-reload.ts";
import { isStablecoinMint, STABLECOIN_MINTS } from "./stablecoin-mints.ts";
import { refuseStablecoinUnderlyingsEnabled } from "./register-poll.ts";

type PoolReader = Pick<Connection, "getAccountInfo">;

export type RowVerdict =
  | { kind: "ok" }
  | { kind: "refuse"; mint: string; ticker: string; why: string }
  | { kind: "held"; why: string };

interface Source {
  poolAddress?: string;
  dexType?: DexType;
  mainnetCa?: string;
}

function sourcesOf(entry: MarketEntry): Source[] {
  if (Array.isArray(entry.assets) && entry.assets.length > 0) {
    return entry.assets.filter((a) => a.source === "pool").map((a) => ({ poolAddress: a.poolAddress, dexType: a.dexType, mainnetCa: a.mainnetCa }));
  }
  return [{ poolAddress: entry.poolAddress, dexType: entry.dexType, mainnetCa: entry.mainnetCa }];
}

const tick = (mint: string): string => STABLECOIN_MINTS.get(mint) ?? "?";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("mainnet RPC timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function classifySource(src: Source, conn: PoolReader | undefined, timeoutMs: number): Promise<RowVerdict> {
  if (src.mainnetCa) {
    if (isStablecoinMint(src.mainnetCa)) {
      return { kind: "refuse", mint: src.mainnetCa, ticker: tick(src.mainnetCa), why: "underlying mainnet_ca is a listed stablecoin" };
    }
    return { kind: "ok" }; // identified, not a stablecoin (price-reader binds mainnet_ca to the pool's base on every read)
  }
  if (!src.poolAddress || !src.dexType) return { kind: "held", why: "no mainnet_ca and no pool to resolve the underlying from" };
  if (!conn) return { kind: "held", why: "no mainnet connection to read the pool" };
  try {
    const pk = new PublicKey(src.poolAddress);
    const info = await withTimeout(conn.getAccountInfo(pk, "confirmed"), timeoutMs);
    if (!info || info.data.length === 0) return { kind: "held", why: "pool account not found on mainnet" };
    const detected = detectDexType(info.owner);
    if (detected !== src.dexType) return { kind: "held", why: `pool owner ${info.owner.toBase58()} does not match dexType=${src.dexType}` };
    const parsed = parseDexPool(src.dexType, pk, new Uint8Array(info.data));
    const base = parsed.baseMint.toBase58();
    const quote = parsed.quoteMint.toBase58();
    if (isStablecoinMint(base) && isStablecoinMint(quote)) {
      return { kind: "refuse", mint: base, ticker: `${tick(base)}/${tick(quote)}`, why: `pool has stablecoins on BOTH sides (${base} / ${quote})` };
    }
    if (isStablecoinMint(base)) return { kind: "refuse", mint: base, ticker: tick(base), why: "pool base (underlying) is a listed stablecoin" };
    return { kind: "ok" };
  } catch (err) {
    return { kind: "held", why: `could not resolve the pool's mints: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Verdict for one NEW row: refuse beats held beats ok across its sources. Never throws. */
export async function classifyNewRow(entry: MarketEntry, conn: PoolReader | undefined, timeoutMs = 8_000): Promise<RowVerdict> {
  let held: RowVerdict | null = null;
  for (const src of sourcesOf(entry)) {
    const v = await classifySource(src, conn, timeoutMs);
    if (v.kind === "refuse") return v;
    if (v.kind === "held" && !held) held = v;
  }
  return held ?? { kind: "ok" };
}

const loggedRefusals = new Set<string>();
/** Test hook: forget which refusals were already logged. */
export function resetStablecoinReloadLogState(): void {
  loggedRefusals.clear();
}

/**
 * The hot-reload step with the stablecoin gate. Same contract as reloadRegistryOnce (never throws, bad files skipped, nothing blanked):
 * a NEW row that is refused or held is left out of the in-memory registry; every other row updates / prunes normally.
 */
export async function reloadRegistryGated(
  registry: Registry,
  registryPath: string,
  opts: { conn?: PoolReader; timeoutMs?: number },
): Promise<{ added: number; removed: number; updated: number }> {
  const zero = { added: 0, removed: 0, updated: 0 };
  try {
    const onDisk = readRegistryForReload(registry, registryPath);
    if (!onDisk) return zero;
    const tracked = new Set(registry.markets.map((m) => m.marketAddress));
    const admit: MarketEntry[] = [];
    for (const row of onDisk.markets) {
      if (tracked.has(row.marketAddress)) { admit.push(row); continue; }
      const v = await classifyNewRow(row, opts.conn, opts.timeoutMs);
      if (v.kind === "ok") { admit.push(row); continue; }
      if (v.kind === "refuse") {
        const key = `${row.marketAddress}|${v.mint}`;
        if (!loggedRefusals.has(key)) {
          loggedRefusals.add(key);
          console.warn(`[stablecoin-refusal] REFUSING hot-reload admission of ${row.marketAddress} mint=${v.mint} ticker=${v.ticker} — ${v.why} (held out of the registry; remove the row to silence)`);
        }
      } else {
        console.warn(`[stablecoin-refusal] HOLDING ${row.marketAddress} out of the registry (mint unresolved, will retry next reload) — ${v.why}`);
      }
    }
    return applyOnDisk(registry, { ...onDisk, markets: admit }, registryPath);
  } catch (err) {
    console.error(`[registry-reload] stablecoin gate error — keeping current in-memory registry: ${err instanceof Error ? err.message : String(err)}`);
    return zero;
  }
}

/**
 * Boot: rows loaded from disk are treated as already tracked (never refused). With the flag on, warn once per stablecoin row.
 * Read-only (pool reads only); never throws.
 */
export async function warnBootStablecoinRows(registry: Registry, conn: PoolReader | undefined, env: NodeJS.ProcessEnv = process.env, timeoutMs = 8_000): Promise<number> {
  if (!refuseStablecoinUnderlyingsEnabled(env)) return 0;
  let n = 0;
  try {
    for (const row of [...registry.markets]) {
      const v = await classifyNewRow(row, conn, timeoutMs);
      if (v.kind === "refuse") {
        n++;
        console.warn(`[stablecoin-refusal] boot: ${row.marketAddress} mint=${v.mint} ticker=${v.ticker} is ALREADY TRACKED — KEEPING it (refusal is new-admission only) — ${v.why}`);
      }
    }
  } catch (err) {
    console.warn(`[stablecoin-refusal] boot scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return n;
}
