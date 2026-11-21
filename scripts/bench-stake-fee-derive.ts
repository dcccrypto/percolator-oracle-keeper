/**
 * Micro-bench of the stake-fee-pusher derivation call sites only (pool PDA in pushStakeFeesOnce and the vault
 * accounts in buildWithdrawInsuranceReserveToStake). 50 markets x 5 cycles, median of 3 runs.
 *   node --import tsx/esm scripts/bench-stake-fee-derive.ts
 */
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { derivePoolPda, deriveVaultAccounts } from "../src/cross-cluster/stake-fee-pusher.ts";

const W = Keypair.generate().publicKey;
const S = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const markets = Array.from({ length: 50 }, () => Keypair.generate().publicKey);
const h = createHash("sha256");
const runs: number[] = [];
for (let r = 0; r < 3; r++) {
  const t = process.hrtime.bigint();
  for (let c = 0; c < 5; c++) {
    for (const m of markets) {
      const p = derivePoolPda(m, S);
      const v = deriveVaultAccounts(W, m, MINT);
      if (r === 0 && c === 0) h.update(p.toBase58() + v.vaultToken.toBase58() + v.vaultAuthority.toBase58() + v.tokenProgram.toBase58());
    }
  }
  runs.push(Number(process.hrtime.bigint() - t) / 1e6);
}
runs.sort((a, b) => a - b);
console.log(JSON.stringify({ medianMs: runs[1], runs, sha: h.digest("hex").slice(0, 16) }));
