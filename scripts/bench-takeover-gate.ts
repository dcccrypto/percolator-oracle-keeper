/**
 * Bench: refreshTakeoverGate (stub connection returning 176-byte slices) and TakeoverGate.health()
 * at 100 / 1,000 / 5,000 markets. Median of 5 runs. Usage: node --import tsx/esm scripts/bench-takeover-gate.ts
 */
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PUSHER_CONFIG, TakeoverGate, refreshTakeoverGate } from "../src/cross-cluster/pusher-role.ts";

const RUNS = 5;
const REFRESHES = 20;
const HEALTHS = 20;

function market(i: number): string {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(i + 1, 0);
  b[31] = 7;
  return new PublicKey(b).toBase58();
}

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function bench(n: number): Promise<{ refresh: number; health: number }> {
  const markets = Array.from({ length: n }, (_, i) => market(i));
  const slice = Buffer.alloc(176);
  slice.writeBigUInt64LE(1_000_000n, 168);
  const conn = {
    getSlot: async () => 1_000_030,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ data: slice })),
  } as never;
  const refs: number[] = [];
  const hs: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const gate = new TakeoverGate(DEFAULT_PUSHER_CONFIG, () => 5_000);
    await refreshTakeoverGate(conn, gate, markets, 5_000); // warm
    let t0 = process.hrtime.bigint();
    for (let k = 0; k < REFRESHES; k++) await refreshTakeoverGate(conn, gate, markets, 5_000 + k);
    refs.push(Number(process.hrtime.bigint() - t0) / 1e6 / REFRESHES);
    t0 = process.hrtime.bigint();
    for (let k = 0; k < HEALTHS; k++) gate.health(markets, 5_000 + k);
    hs.push(Number(process.hrtime.bigint() - t0) / 1e6 / HEALTHS);
  }
  return { refresh: median(refs), health: median(hs) };
}

for (const n of [100, 1000, 5000]) {
  const r = await bench(n);
  console.log(`${n} markets: refresh ${r.refresh.toFixed(4)} ms, health ${r.health.toFixed(4)} ms, sum ${(r.refresh + r.health).toFixed(4)} ms`);
}
