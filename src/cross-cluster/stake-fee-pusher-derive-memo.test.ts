/** Memoised PDA derivation in stake-fee-pusher is byte-identical to the raw SDK derivation (200 random markets). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { deriveMarketVaultAccounts, deriveStakePool } from "@percolatorct/sdk";
import { buildWithdrawInsuranceReserveToStakeIx, derivePoolPda, deriveVaultAccounts } from "./stake-fee-pusher.ts";

describe("stake-fee-pusher derive memo", () => {
  it("200 random markets: pool PDA, vault accounts and ix keys equal the uncached derivation (cold and warm)", () => {
    const W = Keypair.generate().publicKey;
    const S = Keypair.generate().publicKey;
    const MINT = Keypair.generate().publicKey;
    const cranker = Keypair.generate().publicKey;
    for (let pass = 0; pass < 2; pass++) {
      const rnd = Array.from({ length: 200 }, () => Keypair.generate().publicKey);
      for (let pass2 = 0; pass2 < 2; pass2++) {
        for (const m of rnd) {
          assert.ok(derivePoolPda(m, S).equals(deriveStakePool(m, S)[0]));
          const a = deriveVaultAccounts(W, m, MINT);
          const b = deriveMarketVaultAccounts(W, m, MINT);
          assert.ok(a.vaultToken.equals(b.vaultToken) && a.vaultAuthority.equals(b.vaultAuthority) && a.tokenProgram.equals(b.tokenProgram));
          const stakePool = deriveStakePool(m, S)[0];
          const stakeVault = Keypair.generate().publicKey;
          const ix = buildWithdrawInsuranceReserveToStakeIx({ wrapperProgramId: W, cranker, market: m, stakePool, stakeVault, collateralMint: MINT });
          const keys = ix.keys.map((k) => k.pubkey.toBase58());
          for (const x of [m, stakePool, stakeVault, b.vaultToken, b.vaultAuthority, b.tokenProgram]) assert.ok(keys.includes(x.toBase58()));
        }
      }
    }
  });
  it("different stake program / mint / wrapper for the same market do not collide", () => {
    const m = Keypair.generate().publicKey;
    const s1 = Keypair.generate().publicKey, s2 = Keypair.generate().publicKey;
    assert.ok(!derivePoolPda(m, s1).equals(derivePoolPda(m, s2)));
    assert.ok(derivePoolPda(m, s2).equals(deriveStakePool(m, s2)[0]));
  });
});
