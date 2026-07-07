#!/usr/bin/env tsx
/**
 * cross-cluster.ts — Cross-cluster price keeper entrypoint
 *
 * Reads spot prices from mainnet DEX pools (Raydium CLMM, Meteora DLMM,
 * PumpSwap) and pushes them as PushAuthMark instructions to the
 * corresponding devnet Percolator markets.
 *
 * The keeper is the per-asset oracle_authority.  Markets delegate to it
 * at creation via the bundled InitMarket + ConfigureAuthMark +
 * UpdateAssetAuthority flow (one user action, keeper co-signs).
 *
 * Environment variables:
 *
 *   MAINNET_RPC_URL       mainnet Helius RPC  (required)
 *   DEVNET_RPC_URL        devnet Helius RPC   (required)
 *   KEEPER_KEYPAIR_PATH   path to keeper JSON keypair
 *                           (default: ~/.config/solana/percolator-v17-devnet.json)
 *   KEEPER_KEYPAIR        inline JSON u8 array (Railway alternative to path)
 *   REGISTRY_PATH         path to registry.json (default: ./registry.json)
 *   CC_INTERVAL_MS        push cycle interval ms  (default: 7000)
 *   CC_HEALTH_PORT        health server port      (default: 3001)
 *   CC_HEALTH_BIND        health server bind addr (default: 0.0.0.0)
 *   DRY_RUN               "true" for dry-run (no on-chain writes, default: false)
 *
 * CLI flags:
 *   --dry-run             same as DRY_RUN=true
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadRegistry } from "./cross-cluster/registry.ts";
import { startKeeperLoop } from "./cross-cluster/keeper-loop.ts";
import { startRecoveryCrankLoop } from "./cross-cluster/recovery-cranker.ts";
import { startRegisterPollLoop } from "./cross-cluster/register-poll.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Resilience guard (2026-07-06) ─────────────────────────────────────────────
// A keeper is a long-running service; a transient RPC fault (e.g. a 429 rate
// limit) must NEVER exit the process. The outage that bricked 4 markets began
// with an un-retried 429 bubbling to an unhandledRejection that killed the
// process — taking the recovery cranker down with it and letting engine accrual
// drift past the point of recovery. Log loudly and stay up; individual RPC calls
// are retried with backoff, and this is the last line of defense so a fault in
// any loop can't take the whole keeper down.
process.on("unhandledRejection", (reason) => {
  console.error(
    `[keeper][unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
process.on("uncaughtException", (err) => {
  console.error(`[keeper][uncaughtException] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});

// ── RPC endpoints ─────────────────────────────────────────────────────────────
const MAINNET_RPC = process.env.MAINNET_RPC_URL;
const DEVNET_RPC = process.env.DEVNET_RPC_URL;

if (!MAINNET_RPC) {
  console.error("[fatal] MAINNET_RPC_URL is required (e.g. https://mainnet.helius-rpc.com/?api-key=...)");
  process.exit(1);
}
if (!DEVNET_RPC) {
  console.error("[fatal] DEVNET_RPC_URL is required (e.g. https://devnet.helius-rpc.com/?api-key=...)");
  process.exit(1);
}

// ── Keeper keypair ─────────────────────────────────────────────────────────────
function loadKeypair(): Keypair {
  if (process.env.KEEPER_KEYPAIR) {
    const raw = JSON.parse(process.env.KEEPER_KEYPAIR) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kpPath =
    process.env.KEEPER_KEYPAIR_PATH ??
    `${process.env.HOME}/.config/solana/percolator-v17-devnet.json`;
  if (!fs.existsSync(kpPath)) {
    console.error(
      `[fatal] Keeper keypair not found at ${kpPath}.` +
        " Set KEEPER_KEYPAIR_PATH or KEEPER_KEYPAIR.",
    );
    process.exit(1);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8")) as number[]),
  );
}

// ── Config ─────────────────────────────────────────────────────────────────────
const DRY_RUN =
  process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");

const CC_INTERVAL_MS = parseInt(process.env.CC_INTERVAL_MS ?? "7000", 10);
const CC_HEALTH_PORT = parseInt(process.env.CC_HEALTH_PORT ?? "3001", 10);
const CC_HEALTH_BIND = process.env.CC_HEALTH_BIND ?? "0.0.0.0";

// Recovery/maintenance crank loop — independent cadence from the oracle push.
// See cross-cluster/recovery-cranker.ts for why this exists (keeps
// asset.slot_last from drifting far enough behind the live slot to trip
// EngineLockActive on risk-increasing trades). Defaults to on; set
// CRANK_ENABLED=false to disable (e.g. for a read-only / dry-run deploy).
const CRANK_ENABLED = process.env.CRANK_ENABLED !== "false";
const CRANK_INTERVAL_MS = parseInt(process.env.CRANK_INTERVAL_MS ?? "20000", 10);

// Registration-poll loop — outbound poll of the Vercel-hosted playground registered-
// markets blob, so markets created through the create-market wizard after this keeper
// booted get added live. See cross-cluster/register-poll.ts for why this exists (the
// keeper is NAT'd/outbound-only; the frontend can never reach it directly). Off unless
// REGISTER_SOURCE_URL is set — nothing to poll without a source.
const REGISTER_SOURCE_URL = process.env.REGISTER_SOURCE_URL;
const REGISTER_POLL_INTERVAL_MS = parseInt(process.env.REGISTER_POLL_INTERVAL_MS ?? "30000", 10);

const REGISTRY_PATH =
  process.env.REGISTRY_PATH ??
  path.resolve(__dirname, "..", "registry.json");

// ── Boot ───────────────────────────────────────────────────────────────────────
const keeper = loadKeypair();
const registry = loadRegistry(REGISTRY_PATH);

if (registry.markets.length === 0) {
  console.warn(
    "[warn] Registry is empty — no markets to push to." +
      " Register markets via addMarket() or by populating registry.json.",
  );
  if (!DRY_RUN) {
    console.error(
      "[fatal] Nothing to do in live mode with an empty registry. Exiting.",
    );
    process.exit(1);
  }
}

const mainnetConn = new Connection(MAINNET_RPC, "confirmed");
const devnetConn = new Connection(DEVNET_RPC, "confirmed");

console.log("[cross-cluster] Boot:");
console.log(`  keeper:    ${keeper.publicKey.toBase58()}`);
console.log(`  registry:  ${REGISTRY_PATH} (${registry.markets.length} markets)`);
console.log(`  mode:      ${DRY_RUN ? "DRY-RUN (no on-chain writes)" : "LIVE"}`);
console.log(`  interval:  ${CC_INTERVAL_MS}ms`);
console.log(
  `  cranker:   ${CRANK_ENABLED ? `every ${CRANK_INTERVAL_MS}ms` : "disabled (CRANK_ENABLED=false)"}`,
);
for (const m of registry.markets) {
  console.log(
    `  market:    ${m.label} | slab=${m.marketAddress.slice(0, 8)}… → pool=${m.poolAddress.slice(0, 8)}… (${m.dexType})`,
  );
}
console.log();

// Recovery crank loop runs concurrently on its own interval — deliberately
// NOT awaited, and deliberately never allowed to throw out of this scope, so
// it can never delay or take down the oracle push loop below.
if (CRANK_ENABLED) {
  void startRecoveryCrankLoop(devnetConn, keeper, registry, {
    intervalMs: CRANK_INTERVAL_MS,
    dryRun: DRY_RUN,
  }).catch((err) => {
    console.error(
      `[cranker] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// Registration-poll loop — same "runs concurrently, never awaited, never allowed to
// throw out of this scope" pattern as the recovery cranker above. Mutates `registry`
// in place (addMarket + saveRegistry), and it's the SAME registry object passed to
// startKeeperLoop/startRecoveryCrankLoop below, so a market added here is picked up
// by both of those loops on their very next cycle.
if (REGISTER_SOURCE_URL) {
  void startRegisterPollLoop(registry, {
    sourceUrl: REGISTER_SOURCE_URL,
    registryPath: REGISTRY_PATH,
    intervalMs: REGISTER_POLL_INTERVAL_MS,
  }).catch((err) => {
    console.error(
      `[register-poll] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
} else {
  console.log("[register-poll] disabled (REGISTER_SOURCE_URL unset)");
}

await startKeeperLoop(mainnetConn, devnetConn, keeper, registry, {
  intervalMs: CC_INTERVAL_MS,
  healthPort: CC_HEALTH_PORT,
  healthBind: CC_HEALTH_BIND,
  dryRun: DRY_RUN,
});
