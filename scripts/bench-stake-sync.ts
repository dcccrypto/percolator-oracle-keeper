/**
 * Bench: stakeSyncOnce where the interval gate skips (50 markets x 200 ticks = 10k calls).
 * Counts PublicKey.findProgramAddressSync calls via a spy. Run: node --import tsx/esm scripts/bench-stake-sync.ts
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, deriveStakePool } from "@percolatorct/sdk";
import { freshStakeSyncState, stakeSyncOnce } from "../src/cross-cluster/v22/stake-sync.ts";
import { execCtx, fakeExecConn, v22Ctx } from "../src/cross-cluster/v22/test-helpers.ts";

const F = STAKE_POOL_FIELD_OFF_V5;
const b = Buffer.alloc(STAKE_POOL_SIZE_V5);
"SPOOL_V1".split("").forEach((c, i) => (b[F.reserved + i] = c.charCodeAt(0)));
b[F.version] = 5;
b[F.riskMode] = 1;
b.writeBigUInt64LE(150n, F.syncCooldownSlots);
const pool = new Uint8Array(b);

let derivations = 0;
const orig = PublicKey.findProgramAddressSync;
PublicKey.findProgramAddressSync = ((...a: Parameters<typeof orig>) => {
  derivations++;
  return orig.apply(PublicKey, a);
}) as typeof orig;

const markets = Array.from({ length: 50 }, () => Keypair.generate().publicKey);
const base = v22Ctx();
const ctxs = markets.map((m) => ({ ...base, market: m }));
const exec = execCtx(fakeExecConn().conn);
const st = freshStakeSyncState();
// prime lastAttemptMs so every later call hits the interval gate
for (const c of ctxs) st.lastAttemptMs.set(deriveStakePool(c.market, (await import("../src/program-ids.ts")).STAKE_PROGRAM_ID)[0].toBase58(), 1000);
const P = { intervalMs: 1e9, nowMs: 2000 };
for (const c of ctxs) await stakeSyncOnce(exec, c, pool, st, P); // warm-up tick
derivations = 0;
const N = 10_000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const r = await stakeSyncOnce(exec, ctxs[i % 50], pool, st, P);
  if (r.kind !== "skipped") throw new Error("not skipped: " + r.kind);
}
const ns = Number(process.hrtime.bigint() - t0) / N;
console.log(JSON.stringify({ calls: N, nsPerCall: Math.round(ns), derivations, derivationsPerCall: derivations / N }));
