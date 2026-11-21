/**
 * Bench: executeKeeperExits over M markets x R requests per tick, T ticks, fake exec connection.
 * Counts PublicKey.findProgramAddressSync calls with a spy. Run: node --import tsx/esm scripts/bench-earn-exit.ts
 */
import { PublicKey } from "@solana/web3.js";
import { executeKeeperExits, freshEarnExitState } from "../src/cross-cluster/v22/earn-exit.ts";
import { deriveLpVaultRegistry } from "@percolatorct/sdk";
import { execCtx, key, v22Ctx } from "../src/cross-cluster/v22/test-helpers.ts";

const MARKETS = Number(process.env.BENCH_MARKETS ?? 20);
const REQS = Number(process.env.BENCH_REQS ?? 10);
const TICKS = Number(process.env.BENCH_TICKS ?? 1000);

function request(registry: PublicKey, n: number): Uint8Array {
  const b = Buffer.alloc(128);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(19, 8);
  b[10] = 6;
  Buffer.from(registry.toBytes()).copy(b, 16);
  Buffer.from(key(n).toBytes()).copy(b, 48);
  b.writeBigUInt64LE(77n, 80);
  b.writeBigUInt64LE(1000n + BigInt(n), 96);
  b[104] = 1;
  b.writeBigUInt64LE(5n, 112);
  b[120] = 1;
  return new Uint8Array(b);
}

const base = v22Ctx();
const markets = Array.from({ length: MARKETS }, (_, i) => {
  const market = key(2000 + i);
  const ctx = { ...base, market, marketAddress: market.toBase58() };
  const reg = deriveLpVaultRegistry(ctx.programId, market)[0];
  const reqs = Array.from({ length: REQS }, (_, j) => ({ pubkey: key(5000 + i * 100 + j), data: request(reg, 300 + j) }));
  return { ctx, reqs, st: freshEarnExitState() };
});

let derivations = 0;
const orig = PublicKey.findProgramAddressSync.bind(PublicKey);
(PublicKey as unknown as { findProgramAddressSync: typeof orig }).findProgramAddressSync = (s, p) => (derivations++, orig(s, p));

let sims = 0;
const conn = {
  async getLatestBlockhash() {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000_000 };
  },
  async simulateTransaction() {
    sims++;
    return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } };
  },
};
const exec = execCtx(conn as never, true);
const tick = async () => {
  for (const m of markets) await executeKeeperExits(exec, m.ctx, m.reqs, REQS, m.st);
};
await tick(); // cold
const cold = derivations;
derivations = 0;
await tick(); // warm (cooldowns are not set: every send succeeds)
const warmOne = derivations;
derivations = 0;
const t0 = performance.now();
for (let i = 0; i < TICKS; i++) await tick();
const ms = performance.now() - t0;
console.log(JSON.stringify({ markets: MARKETS, reqs: REQS, ticks: TICKS, coldDerivations: cold, warmTickDerivations: warmOne, totalDerivations: derivations, ms: Math.round(ms), simulated: sims }));
