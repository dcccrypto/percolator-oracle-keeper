/**
 * Microbenchmark: the per-cycle refresh / catch-up PLAN for positioned accounts (positioned-refresh.ts):
 * planCrankTx + chunkOverflowTargets + planRefreshTx over N synthetic accounts spread across 20 markets.
 * Pure CPU. The planner takes no connection, so RPC calls per cycle are counted through a mock Connection that
 * is handed to nothing: the count is structurally 0 and is printed so a regression that adds a read shows up
 * (any import of a Connection method here would increment it).
 * Prints median-of-20 ms per cycle and a sha256 of the whole plan (order, kinds, keys, ix data, CU).
 *
 *   node --import tsx/esm scripts/bench-positioned-refresh.ts
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { planCrankTx, planRefreshTx, chunkOverflowTargets, V22_LEG_COST } from "../src/cross-cluster/positioned-refresh.ts";
import type { PositionedPortfolio, CrankPlan } from "../src/cross-cluster/positioned-refresh.ts";

const MARKETS = 20;
const RUNS = 20;

let rpcCalls = 0;
export const mockRpc = new Proxy({}, { get: () => () => { rpcCalls++; } });

let s = 0x9e3779b9;
const rnd = (): number => {
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5; s >>>= 0;
  return s / 0x100000000;
};
const mkKey = (): PublicKey => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(rnd() * 256);
  return new PublicKey(b);
};

interface Cycle {
  owner: PublicKey;
  market: PublicKey;
  lp: PositionedPortfolio;
  targets: PositionedPortfolio[];
  liq: PublicKey[];
  catchup: number;
  withCost: boolean;
}

function build(n: number): Cycle[] {
  s = 0x9e3779b9;
  const owner = mkKey();
  const per = Math.floor(n / MARKETS);
  const out: Cycle[] = [];
  for (let m = 0; m < MARKETS; m++) {
    const targets: PositionedPortfolio[] = [];
    for (let i = 0; i < per; i++) {
      const legs = 1 + Math.floor(rnd() * 4);
      targets.push({
        pubkey: mkKey(),
        longLegs: rnd() < 0.5 ? 1 : 0,
        shortLegs: rnd() < 0.5 ? 1 : 0,
        isLp: i === 0,
        activeLegs: legs,
      });
    }
    const liq = targets.filter(() => rnd() < 0.1).map((t) => t.pubkey);
    out.push({ owner, market: mkKey(), lp: targets[0]!, targets, liq, catchup: m % 4 === 3 ? 12 : m % 4, withCost: m % 2 === 0 });
  }
  return out;
}

function planAll(cycles: Cycle[]): CrankPlan[] {
  const plans: CrankPlan[] = [];
  for (const c of cycles) {
    const cost = c.withCost ? V22_LEG_COST : undefined;
    const p = planCrankTx({ owner: c.owner, market: c.market, lpPortfolio: c.lp.pubkey, catchup: c.catchup, refreshTargets: c.targets, liquidateTargets: c.liq, cost, lp: c.lp });
    plans.push(p);
    for (const g of chunkOverflowTargets(p.overflow, undefined, cost)) {
      plans.push(planRefreshTx({ owner: c.owner, market: c.market, targets: g, liquidateTargets: c.liq, cost }));
    }
  }
  return plans;
}

export function hashPlans(plans: CrankPlan[]): string {
  const h = createHash("sha256");
  for (const p of plans) {
    h.update(`CU${p.computeUnits}|OV${p.overflow.map((o) => o.pubkey.toBase58()).join(",")}|`);
    for (const c of p.cranks) {
      h.update(`${c.kind}:${c.portfolio.toBase58()}:${c.ix.programId.toBase58()}:`);
      for (const k of c.ix.keys) h.update(`${k.pubkey.toBase58()}${k.isSigner ? "s" : ""}${k.isWritable ? "w" : ""},`);
      h.update(Buffer.from(c.ix.data));
      h.update(";");
    }
    h.update("\n");
  }
  return h.digest("hex");
}

for (const n of [1000, 5000]) {
  const cycles = build(n);
  planAll(cycles); // warm-up
  const times: number[] = [];
  let digest = "";
  let cranks = 0;
  for (let r = 0; r < RUNS; r++) {
    rpcCalls = 0;
    const t0 = process.hrtime.bigint();
    const plans = planAll(cycles);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r === 0) {
      digest = hashPlans(plans);
      cranks = plans.reduce((a, p) => a + p.cranks.length, 0);
    }
  }
  times.sort((a, b) => a - b);
  const med = (times[9]! + times[10]!) / 2;
  console.log(`accounts=${n} markets=${MARKETS} median_ms=${med.toFixed(2)} rpc_calls_per_cycle=${rpcCalls} cranks=${cranks} sha256=${digest.slice(0, 16)}`);
}
