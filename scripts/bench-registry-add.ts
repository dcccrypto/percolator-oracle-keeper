// node --import tsx/esm scripts/bench-registry-add.ts
import { addMarket, type Registry, type MarketEntry } from "../src/cross-cluster/registry.js";
import { reconcileMarkets } from "../src/cross-cluster/register-poll.js";

const mk = (i: number): any => ({
  marketAddress: `M${i}`,
  mainnetMint: `X${i}`,
  pool: { dex: "raydium-clmm", poolAddress: `P${i}` },
});

function med(a: number[]) {
  return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
}

for (const N of [2000, 10000]) {
  const add: number[] = [];
  const rec: number[] = [];
  const steady: number[] = [];
  for (let r = 0; r < 5; r++) {
    // batch: N rows, half new / half replacing (registry preloaded with N/2)
    const reg: Registry = { version: 1, markets: [] } as any;
    for (let i = 0; i < N / 2; i++) reg.markets.push({ ...mk(i), registeredAt: 1 });
    let t = performance.now();
    for (let i = 0; i < N; i++) addMarket(reg, mk(i));
    add.push(performance.now() - t);

    // poll cycle: reconcile N desired rows against N local rows, no change
    const desired: MarketEntry[] = reg.markets.map((m) => ({ ...m }));
    const abs = new Map<string, number>();
    t = performance.now();
    reconcileMarkets(reg, desired, abs);
    steady.push(performance.now() - t);
    // half new rows
    const reg2: Registry = { version: 1, markets: reg.markets.slice(0, N / 2).map((m) => ({ ...m })) } as any;
    t = performance.now();
    reconcileMarkets(reg2, desired, abs);
    rec.push(performance.now() - t);
  }
  console.log(
    `N=${N} addMarket batch(${N} rows) median=${med(add).toFixed(2)}ms | reconcile steady=${med(steady).toFixed(2)}ms | reconcile half-new=${med(rec).toFixed(2)}ms`,
  );
}
