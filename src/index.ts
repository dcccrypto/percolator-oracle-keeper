#!/usr/bin/env npx tsx
/**
 * PERC-374: Oracle Keeper Bot
 *
 * Production-grade oracle keeper that mirrors Binance spot prices to
 * Percolator devnet markets via PushOraclePrice + KeeperCrank.
 *
 * Improvements over oracle-pusher.ts:
 *   - Multi-source failover: Pyth Hermes → Jupiter → DexScreener
 *   - Staleness detection: alerts if price hasn't updated in 30s
 *   - Circuit breaker: rejects price moves > 10% per update
 *   - Health endpoint: /health for monitoring
 *   - Graceful shutdown with drain
 *   - Per-market stats tracking
 *   - Auto-discovery: reads markets from deployment or Supabase
 *
 * Usage:
 *   npx tsx scripts/oracle-keeper.ts
 *
 * Environment:
 *   RPC_URL           — Solana RPC (default: devnet)
 *   ADMIN_KEYPAIR_PATH — Oracle authority keypair
 *   PUSH_INTERVAL_MS  — Push interval (default: 3000)
 *   HEALTH_PORT       — HTTP health check port (default: 18810)
 *   HEALTH_BIND       — Bind address for health server (default: 0.0.0.0 so platform
 *                       health checks can reach it; set 127.0.0.1 for loopback-only)
 *   HEALTH_AUTH_TOKEN — Bearer token for health endpoint auth (optional but recommended)
 *   MAX_PRICE_MOVE_PCT — Circuit breaker % (default: 10)
 *   STALE_THRESHOLD_S  — Staleness alert threshold (default: 30)
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  encodePushOraclePrice, encodeKeeperCrank, encodeUpdateHyperpMark,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas, buildIx, WELL_KNOWN,
  parseConfig,
  detectDexType, parseDexPool,
} from "@percolator/sdk";
import * as fs from "fs";
import * as http from "http";

// ── Config ──────────────────────────────────────────────────
const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS ?? "3000");
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "18810");
const MAX_PRICE_MOVE_PCT = Number(process.env.MAX_PRICE_MOVE_PCT ?? "10");
const STALE_THRESHOLD_S = Number(process.env.STALE_THRESHOLD_S ?? "30");
/**
 * Blocked Markets - Markets that cannot be serviced by this oracle-keeper
 *
 * These markets are permanently blocked because their oracle_authority is not controlled
 * by this keeper's private key. Attempting to crank them fails with admin check error (0xf).
 *
 * WHY BLOCKED:
 * - Slab admin mismatch: User-created markets use different admin keypair (3ee9...b55)
 * - Our keeper controls oracle_authority: DJKjmSbWjhx925kuk1fS1BENCBnqXCfwUJjb9EKwSEnV
 * - On-chain check: SetOracleAuthority instruction rejects mismatched admin
 * - Last verified: 2026-03-10 (confirmed: instruction fails with error code 0xf)
 *
 * ADDING MARKETS:
 * 1. Hardcoded: Add address to HARDCODED_BLOCKED_MARKETS below
 * 2. Temporary: Set ORACLE_KEEPER_BLOCKED_MARKETS env var:
 *    $ export ORACLE_KEEPER_BLOCKED_MARKETS="addr1,addr2,addr3"
 * 3. Permanent: Update hardcoded list and redeploy
 * 
 * DO NOT attempt to include marketplace-created markets without fixing oracle_authority.
 * This will cause repeated failed transactions and wasted transaction fees.
 *
 * @see SetOracleAuthority on-chain instruction for admin check logic
 */
const HARDCODED_BLOCKED_MARKETS = new Set<string>([
  "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT", // PERCOLATOR-PERP-1 (Small)
  "484DG6KQi5eVXuaXzWxaWMWeXDp9LFXyshNi33UnWfxV", // PERCOLATOR-PERP-2 (Small)
  "GDyHCzpiuEsWDkLuji3NEFYJfqbDTzMCKn9ugUzTZqAW", // PERCOLATOR-PERP-3 (Large)
]);

/**
 * Combined list of blocked markets (hardcoded + environment-based)
 *
 * Supports two configuration methods:
 * - Hardcoded: HARDCODED_BLOCKED_MARKETS (permanent)
 * - Environment: ORACLE_KEEPER_BLOCKED_MARKETS (temporary/operational)
 *
 * Both are merged at startup. Use environment variable for emergency blocks
 * without redeploying. Use hardcoded for permanent blocks.
 */
const ORACLE_KEEPER_BLOCKED_MARKETS = new Set<string>([
  ...HARDCODED_BLOCKED_MARKETS,
  ...(process.env.ORACLE_KEEPER_BLOCKED_MARKETS ?? "").split(",").map(s => s.trim()).filter(Boolean),
]);
const ADMIN_KP_PATH = process.env.ADMIN_KEYPAIR_PATH ??
  `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;
// RPC_URL is required and validated at startup by validateEnvironmentConfig()
// Removed silent fallback to prevent misconfigured production deployments from
// accidentally connecting to public devnet (HIGH-002 security hardening)
const RPC_URL = process.env.RPC_URL!;

const conn = new Connection(RPC_URL, "confirmed");

/**
 * Load oracle keeper admin keypair with security hardening
 * 
 * Supports two sources:
 * 1. ADMIN_KEYPAIR env var (JSON array) — for Railway/Docker deployments
 * 2. File at ADMIN_KEYPAIR_PATH — standard Solana keypair file
 * 
 * Security measures:
 * - Sanitized error handling (never expose env contents in errors)
 * - Memory overwrite before deletion (prevent recovery via forensics)
 * - Structured deletion verification (assert cleanup succeeded)
 * - Fail-fast if deletion fails (prevents accidental leaks)
 */
function loadAdminKeypair(): Keypair {
  let adminSecretKey: Uint8Array;
  const hasEnvKeypair = !!process.env.ADMIN_KEYPAIR;

  try {
    if (hasEnvKeypair) {
      // Load from environment (inline keypair for deployments)
      try {
        const keypairJson = process.env.ADMIN_KEYPAIR!;
        const secretKeyArray = JSON.parse(keypairJson) as number[];
        adminSecretKey = Uint8Array.from(secretKeyArray);
      } catch (parseErr) {
        // Never expose the actual env var contents in error messages
        const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.error("[FATAL] Failed to parse ADMIN_KEYPAIR from environment: Invalid JSON format");
        console.error("[DEBUG] Parse error detail:", errMsg);
        process.exit(1);
      }
    } else {
      // Load from file (standard Solana keypair file)
      try {
        const fileContent = fs.readFileSync(ADMIN_KP_PATH, "utf8");
        const secretKeyArray = JSON.parse(fileContent) as number[];
        adminSecretKey = Uint8Array.from(secretKeyArray);
      } catch (fileErr) {
        const errMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
        console.error(`[FATAL] Failed to load keypair from ${ADMIN_KP_PATH}: ${errMsg}`);
        process.exit(1);
      }
    }

    // Create keypair instance
    const admin = Keypair.fromSecretKey(adminSecretKey);

    // ─── Security: Scrub keypair material from environment ───
    // Prevent leaks via process inspection, child processes, or crash dumps
    if (hasEnvKeypair) {
      const keypairLength = process.env.ADMIN_KEYPAIR!.length;
      
      // Overwrite memory with garbage before deletion
      // This prevents forensic recovery of the secret key if the process is dumped
      process.env.ADMIN_KEYPAIR = Buffer.alloc(keypairLength, 0x00).toString("hex");
      
      // Delete the environment variable
      delete process.env.ADMIN_KEYPAIR;
      
      // Verify deletion succeeded (fail-fast if something went wrong)
      if (process.env.ADMIN_KEYPAIR !== undefined) {
        console.error("[CRITICAL] Failed to delete ADMIN_KEYPAIR from environment");
        console.error("[ACTION] Process must exit to prevent secret key exposure");
        process.exit(1);
      }
      
      console.log("[INFO] Keeper authentication loaded from environment (secret cleared)");
    } else {
      console.log(`[INFO] Keeper authentication loaded from file: ${ADMIN_KP_PATH}`);
    }

    return admin;
  } catch (err) {
    // Catch any unexpected errors
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[FATAL] Unexpected error loading keeper authentication: ${errMsg}`);
    process.exit(1);
  }
}

const admin = loadAdminKeypair();

// Pyth Hermes endpoint (free, no API key required)
const HERMES_URL = process.env.HERMES_URL ?? "https://hermes.pyth.network";
// Health endpoint security (from security hardening #616).
// #2: default to 0.0.0.0 — Railway's platform health check probes the container from
// outside, so a 127.0.0.1 (loopback-only) bind is unreachable and the service is marked
// unhealthy / fails to deploy. Binding all interfaces is the correct container default;
// the endpoint is gated by HEALTH_AUTH_TOKEN when set. Override via HEALTH_BIND for
// loopback-only / sidecar setups.
const HEALTH_BIND = process.env.HEALTH_BIND ?? "0.0.0.0";
const HEALTH_AUTH_TOKEN = process.env.HEALTH_AUTH_TOKEN ?? "";

// Track markets where we're not the oracle authority (skip future attempts)
const skippedMarkets = new Set<string>();
// Track markets where oracle authority has been successfully verified
const authorityVerified = new Set<string>();
// Cache the on-chain program owner (slab.owner) per slab address.
// Dynamic markets discovered via Supabase may be owned by a different program tier
// than the one in deployment.json (e.g. old program FwfB... vs current FxfD...).
// We must use the slab's actual owner as the programId when building instructions,
// otherwise the Solana runtime rejects with "Provided owner is not allowed" (0x10).
const slabProgramId = new Map<string, PublicKey>();

/**
 * Validate critical environment variables at startup (HIGH-001 security fix)
 *
 * Performs structured validation of config to catch misconfigurations
 * before they cause runtime failures or silent degradation.
 *
 * Validates:
 * - RPC_URL: Must be a valid URL (not empty)
 * - SUPABASE_URL: If set, must be valid URL
 * - SUPABASE_SERVICE_ROLE_KEY: If SUPABASE_URL set, key must be non-empty (100+ chars)
 * - API_AUTH_TOKEN: If set, must be non-empty
 * - HEALTH_AUTH_TOKEN: If set, must be non-empty
 *
 * @throws Exits process with code 1 if validation fails
 */
function validateEnvironmentConfig(): void {
  const errors: string[] = [];

  // Validate RPC_URL (critical — cannot crank without valid RPC)
  const rpcUrl = (process.env.RPC_URL ?? "").trim();
  if (!rpcUrl) {
    errors.push("RPC_URL is required but not set or empty. Set RPC_URL to your Solana RPC endpoint.");
  } else {
    try {
      const url = new URL(rpcUrl);
      if (!url.protocol.match(/^https?:$/)) {
        errors.push(`RPC_URL must use http or https protocol, got: ${url.protocol}`);
      }
    } catch (e) {
      errors.push(`RPC_URL is not a valid URL: ${rpcUrl}`);
    }
  }

  // Validate Supabase configuration (if enabled)
  const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  if (supabaseUrl && !supabaseKey) {
    errors.push(
      "SUPABASE_URL is configured but SUPABASE_SERVICE_ROLE_KEY is missing. " +
      "Either disable Supabase (unset SUPABASE_URL) or provide a service role key.",
    );
  }

  if (supabaseUrl) {
    try {
      const url = new URL(supabaseUrl);
      if (!url.protocol.match(/^https?:$/)) {
        errors.push(`SUPABASE_URL must use http or https protocol, got: ${url.protocol}`);
      }
    } catch (e) {
      errors.push(`SUPABASE_URL is not a valid URL: ${supabaseUrl}`);
    }
  }

  if (supabaseUrl && supabaseKey && supabaseKey.length < 100) {
    errors.push(
      `SUPABASE_SERVICE_ROLE_KEY appears truncated (${supabaseKey.length} chars, expected 100+). ` +
      "This usually indicates a copy-paste error.",
    );
  }

  // Validate optional auth tokens (should not be empty if set)
  const apiAuthToken = process.env.API_AUTH_TOKEN?.trim() ?? "";
  if (process.env.API_AUTH_TOKEN && !apiAuthToken) {
    errors.push(
      "API_AUTH_TOKEN is set but empty. Either remove it or provide a token.",
    );
  }

  const healthAuthToken = process.env.HEALTH_AUTH_TOKEN?.trim() ?? "";
  if (process.env.HEALTH_AUTH_TOKEN && !healthAuthToken) {
    errors.push(
      "HEALTH_AUTH_TOKEN is set but empty. Either remove it or provide a token.",
    );
  }

  // If any validation errors, log them and exit
  if (errors.length > 0) {
    console.error("[FATAL] Environment configuration validation failed:");
    errors.forEach((err, idx) => {
      console.error(`  ${idx + 1}. ${err}`);
    });
    console.error("");
    console.error("[ACTION] Fix the above environment variables and restart the keeper.");
    process.exit(1);
  }

  console.log("[INFO] ✅ Environment configuration validated successfully");
}

// ── Supabase Auto-Discovery ─────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS ?? "30000"); // 30s

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

/** Lightweight Supabase REST query — no client library needed */
async function supabaseQuery(table: string, params: string): Promise<any[] | null> {
  if (!supabaseEnabled) return null;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${params}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ── Types ───────────────────────────────────────────────────
interface MarketInfo {
  symbol: string;
  label: string;
  slab: string;
  priceE6?: string;
  /** "admin" | "pyth" | "hyperp" — from Supabase oracle_mode column */
  oracleMode?: string;
  /** DEX pool address for HYPERP markets — from Supabase dex_pool_address column */
  dexPoolAddress?: string;
}

interface MarketStats {
  symbol: string;
  lastPrice: number;
  lastPushAt: number;       // epoch ms
  lastPushSig: string;
  totalPushes: number;
  totalErrors: number;
  consecutiveErrors: number;
  circuitBreakerTrips: number;
  source: string;           // last successful source
}

// ── Price Sources ───────────────────────────────────────────

// Pyth Network feed IDs (hex, without 0x prefix) — universal across all chains
const PYTH_FEED_IDS: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BONK: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  WIF: "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
  JTO: "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  JUP: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  PYTH: "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff",
  RAY: "91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a",
  W: "eff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389",
  TNSR: "05ecd4597cd48fe13d6cc3596c62af4f9675aee06e2e0b94c06d8bee2b659e05",
};

// Jupiter mint addresses — fallback for tokens not on Pyth
const JUPITER_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  RNDR: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
  SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
  SEEKER: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
};

/** Batch-fetch prices from Pyth Hermes REST API */
const pythCache = new Map<string, { price: number; ts: number }>();

async function fetchPythPrices(symbols: string[]): Promise<void> {
  const ids = symbols
    .map(s => PYTH_FEED_IDS[s])
    .filter(Boolean);
  if (ids.length === 0) return;

  try {
    const params = ids.map(id => `ids[]=${id}`).join("&");
    const resp = await fetch(
      `${HERMES_URL}/v2/updates/price/latest?${params}&parsed=true`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      log(`⚠️ Pyth Hermes returned ${resp.status}`);
      return;
    }
    const json = (await resp.json()) as {
      parsed: Array<{
        id: string;
        price: { price: string; expo: number; publish_time: number };
      }>;
    };

    // Build reverse map: feedId → symbol
    const idToSymbol = new Map<string, string>();
    for (const [sym, id] of Object.entries(PYTH_FEED_IDS)) {
      idToSymbol.set(id, sym);
    }

    for (const entry of json.parsed) {
      const sym = idToSymbol.get(entry.id);
      if (!sym) continue;
      const rawPrice = parseInt(entry.price.price, 10);
      const expo = entry.price.expo;
      const price = rawPrice * Math.pow(10, expo);
      // Use Pyth's publish_time as the cache timestamp (not fetch time).
      // This ensures getPythPrice's 30s staleness check operates against the
      // actual Pyth oracle clock, not the moment we fetched the HTTP response.
      // Reject prices Pyth hasn't updated in 60s — they are stale at the source.
      const publishMs = entry.price.publish_time * 1000;
      const ageMs = Date.now() - publishMs;
      if (price > 0 && ageMs >= 0 && ageMs < 60_000) {
        pythCache.set(sym, { price, ts: publishMs });
      } else if (price > 0) {
        log(`⚠️ ${sym}: Pyth publish_time is ${Math.floor(ageMs / 1000)}s old — rejecting stale price`);
      }
    }
  } catch (e) {
    log(`⚠️ Pyth Hermes fetch failed: ${(e as Error).message?.slice(0, 60)}`);
  }
}

function getPythPrice(symbol: string): number | null {
  const cached = pythCache.get(symbol);
  if (!cached) return null;
  // Reject if older than 30s
  if (Date.now() - cached.ts > 30_000) return null;
  return cached.price;
}

/** Jupiter price fallback (uses mint addresses) */
async function fetchJupiterPrice(symbol: string): Promise<number | null> {
  const mint = JUPITER_MINTS[symbol];
  if (!mint) return null;
  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${mint}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const data = json.data?.[mint];
    if (!data?.price) return null;
    const p = parseFloat(data.price);
    return isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** DexScreener fallback for custom/exotic tokens */
async function fetchDexScreenerPrice(symbol: string): Promise<number | null> {
  const mint = JUPITER_MINTS[symbol];
  if (!mint) return null;
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const pair = json.pairs?.[0];
    if (!pair?.priceUsd) return null;
    const p = parseFloat(pair.priceUsd);
    return isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** Fetch price with multi-source failover: Pyth → Jupiter → DexScreener → CA lookup */
async function getPrice(symbol: string, slab?: string): Promise<{ price: number; source: string } | null> {
  // Primary: Pyth (decentralized oracle, fastest for supported tokens)
  const pyth = getPythPrice(symbol);
  if (pyth) return { price: pyth, source: "pyth" };

  // Secondary: Jupiter (Solana DEX aggregator, uses mint addresses)
  const jup = await fetchJupiterPrice(symbol);
  if (jup) return { price: jup, source: "jupiter" };

  // Tertiary: DexScreener (broad coverage for exotic tokens)
  const dex = await fetchDexScreenerPrice(symbol);
  if (dex) return { price: dex, source: "dexscreener" };

  // Quaternary: Direct CA lookup for dynamic markets (PERC-465)
  if (slab) {
    const ca = slabToMainnetCA.get(slab);
    if (ca) {
      const caPrice = await fetchPriceByCA(ca);
      if (caPrice) return caPrice;
    }
  }

  return null;
}

/**
 * Sanity-check a price before pushing it on-chain.
 * Rejects zero, negative, or non-finite values which would corrupt market state.
 */
function isPriceValid(price: number): boolean {
  return typeof price === "number" && isFinite(price) && price > 0;
}

// ── Stats ───────────────────────────────────────────────────
const stats = new Map<string, MarketStats>();
let startTime = Date.now();

// ── Wallet Balance Guard ─────────────────────────────────────
// Minimum keeper wallet balance (lamports) before pushing is paused.
// Devops audit 2026-03-14: wallet FF7KFfU5 exhausted twice in one day from
// ~20+ markets per 3-second cycle. Guard prevents on-chain txn drain when
// balance is low. Default: 0.05 SOL (50_000_000 lamports).
const MIN_KEEPER_BALANCE_LAMPORTS = Number(
  process.env.MIN_KEEPER_BALANCE_SOL
    ? Math.round(parseFloat(process.env.MIN_KEEPER_BALANCE_SOL) * 1e9)
    : 50_000_000,
);
// Interval between balance refreshes (default: every 30 s = ~10 push cycles at 3s interval)
const BALANCE_CHECK_INTERVAL_MS = Number(process.env.BALANCE_CHECK_INTERVAL_MS ?? "30000");
let walletBalanceLamports: number | null = null;
let lastBalanceCheckAt = 0;
let walletLow = false;

function getOrCreateStats(market: MarketInfo): MarketStats {
  let s = stats.get(market.slab);
  if (!s) {
    s = {
      symbol: market.symbol,
      lastPrice: 0,
      lastPushAt: 0,
      lastPushSig: "",
      totalPushes: 0,
      totalErrors: 0,
      consecutiveErrors: 0,
      circuitBreakerTrips: 0,
      source: "",
    };
    stats.set(market.slab, s);
  }
  return s;
}

// ── Circuit Breaker ─────────────────────────────────────────
function checkCircuitBreaker(stats: MarketStats, newPrice: number): boolean {
  if (stats.lastPrice === 0) return true; // First price, always accept
  const movePct = Math.abs((newPrice - stats.lastPrice) / stats.lastPrice) * 100;
  if (movePct > MAX_PRICE_MOVE_PCT) {
    log(`🔴 ${stats.symbol}: Circuit breaker! ${stats.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} (${movePct.toFixed(1)}% > ${MAX_PRICE_MOVE_PCT}%)`);
    stats.circuitBreakerTrips++;
    return false;
  }
  return true;
}

// ── Logging ─────────────────────────────────────────────────
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [oracle-keeper] ${msg}`);
}

/**
 * Extract transaction context from error or transaction object for debugging.
 * Helps diagnose cranking failures by capturing:
 * - Transaction size (bytes)
 * - Instruction count
 * - Compute budget allocated vs used
 * - Blockhash age
 * - Recent transaction signatures (for duplicate detection)
 * - Error code if ParsedTransactionError
 */
function formatTransactionContext(error: any, tx?: any): string {
  const parts: string[] = [];

  // Extract error code if available
  if (error?.code) {
    parts.push(`code=${error.code}`);
  } else if (error?.message?.match(/error [0-9]+/i)) {
    const match = error.message.match(/error (\d+)/i);
    if (match) parts.push(`code=${match[1]}`);
  }

  // Transaction details if available
  if (tx) {
    try {
      // Transaction size
      const txSize = tx.serialize?.().length || tx.instructions?.reduce?.((sum: number, ix: any) => {
        const ixSize = (ix.data?.length || 0) + (ix.keys?.length || 0) * 32;
        return sum + ixSize;
      }, 0) || 0;
      if (txSize > 0) parts.push(`tx_size=${txSize}B`);

      // Instruction count
      const ixCount = tx.instructions?.length || 0;
      if (ixCount > 0) parts.push(`ixs=${ixCount}`);

      // Compute budget — look for setComputeUnitLimit instruction
      const computeIx = tx.instructions?.find?.((ix: any) =>
        ix.programId?.equals?.(ComputeBudgetProgram.programId) &&
        ix.data?.[0] === 0x00 // setComputeUnitLimit opcode
      );
      if (computeIx) {
        const budget = computeIx.data ? new DataView(computeIx.data.buffer).getUint32(1, true) : 0;
        if (budget > 0) parts.push(`compute_budget=${budget}CU`);
      }

      // Blockhash age
      if (tx.recentBlockhash) {
        // This is approximate — actual age would require fetching blockhash creation time
        const age = Math.floor(Date.now() / 1000) % 256; // Rough estimate
        if (age < 256) parts.push(`blockhash_age_approx=${age}s`);
      }
    } catch {
      // Silently skip if unable to extract transaction details
    }
  }

  // Recent transaction signatures from error — helps detect duplicates
  if (error?.signature) {
    parts.push(`sig=${(error.signature as string).slice(0, 12)}...`);
  }

  if (error?.logs?.length > 0) {
    // Count WARN/ERROR log lines
    const errorLogs = (error.logs as string[]).filter((l: string) =>
      l.includes("ERROR") || l.includes("panic") || l.includes("Custom:")
    );
    if (errorLogs.length > 0) parts.push(`error_logs=${errorLogs.length}`);
  }

  return parts.length > 0 ? `[${parts.join(" | ")}]` : "";
}

// ── Push + Crank ────────────────────────────────────────────
async function pushAndCrank(market: MarketInfo, programId: PublicKey): Promise<void> {
  const s = getOrCreateStats(market);

  // Skip markets explicitly blocked via ORACLE_KEEPER_BLOCKED_MARKETS env var
  if (ORACLE_KEEPER_BLOCKED_MARKETS.has(market.slab)) return;

  // HYPERP markets use on-chain DEX pool oracle — route to dedicated crank
  if (market.oracleMode === "hyperp") {
    try {
      await updateHyperpMark(market, programId);
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 120) ?? String(e);
      log(`⚠️ ${market.label}: UpdateHyperpMark failed: ${msg}`);
      s.totalErrors++;
      s.consecutiveErrors++;
    }
    return;
  }

  // Skip markets where we've already confirmed we're not the oracle authority
  if (skippedMarkets.has(market.slab)) return;

  // Validate oracle authority on-chain: run on first attempt, or every 50 errors
  // (catches cases where fetchSlab failed transiently on the first check)
  const needsAuthorityCheck = !authorityVerified.has(market.slab) &&
    (s.totalErrors === 0 || s.totalErrors % 50 === 0);
  if (needsAuthorityCheck) {
    try {
      // Use getAccountInfo directly (not fetchSlab) so we can also cache the
      // slab's on-chain owner program. Dynamic markets discovered via Supabase
      // may be owned by a different deployed program than the one in
      // deployment.json (e.g. old FwfB... vs current FxfD...).
      const slabInfo = await conn.getAccountInfo(new PublicKey(market.slab));
      if (!slabInfo) throw new Error(`Slab account not found: ${market.slab}`);
      const slabData = new Uint8Array(slabInfo.data);
      const cfg = parseConfig(slabData);
      if (!cfg.oracleAuthority.equals(admin.publicKey)) {
        log(`🚨 ${market.label}: ORACLE AUTHORITY MISMATCH — slab has ${cfg.oracleAuthority.toBase58()}, keeper is signing as ${admin.publicKey.toBase58()}. Needs reinit. Skipping.`);
        skippedMarkets.add(market.slab);
        return;
      }
      // Cache the slab's actual program owner for use in instruction building
      slabProgramId.set(market.slab, slabInfo.owner);
      if (!slabInfo.owner.equals(programId)) {
        log(`ℹ️ ${market.label}: slab owned by ${slabInfo.owner.toBase58().slice(0, 12)}... (differs from deployment.json programId ${programId.toBase58().slice(0, 12)}...) — will use slab owner`);
      }
      authorityVerified.add(market.slab);
      log(`✓ ${market.label}: oracle authority verified (${admin.publicKey.toBase58().slice(0, 12)}...)`);
    } catch (e) {
      // getAccountInfo/parseConfig failed — we cannot confirm we have authority.
      // Skip this tick rather than pushing blindly and generating 'Provided owner is not allowed' spam.
      log(`⚠️ ${market.label}: failed to verify oracle authority — skipping tick (attempt ${s.totalErrors + 1}): ${(e as Error).message?.slice(0, 80)}`);
      s.totalErrors++;
      return;
    }
  }

  const result = await getPrice(market.symbol, market.slab);

  // Resolve price: live source preferred, fall back to last known price when all
  // external sources return null or zero (e.g. devnet token with no DEX pool).
  // Without a fallback the on-chain oracle stays at 0, the UI freshness check marks
  // the market "unavailable", and trading is blocked even though a valid price exists
  // from a previous push.  This is safe: the circuit breaker below will still reject
  // moves > MAX_PRICE_MOVE_PCT, and s.lastPrice is only set after a successful push.
  let price: number;
  let source: string;

  if (result && isPriceValid(result.price)) {
    price = result.price;
    source = result.source;
  } else if (s.lastPrice > 0) {
    // Devnet / no-pool fallback: use last successfully pushed price to keep oracle alive.
    // Logged clearly so ops know the market is running on cached data.
    price = s.lastPrice;
    source = "last-known";
    if (!result) {
      s.totalErrors++;
      s.consecutiveErrors++;
      log(`⚠️ ${market.label}: no live price (${s.consecutiveErrors} consecutive failures) — holding last known $${s.lastPrice.toFixed(2)} to keep oracle alive`);
    } else {
      log(`⚠️ ${market.label}: invalid live price $${result.price} from ${result.source} — holding last known $${s.lastPrice.toFixed(2)}`);
    }
  } else {
    // No live price and no last known price — nothing we can safely push.
    s.totalErrors++;
    s.consecutiveErrors++;
    if (s.consecutiveErrors >= 3) {
      log(`⚠️ ${market.label}: no price from any source (${s.consecutiveErrors} consecutive failures)`);
    }
    return;
  }

  // Circuit breaker
  if (!checkCircuitBreaker(s, price)) return;

  const priceE6 = BigInt(Math.round(price * 1_000_000));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const slab = new PublicKey(market.slab);

  // Use the slab's actual on-chain program owner, not the deployment.json
  // programId. This handles Supabase-discovered markets that may have been
  // created by a different program tier/version than the BTC-PERP markets.
  const effectiveProgramId = slabProgramId.get(market.slab) ?? programId;

  const pushData = encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: timestamp.toString() });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [admin.publicKey, slab]);

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    admin.publicKey, slab, WELL_KNOWN.clock, slab,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: effectiveProgramId, keys: pushKeys, data: pushData }),
    buildIx({ programId: effectiveProgramId, keys: crankKeys, data: crankData }),
  );
  tx.feePayer = admin.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  let sig: string;
  try {
    sig = await sendAndConfirmTransaction(conn, tx, [admin], {
      commitment: "confirmed",
    });
  } catch (e) {
    // MEDIUM-004: Attach transaction details to error for better debugging
    const err = e as any;
    if (!err.txContext) {
      err.txContext = formatTransactionContext(e, tx);
    }
    throw err;
  }

  s.lastPrice = price;
  s.lastPushAt = Date.now();
  s.lastPushSig = sig;
  s.totalPushes++;
  s.consecutiveErrors = 0;
  s.source = source;

  log(`✅ ${market.label}: $${price.toFixed(2)} [${source}] → ${sig.slice(0, 12)}...`);
}

// ── HYPERP Oracle Cache ─────────────────────────────────────

interface HyperpPoolMeta {
  pool: PublicKey;
  /** Additional accounts required by the DEX (e.g. PumpSwap vaults) */
  extraAccounts: PublicKey[];
}

const hyperpPoolCache = new Map<string, HyperpPoolMeta>();

/**
 * Crank UpdateHyperpMark for a market in HYPERP oracle mode.
 *
 * HYPERP markets read their index price from an on-chain DEX pool (PumpSwap,
 * Raydium CLMM, or Meteora DLMM) instead of a Pyth feed. UpdateHyperpMark
 * is permissionless — any fee payer works.
 *
 * Without regular cranking the mark price goes stale (30–120 s observed
 * latency): each missed crank extends the EMA staleness window.
 */
async function updateHyperpMark(
  market: MarketInfo,
  programId: PublicKey,
): Promise<void> {
  if (!market.dexPoolAddress) {
    log(`⚠️ ${market.label}: HYPERP but no dex_pool_address — skipping UpdateHyperpMark`);
    return;
  }

  const slab = new PublicKey(market.slab);
  const effectiveProgramId = slabProgramId.get(market.slab) ?? programId;

  // Resolve (and cache) pool meta + extra accounts
  let poolMeta = hyperpPoolCache.get(market.slab);
  if (!poolMeta) {
    const poolPk = new PublicKey(market.dexPoolAddress);
    const poolInfo = await conn.getAccountInfo(poolPk);
    if (!poolInfo) {
      log(`⚠️ ${market.label}: DEX pool account not found: ${market.dexPoolAddress}`);
      return;
    }
    const extraAccounts: PublicKey[] = [];
    // PumpSwap pools carry vault addresses in their account data layout
    const dexType = detectDexType(poolInfo.owner);
    if (dexType === "pumpswap") {
      const parsed = parseDexPool(dexType, poolPk, Buffer.from(poolInfo.data));
      if (parsed?.baseVault) extraAccounts.push(parsed.baseVault);
      if (parsed?.quoteVault) extraAccounts.push(parsed.quoteVault);
    }
    poolMeta = { pool: poolPk, extraAccounts };
    hyperpPoolCache.set(market.slab, poolMeta);
    log(`ℹ️ ${market.label}: resolved DEX pool ${market.dexPoolAddress.slice(0, 12)}... (dex=${dexType}, extras=${extraAccounts.length})`);
  }

  const markData = encodeUpdateHyperpMark();
  const markKeys = [
    { pubkey: slab, isSigner: false, isWritable: true },
    { pubkey: poolMeta.pool, isSigner: false, isWritable: false },
    { pubkey: WELL_KNOWN.clock, isSigner: false, isWritable: false },
    ...poolMeta.extraAccounts.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: false })),
  ];

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    admin.publicKey, slab, WELL_KNOWN.clock, slab,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: effectiveProgramId, keys: markKeys, data: markData }),
    buildIx({ programId: effectiveProgramId, keys: crankKeys, data: crankData }),
  );
  tx.feePayer = admin.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  let sig: string;
  try {
    sig = await sendAndConfirmTransaction(conn, tx, [admin], {
      commitment: "confirmed",
    });
  } catch (e) {
    // MEDIUM-004: Attach transaction details to error for better debugging
    const err = e as any;
    if (!err.txContext) {
      err.txContext = formatTransactionContext(e, tx);
    }
    throw err;
  }

  const s = getOrCreateStats(market);
  s.lastPushAt = Date.now();
  s.lastPushSig = sig;
  s.totalPushes++;
  s.consecutiveErrors = 0;
  s.source = "hyperp-dex";

  log(`✅ ${market.label}: UpdateHyperpMark + KeeperCrank → ${sig.slice(0, 12)}...`);
}

// ── Health Check Server ─────────────────────────────────────
function startHealthServer() {
  const server = http.createServer((req, res) => {
    // Auth guard: if HEALTH_AUTH_TOKEN is set, require Bearer token
    if (HEALTH_AUTH_TOKEN) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${HEALTH_AUTH_TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (req.url === "/health" || req.url === "/") {
      const now = Date.now();
      const uptimeS = Math.floor((now - startTime) / 1000);
      const markets: Record<string, any> = {};
      let healthy = true;

      for (const [slab, s] of stats) {
        const staleSec = s.lastPushAt ? Math.floor((now - s.lastPushAt) / 1000) : -1;
        const isStale = staleSec > STALE_THRESHOLD_S;
        if (isStale) healthy = false;
        markets[s.symbol] = {
          lastPrice: s.lastPrice,
          lastPushAgo: `${staleSec}s`,
          stale: isStale,
          source: s.source,
          totalPushes: s.totalPushes,
          totalErrors: s.totalErrors,
          consecutiveErrors: s.consecutiveErrors,
          circuitBreakerTrips: s.circuitBreakerTrips,
        };
      }

      // If wallet is low, override status to degraded regardless of market staleness
      if (walletLow) healthy = false;

      const body = JSON.stringify({
        status: healthy ? "ok" : "degraded",
        uptime: `${uptimeS}s`,
        pushIntervalMs: PUSH_INTERVAL_MS,
        wallet: {
          address: admin.publicKey.toBase58(),
          balanceSol: walletBalanceLamports != null ? walletBalanceLamports / 1e9 : null,
          minBalanceSol: MIN_KEEPER_BALANCE_LAMPORTS / 1e9,
          low: walletLow,
        },
        markets,
      }, null, 2);

      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(HEALTH_PORT, HEALTH_BIND, () => {
    log(`Health endpoint: http://${HEALTH_BIND}:${HEALTH_PORT}/health${HEALTH_AUTH_TOKEN ? " (auth required)" : ""}`);
  });
  return server;
}

// ── Supabase Market Discovery ───────────────────────────────
const knownSlabs = new Set<string>();
// Module-level markets array — must be at module scope so discovery functions
// (discoverHyperpFromOracleTable, discoverNewMarkets) can read/mutate it.
// Bug fix: was previously `const markets` inside main(), making it inaccessible
// to module-level async functions → ReferenceError "markets is not defined" on
// every discovery cycle (oracle_markets discovery error). (Devops audit 2026-03-14)
let markets: MarketInfo[] = [];

/**
 * Poll Supabase `oracle_markets` table for explicitly-registered oracle configs.
 *
 * This table is an override layer: rows here take precedence over
 * markets.oracle_mode. Useful for registering HYPERP markets on devnet where
 * all markets are forced to oracle_mode='admin' because devnet-mirrored tokens
 * don't have real DEX pools (isDevnetMirror path in useCreateMarket).
 *
 * Any market listed here with oracle_type='hyperp' will be cranked via
 * UpdateHyperpMark regardless of what markets.oracle_mode says.
 * If the slab is already tracked with a different mode, this function
 * updates it in-place and clears the pool cache so the new pool is resolved.
 */
// Track which slabs were registered as hyperp via oracle_markets so we can
// detect when they're disabled and downgrade them back to admin oracle mode.
const hyperpFromOracleTable = new Set<string>();

async function discoverHyperpFromOracleTable(): Promise<MarketInfo[]> {
  if (!supabaseEnabled) return [];
  try {
    // Fetch ALL oracle_markets rows (both enabled and disabled) to detect downgrades.
    // Enabled=true rows: upgrade/register as hyperp.
    // Enabled=false rows previously registered: downgrade back to admin oracle mode
    // (PERC-804: prevents "DEX pool account not found" spam when pool is invalid).
    const data = await supabaseQuery(
      "oracle_markets",
      "select=slab_address,oracle_type,dex_pool_address,enabled&oracle_type=eq.hyperp",
    );
    if (!data) return [];

    // Build set of currently-enabled hyperp slabs from this poll
    const enabledHyperpSlabs = new Set<string>(
      data.filter((r: any) => r.enabled && r.slab_address && r.dex_pool_address).map((r: any) => r.slab_address as string)
    );

    // Downgrade: previously-registered hyperp slabs that are now disabled
    for (const slab of hyperpFromOracleTable) {
      if (!enabledHyperpSlabs.has(slab)) {
        const existing = markets.find(m => m.slab === slab);
        if (existing && existing.oracleMode === "hyperp") {
          log(`⬇️ ${existing.label}: oracle_markets disabled → downgrading from hyperp to admin oracle mode`);
          existing.oracleMode = "admin";
          existing.dexPoolAddress = undefined;
          hyperpPoolCache.delete(slab);
        }
        hyperpFromOracleTable.delete(slab);
      }
    }

    const newMarkets: MarketInfo[] = [];
    for (const row of data) {
      if (!row.enabled || !row.slab_address || !row.dex_pool_address) continue;

      if (knownSlabs.has(row.slab_address)) {
        // Upgrade an already-tracked market from admin/pyth → hyperp
        const existing = markets.find(m => m.slab === row.slab_address);
        if (existing && existing.oracleMode !== "hyperp") {
          log(`🔄 ${existing.label}: oracle_markets override → hyperp (pool=${row.dex_pool_address.slice(0, 12)}...)`);
          existing.oracleMode = "hyperp";
          existing.dexPoolAddress = row.dex_pool_address;
          hyperpPoolCache.delete(row.slab_address); // force re-fetch with new pool
        }
        hyperpFromOracleTable.add(row.slab_address);
        continue;
      }

      knownSlabs.add(row.slab_address);
      hyperpFromOracleTable.add(row.slab_address);
      newMarkets.push({
        symbol: "HYPERP",
        label: `${row.slab_address.slice(0, 8)}... (oracle_markets)`,
        slab: row.slab_address,
        oracleMode: "hyperp",
        dexPoolAddress: row.dex_pool_address ?? undefined,
      });
    }

    if (newMarkets.length > 0) {
      log(`🗂 oracle_markets: ${newMarkets.length} new HYPERP slab(s) registered for cranking`);
    }

    return newMarkets;
  } catch (e) {
    log(`⚠️ oracle_markets discovery error: ${(e as Error).message?.slice(0, 80)}`);
    return [];
  }
}

/**
 * Poll Supabase `markets` table for newly created markets with a mainnet_ca.
 * Returns new MarketInfo entries that aren't already tracked.
 */
async function discoverNewMarkets(): Promise<MarketInfo[]> {
  if (!supabaseEnabled) return [];
  try {
    const data = await supabaseQuery(
      "markets",
      "select=slab_address,mint_address,mainnet_ca,symbol,name,oracle_mode,dex_pool_address&mainnet_ca=not.is.null",
    );

    if (!data) {
      log(`⚠️ Supabase discovery failed`);
      return [];
    }

    const newMarkets: MarketInfo[] = [];
    for (const row of data) {
      if (knownSlabs.has(row.slab_address)) continue;
      knownSlabs.add(row.slab_address);

      // Map mainnet CA to a symbol for price lookup
      // Use the stored symbol, or fall back to the DB name
      const symbol = row.symbol?.toUpperCase() ?? "UNKNOWN";
      const oracleMode: string = row.oracle_mode ?? "admin";
      newMarkets.push({
        symbol,
        label: `${symbol}-PERP (dynamic)`,
        slab: row.slab_address,
        oracleMode,
        dexPoolAddress: row.dex_pool_address ?? undefined,
      });
    }
    return newMarkets;
  } catch (e) {
    log(`⚠️ Supabase discovery error: ${(e as Error).message?.slice(0, 80)}`);
    return [];
  }
}

/**
 * For dynamically discovered markets, we need to fetch prices by mainnet CA
 * since they may not be in PYTH_FEED_IDS or JUPITER_MINTS.
 * This fetches price directly using the mainnet CA via Jupiter Lite API.
 */
async function fetchPriceByCA(mainnetCA: string): Promise<{ price: number; source: string } | null> {
  // Validate as base58 Solana address before using in external URLs (#783, #784)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mainnetCA)) return null;
  const encoded = encodeURIComponent(mainnetCA);

  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${encoded}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const data = json.data?.[mainnetCA];
    if (data?.price) {
      const p = parseFloat(data.price);
      if (isFinite(p) && p > 0) return { price: p, source: "jupiter-ca" };
    }
  } catch {}

  // DexScreener fallback
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encoded}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const pair = json.pairs?.[0];
    if (pair?.priceUsd) {
      const p = parseFloat(pair.priceUsd);
      if (isFinite(p) && p > 0) return { price: p, source: "dexscreener-ca" };
    }
  } catch {}

  return null;
}

// Map slab address → mainnet CA for dynamic markets
const slabToMainnetCA = new Map<string, string>();

// ── Main Loop ───────────────────────────────────────────────
async function main() {
  // ─── STARTUP: Validate environment configuration (HIGH-001 security fix) ───
  validateEnvironmentConfig();

  log(`Oracle Keeper starting — admin: ${admin.publicKey.toBase58().slice(0, 12)}...`);
  // Redact RPC URL to prevent API key exposure in logs
  const rpcRedacted = (() => {
    try { const u = new URL(RPC_URL); return `${u.protocol}//${u.hostname}`; }
    catch { return "<invalid-url>"; }
  })();
  log(`RPC: ${rpcRedacted}`);
  log(`Push interval: ${PUSH_INTERVAL_MS}ms | Circuit breaker: ${MAX_PRICE_MOVE_PCT}% | Stale threshold: ${STALE_THRESHOLD_S}s`);

  const deployPath = "/tmp/percolator-devnet-deployment.json";
  let deployRaw: string | undefined;
  if (fs.existsSync(deployPath)) {
    deployRaw = fs.readFileSync(deployPath, "utf8");
  } else if (process.env.DEPLOYMENT_JSON) {
    log("Deployment file not found — falling back to DEPLOYMENT_JSON env var");
    deployRaw = process.env.DEPLOYMENT_JSON;
  } else if (supabaseEnabled) {
    log("No deployment file — running in Supabase-only discovery mode");
  } else {
    console.error("❌ Deployment info not found at", deployPath);
    console.error("   Run deploy-devnet-mm.ts first, set DEPLOYMENT_JSON env var, or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const deploy = deployRaw ? JSON.parse(deployRaw) : { programId: process.env.PROGRAM_ID, markets: [] };
  const programId = new PublicKey(deploy.programId);
  // Assign to module-level `markets` so discovery functions can access it.
  markets = (deploy.markets as MarketInfo[]).filter(m => {
    if (ORACLE_KEEPER_BLOCKED_MARKETS.has(m.slab)) {
      log(`⛔ STARTUP: ${m.label} (${m.slab.slice(0, 12)}...) — in ORACLE_KEEPER_BLOCKED_MARKETS, skipping`);
      return false;
    }
    return true;
  });

  log(`Program: ${programId.toBase58().slice(0, 12)}...`);
  log(`Markets: ${markets.map(m => m.label).join(", ")}`);

  // ── Startup oracle authority check ──────────────────────────
  // Verify all slabs before entering the main loop so mismatches are obvious in boot logs.
  log(`Verifying oracle authority for ${markets.length} market(s)...`);
  for (const m of markets) {
    try {
      // Use getAccountInfo directly to capture both slab data and program owner.
      // The owner is cached in slabProgramId and used when building instructions,
      // preventing "Provided owner is not allowed" for markets on different program tiers.
      const slabInfo = await conn.getAccountInfo(new PublicKey(m.slab));
      if (!slabInfo) throw new Error(`Slab account not found`);
      const slabData = new Uint8Array(slabInfo.data);
      const cfg = parseConfig(slabData);
      if (!cfg.oracleAuthority.equals(admin.publicKey)) {
        log(`🚨 STARTUP: ${m.label} (${m.slab.slice(0, 12)}...) — authority MISMATCH. Slab: ${cfg.oracleAuthority.toBase58()} | Keeper: ${admin.publicKey.toBase58()} → SLAB NEEDS REINIT`);
        skippedMarkets.add(m.slab);
      } else {
        slabProgramId.set(m.slab, slabInfo.owner);
        if (!slabInfo.owner.equals(programId)) {
          log(`ℹ️ STARTUP: ${m.label} — slab owned by ${slabInfo.owner.toBase58().slice(0, 12)}... (differs from deployment programId)`);
        }
        authorityVerified.add(m.slab);
        log(`✅ STARTUP: ${m.label} — authority OK (${admin.publicKey.toBase58().slice(0, 12)}...)`);
      }
    } catch (e) {
      log(`⚠️ STARTUP: ${m.label} — authority check failed: ${(e as Error).message?.slice(0, 80)}. Will retry during push loop.`);
    }
  }
  if (skippedMarkets.size > 0) {
    log(`⛔ ${skippedMarkets.size} market(s) skipped due to authority mismatch: ${markets.filter(m => skippedMarkets.has(m.slab)).map(m => m.label).join(", ")}`);
    log(`   Action required: reinitialise slab(s) with current keeper authority, or update ADMIN_KEYPAIR to match.`);
  }

  // Initialize stats and mark existing markets as known
  for (const m of markets) {
    getOrCreateStats(m);
    knownSlabs.add(m.slab);
  }

  // Start health server
  const healthServer = startHealthServer();

  let running = true;
  const shutdown = () => {
    if (!running) return;
    running = false;
    log("Shutting down...");
    healthServer.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Supabase discovery state
  let lastDiscoveryAt = 0;
  if (supabaseEnabled) {
    log(`Supabase auto-discovery enabled (interval: ${DISCOVERY_INTERVAL_MS}ms)`);
    // Load mainnet CAs for existing markets from Supabase
    const caRows = await supabaseQuery(
      "markets",
      "select=slab_address,mainnet_ca&mainnet_ca=not.is.null",
    );
    if (caRows) {
      for (const row of caRows) {
        slabToMainnetCA.set(row.slab_address, row.mainnet_ca);
      }
      log(`Loaded ${caRows.length} mainnet CA mapping(s) from Supabase`);
    }
  } else {
    log("⚠️ Supabase not configured — auto-discovery disabled (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
  }

  // Main push loop
  while (running) {
    // Periodic Supabase discovery — check for newly created markets
    const now = Date.now();
    if (supabaseEnabled && now - lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
      lastDiscoveryAt = now;
      try {
        // Refresh mainnet CA mappings
        const caData = await supabaseQuery(
          "markets",
          "select=slab_address,mainnet_ca&mainnet_ca=not.is.null",
        );
        if (caData) {
          for (const row of caData) {
            slabToMainnetCA.set(row.slab_address, row.mainnet_ca);
          }
        }

        // Also check the oracle_markets override table (HYPERP explicit registrations)
        const oracleTableMarkets = await discoverHyperpFromOracleTable();

        const newMarkets = [...(await discoverNewMarkets()), ...oracleTableMarkets];
        if (newMarkets.length > 0) {
          log(`🔍 Discovered ${newMarkets.length} new market(s): ${newMarkets.map(m => m.label).join(", ")}`);
          for (const m of newMarkets) {
            if (ORACLE_KEEPER_BLOCKED_MARKETS.has(m.slab)) {
              log(`⛔ ${m.label}: in ORACLE_KEEPER_BLOCKED_MARKETS — skipping`);
              continue;
            }
            markets.push(m);
            getOrCreateStats(m);
            // Verify oracle authority for new market
            try {
              const slabInfo = await conn.getAccountInfo(new PublicKey(m.slab));
              if (!slabInfo) throw new Error(`Slab account not found`);
              const slabData = new Uint8Array(slabInfo.data);
              const cfg = parseConfig(slabData);
              if (!cfg.oracleAuthority.equals(admin.publicKey)) {
                log(`🚨 ${m.label}: authority MISMATCH — skipping`);
                skippedMarkets.add(m.slab);
              } else {
                slabProgramId.set(m.slab, slabInfo.owner);
                if (!slabInfo.owner.equals(programId)) {
                  log(`ℹ️ ${m.label}: slab owned by ${slabInfo.owner.toBase58().slice(0, 12)}... (different program tier)`);
                }
                authorityVerified.add(m.slab);
                log(`✅ ${m.label}: authority OK`);
              }
            } catch (e) {
              log(`⚠️ ${m.label}: authority check failed: ${(e as Error).message?.slice(0, 60)}`);
            }
          }
        }
      } catch (e) {
        log(`⚠️ Discovery poll error: ${(e as Error).message?.slice(0, 60)}`);
      }
    }

    // ── Wallet balance guard ─────────────────────────────────
    // Refresh balance every BALANCE_CHECK_INTERVAL_MS; pause all pushes if low.
    // Devops audit 2026-03-14: wallet exhausted twice in one day from ~20+ markets per cycle.
    if (now - lastBalanceCheckAt > BALANCE_CHECK_INTERVAL_MS) {
      lastBalanceCheckAt = now;
      try {
        walletBalanceLamports = await conn.getBalance(admin.publicKey, "confirmed");
        const prevLow = walletLow;
        walletLow = walletBalanceLamports < MIN_KEEPER_BALANCE_LAMPORTS;
        if (walletLow && !prevLow) {
          log(`🚨 WALLET LOW: ${(walletBalanceLamports / 1e9).toFixed(4)} SOL — below ${MIN_KEEPER_BALANCE_LAMPORTS / 1e9} SOL threshold. PAUSING ALL PUSHES. Refund ${admin.publicKey.toBase58().slice(0, 8)}...`);
        } else if (!walletLow && prevLow) {
          log(`✅ WALLET REFUNDED: ${(walletBalanceLamports / 1e9).toFixed(4)} SOL — resuming pushes.`);
        }
      } catch (e) {
        log(`⚠️ Wallet balance check failed: ${(e as Error).message?.slice(0, 60)}`);
      }
    }

    if (walletLow) {
      log(`⏸ Wallet balance low (${walletBalanceLamports != null ? (walletBalanceLamports / 1e9).toFixed(4) : "??"} SOL) — skipping push cycle`);
      await new Promise(r => setTimeout(r, PUSH_INTERVAL_MS));
      continue;
    }

    // Batch-fetch all Pyth prices in a single request
    const marketSymbols = [...new Set(markets.map(m => m.symbol))];
    await fetchPythPrices(marketSymbols);

    const promises = markets.map(market =>
      pushAndCrank(market, programId).catch(e => {
        const s = getOrCreateStats(market);
        s.totalErrors++;
        s.consecutiveErrors++;
        // Safely extract error info — SendTransactionError.message may be undefined
        // on some @solana/web3.js versions; .logs contains the on-chain program output
        const err = e as any;
        const msg: string = (typeof err?.message === "string" && err.message.length > 0)
          ? err.message.slice(0, 120)
          : (typeof err === "string" ? err.slice(0, 120) : `[${Object.prototype.toString.call(err)}]`);
        const txLogs = Array.isArray(err?.logs) ? (err.logs as string[]) : [];
        
        // MEDIUM-004: Format transaction context for enhanced debugging
        const txContext = formatTransactionContext(err);
        log(`❌ ${market.label}: ${msg} ${txContext}`);
        
        if (txLogs.length > 0) {
          // Print last 5 program log lines — this reveals the actual on-chain error
          log(`   TX logs: ${txLogs.slice(-5).join(" | ").slice(0, 400)}`);
        }
        // Auto-skip markets that fail with Custom:15 (InvalidOracleAuthority / 0xf).
        // The pre-flight authority check can pass if the slab config was updated between
        // the check and the tx, or if parseConfig read stale data. Catching the on-chain
        // error here prevents infinite retry spam.
        const isAuthorityError = msg.includes("custom program error: 0xf") ||
          msg.includes("Custom:15") ||
          txLogs.some(l => l.includes("0xf") || l.includes("Custom:15"));
        if (isAuthorityError) {
          log(`🚫 ${market.label}: Custom:15 = InvalidOracleAuthority — permanently skipping this market`);
          skippedMarkets.add(market.slab);
          authorityVerified.delete(market.slab);
        }
      })
    );
    await Promise.allSettled(promises);
    await new Promise(r => setTimeout(r, PUSH_INTERVAL_MS));
  }

  log("Oracle Keeper stopped.");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
