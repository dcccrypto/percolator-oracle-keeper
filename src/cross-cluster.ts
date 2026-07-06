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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

await startKeeperLoop(mainnetConn, devnetConn, keeper, registry, {
  intervalMs: CC_INTERVAL_MS,
  healthPort: CC_HEALTH_PORT,
  healthBind: CC_HEALTH_BIND,
  dryRun: DRY_RUN,
});
