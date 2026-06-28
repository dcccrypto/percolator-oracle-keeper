#!/usr/bin/env tsx
/**
 * dry-run.ts — Standalone dry-run for the cross-cluster keeper.
 *
 * Reads spot prices from mainnet DEX pools and logs what PushAuthMark
 * instructions would be sent.  No devnet writes, no SOL consumed.
 *
 * Always validates the two canonical test pools (Raydium CLMM + Meteora DLMM
 * SOL/USDC on mainnet) regardless of registry contents, so you can confirm
 * the price-reading pipeline is healthy before registering any markets.
 *
 * Usage:
 *   MAINNET_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... \
 *     npx tsx src/dry-run.ts
 *
 * Optional env:
 *   REGISTRY_PATH   path to registry.json (default: ./registry.json)
 */
import { Connection } from "@solana/web3.js";
import path from "path";
import { fileURLToPath } from "url";
import { loadRegistry } from "./cross-cluster/registry.ts";
import {
  readPoolPriceE6,
  type DecimalsCache,
} from "./cross-cluster/price-reader.ts";
import type { DexType } from "./cross-cluster/registry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAINNET_RPC =
  process.env.MAINNET_RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=2a089bfd-18ae-48b5-abbe-36b0383ecad3";

const REGISTRY_PATH =
  process.env.REGISTRY_PATH ??
  path.resolve(__dirname, "..", "registry.json");

// These two pools are always read as a sanity check for the price pipeline.
const CANONICAL_POOLS: Array<{
  label: string;
  poolAddress: string;
  dexType: DexType;
}> = [
  {
    label: "SOL/USDC — Raydium CLMM",
    poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    dexType: "raydium-clmm",
  },
  {
    label: "SOL/USDC — Meteora DLMM",
    poolAddress: "FoSDw2L5DmTuQTFe55gWPDXf88euaxAEKFre74CnvQbX",
    dexType: "meteora-dlmm",
  },
];

const mainnetConn = new Connection(MAINNET_RPC, "confirmed");
const decimalsCache: DecimalsCache = new Map();
const registry = loadRegistry(REGISTRY_PATH);

const rpcDisplay = MAINNET_RPC.replace(/api-key=[^&]+/, "api-key=***");

console.log("\n=== Cross-Cluster Keeper — Dry-Run ===");
console.log(`Mainnet RPC : ${rpcDisplay}`);
console.log(`Registry    : ${REGISTRY_PATH} (${registry.markets.length} markets)`);
console.log();

// ── 1. Canonical pool verification ──────────────────────────────────────────
console.log("── Canonical pool prices (always verified) ────────────────────────────");
for (const pool of CANONICAL_POOLS) {
  process.stdout.write(`  ${pool.label} ... `);
  try {
    const result = await readPoolPriceE6(
      mainnetConn,
      { poolAddress: pool.poolAddress, dexType: pool.dexType, label: pool.label },
      decimalsCache,
    );
    if (result.skipped) {
      console.log(`SKIP: ${result.skipReason}`);
    } else {
      const usd = (Number(result.priceE6) / 1e6).toFixed(4);
      console.log(`OK  priceE6=${result.priceE6}  ($${usd})`);
    }
  } catch (e) {
    console.log(
      `ERROR: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`,
    );
  }
}

// ── 2. Registered market prices ──────────────────────────────────────────────
if (registry.markets.length > 0) {
  console.log("\n── Registry market push simulation ────────────────────────────────────");
  for (const entry of registry.markets) {
    process.stdout.write(`  ${entry.label} (${entry.dexType}) ... `);
    try {
      const result = await readPoolPriceE6(mainnetConn, entry, decimalsCache);
      if (result.skipped) {
        console.log(`SKIP: ${result.skipReason}`);
      } else {
        const usd = (Number(result.priceE6) / 1e6).toFixed(4);
        console.log(`OK  priceE6=${result.priceE6}  ($${usd})`);
        console.log(
          `    [DRY-RUN] PushAuthMark` +
            ` market=${entry.marketAddress.slice(0, 8)}…` +
            ` assetIndex=${entry.assetIndex}` +
            ` priceE6=${result.priceE6} ($${usd})`,
        );
      }
    } catch (e) {
      console.log(
        `ERROR: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`,
      );
    }
  }
} else {
  console.log(
    "\n[info] Registry is empty — only canonical pool prices verified.",
  );
}

console.log("\n=== Dry-run complete ===\n");
