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
import { isExplicitTrue, validateRpcEndpoint } from "./rpc-url.ts";
import { startKeeperLoop } from "./cross-cluster/keeper-loop.ts";
import { crankAllOnce, startRecoveryCrankLoop } from "./cross-cluster/recovery-cranker.ts";
import { startLpFeeCrankLoop } from "./cross-cluster/lp-fee-cranker.ts";
import { startRegisterPollLoop, pollOnce } from "./cross-cluster/register-poll.ts";
import { startRegistrationStream, type RegistrationStream } from "./cross-cluster/registration-stream.ts";
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

// These two carry the Helius API key in the query string and are the ONLY RPC
// endpoints the running keeper uses (launchd -> start-keeper.sh -> this file).
// A plaintext http:// endpoint would put that key on the wire in clear, so the
// same scheme check #89 added for the legacy entry point is applied here, where
// it actually protects something. http:// stays available for localhost when
// ALLOW_INSECURE_LOCAL_RPC=true, matching rpc-url.ts's contract exactly.
{
  const allowInsecureLocalRpc = isExplicitTrue(process.env.ALLOW_INSECURE_LOCAL_RPC);
  for (const [name, value] of [
    ["MAINNET_RPC_URL", MAINNET_RPC],
    ["DEVNET_RPC_URL", DEVNET_RPC],
  ] as const) {
    const problem = validateRpcEndpoint(name, value, {
      required: true,
      allowInsecureLocalRpc,
    });
    if (problem) {
      console.error(`[fatal] ${problem}`);
      process.exit(1);
    }
  }
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

// Supabase Realtime credentials for push registration. Anon key only: `markets`
// has RLS with a public_read SELECT policy and Realtime enforces RLS per
// subscriber, so this exposes nothing GET /api/markets does not already serve.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
let registrationStream: RegistrationStream | null = null;
// This is the SAFETY NET, not the fast path. Supabase Realtime (see
// registration-stream.ts) triggers a poll the instant a `markets` row changes,
// so a new market is picked up in ~ms. This loop exists for when that socket is
// down, throttled, or Realtime is unavailable — registration still converges,
// just slower. 30s is fine for that role; it does not gate launch latency.
const REGISTER_POLL_INTERVAL_MS = parseInt(process.env.REGISTER_POLL_INTERVAL_MS ?? "30000", 10);

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
// The market list now comes from Supabase (`markets` where keeper_status='active')
// rather than the Vercel blob, so Supabase config — not REGISTER_SOURCE_URL — is
// what gates registration. The blob was a second store that the Realtime
// notification this keeper already subscribes to pointed away from.
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  const registerPollConfig = {
    db: {
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      network: "devnet",
      mainnetConn,
      // Pool -> DEX type, resolved from each pool's on-chain owner and cached
      // for the process. dex_type is deliberately not a DB column.
      dexCache: new Map(),
    },
    registryPath: REGISTRY_PATH,
    intervalMs: REGISTER_POLL_INTERVAL_MS,
    // Owner filter: only admit markets owned by the current wrapper (WRAPPER_PROGRAM_ID
    // = PROGRAM_IDS_V17.percolator). Keeps retired-wrapper entries out of the
    // atomic push batch (they revert it with IncorrectProgramId).
    connection: devnetConn,
    expectedOwner: WRAPPER_PROGRAM_ID,
  };

  // Push path: Supabase Realtime tells us the instant a `markets` row changes,
  // so a market the user just created is picked up in ~ms rather than waiting
  // for the next tick. It TRIGGERS the poll rather than replacing it — one code
  // path still admits a market, and if the socket drops the loop below covers
  // it. See cross-cluster/registration-stream.ts.
  {
    registrationStream = startRegistrationStream({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      onChange: () => {
        void pollOnce(registry, registerPollConfig).catch((err) => {
          console.warn(
            `[registration-stream] triggered poll failed (periodic poll unaffected): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      },
    });
  }

  void startRegisterPollLoop(registry, registerPollConfig).catch((err) => {
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
