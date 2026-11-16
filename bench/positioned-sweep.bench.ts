/** node --import tsx bench/positioned-sweep.bench.ts [modulePath]  (median ms over 5 runs per N) */
import { PublicKey } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
const mod = await import(process.argv[2] ?? "../src/cross-cluster/positioned-sweep.ts");
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";

const pk = (i: number): PublicKey => {
  const b = new Uint8Array(32);
  b[0] = 1; b[29] = (i >> 16) & 255; b[30] = (i >> 8) & 255; b[31] = i & 255;
  return new PublicKey(b);
};
const build = (n: number): PositionedPortfolio[] =>
  Array.from({ length: n }, (_, i) => ({
    pubkey: pk(i + 1), longLegs: 1, shortLegs: 0, isLp: i === 0,
    lossWeight: BigInt((i * 7919) % 1000), kfEpochSnapLong: BigInt(i % 3), kfEpochSnapShort: null,
  }));
const OWNER = Keypair.generate().publicKey, MARKET = pk(900000), LP = pk(1);

function cycle(n: number) {
  const pos = build(n);
  const cursor = mod.freshSweepCursor();
  const cfg = mod.DEFAULT_SWEEP_CONFIG;
  const epochs = { long: 2n, short: 0n };
  const batches = 40; // sweep batches run per measured window
  for (let b = 0; b < batches; b++) {
    const batch = mod.selectSweepBatch(pos, cursor, cfg.k, new Set(), epochs);
    mod.planSweepTx({ owner: OWNER, market: MARKET, lpPortfolio: LP, targets: batch, cfg });
    mod.markVisited(cursor, batch.map((p: PositionedPortfolio) => p.pubkey));
    mod.refreshPositionedFrom(pos, batch);
  }
  mod.pruneVisits(cursor, pos);
}
for (const n of [100, 1000, 5000]) {
  const ts: number[] = [];
  cycle(n); // warm
  for (let r = 0; r < 5; r++) { const t = performance.now(); cycle(n); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  console.log(`N=${n} median ${ts[2].toFixed(2)} ms`);
}
