/**
 * cross-cluster/registry.ts
 *
 * Market→pool registry for the cross-cluster keeper.
 *
 * Each entry maps a devnet slab (market) address to its corresponding
 * mainnet DEX pool. The keeper reads prices from mainnet pools and pushes
 * them to devnet markets via PushAuthMark.
 *
 * The registry is backed by a JSON file (default: ./registry.json).
 * Managed programmatically via addMarket() / removeMarket(), and by the
 * create-market wizard which registers markets at creation time.
 */
import fs from "fs";
import path from "path";

/** DEX types supported by the dex-oracle module. */
export type DexType = "raydium-clmm" | "meteora-dlmm" | "pumpswap";

/**
 * A single market registration: one devnet slab tracked against one mainnet pool.
 */
export interface MarketEntry {
  /** Human-readable label, e.g. "SOL/USDC (Raydium CLMM)". */
  label: string;
  /** Devnet slab (market) account address — target for PushAuthMark. */
  marketAddress: string;
  /** Mainnet DEX pool address — price source. */
  poolAddress: string;
  /** DEX type for price computation. */
  dexType: DexType;
  /**
   * Asset slot index in the slab.
   * Current markets use a single asset at index 0.
   */
  assetIndex: number;
  /** Unix timestamp (ms) when this entry was registered. */
  registeredAt?: number;
  /**
   * Optional display symbol (e.g. "SOL/USDC"). Present on the pre-seeded entries in
   * registry.json and on entries added by the playground registration-poll loop
   * (register-poll.ts). Not read by the push/crank loops — display/logging only.
   */
  symbol?: string;
  /**
   * Optional collateral label or mint address, for display/logging only — not read
   * by the push/crank loops. Pre-seeded entries use a short label ("SimUSDC");
   * playground-registered entries carry the actual devnet collateral mint.
   */
  collateral?: string;
  /**
   * Optional pre-known LP-vault ("matcher-enabled") portfolio address for this
   * market, seeded directly in registry.json for markets created via
   * newmarkets.ts / launch-test-market.ts. When present, the recovery cranker
   * (recovery-cranker.ts) uses it immediately and SKIPS the
   * getProgramAccounts discovery scan entirely for this market.
   *
   * This closes the D5 boot-gap that caused the 2026-07 SOL/JUP/TRUMP market
   * deaths: the old discovery-only path retried a failed lookup only every
   * DISCOVERY_RETRY_MS (previously 5 minutes) — longer than the ~190s engine
   * accrue-staleness cliff — so a single transient discovery miss right after
   * boot was enough to leave a market un-cranked long enough to drift into a
   * permanent EngineStale(19)/EngineLockActive(21) state. Markets registered
   * live via the register-poll loop have no lpPortfolio in their payload, so
   * they still fall back to discovery — just retried much faster now.
   */
  lpPortfolio?: string;
}

export interface Registry {
  version: number;
  description: string;
  markets: MarketEntry[];
}

const REGISTRY_VERSION = 1;

/**
 * Load the registry from a JSON file.
 * Returns an empty registry if the file does not exist.
 * Throws on malformed JSON or missing required fields.
 */
export function loadRegistry(registryPath: string): Registry {
  if (!fs.existsSync(registryPath)) {
    return {
      version: REGISTRY_VERSION,
      description:
        "Cross-cluster oracle keeper: devnet markets → mainnet pool price sources",
      markets: [],
    };
  }
  const raw = fs.readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<Registry>;
  if (typeof parsed.version !== "number" || !Array.isArray(parsed.markets)) {
    throw new Error(
      `Invalid registry at ${registryPath}: missing version or markets array`,
    );
  }
  return parsed as Registry;
}

/**
 * Save the registry to a JSON file.
 * Creates parent directories if necessary.
 */
export function saveRegistry(registry: Registry, registryPath: string): void {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify(registry, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Add or update a market entry.
 * If a market with the same `marketAddress` already exists it is replaced.
 * Returns the (possibly updated) entry.
 */
export function addMarket(
  registry: Registry,
  entry: Omit<MarketEntry, "registeredAt">,
): MarketEntry {
  const idx = registry.markets.findIndex(
    (m) => m.marketAddress === entry.marketAddress,
  );
  const full: MarketEntry = { ...entry, registeredAt: Date.now() };
  if (idx >= 0) {
    registry.markets[idx] = full;
  } else {
    registry.markets.push(full);
  }
  return full;
}

/**
 * Remove a market entry by its devnet address.
 * Returns true if an entry was removed, false if it was not found.
 */
export function removeMarket(
  registry: Registry,
  marketAddress: string,
): boolean {
  const before = registry.markets.length;
  registry.markets = registry.markets.filter(
    (m) => m.marketAddress !== marketAddress,
  );
  return registry.markets.length < before;
}
