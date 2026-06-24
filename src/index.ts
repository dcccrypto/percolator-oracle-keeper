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
  AccountInfo,
} from "@solana/web3.js";
import {
  encodePushAuthMark, encodePushEwmaMark,
  ACCOUNTS_PUSH_AUTH_MARK, ACCOUNTS_PUSH_EWMA_MARK,
  buildAccountMetas, buildIx,
  parseConfig,
  parseAssetOracleProfileV17,
  V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN, V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";
import * as fs from "fs";
import * as http from "http";
import * as crypto from "crypto";

// ── Config ──────────────────────────────────────────────────
import { parsePositiveNumberEnv, requireProgramIdForSupabaseMode } from "./env-utils.ts";
import { checkCircuitBreaker as _checkCircuitBreaker } from "./circuit-breaker.ts";
import type { CircuitBreakerState } from "./circuit-breaker.ts";

// #31(a): Refuse to start with TLS verification disabled.
// NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate validation for ALL
// outbound connections — this allows MITM attacks on Hermes (price injection),
// RPC, and DexScreener. Fail fast before any connections are made.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  console.error("[FATAL] NODE_TLS_REJECT_UNAUTHORIZED=0 is set — this disables TLS certificate verification for all outbound connections and allows price injection via MITM. Remove this variable and restart.");
  process.exit(1);
}

const PUSH_INTERVAL_MS    = parsePositiveNumberEnv("PUSH_INTERVAL_MS",    3000);
const HEALTH_PORT         = parsePositiveNumberEnv("HEALTH_PORT",         18810);
const MAX_PRICE_MOVE_PCT  = parsePositiveNumberEnv("MAX_PRICE_MOVE_PCT",  10, 100);
const STALE_THRESHOLD_S   = parsePositiveNumberEnv("STALE_THRESHOLD_S",   30);
/**
 * Number of consecutive circuit-breaker trips at a consistent new price level
 * required before the breaker re-baselines to that level (issue #30 fix).
 *
 * A one-off spike is rejected every time (the next normal push resets the
 * counter).  A genuine, sustained relocation — where the same approximate
 * price level arrives on CIRCUIT_BREAKER_CONFIRM_TRIPS successive push cycles
 * without itself varying by more than MAX_PRICE_MOVE_PCT from the first
 * tripping price — is accepted and re-baselines lastPrice, un-wedging the
 * market without a process restart.
 *
 * Set via env var CIRCUIT_BREAKER_CONFIRM_TRIPS (must be ≥ 1, default 3).
 */
const CIRCUIT_BREAKER_CONFIRM_TRIPS = parsePositiveNumberEnv("CIRCUIT_BREAKER_CONFIRM_TRIPS", 3);
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
const envBlockedRaw = (process.env.ORACLE_KEEPER_BLOCKED_MARKETS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const validatedBlockedMarkets: string[] = [];
for (const entry of envBlockedRaw) {
  try {
    new PublicKey(entry);
    validatedBlockedMarkets.push(entry);
  } catch (e) {
    // #50: fail-fast — an invalid blocked-market address means the blocklist is
    // misconfigured and a market that should be blocked might not be. Exit
    // immediately so the operator is forced to fix the address before the
    // keeper resumes signing transactions.
    console.error(`[FATAL] Invalid blocked market address in ORACLE_KEEPER_BLOCKED_MARKETS: "${entry}" — fix the address or remove it, then restart.`);
    process.exit(1);
  }
}

const ORACLE_KEEPER_BLOCKED_MARKETS = new Set<string>([
  ...HARDCODED_BLOCKED_MARKETS,
  ...validatedBlockedMarkets,
]);
const ADMIN_KP_PATH = process.env.ADMIN_KEYPAIR_PATH ??
  "/app/.config/solana/percolator-upgrade-authority.json";
// RPC_URL is required and validated at startup by validateEnvironmentConfig()
// Removed silent fallback to prevent misconfigured production deployments from
// accidentally connecting to public devnet (HIGH-002 security hardening)
const RPC_URL = process.env.RPC_URL!;

const conn = new Connection(RPC_URL, "confirmed");

// #37: Optional secondary connection for transaction-inclusion verification.
// Set VERIFY_RPC_URL to a different RPC endpoint to cross-check that the
// submitted transaction actually landed on-chain. Falls back to the primary
// conn if VERIFY_RPC_URL is not set.
const connVerify: Connection | null = process.env.VERIFY_RPC_URL
  ? new Connection(process.env.VERIFY_RPC_URL, "confirmed")
  : null;

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
 * v17 oracle mode numeric constants from v16_program.rs state module.
 *
 * Evidence (v16_program.rs lines 75-78):
 *   pub const ORACLE_MODE_MANUAL: u8 = 0;
 *   pub const ORACLE_MODE_HYBRID_AFTER_HOURS: u8 = 1;
 *   pub const ORACLE_MODE_EWMA_MARK: u8 = 2;
 *   pub const ORACLE_MODE_AUTH_MARK: u8 = 3;
 */
const V17_ORACLE_MODE_MANUAL           = 0;
const V17_ORACLE_MODE_HYBRID           = 1;
const V17_ORACLE_MODE_EWMA_MARK        = 2;
const V17_ORACLE_MODE_AUTH_MARK        = 3;

/**
 * Byte offset of AssetOracleProfileV17 for asset_index N within a v17 market account.
 *
 * Layout (from v16_program.rs constants and SDK slab.ts):
 *   HEADER_LEN (16) + WRAPPER_CONFIG_LEN (432) = V17_MARKET_GROUP_OFF (448)
 *   + V17_MARKET_GROUP_LEN (758) = first asset slot start (1206)
 *   + N * V17_MARKET_ASSET_SLOT_LEN (1797)
 *
 * The oracle profile is at byte 0 within each dynamic asset slot
 * (dynamic_slot_offset returns MARKET_GROUP_OFF + slot_stride * N,
 * and oracle_profile_range starts at that same offset).
 *
 * Evidence: v16_program.rs asset_oracle_profile_range + dynamic_slot_offset;
 * SDK slab.ts V17_MARKET_GROUP_OFF=448, V17_MARKET_GROUP_LEN=758, V17_MARKET_ASSET_SLOT_LEN=1797.
 */
function v17OracleProfileOffset(assetIndex: number): number {
  return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
}

/**
 * Cached v17 oracle mode per slab address (numeric value from AssetOracleProfileV17.oracleMode).
 *
 * Populated at startup and during the authority-check path. A null value means
 * the mode has not been read yet or could not be parsed. When null, the push
 * is skipped conservatively rather than guessing.
 */
const slabOracleMode = new Map<string, number>();

// #32: allowlist of program IDs whose slabs this keeper is permitted to sign for.
// Populated at startup from deploy.programId + ADDITIONAL_PROGRAM_IDS env var.
// A Supabase row that points at an attacker-owned program would make the keeper
// sign transactions for that program; validating slabInfo.owner before parseConfig
// prevents this. Access via isAllowedProgramId() below.
const allowedProgramIds = new Set<string>();

/**
 * Check that a slab account's on-chain owner (slabInfo.owner) is in the
 * EXPECTED_PROGRAM_IDS allowlist before trusting it for parseConfig or
 * instruction building.  Must be called at ALL THREE fetch sites:
 *   1. startup authority loop
 *   2. pushAndCrank authority re-check
 *   3. discovery loop authority check
 *
 * @param owner - the PublicKey from slabInfo.owner
 * @param slabAddress - for logging
 * @param label - human-readable market label for logging
 * @returns true if allowed, false if the slab should be skipped
 */
/**
 * Read and cache the v17 oracle mode from the on-chain AssetOracleProfileV17
 * at asset_index=0. Called any time we have fresh slab account data.
 *
 * Mode values from v16_program.rs (constants 75-78):
 *   0 = MANUAL         — no push instruction; price driven by crank (skip push)
 *   1 = HYBRID         — Pyth feeds read during crank; no separate push (skip push)
 *   2 = EWMA_MARK      — authority pushes via PushEwmaMark (tag 36)
 *   3 = AUTH_MARK      — authority pushes via PushAuthMark  (tag 63)
 *
 * If the profile cannot be parsed (short/malformed account), the cached value
 * is NOT updated so the previous cached value (or absence) is preserved.
 */
function cacheV17OracleMode(slabAddress: string, slabData: Uint8Array): void {
  try {
    const profileOff = v17OracleProfileOffset(0);
    if (slabData.length < profileOff + 1) {
      // Account is too short for a v17 slab — could be a v12 slab on a wrong network.
      // Do not update cache; existing value (if any) remains.
      return;
    }
    const profile = parseAssetOracleProfileV17(slabData, profileOff);
    const mode = profile.oracleMode;
    if (mode !== V17_ORACLE_MODE_MANUAL && mode !== V17_ORACLE_MODE_HYBRID &&
        mode !== V17_ORACLE_MODE_EWMA_MARK && mode !== V17_ORACLE_MODE_AUTH_MARK) {
      // Unknown mode value — do not cache; conservative skip
      log(`⚠️ [v17-oracle] slab ${slabAddress.slice(0, 12)}...: unknown oracle mode ${mode} — will skip push`);
      return;
    }
    slabOracleMode.set(slabAddress, mode);
  } catch {
    // parseAssetOracleProfileV17 threw — account may be v12 or truncated.
    // Do not cache; push will be skipped conservatively.
  }
}

function isAllowedProgramId(owner: PublicKey, slabAddress: string, label: string): boolean {
  if (allowedProgramIds.size === 0) {
    // Allowlist not yet populated (called before main() sets it up).
    // This should not happen in production; block as a safety measure.
    log(`🚨 [#32] ${label}: allowedProgramIds not initialised — blocking slab ${slabAddress.slice(0, 12)}...`);
    return false;
  }
  if (!allowedProgramIds.has(owner.toBase58())) {
    log(`🚨 [#32] ${label}: slab owned by UNEXPECTED program ${owner.toBase58()} — not in allowlist. Possible Supabase injection attack. Skipping.`);
    return false;
  }
  return true;
}

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
/**
 * Fetch account info with a strict timeout (e.g. 5 seconds) to prevent RPC hangs. (LOW-003)
 */
async function getAccountInfoWithTimeout(
  connection: Connection,
  publicKey: PublicKey,
  timeoutMs = 5000,
): Promise<AccountInfo<Buffer> | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`RPC timeout: getAccountInfo took longer than ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      connection.getAccountInfo(publicKey),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
 * - HEALTH_AUTH_TOKEN: Must be non-empty and set (MED-001)
 * - HERMES_URL: If set, must use HTTPS (HIGH-002)
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

  // Validate HERMES_URL (must be HTTPS to prevent SSRF and price injection)
  const hermesUrl = (process.env.HERMES_URL ?? "").trim();
  if (hermesUrl) {
    try {
      const url = new URL(hermesUrl);
      if (url.protocol !== "https:") {
        errors.push(`HERMES_URL must use secure https protocol, got: ${url.protocol}`);
      }
    } catch (e) {
      errors.push(`HERMES_URL is not a valid URL: ${hermesUrl}`);
    }
  }

  // Validate Supabase configuration (if enabled)
  // #46: accept either SUPABASE_ANON_KEY (preferred for read-only) or SUPABASE_SERVICE_ROLE_KEY.
  const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY ?? "").trim();
  const supabaseServiceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const supabaseEffectiveKey = supabaseAnonKey || supabaseServiceKey;

  if (supabaseUrl && !supabaseEffectiveKey) {
    errors.push(
      "SUPABASE_URL is configured but neither SUPABASE_ANON_KEY nor SUPABASE_SERVICE_ROLE_KEY is set. " +
      "Either disable Supabase (unset SUPABASE_URL) or provide a read key.",
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

  if (supabaseUrl && supabaseEffectiveKey && supabaseEffectiveKey.length < 100) {
    errors.push(
      `Supabase key appears truncated (${supabaseEffectiveKey.length} chars, expected 100+). ` +
      "This usually indicates a copy-paste error. Check SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  // Validate optional auth tokens (should not be empty if set)
  const apiAuthToken = process.env.API_AUTH_TOKEN?.trim() ?? "";
  if (process.env.API_AUTH_TOKEN && !apiAuthToken) {
    errors.push(
      "API_AUTH_TOKEN is set but empty. Either remove it or provide a token.",
    );
  }

  // Validate health auth token (mandatory check to prevent wallet leak - MED-001)
  const healthAuthToken = (process.env.HEALTH_AUTH_TOKEN ?? "").trim();
  if (!healthAuthToken) {
    errors.push(
      "HEALTH_AUTH_TOKEN is required but not set or empty. " +
      "Please set a secure bearer token for the health check endpoint.",
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
// #46: accept either the anon key or the service role key.
// Prefer the anon key (SUPABASE_ANON_KEY) for read-only queries so the service
// role key's write privileges aren't exposed to Supabase's REST layer.
// Fall back to the service role key when no anon key is set, but emit a
// startup warning so operators know to provision a dedicated read key.
const SUPABASE_READ_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
const DISCOVERY_INTERVAL_MS = parsePositiveNumberEnv("DISCOVERY_INTERVAL_MS", 30000); // 30s

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_READ_KEY);

/** Lightweight Supabase REST query — no client library needed */
async function supabaseQuery(table: string, params: string): Promise<any[] | null> {
  if (!supabaseEnabled) return null;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${params}`,
      {
        headers: {
          apikey: SUPABASE_READ_KEY,
          Authorization: `Bearer ${SUPABASE_READ_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!resp.ok) {
      log(`⚠️ Supabase query to ${table} failed with HTTP status ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    log(`⚠️ Supabase query to ${table} failed: ${(e as Error).message}`);
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
  isDynamic?: boolean;
}

interface MarketStats {
  symbol: string;
  lastPrice: number;
  lastPushAt: number;       // epoch ms
  lastFreshPriceAt: number;  // epoch ms of last successful live-source push
  lastPushSig: string;
  totalPushes: number;
  totalErrors: number;
  consecutiveErrors: number;
  circuitBreakerTrips: number;
  source: string;           // last successful source
  /** Price of the first trip in the current consecutive-trip run (issue #30). */
  cbTripPrice: number;
  /** How many consecutive trips have occurred near cbTripPrice (issue #30). */
  cbConsecutiveTrips: number;
  /** #34: consecutive push cycles where the price came only from a DexScreener source. */
  consecutiveLowTrustCycles: number;
}

// ── Price Sources ───────────────────────────────────────────

// #34: DexScreener is an unattested, single-source feed — apply a tighter
// circuit-breaker bound than Pyth/Jupiter. Bounded <100 via the #44 helper.
const DEXSCREENER_MAX_MOVE_PCT = parsePositiveNumberEnv("DEXSCREENER_MAX_MOVE_PCT", 5, 100);

// #34: Alert after this many consecutive push cycles where only a DexScreener
// source was available (low-trust alert).
const DEXSCREENER_LOW_TRUST_ALERT_CYCLES = parsePositiveNumberEnv("DEXSCREENER_LOW_TRUST_ALERT_CYCLES", 5);

type PriceResult = {
  price: number;
  source: string;
  freshAt: number;
  /** Circuit-breaker max-move override for this source. When set, pushAndCrank
   *  uses this value instead of the global MAX_PRICE_MOVE_PCT. */
  maxMovePct?: number;
};

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
    // #31(b): Request with encoding=base64 so the response includes binary.data
    // (the Wormhole VAA / guardian-attestation blob). Reject responses where the
    // binary field is absent or empty — this is a presence check, not a full
    // guardian-signature verification, but it ensures Hermes is returning real
    // attested price data rather than a spoofed parsed-only response.
    const params = ids.map(id => `ids[]=${id}`).join("&");
    const resp = await fetch(
      `${HERMES_URL}/v2/updates/price/latest?${params}&parsed=true&encoding=base64`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      log(`⚠️ Pyth Hermes returned ${resp.status}`);
      return;
    }
    const json = (await resp.json()) as {
      binary?: { encoding?: string; data?: string[] };
      parsed: Array<{
        id: string;
        price: { price: string; expo: number; publish_time: number };
      }>;
    };

    // Reject the entire batch if the Wormhole VAA blob is absent or empty.
    // This is a presence check — we do NOT verify guardian signatures here
    // (that would require the full Wormhole verification stack). The intent is
    // to ensure Hermes is returning attestation-backed data.
    if (!json.binary?.data || json.binary.data.length === 0) {
      log(`⚠️ Pyth Hermes: binary.data absent or empty — rejecting response (no Wormhole VAA present)`);
      return;
    }

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

function getPythPrice(symbol: string): { price: number; freshAt: number } | null {
  const cached = pythCache.get(symbol);
  if (!cached) return null;
  // Reject if older than 30s
  if (Date.now() - cached.ts > 30_000) return null;
  return { price: cached.price, freshAt: cached.ts };
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

/** DexScreener fallback for custom/exotic tokens.
 * Returns a PriceResult with the tighter DEXSCREENER_MAX_MOVE_PCT bound (#34).
 */
async function fetchDexScreenerPrice(symbol: string): Promise<PriceResult | null> {
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
    if (!isFinite(p) || p <= 0) return null;
    return { price: p, source: "dexscreener", freshAt: Date.now(), maxMovePct: DEXSCREENER_MAX_MOVE_PCT };
  } catch { return null; }
}

/** Fetch price with multi-source failover: CA lookup for mapped dynamic markets → Pyth → Jupiter → DexScreener */
const ALLOWED_STATIC_SYMBOLS = new Set<string>(Object.keys(PYTH_FEED_IDS).concat(Object.keys(JUPITER_MINTS)));

/** Fetch price with multi-source failover: CA lookup for mapped dynamic markets → Pyth → Jupiter → DexScreener */
async function getPrice(
  symbol: string,
  slab?: string,
  isDynamic?: boolean,
): Promise<PriceResult | null> {
  // If the market is dynamic, bypass symbol-based lookups completely to prevent oracle confusion. (HIGH-004)
  // Dynamic markets must resolve strictly through their contract address (mainnet_ca).
  if (isDynamic) {
    if (slab) {
      const ca = slabToMainnetCA.get(slab);
      if (ca) {
        return fetchPriceByCA(ca);
      }
    }
    return null;
  }

  // Non-dynamic: CA-first routing for markets with a known mainnet_ca mapping.
  // This ensures symbol→wrong-asset confusion is avoided even for non-isDynamic markets.
  if (slab) {
    const ca = slabToMainnetCA.get(slab);
    if (ca) {
      const caPrice = await fetchPriceByCA(ca);
      if (caPrice) return caPrice;
    }
  }

  // Security hardening: Restrict static symbols to a known safe allowlist to prevent confusion (HIGH-004)
  if (!ALLOWED_STATIC_SYMBOLS.has(symbol)) {
    log(`⚠️ getPrice: rejected unknown static symbol lookup for "${symbol}"`);
    return null;
  }

  // Primary: Pyth (decentralized oracle, fastest for supported tokens)
  const pyth = getPythPrice(symbol);
  if (pyth) return { price: pyth.price, source: "pyth", freshAt: pyth.freshAt };

  // Secondary: Jupiter (Solana DEX aggregator, uses mint addresses)
  const jup = await fetchJupiterPrice(symbol);
  if (jup) return { price: jup, source: "jupiter", freshAt: Date.now() };

  // Tertiary: DexScreener (broad coverage for exotic tokens) — uses tighter bound (#34)
  const dex = await fetchDexScreenerPrice(symbol);
  if (dex) return dex;

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
const MIN_KEEPER_BALANCE_LAMPORTS = process.env.MIN_KEEPER_BALANCE_SOL
  ? Math.round(parsePositiveNumberEnv("MIN_KEEPER_BALANCE_SOL", 0.05) * 1e9)
  : 50_000_000;
// Interval between balance refreshes (default: every 30 s = ~10 push cycles at 3s interval)
const BALANCE_CHECK_INTERVAL_MS = parsePositiveNumberEnv("BALANCE_CHECK_INTERVAL_MS", 30000);
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
      lastFreshPriceAt: 0,
      lastPushSig: "",
      totalPushes: 0,
      totalErrors: 0,
      consecutiveErrors: 0,
      circuitBreakerTrips: 0,
      source: "",
      cbTripPrice: 0,
      cbConsecutiveTrips: 0,
      consecutiveLowTrustCycles: 0,
    };
    stats.set(market.slab, s);
  }
  return s;
}

// ── Circuit Breaker ─────────────────────────────────────────
/**
 * Thin wrapper that binds the module-level config constants and log function
 * to the pure checkCircuitBreaker helper from ./circuit-breaker.ts.
 * See that module for full doc + issue #30 relocation-recovery semantics.
 *
 * #34: accepts an optional per-source maxMovePct override so DexScreener
 * sources are held to the tighter DEXSCREENER_MAX_MOVE_PCT bound.
 */
function checkCircuitBreaker(s: MarketStats, newPrice: number, sourceMaxMovePct?: number): boolean {
  return _checkCircuitBreaker(s as CircuitBreakerState, newPrice, {
    maxMovePct: sourceMaxMovePct ?? MAX_PRICE_MOVE_PCT,
    confirmTrips: CIRCUIT_BREAKER_CONFIRM_TRIPS,
    log,
  });
}

// ── Logging ─────────────────────────────────────────────────
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [oracle-keeper] ${msg}`);
}

/**
 * #37: Verify a transaction signature was actually included on-chain.
 *
 * Uses connVerify (if set) or falls back to conn. If the verify RPC itself
 * errors we credit the push optimistically (don't halt on RPC outage).
 * Returns true if confirmed or if the verify check errored (optimistic credit).
 * Returns false only when we can positively confirm the tx was NOT included.
 */
async function verifyTxInclusion(sig: string): Promise<boolean> {
  const verifyConn = connVerify ?? conn;
  try {
    const result = await verifyConn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (result === null) {
      // Transaction not found — may still be pending; treat as not confirmed
      log(`⚠️ [#37] tx ${sig.slice(0, 12)}... not found on verify RPC after sendAndConfirm — optimistic credit`);
      // Optimistic: sendAndConfirmTransaction already waited for confirmation;
      // a missing tx on the verify RPC is likely a propagation lag, not a real miss.
      return true;
    }
    if (result.meta?.err) {
      log(`⚠️ [#37] tx ${sig.slice(0, 12)}... landed but meta.err=${JSON.stringify(result.meta.err)} — marking as error`);
      return false;
    }
    return true;
  } catch (e) {
    // Verify RPC errored — credit optimistically, don't halt on verify-RPC outage
    log(`⚠️ [#37] verify RPC error for tx ${sig.slice(0, 12)}...: ${(e as Error).message?.slice(0, 60)} — crediting optimistically`);
    return true;
  }
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
//
// v17 DESIGN NOTE:
// In v17 the "crank" (PermissionlessCrank tag 5) requires a keeper-owned
// portfolio account at slot [2]. The oracle-keeper does NOT provision portfolios.
// The main keeper service (percolator-keeper) handles PermissionlessCrank Refresh
// on its own cycle (~30 s). The oracle-keeper's job is now ONLY to push mark
// prices to markets in EWMA_MARK or AUTH_MARK mode.
//
// The function is kept as "pushAndCrank" for historical naming; the crank half
// is removed in v17. HYPERP / DEX-pool mark mode was also removed in v17 —
// HYBRID_AFTER_HOURS (mode=1) reads Pyth feeds at crank time and needs no push.
//
// v17 oracle mode → push instruction mapping:
//   MANUAL (0)       — NO push instruction (price driven by off-chain settlement). Skip.
//   HYBRID (1)       — NO push instruction (Pyth feeds read at crank). Skip.
//   EWMA_MARK (2)    — PushEwmaMark (tag 36). Authority signer + market writable.
//   AUTH_MARK (3)    — PushAuthMark  (tag 63). Authority signer + market writable.
// Evidence: v16_program.rs handle_push_ewma_mark (lines 11148-11224, checks
//   profile_is_ewma_mark) and handle_push_auth_mark (lines 11224-11340, checks
//   profile_is_auth_mark). Both have identical account layout:
//   [0] authority (signer), [1] market (writable).
//
// The old "admin" Supabase oracle mode mapped to AUTH_MARK in v17.
// The old "hyperp" Supabase oracle mode is now a skip (HYBRID reads Pyth at crank).
async function pushAndCrank(market: MarketInfo, programId: PublicKey): Promise<void> {
  const s = getOrCreateStats(market);

  // Skip markets explicitly blocked via ORACLE_KEEPER_BLOCKED_MARKETS env var
  if (ORACLE_KEEPER_BLOCKED_MARKETS.has(market.slab)) return;

  // v17: HYPERP mode is removed. The old updateHyperpMark path no longer exists.
  // If a market is still labeled "hyperp" in Supabase, it is now either HYBRID
  // (reads Pyth at crank — no push needed) or misconfigured. Skip and log once.
  if (market.oracleMode === "hyperp") {
    log(`ℹ️ ${market.label}: oracleMode="hyperp" — v17 DEX-pool mark crank removed. If this market is HYBRID_AFTER_HOURS it is cranked by the keeper service. Skipping oracle-keeper push.`);
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
      const slabInfo = await getAccountInfoWithTimeout(conn, new PublicKey(market.slab));
      if (!slabInfo) throw new Error(`Slab account not found: ${market.slab}`);
      // #32: validate slab owner BEFORE parseConfig/trusting any account data
      if (!isAllowedProgramId(slabInfo.owner, market.slab, market.label)) {
        skippedMarkets.add(market.slab);
        return;
      }
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
      // v17: read oracle mode from AssetOracleProfileV17 at asset_index=0 and cache it.
      // The oracle mode determines which push instruction to use (EWMA_MARK → tag 36,
      // AUTH_MARK → tag 63, MANUAL/HYBRID → no push instruction exists).
      // Conservative: if we cannot parse the profile, we do NOT guess — skip push.
      cacheV17OracleMode(market.slab, slabData);
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

  const result = await getPrice(market.symbol, market.slab, market.isDynamic);

  // Resolve price: live source preferred. A last-known fallback is only allowed
  // while the previous successful push is still within the freshness threshold.
  // This avoids re-publishing stale cached prices with fresh oracle timestamps when
  // all live price sources fail.
  let price: number;
  let source: string;
  let freshPriceAt: number | null = null;

  if (result && isPriceValid(result.price)) {
    price = result.price;
    source = result.source;
    freshPriceAt = result.freshAt;
  } else if (s.lastPrice > 0) {
    // Devnet / transient no-pool fallback: reuse the last successfully pushed
    // live-source price only while it remains within the freshness threshold.
    const lastKnownAgeSec = s.lastFreshPriceAt
      ? Math.floor((Date.now() - s.lastFreshPriceAt) / 1000)
      : Infinity;

    if (lastKnownAgeSec > STALE_THRESHOLD_S) {
      s.totalErrors++;
      s.consecutiveErrors++;
      log(`No fresh price available for ${market.symbol}; last-known price is stale (${lastKnownAgeSec}s), skipping push`);
      return;
    }

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

  // #33: First-push cross-check.
  // The sync circuit-breaker in circuit-breaker.ts unconditionally accepts any
  // price when lastPrice===0 (every restart). An attacker who can influence the
  // first price (e.g. flash a DexScreener/Jupiter pool just before restart) could
  // re-baseline the keeper to a manipulated price.
  //
  // Mitigation: on the FIRST push for a market after start (lastPrice===0),
  // require a secondary-source confirmation UNLESS the price came from a Pyth
  // (Wormhole-attested) source, which is already multi-oracle-verified.
  //
  // The actual circuit-breaker (sync) runs after this async pre-check.
  if (s.lastPrice === 0 && source !== "pyth") {
    // Attempt a secondary source confirmation
    let secondaryOk = false;
    let secondaryPrice: number | null = null;
    // Try Jupiter first (it's the fastest non-Pyth source)
    const jupPrice = await fetchJupiterPrice(market.symbol);
    if (jupPrice !== null) {
      secondaryPrice = jupPrice;
      const movePct = Math.abs((price - jupPrice) / jupPrice) * 100;
      // Use DEXSCREENER_MAX_MOVE_PCT as the cross-check tolerance
      if (movePct <= DEXSCREENER_MAX_MOVE_PCT) {
        secondaryOk = true;
      }
    }
    if (!secondaryOk) {
      // Also try Pyth cache (may have been populated by this tick's batch fetch)
      const pythEntry = getPythPrice(market.symbol);
      if (pythEntry) {
        const movePct = Math.abs((price - pythEntry.price) / pythEntry.price) * 100;
        if (movePct <= DEXSCREENER_MAX_MOVE_PCT) {
          secondaryOk = true;
          secondaryPrice = pythEntry.price;
        }
      }
    }
    if (!secondaryOk) {
      log(
        `⚠️ [#33] ${market.label}: first push cross-check FAILED — ` +
        `${source} price $${price.toFixed(4)} not confirmed by secondary source ` +
        `(secondary=${ secondaryPrice !== null ? `$${secondaryPrice.toFixed(4)}` : "unavailable" }). ` +
        `Holding until cross-check passes or a Pyth price becomes available.`,
      );
      s.totalErrors++;
      s.consecutiveErrors++;
      return;
    }
    log(`✓ [#33] ${market.label}: first push cross-check PASSED (${source} $${price.toFixed(4)} ≈ secondary $${secondaryPrice!.toFixed(4)})`);
  }

  // Circuit breaker — use per-source bound for DexScreener (#34)
  if (!checkCircuitBreaker(s, price, result?.maxMovePct)) return;

  // #34: track consecutive low-trust (DexScreener-only) cycles and alert
  const isDexScreenerSource = source === "dexscreener" || source === "dexscreener-ca";
  if (isDexScreenerSource) {
    s.consecutiveLowTrustCycles++;
    if (s.consecutiveLowTrustCycles >= DEXSCREENER_LOW_TRUST_ALERT_CYCLES) {
      log(`⚠️ [#34] ${market.label}: ${s.consecutiveLowTrustCycles} consecutive DexScreener-only cycles — Pyth/Jupiter unavailable. Price trust is reduced.`);
    }
  } else {
    s.consecutiveLowTrustCycles = 0;
  }

  const priceE6 = BigInt(Math.round(price * 1_000_000));
  const slab = new PublicKey(market.slab);

  // Use the slab's actual on-chain program owner, not the deployment.json
  // programId. This handles Supabase-discovered markets that may have been
  // created by a different program tier/version than the BTC-PERP markets.
  const effectiveProgramId = slabProgramId.get(market.slab) ?? programId;

  // v17: determine which push instruction to use based on the on-chain oracle mode.
  // Evidence: v16_program.rs handle_push_ewma_mark (tag 36) checks profile_is_ewma_mark
  //   → ORACLE_MODE_EWMA_MARK (2); handle_push_auth_mark (tag 63) checks profile_is_auth_mark
  //   → ORACLE_MODE_AUTH_MARK (3). Both reject any other mode with Unauthorized.
  //
  // Account layout for BOTH push instructions (same for tag 36 and tag 63):
  //   [0] oracle_authority  — signer (admin.publicKey)
  //   [1] market            — writable (the slab)
  //
  // Wire format for both (19 bytes):
  //   tag(u8) + asset_index(u16 LE) + now_slot(u64 LE) + mark_e6(u64 LE)
  //   asset_index=0 for single-asset v17 markets (all current devnet markets).
  //
  // MANUAL (0) and HYBRID (1): no authority push instruction exists for these modes.
  // Skip conservatively — pushing with the wrong tag would cause InvalidInstruction.
  const oracleMode = slabOracleMode.get(market.slab);
  if (oracleMode === undefined) {
    // Mode not yet cached — this should not happen since authority check populates it,
    // but guard conservatively. Skip without incrementing error counter.
    log(`⚠️ ${market.label}: oracle mode not yet cached — skipping push tick (will resolve on next authority recheck)`);
    return;
  }
  if (oracleMode === V17_ORACLE_MODE_MANUAL) {
    // MANUAL: no push instruction. Market price is driven by administrative settlement.
    // Skip silently — this is expected behaviour, not an error.
    return;
  }
  if (oracleMode === V17_ORACLE_MODE_HYBRID) {
    // HYBRID_AFTER_HOURS: oracle reads Pyth feeds at crank time. No push instruction.
    // The main keeper service handles cranking. Skip silently.
    return;
  }

  // Fetch current slot for the now_slot argument.
  // The program calls authenticated_slot_or_fallback(now_slot) — passing 0 triggers
  // a Clock::get() fallback inside the program, but passing the actual slot avoids
  // that sysvar read and is strictly correct.
  let nowSlot: bigint;
  try {
    nowSlot = BigInt(await conn.getSlot("processed"));
  } catch {
    // If getSlot fails, pass 0 to trigger the in-program Clock fallback.
    nowSlot = 0n;
  }

  // Build the push instruction data and account keys.
  // asset_index=0: v17 markets are multi-asset but all current devnet markets
  // have a single asset at index 0.
  let pushData: Uint8Array;
  let pushKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  let pushTag: string;

  if (oracleMode === V17_ORACLE_MODE_EWMA_MARK) {
    // PushEwmaMark (tag 36): EWMA exponential moving average oracle mode.
    // The program applies a halflife-weighted EWMA update using the pushed mark_e6.
    pushData = encodePushEwmaMark({ assetIndex: 0, nowSlot, markE6: priceE6 });
    pushKeys = buildAccountMetas(ACCOUNTS_PUSH_EWMA_MARK, [admin.publicKey, slab]);
    pushTag = "PushEwmaMark(36)";
  } else if (oracleMode === V17_ORACLE_MODE_AUTH_MARK) {
    // PushAuthMark (tag 63): direct authority-set oracle mode.
    // The program stores mark_e6 directly with no smoothing.
    pushData = encodePushAuthMark({ assetIndex: 0, nowSlot, markE6: priceE6 });
    pushKeys = buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, [admin.publicKey, slab]);
    pushTag = "PushAuthMark(63)";
  } else {
    // Unrecognised mode value not caught by cacheV17OracleMode — never push.
    log(`⚠️ ${market.label}: unrecognised oracle mode ${oracleMode} — skipping push (fund-safe: never push to unknown mode)`);
    return;
  }

  // v17: oracle-keeper pushes the mark price only. PermissionlessCrank (tag 5)
  // requires a keeper-owned portfolio account that this service does not provision.
  // The main keeper service (percolator-keeper) runs PermissionlessCrank Refresh
  // on its own cadence to accrue fees and funding.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: effectiveProgramId, keys: pushKeys, data: pushData }),
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

  // #37: verify the transaction actually landed before crediting the push
  const included = await verifyTxInclusion(sig);
  if (!included) {
    // tx landed but meta.err set — treat as an error push, do not update stats
    s.totalErrors++;
    s.consecutiveErrors++;
    log(`❌ ${market.label}: tx ${sig.slice(0, 12)}... confirmed but meta.err — not crediting push`);
    return;
  }

  s.lastPrice = price;
  s.lastPushAt = Date.now();
  if (freshPriceAt !== null) {
    s.lastFreshPriceAt = freshPriceAt;
  }
  s.lastPushSig = sig;
  s.totalPushes++;
  s.consecutiveErrors = 0;
  s.source = source;

  log(`✅ ${market.label}: $${price.toFixed(2)} [${source}] ${pushTag} → ${sig.slice(0, 12)}...`);
}

// ── HYPERP Oracle Cache ─────────────────────────────────────

interface HyperpPoolMeta {
  pool: PublicKey;
  /** Additional accounts required by the DEX (e.g. PumpSwap vaults) */
  extraAccounts: PublicKey[];
}

const hyperpPoolCache = new Map<string, HyperpPoolMeta>();

/**
 * v17: UpdateHyperpMark is REMOVED. The v12 DEX-pool mark crank (old tag 34) is
 * now ConfigureHybridOracle in v17, and no DEX-pool mark-push instruction exists.
 *
 * Markets that were configured as "hyperp" in v12 are now expected to use one of:
 *   - HYBRID_AFTER_HOURS (mode 1): Pyth/switchboard feeds read at PermissionlessCrank time.
 *     No push instruction needed. The main keeper handles cranking.
 *   - AUTH_MARK (mode 3): Authority pushes mark directly via PushAuthMark (tag 63).
 *     The pushAndCrank function handles this path.
 *   - EWMA_MARK (mode 2): Authority pushes new observation; mark is EWMA-smoothed.
 *
 * This function is retained for compile-time safety (the HYPERP branch in pushAndCrank
 * calls it early-return instead) but does nothing. All formerly-hyperp markets that
 * were converted to HYBRID are automatically served by the keeper service's crank cycle.
 *
 * @deprecated v17: call removed. Retained as dead function for build hygiene.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function updateHyperpMark(
  _market: MarketInfo,
  _programId: PublicKey,
): Promise<void> {
  // v17: DEX-pool mark push removed. This function is never called.
}

// ── Health Check Server ─────────────────────────────────────

// #35+#36: per-IP rate limit state.
// Bounded to IP_RATE_LIMIT_MAP_MAX entries to prevent unbounded memory growth from
// IP spoofing / scanning. When the map is full, the oldest entry is evicted.
const IP_RATE_LIMIT_WINDOW_MS = 60_000;       // 1-minute sliding window
const IP_RATE_LIMIT_MAX_REQS  = 60;            // max requests per window per IP
const IP_RATE_LIMIT_MAP_MAX   = 4096;          // max IPs tracked simultaneously
const ipRequestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - IP_RATE_LIMIT_WINDOW_MS;
  let timestamps = ipRequestLog.get(ip) ?? [];
  // Remove timestamps outside the window
  timestamps = timestamps.filter(t => t >= windowStart);
  if (timestamps.length >= IP_RATE_LIMIT_MAX_REQS) {
    ipRequestLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  // Evict oldest entry if map is full (bounded growth)
  if (!ipRequestLog.has(ip) && ipRequestLog.size >= IP_RATE_LIMIT_MAP_MAX) {
    const oldestKey = ipRequestLog.keys().next().value;
    if (oldestKey !== undefined) ipRequestLog.delete(oldestKey);
  }
  ipRequestLog.set(ip, timestamps);
  return false;
}

/**
 * Timing-safe token comparison using crypto.timingSafeEqual.
 * Length-normalises both buffers before comparison to prevent length-timing
 * side-channel attacks (#35).
 */
function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Pad the shorter buffer so both are the same length — this prevents a
  // length mismatch from immediately revealing that the tokens differ.
  const len = Math.max(bufA.length, bufB.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    // #35+#36: per-IP rate limit (prevents brute-force token guessing)
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "too many requests" }));
      return;
    }

    // Auth guard: if HEALTH_AUTH_TOKEN is set, require Bearer token
    // #35: timing-safe comparison to prevent timing side-channel token recovery
    if (HEALTH_AUTH_TOKEN) {
      const auth = req.headers.authorization ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
      if (!timingSafeTokenEqual(provided, HEALTH_AUTH_TOKEN)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (req.url === "/health" || req.url === "/") {
      const now = Date.now();
      const uptimeS = Math.floor((now - startTime) / 1000);
      const markets: Record<string, any> = {};
      const marketsBySlab: Record<string, unknown> = {};
      let healthy = true;

      for (const [slab, s] of stats) {
        const staleSec = s.lastPushAt ? Math.floor((now - s.lastPushAt) / 1000) : -1;
        const isStale = staleSec > STALE_THRESHOLD_S;
        if (isStale) healthy = false;
        const marketHealth = {
          lastPrice: s.lastPrice,
          lastPushAgo: `${staleSec}s`,
          stale: isStale,
          source: s.source,
          totalPushes: s.totalPushes,
          totalErrors: s.totalErrors,
          consecutiveErrors: s.consecutiveErrors,
          circuitBreakerTrips: s.circuitBreakerTrips,
          cbConsecutiveTrips: s.cbConsecutiveTrips,
        };
        markets[s.symbol] = marketHealth;
        marketsBySlab[slab] = {
          symbol: s.symbol,
          ...marketHealth,
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
        marketsBySlab,
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

/**
 * Discovers HYPERP markets from the Supabase oracle_markets table.
 *
 * This keeps already-tracked slabs synchronized with oracle_markets by:
 * - upgrading non-HYPERP markets to HYPERP mode when an override is enabled
 * - refreshing dexPoolAddress when an existing HYPERP pool override changes
 * - invalidating cached HYPERP pool metadata after pool updates
 *
 * @returns Newly discovered HYPERP markets that should be added to the keeper.
 */
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
        // Upgrade an already-tracked market from admin/pyth → hyperp, or refresh
        // the pool override when oracle_markets changes dex_pool_address.
        const existing = markets.find(m => m.slab === row.slab_address);
        if (existing) {
          if (existing.oracleMode !== "hyperp") {
            log(`🔄 ${existing.label}: oracle_markets override → hyperp (pool=${row.dex_pool_address.slice(0, 12)}...)`);
            existing.oracleMode = "hyperp";
            existing.dexPoolAddress = row.dex_pool_address;
            hyperpPoolCache.delete(row.slab_address); // force re-fetch with new pool
          } else if (existing.dexPoolAddress !== row.dex_pool_address) {
            log(`🔄 ${existing.label}: oracle_markets pool updated ${existing.dexPoolAddress?.slice(0, 12) ?? "none"}... → ${row.dex_pool_address.slice(0, 12)}...`);
            existing.dexPoolAddress = row.dex_pool_address;
            hyperpPoolCache.delete(row.slab_address); // invalidate stale pool metadata
          }
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
        isDynamic: true,
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
        isDynamic: true,
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
async function fetchPriceByCA(mainnetCA: string): Promise<PriceResult | null> {
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
      if (isFinite(p) && p > 0) return { price: p, source: "jupiter-ca", freshAt: Date.now() };
    }
  } catch {}

  // DexScreener fallback — tag with tighter bound (#34)
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encoded}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const pair = json.pairs?.[0];
    if (pair?.priceUsd) {
      const p = parseFloat(pair.priceUsd);
      if (isFinite(p) && p > 0) return { price: p, source: "dexscreener-ca", freshAt: Date.now(), maxMovePct: DEXSCREENER_MAX_MOVE_PCT };
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
    // Guard: Supabase discovery cannot supply a program id from its market rows.
    // The programId is needed as a fallback when building instructions for any
    // market whose slab owner has not yet been cached.  Without it, the next
    // line (`new PublicKey(deploy.programId)`) throws the opaque "_bn" error
    // from inside @solana/web3.js, making the service crash after already
    // claiming Supabase-only mode is active (issue #29).
    try {
      requireProgramIdForSupabaseMode(process.env.PROGRAM_ID);
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error("❌ Deployment info not found at", deployPath);
    console.error("   Run deploy-devnet-mm.ts first, set DEPLOYMENT_JSON env var, or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  let deploy: any;
  try {
    deploy = deployRaw ? JSON.parse(deployRaw) : { programId: process.env.PROGRAM_ID, markets: [] };
  } catch (parseErr) {
    console.error("❌ Failed to parse deployment JSON:", parseErr instanceof Error ? parseErr.message : String(parseErr));
    process.exit(1);
  }

  if (!deploy || typeof deploy.programId !== "string") {
    console.error("❌ Invalid deployment JSON: programId must be a string");
    process.exit(1);
  }

  // Validate base58 programId format (43-44 characters) (MED-002)
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(deploy.programId)) {
    console.error(`❌ Invalid programId format: "${deploy.programId}" (must be 43-44 base58 characters)`);
    process.exit(1);
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(deploy.programId);
  } catch (err) {
    console.error(`❌ Failed to construct programId PublicKey: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // #32: Build the EXPECTED_PROGRAM_IDS allowlist.
  // Always includes deploy.programId. ADDITIONAL_PROGRAM_IDS (comma-separated)
  // lets operators allowlist additional program tiers (e.g. legacy small-tier).
  allowedProgramIds.add(programId.toBase58());
  const additionalIds = (process.env.ADDITIONAL_PROGRAM_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  for (const id of additionalIds) {
    try {
      const pk = new PublicKey(id);
      allowedProgramIds.add(pk.toBase58());
    } catch {
      console.error(`⚠️ [#32] Invalid ADDITIONAL_PROGRAM_IDS entry: "${id}" — ignoring`);
    }
  }
  log(`[#32] Slab program allowlist (${allowedProgramIds.size}): ${[...allowedProgramIds].map(id => id.slice(0, 12) + "...").join(", ")}`);

  if (!Array.isArray(deploy.markets)) {
    deploy.markets = [];
  }

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
      // Use getAccountInfo with timeout to capture both slab data and program owner. (LOW-003)
      // The owner is cached in slabProgramId and used when building instructions,
      // preventing "Provided owner is not allowed" for markets on different program tiers.
      const slabInfo = await getAccountInfoWithTimeout(conn, new PublicKey(m.slab));
      if (!slabInfo) throw new Error(`Slab account not found`);
      // #32: validate slab owner BEFORE parseConfig/trusting any account data
      if (!isAllowedProgramId(slabInfo.owner, m.slab, `STARTUP: ${m.label}`)) {
        skippedMarkets.add(m.slab);
        continue;
      }
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
        cacheV17OracleMode(m.slab, slabData);
        const mode = slabOracleMode.get(m.slab);
        const modeStr = mode === V17_ORACLE_MODE_MANUAL ? "MANUAL" :
          mode === V17_ORACLE_MODE_HYBRID ? "HYBRID" :
          mode === V17_ORACLE_MODE_EWMA_MARK ? "EWMA_MARK" :
          mode === V17_ORACLE_MODE_AUTH_MARK ? "AUTH_MARK" :
          mode === undefined ? "UNKNOWN(parse-failed)" : `UNKNOWN(${mode})`;
        authorityVerified.add(m.slab);
        log(`✅ STARTUP: ${m.label} — authority OK (${admin.publicKey.toBase58().slice(0, 12)}...) oracle_mode=${modeStr}`);
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
    // #46: warn when using service role key without a dedicated anon key
    if (!process.env.SUPABASE_ANON_KEY && SUPABASE_SERVICE_KEY) {
      log("⚠️ [#46] SUPABASE_ANON_KEY not set — falling back to SUPABASE_SERVICE_ROLE_KEY for read queries. Provision a dedicated anon/read key to reduce exposure.");
    }
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
    log("⚠️ Supabase not configured — auto-discovery disabled (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY)");
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
              const slabInfo = await getAccountInfoWithTimeout(conn, new PublicKey(m.slab));
              if (!slabInfo) throw new Error(`Slab account not found`);
              // #32: validate slab owner BEFORE parseConfig/trusting any account data
              if (!isAllowedProgramId(slabInfo.owner, m.slab, m.label)) {
                skippedMarkets.add(m.slab);
                continue;
              }
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
                cacheV17OracleMode(m.slab, slabData);
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
