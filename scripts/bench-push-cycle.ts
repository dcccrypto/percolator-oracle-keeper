/**
 * scripts/bench-push-cycle.ts — read-only latency bench of the oracle PUSH critical path (perf/v22-keep-1113).
 *
 * Runs the REAL `startKeeperLoop` (src/cross-cluster/keeper-loop.ts) against devnet + mainnet with every send refused,
 * and times, per cycle, how long the keeper takes from the start of the cycle (= the moment it begins reading prices) to
 * the moment it hands the signed PushAuthMark tx to `sendRawTransaction` ("cycle→send"). That is the keeper's own share
 * of price-move → on-chain latency (the rest is the cadence wait and the cluster's landing time).
 *
 * NOTHING IS SENT, by three independent guards:
 *   1. both Connections' sendRawTransaction / sendTransaction / sendEncodedTransaction throw (the DRY_RUN hard stop);
 *   2. the fetch under both Connections refuses any JSON-RPC body that names `sendTransaction`;
 *   3. no other loop is started (no cranker, no v2.2 layer, no fee jobs): only the push loop runs.
 * `dryRun: false` is passed to the loop ONLY so it runs the live preflight (simulateTransaction, read-only) before the
 * refused send — the dry-run path returns before preflight and would under-measure the critical path.
 *
 * Usage (env as the live launcher sets it; the RPC key is read at runtime and never printed):
 *   BENCH_CYCLES=25 BENCH_OUT=/path/out.json REGISTRY_PATH=/path/registry.json node --import tsx/esm scripts/bench-push-cycle.ts
 * Keep runs short: the Helius key is shared with the live keeper (~one cycle per CC_INTERVAL_MS, ~8 calls a cycle).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CYCLES = Number(process.env.BENCH_CYCLES ?? 25);
const OUT = process.env.BENCH_OUT ?? "";

// ── env exactly as run-v22fresh1106.sh sets it for the push loop (no secrets in this file) ──────────────────────────
function readKey(): string {
  const tok = path.join(os.homedir(), ".openclaw/credentials/deploy-tokens.env");
  const line = fs.readFileSync(tok, "utf8").split("\n").find((l) => /^(export )?HELIUS_KEEPER_API_KEY=/.test(l));
  const key = line?.replace(/^(export )?HELIUS_KEEPER_API_KEY=/, "").replace(/^["']|["']$/g, "").trim();
  if (!key) throw new Error("HELIUS_KEEPER_API_KEY missing");
  return key;
}
const KEY = readKey();
for (const k of ["SUPABASE_URL", "REGISTER_SOURCE_URL", "TICK_INGEST_URL", "TICK_INGEST_KEY", "KEEPER_ALERT_WEBHOOK_URL", "KEEPER_ALERT_TELEGRAM_BOT_TOKEN", "DRY_RUN", "KEEPER_DRY_RUN"]) delete process.env[k];
Object.assign(process.env, {
  WRAPPER_PROGRAM_ID: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  STAKE_PROGRAM_ID: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  KEEPER_NFT_PROGRAM_ID: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
  MATCHER_PROGRAM_ID: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
  KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1",
  KEEPER_DEVNET_V21: "1",
  PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE: "1",
  SOL_USD_REFERENCE_POOL: process.env.SOL_USD_REFERENCE_POOL ?? "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  CC_INTERVAL_MS: process.env.CC_INTERVAL_MS ?? "3000",
  CC_MARK_WINDOW_MS: process.env.CC_MARK_WINDOW_MS ?? "17000",
  KEEPER_PUSH_DEPTH: process.env.KEEPER_PUSH_DEPTH ?? "on",
  KEEPER_V22_REFUSE_STABLECOIN_UNDERLYINGS: "1",
});

const { Connection, Keypair } = await import("@solana/web3.js");
const { startKeeperLoop } = await import("../src/cross-cluster/keeper-loop.ts");
const { loadRegistryForProgramSet } = await import("../src/cross-cluster/registry.ts");
const { bindObservationRegistry } = await import("../src/cross-cluster/multi-asset.ts");
const { PROGRAM_IDS_RESOLVED } = await import("../src/program-ids.ts");
const { devnetConnectionConfig } = await import("../src/rpc-headers.ts");

// ── timeline recording ───────────────────────────────────────────────────────────────────────────────────────────────
type Call = { ep: string; method: string; t0: number; t1: number };
type CycleRec = { n: number; start: number; end?: number; sendAt?: number; calls: Call[] };
const cycles: CycleRec[] = [];
const cur = (): CycleRec | undefined => cycles[cycles.length - 1];
const now = () => performance.now();

function benchFetch(ep: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const method = /"method"\s*:\s*"([A-Za-z0-9_]+)"/.exec(body)?.[1] ?? "?";
    if (/sendTransaction/.test(method)) throw new Error("BENCH: send refused at fetch");
    const c = cur();
    const t0 = now();
    try {
      return await fetch(input, init);
    } finally {
      c?.calls.push({ ep, method, t0: t0 - c.start, t1: now() - c.start });
    }
  }) as typeof fetch;
}

const mainnetConn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, { commitment: "confirmed", fetch: benchFetch("mainnet") });
const devnetConn = new Connection(`https://devnet.helius-rpc.com/?api-key=${KEY}`, { ...devnetConnectionConfig(process.env), fetch: benchFetch("devnet") });
for (const conn of [devnetConn, mainnetConn]) {
  const refuse = (): never => {
    const c = cur();
    if (c && c.sendAt === undefined) c.sendAt = now() - c.start;
    throw new Error("BENCH: transaction send blocked at the connection");
  };
  conn.sendRawTransaction = refuse;
  conn.sendTransaction = refuse;
  conn.sendEncodedTransaction = refuse;
}

const kpPath = process.env.KEEPER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/percolator-v17-devnet.json");
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
const registry = loadRegistryForProgramSet(process.env.REGISTRY_PATH!, PROGRAM_IDS_RESOLVED.programSet);
bindObservationRegistry(() => registry.markets);

// Cycle boundaries come from the loop's own "=== Cycle N" line (logged at cycleStart).
const origLog = console.log.bind(console);
const quiet = process.env.BENCH_VERBOSE !== "1";
console.log = (...args: unknown[]) => {
  const s = String(args[0] ?? "");
  const m = /=== Cycle (\d+) /.exec(s);
  if (m) {
    const prev = cur();
    if (prev && prev.end === undefined) prev.end = now() - prev.start;
    if (Number(m[1]) > CYCLES) finish();
    cycles.push({ n: Number(m[1]), start: now(), calls: [] });
  }
  if (!quiet) origLog(...args);
};
const origErr = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const s = String(args[0] ?? "");
  if (!/BENCH: transaction send blocked|push\(es\) failed/.test(s)) origErr(...args);
};

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
}
function finish(): never {
  // Cycle 1 carries the one-off oracle-authority reads (cached 30 min) — warm-up, excluded.
  const done = cycles.filter((c) => c.n > 1 && c.end !== undefined);
  const sent = done.filter((c) => c.sendAt !== undefined);
  const toSend = sent.map((c) => c.sendAt!);
  const calls = done.map((c) => c.calls.length);
  const byMethod: Record<string, number> = {};
  for (const c of done) for (const k of c.calls) byMethod[`${k.ep}:${k.method}`] = (byMethod[`${k.ep}:${k.method}`] ?? 0) + 1;
  for (const k of Object.keys(byMethod)) byMethod[k] = Number((byMethod[k] / done.length).toFixed(2));
  const summary = {
    when: new Date().toISOString(),
    cycles: done.length,
    cyclesWithSend: sent.length,
    cycleToSendMs: { p50: pct(toSend, 0.5), p90: pct(toSend, 0.9), p95: pct(toSend, 0.95), max: Math.max(...toSend), mean: toSend.reduce((a, b) => a + b, 0) / (toSend.length || 1) },
    rpcCallsPerCycle: { p50: pct(calls, 0.5), mean: calls.reduce((a, b) => a + b, 0) / (calls.length || 1) },
    rpcPerCycleByMethod: byMethod,
  };
  origLog(JSON.stringify(summary, null, 2));
  // one sample timeline, for the plan
  const sample = sent[Math.floor(sent.length / 2)];
  if (sample) {
    origLog(`sample timeline (cycle ${sample.n}, send at ${sample.sendAt!.toFixed(0)}ms):`);
    for (const k of sample.calls.filter((k) => k.t0 <= sample.sendAt!)) origLog(`  ${k.t0.toFixed(0).padStart(5)} → ${k.t1.toFixed(0).padStart(5)}  ${k.ep}:${k.method}`);
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, cycles: done }, null, 1));
  process.exit(0);
}

await startKeeperLoop(mainnetConn, devnetConn, keeper, registry, {
  intervalMs: Number(process.env.CC_INTERVAL_MS),
  healthPort: Number(process.env.BENCH_HEALTH_PORT ?? 18913),
  healthBind: "127.0.0.1",
  dryRun: false, // see header: sends are refused at two layers; this only enables the read-only preflight
  cycleTimeoutMs: 10_000,
  minKeeperBalanceLamports: 50_000_000,
  balanceCheckIntervalMs: 60_000,
});
