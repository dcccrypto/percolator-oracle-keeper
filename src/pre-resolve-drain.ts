#!/usr/bin/env tsx
/**
 * pre-resolve-drain.ts — run BEFORE any ResolveMarket (fee-flow audit F4).
 *
 *   npm run pre-resolve -- --market <slab> [--dry-run]
 *
 * Cranks the market's LP fee leg (tag 78) and staker fee leg (tag 87 ->
 * stake AccrueFees), re-reads the slab, and prints what is still owed.
 * Exit codes:
 *   0  safe to resolve: no Live-only leg outstanding (protocol/creator
 *      warnings may still print — claim those before CloseSlab)
 *   2  NOT safe: a Live-only leg is still owed and would be lost at resolve
 *   1  error (bad args, RPC failure)
 *
 * Env: DEVNET_RPC_URL (required), DEVNET_RPC_ORIGIN (optional Origin header),
 * KEEPER_KEYPAIR_PATH / KEEPER_KEYPAIR (any funded signer — both cranks are
 * permissionless), WRAPPER_PROGRAM_ID / STAKE_PROGRAM_ID (see program-ids.ts).
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import { drainFeeLegsBeforeResolve } from "./cross-cluster/pre-resolve.ts";
import { stakeFeeConfigFromEnv } from "./cross-cluster/stake-fee-pusher.ts";
import { describeProgramIds } from "./program-ids.ts";
import { devnetConnectionConfig } from "./rpc-headers.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadKeypair(): Keypair {
  if (process.env.KEEPER_KEYPAIR) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEEPER_KEYPAIR) as number[]));
  }
  const p = process.env.KEEPER_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main(): Promise<number> {
  const market = arg("--market");
  const dryRun = process.argv.includes("--dry-run");
  const rpc = process.env.DEVNET_RPC_URL;
  if (!market || !rpc) {
    console.error("usage: DEVNET_RPC_URL=… npm run pre-resolve -- --market <slab> [--dry-run]");
    return 1;
  }
  const conn = new Connection(rpc, devnetConnectionConfig(process.env));
  const keeper = loadKeypair();
  console.log(`[pre-resolve] ${describeProgramIds().join("  ")}`);
  console.log(`[pre-resolve] market=${market} signer=${keeper.publicKey.toBase58()} mode=${dryRun ? "DRY-RUN" : "LIVE"}`);
  const r = await drainFeeLegsBeforeResolve(conn, keeper, market, dryRun, stakeFeeConfigFromEnv(process.env));
  const fmt = (l: typeof r.before) =>
    `protocol=${l.protocolOwed} lp=${l.lpOwed} stake=${l.stakeOwed} creator=${l.creatorClaimable ?? "?"}`;
  console.log(`[pre-resolve] before: ${fmt(r.before)}`);
  console.log(`[pre-resolve] tag 78: ${typeof r.lp === "string" ? r.lp : `error ${r.lp.error}`}`);
  console.log(`[pre-resolve] tag 87+12: ${JSON.stringify(r.stake)}`);
  console.log(`[pre-resolve] after:  ${fmt(r.after)}`);
  for (const w of r.warnings) console.warn(`[pre-resolve][warn] ${w}`);
  for (const b of r.blockers) console.error(`[pre-resolve][BLOCKER] ${b}`);
  console.log(`[pre-resolve] ${r.safeToResolve ? "SAFE to resolve" : "NOT safe to resolve"}`);
  return r.safeToResolve ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[pre-resolve][fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
