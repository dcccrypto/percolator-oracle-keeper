// node --import tsx/esm scripts/bench-close-scan.ts
// Median of 5 runs: one snapshot build over N synthetic portfolios + a lookup for each of 50 markets.
import { Keypair, PublicKey } from "@solana/web3.js";
import { CLOSE_LAYOUT_V21, CLOSE_PROGRESS_LEN, makeSharedCloseScan } from "../src/cross-cluster/bankrupt-close-watch.ts";
import { makeLegacySharedCloseScan } from "../src/cross-cluster/bankrupt-close-watch-legacy.fixture.ts";

const L = CLOSE_LAYOUT_V21;
const sliceLen = L.closeOff + CLOSE_PROGRESS_LEN - 16;
const markets = Array.from({ length: 50 }, () => Keypair.generate().publicKey);
function accounts(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const data = Buffer.alloc(sliceLen, (i * 7) & 0xff);
    markets[i % 50].toBuffer().copy(data, 0);
    return { pubkey: Keypair.generate().publicKey, account: { data } };
  });
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function run(make: typeof makeSharedCloseScan, accs: ReturnType<typeof accounts>) {
  const conn = { getProgramAccounts: async () => accs } as never;
  const s = make(90_000, () => 0);
  const t = performance.now();
  for (const m of markets) await s.forMarket(conn, markets[0], m, L);
  return performance.now() - t;
}
for (const n of [5000, 20000]) {
  const accs = accounts(n);
  for (const [name, mk] of [["legacy", makeLegacySharedCloseScan], ["new", makeSharedCloseScan]] as const) {
    await run(mk as never, accs); // warmup
    const ts: number[] = [];
    for (let i = 0; i < 5; i++) ts.push(await run(mk as never, accs));
    console.log(`${n} portfolios ${name}: median ${median(ts).toFixed(2)} ms`);
  }
}
