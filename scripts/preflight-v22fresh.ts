#!/usr/bin/env tsx
/**
 * preflight-v22fresh.ts — refuse to start the v2.2 fresh-ID keeper against a registry that could touch anything but
 * the fresh wrapper's markets. Read-only (one getMultipleAccounts on devnet). Exit 0 = safe, 1 = refuse.
 *
 * env: DEVNET_RPC_URL, WRAPPER_PROGRAM_ID, REGISTRY_PATH, PREFLIGHT_ALLOW_EMPTY=1 (dry-run boot with no markets)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const DEVNET_RPC = process.env.DEVNET_RPC_URL ?? "";
const WRAPPER = process.env.WRAPPER_PROGRAM_ID ?? "";
const REGISTRY_PATH = process.env.REGISTRY_PATH ?? "";
const DEX = new Set(["raydium-clmm", "meteora-dlmm", "pumpswap"]);

function fail(msg: string): never {
  console.error(`[preflight] REFUSE: ${msg}`);
  process.exit(1);
}

interface Entry { label?: string; marketAddress?: string; poolAddress?: string; dexType?: string; assetIndex?: number }

async function main(): Promise<void> {
  if (!DEVNET_RPC || !WRAPPER || !REGISTRY_PATH) fail("DEVNET_RPC_URL, WRAPPER_PROGRAM_ID and REGISTRY_PATH are required");
  if (!fs.existsSync(REGISTRY_PATH)) {
    if (process.env.PREFLIGHT_ALLOW_EMPTY === "1") { console.log(`[preflight] ok (no registry at ${REGISTRY_PATH}; empty boot allowed)`); return; }
    fail(`registry file ${REGISTRY_PATH} does not exist`);
  }
  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as { programSet?: string; markets?: Entry[] };
  if (reg.programSet !== undefined && reg.programSet !== "v1") fail(`registry programSet=${reg.programSet}; this keeper runs the explicit-ID (untagged/"v1") mode`);
  const markets = reg.markets ?? [];
  if (markets.length === 0) {
    if (process.env.PREFLIGHT_ALLOW_EMPTY === "1") { console.log("[preflight] ok (registry empty; allowed for dry-run)"); return; }
    fail("registry has 0 markets (live mode exits on an empty registry)");
  }
  const seen = new Set<string>();
  for (const m of markets) {
    if (!m.marketAddress || !m.poolAddress || !m.dexType) fail(`entry ${m.label ?? "?"} lacks marketAddress/poolAddress/dexType`);
    if (!DEX.has(m.dexType)) fail(`entry ${m.label}: unknown dexType ${m.dexType}`);
    if (seen.has(m.marketAddress)) fail(`duplicate market ${m.marketAddress}`);
    seen.add(m.marketAddress);
    new PublicKey(m.marketAddress); new PublicKey(m.poolAddress);
  }
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const infos = await conn.getMultipleAccountsInfo(markets.map((m) => new PublicKey(m.marketAddress as string)));
  infos.forEach((info, i) => {
    const m = markets[i] as Entry;
    if (!info) fail(`${m.label}: market ${m.marketAddress} does not exist on devnet`);
    if (info.owner.toBase58() !== WRAPPER) fail(`${m.label}: market ${m.marketAddress} is owned by ${info.owner.toBase58()}, not the fresh wrapper ${WRAPPER}`);
  });
  console.log(`[preflight] ok: ${markets.length} market(s), all owned by wrapper ${WRAPPER}`);
}
main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
