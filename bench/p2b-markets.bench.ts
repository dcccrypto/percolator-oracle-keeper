// Bench: readVaultMarketSnapshots parse loop (stubbed RPC) and readU64/readU128.
// Run: node --import tsx/esm bench/p2b-markets.bench.ts
import { Keypair, PublicKey } from "@solana/web3.js";
import { readVaultMarketSnapshots, readU64, readU128 } from "../src/cross-cluster/p2b-markets.ts";

const programId = Keypair.generate().publicKey;
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
function acct(len: number, fill: number) {
  const d = Buffer.alloc(len, fill);
  return { data: d, lamports: 1, owner: programId, executable: false };
}
function stub(): any {
  return {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({
      context: { slot: 1 },
      value: keys.map((_, i) => acct([4096, 512, 512][i % 3], i % 251)),
    }),
  };
}
async function main() {
  for (const n of [10, 100, 1000]) {
    const refs = Array.from({ length: n }, (_, i) => ({ marketAddress: Keypair.generate().publicKey.toBase58(), label: `m${i}`, assetIndex: 0 }));
    await readVaultMarketSnapshots(stub(), programId, refs.slice(0, 5)); // warm
    const t: number[] = [];
    for (let r = 0; r < 5; r++) {
      const s = performance.now();
      await readVaultMarketSnapshots(stub(), programId, refs);
      t.push(performance.now() - s);
    }
    console.log(`readVaultMarketSnapshots N=${n}: median ${med(t).toFixed(3)} ms`);
  }
  for (const n of [10, 100, 1000]) {
    const bufs = Array.from({ length: n }, () => new Uint8Array(Buffer.alloc(4096, 7)));
    const t: number[] = [];
    let sink = 0n;
    for (let r = 0; r < 5; r++) {
      const s = performance.now();
      for (const b of bufs) for (let o = 0; o < 64; o += 16) sink ^= readU128(b, o) ^ readU64(b, o + 8);
      t.push(performance.now() - s);
    }
    console.log(`readU64/U128 x${n} bufs x4: median ${med(t).toFixed(3)} ms (sink ${sink & 1n})`);
  }
}
main();
