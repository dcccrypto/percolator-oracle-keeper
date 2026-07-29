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
 *   CC_CYCLE_TIMEOUT_MS   D2a per-cycle hang-detection timeout (default: 10000)
 *   DRY_RUN               "true" for dry-run (no on-chain writes, default: false)
 *   CRANK_ENABLED          "false" disables the recovery crank loop + crank-on-boot (default: true)
 *   CRANK_INTERVAL_MS       recovery crank cycle interval ms (default: 20000)
 *   REGISTER_SOURCE_URL     GET endpoint polled for wizard-registered markets (unset = disabled)
 *   REGISTER_POLL_INTERVAL_MS  register-poll interval ms (default: 30000)
 *   REGISTRY_RELOAD_INTERVAL_MS  G6 registry.json hot-reload interval ms (default: 15000)
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
import { crankAllOnce, startRecoveryCrankLoop } from "./cross-cluster/recovery-cranker.ts";
import { startLpFeeCrankLoop } from "./cross-cluster/lp-fee-cranker.ts";
import { startRegisterPollLoop } from "./cross-cluster/register-poll.ts";
import { startRegistryReloadLoop } from "./cross-cluster/registry-reload.ts";
import { WRAPPER_PROGRAM_ID } from "./cross-cluster/auth-mark-pusher.ts";

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
// D2a — see cross-cluster/keeper-loop.ts's hang-detection doc comment.
const CC_CYCLE_TIMEOUT_MS = parseInt(process.env.CC_CYCLE_TIMEOUT_MS ?? "10000", 10);

// Recovery/maintenance crank loop — independent cadence from the oracle push.
// See cross-cluster/recovery-cranker.ts for why this exists (keeps
// asset.slot_last from drifting far enough behind the live slot to trip
// EngineLockActive on risk-increasing trades). Defaults to on; set
// CRANK_ENABLED=false to disable (e.g. for a read-only / dry-run deploy).
const CRANK_ENABLED = process.env.CRANK_ENABLED !== "false";
const CRANK_INTERVAL_MS = parseInt(process.env.CRANK_INTERVAL_MS ?? "20000", 10);
// LP_FEE_CRANK_ENABLED=false to disable. 200s by default: fee distribution is not
// latency-sensitive (it only moves already-accrued atoms into the vault), and a
// market with no LP depositors costs no transaction at all.
const LP_FEE_CRANK_ENABLED = process.env.LP_FEE_CRANK_ENABLED !== "false";
const LP_FEE_CRANK_INTERVAL_MS = parseInt(process.env.LP_FEE_CRANK_INTERVAL_MS ?? "200000", 10);

// Registration-poll loop — outbound poll of the Vercel-hosted playground registered-
// markets blob, so markets created through the create-market wizard after this keeper
// booted get added live. See cross-cluster/register-poll.ts for why this exists (the
// keeper is NAT'd/outbound-only; the frontend can never reach it directly). Off unless
// REGISTER_SOURCE_URL is set — nothing to poll without a source.
const REGISTER_SOURCE_URL = process.env.REGISTER_SOURCE_URL;
// 3s, not 30s. A market the user just created has to start being priced
// immediately — at 30s the markets page showed it live while the keeper had not
// yet heard of it, so its price sat at the seed value for up to half a minute.
// The endpoint is a no-store liveness feed backed by one indexed select, so
// polling it every 3s is cheap; the old interval was sized for a cached
// Blob-only read.
const REGISTER_POLL_INTERVAL_MS = parseInt(process.env.REGISTER_POLL_INTERVAL_MS ?? "3000", 10);

const REGISTRY_PATH =
  process.env.REGISTRY_PATH ??
  path.resolve(__dirname, "..", "registry.json");

// G6 — registry.json hot-reload, so a re-seed is picked up live without a
// restart. See cross-cluster/registry-reload.ts for the full rationale.
const REGISTRY_RELOAD_INTERVAL_MS = parseInt(process.env.REGISTRY_RELOAD_INTERVAL_MS ?? "15000", 10);

// ── Boot ───────────────────────────────────────────────────────────────────────
const keeper = loadKeypair();
const registry = loadRegistry(REGISTRY_PATH);

if (registry.markets.length === 0) {
  console.warn(
    "[warn] Registry is empty — no markets to push to." +
      " Register markets via addMarket() or by populating registry.json.",
  );
  // An empty registry is only fatal when there is no way to become non-empty.
  //
  // This exit predates the registration-poll loop, when registry.json was the
  // only source and empty genuinely meant "nothing to do, ever". With
  // REGISTER_SOURCE_URL set there IS something to do: wait for the frontend to
  // publish a market and pick it up on the next poll.
  //
  // Exiting here made retiring every market a trap — the board is cleared, the
  // keeper dies, and the next market launched is never priced because nothing
  // is alive to poll for it. Starting empty and filling from the poll is the
  // normal cold-start path now, not an error.
  if (!DRY_RUN && !REGISTER_SOURCE_URL) {
    console.error(
      "[fatal] Nothing to do in live mode with an empty registry and no" +
        " REGISTER_SOURCE_URL to poll. Exiting.",
    );
    process.exit(1);
  }
  if (REGISTER_SOURCE_URL) {
    console.warn(
      `[warn] Starting with an empty registry — waiting for markets from ${REGISTER_SOURCE_URL}` +
        ` (poll every ${REGISTER_POLL_INTERVAL_MS}ms).`,
    );
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
  `  lp-fee:    ${LP_FEE_CRANK_ENABLED ? `every ${LP_FEE_CRANK_INTERVAL_MS}ms` : "disabled (LP_FEE_CRANK_ENABLED=false)"}`,
);
for (const m of registry.markets) {
  console.log(
    `  market:    ${m.label} | slab=${m.marketAddress.slice(0, 8)}… → pool=${m.poolAddress.slice(0, 8)}… (${m.dexType})${m.lpPortfolio ? ` | lp=${m.lpPortfolio.slice(0, 8)}…` : ""}`,
  );
}
console.log();

// G9 — register-poll is what picks up markets created through the create-market
// wizard AFTER this keeper booted. Silently running without it in live mode means
// those markets never get priced/cranked and quietly die on arrival — loud enough
// to be seen in logs/alerts, but not fatal (some deploys are intentionally
// registry.json-only).
if (!REGISTER_SOURCE_URL && !DRY_RUN) {
  console.warn(
    "[warn] REGISTER_SOURCE_URL is unset in LIVE mode — markets created through the" +
      " create-market wizard after this keeper booted will NEVER be picked up" +
      " (register-poll is disabled). Set REGISTER_SOURCE_URL (see .env.example) unless" +
      " this registry.json-only deploy is intentional.",
  );
}

// D1 — deterministic crank-on-boot. AWAITED (unlike every loop below, which is
// deliberately fire-and-forget) so process boot does not complete — and the
// recurring loops below do not start — until every seeded market has had a real
// crank attempt. Uses ONLY registry.json's known lpPortfolio (no discovery), so
// this resolves in a small, bounded number of RPC calls regardless of registry
// size. See cross-cluster/recovery-cranker.ts's crankAllOnce() doc comment for
// exactly why this closes the SOL/JUP/TRUMP boot-gap.
if (CRANK_ENABLED) {
  await crankAllOnce(devnetConn, keeper, registry, DRY_RUN);
}

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

// LP-fee distribution loop. Same "concurrent, never awaited, never throws out of
// scope" pattern. Without this, `lp_fee_accrued_atoms` grows on the slab forever
// and LP depositors see 0% APY no matter how much the market trades — the fee
// split is correct, but nothing ever moves the LP's share into the vault.
// Runs 10x slower than the recovery crank: distribution is not latency-sensitive,
// and a market with no LP depositors is skipped locally without a transaction.
if (LP_FEE_CRANK_ENABLED) {
  void startLpFeeCrankLoop(devnetConn, keeper, registry, {
    intervalMs: LP_FEE_CRANK_INTERVAL_MS,
    dryRun: DRY_RUN,
  }).catch((err) => {
    console.error(
      `[lp-fee] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
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
    // Owner filter: only admit markets owned by the current wrapper (WRAPPER_PROGRAM_ID
    // = PROGRAM_IDS_V17.percolator). Keeps retired-wrapper blob entries out of the
    // atomic push batch (they revert it with IncorrectProgramId).
    connection: devnetConn,
    expectedOwner: WRAPPER_PROGRAM_ID,
  }).catch((err) => {
    console.error(
      `[register-poll] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
} else {
  console.log("[register-poll] disabled (REGISTER_SOURCE_URL unset)");
}

// G6 — registry.json hot-reload. Same fire-and-forget pattern as the other
// background loops. Critical ahead of the upcoming re-seed: without this, a
// new registry.json on disk is invisible to a running keeper until restart —
// and a restart right after a re-seed reintroduces exactly the kind of
// boot-time gap D5/D1 exist to close.
void startRegistryReloadLoop(registry, {
  registryPath: REGISTRY_PATH,
  intervalMs: REGISTRY_RELOAD_INTERVAL_MS,
}).catch((err) => {
  console.error(
    `[registry-reload] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
  );
});

await startKeeperLoop(mainnetConn, devnetConn, keeper, registry, {
  intervalMs: CC_INTERVAL_MS,
  healthPort: CC_HEALTH_PORT,
  healthBind: CC_HEALTH_BIND,
  dryRun: DRY_RUN,
  cycleTimeoutMs: CC_CYCLE_TIMEOUT_MS,
});
