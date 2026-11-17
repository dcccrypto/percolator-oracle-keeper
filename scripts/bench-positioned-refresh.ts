import { Keypair } from "@solana/web3.js";
import { planCrankTx, planRefreshTx, chunkOverflowTargets, V22_LEG_COST, type PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.js";

const owner = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const lp = Keypair.generate().publicKey;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

for (const n of [100, 1000, 5000]) {
  const targets: PositionedPortfolio[] = [];
  for (let i = 0; i < n; i++) targets.push({ pubkey: Keypair.generate().publicKey, longLegs: i % 2, shortLegs: 1 - (i % 2), isLp: i % 97 === 0, activeLegs: 1 + (i % 4) });
  const liq = targets.filter((_, i) => i % 10 === 0).map((t) => t.pubkey);
  const run = (name: string, f: () => unknown) => {
    for (let i = 0; i < 3; i++) f();
    const ts: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); }
    console.log(`N=${n} ${name}: ${median(ts).toFixed(3)} ms`);
  };
  run("planCrankTx(legacy)", () => planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: targets, liquidateTargets: liq }));
  run("planCrankTx(v22)", () => planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: targets, liquidateTargets: liq, cost: V22_LEG_COST }));
  run("planRefreshTx(all)", () => planRefreshTx({ owner, market, targets, liquidateTargets: liq }));
  const ov = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: targets, liquidateTargets: liq }).overflow;
  run("overflow pipeline(chunk+planRefreshTx)", () => chunkOverflowTargets(ov, undefined, undefined).map((g) => planRefreshTx({ owner, market, targets: g, liquidateTargets: liq })));
}
