/**
 * End-to-end with the switch ON: KEEPER_DEVNET_V21=1 alone moves every builder
 * to the v2.1 wrapper and the stake config to the v2.1 stake program.
 * (node --test runs each file in its own process, so this env is isolated.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";

process.env.KEEPER_DEVNET_V21 = "1";
delete process.env.WRAPPER_PROGRAM_ID;
delete process.env.PROGRAM_ID;
delete process.env.STAKE_PROGRAM_ID;
delete process.env.MATCHER_PROGRAM_ID;
delete process.env.NFT_PROGRAM_ID;

describe("KEEPER_DEVNET_V21=1 reaches every builder", () => {
  it("auth-mark-pusher, recovery-cranker, positioned-refresh, liveness-repair, stake-fee", async () => {
    const ids = await import("./program-ids.ts");
    const pusher = await import("./cross-cluster/auth-mark-pusher.ts");
    const cranker = await import("./cross-cluster/recovery-cranker.ts");
    const refresh = await import("./cross-cluster/positioned-refresh.ts");
    const repair = await import("./cross-cluster/liveness-repair.ts");
    const stake = await import("./cross-cluster/stake-fee-pusher.ts");
    const W = "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe";
    const k = Keypair.generate().publicKey;
    assert.equal(ids.PROGRAM_IDS_RESOLVED.programSet, "v21");
    assert.equal(ids.MATCHER_PROGRAM_ID.toBase58(), "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam");
    assert.equal(ids.NFT_PROGRAM_ID.toBase58(), "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs");
    assert.equal(pusher.WRAPPER_PROGRAM_ID.toBase58(), W, "register-poll expectedOwner is this export");
    assert.equal(cranker.buildCrankIx(k, k, k).programId.toBase58(), W);
    assert.equal(refresh.buildRefreshCrankIx(k, k, k).programId.toBase58(), W);
    assert.equal(repair.buildExpireBackingBucketIx(k, 0).programId.toBase58(), W);
    const cfg = stake.stakeFeeConfigFromEnv({});
    assert.equal(cfg.wrapperProgramId.toBase58(), W);
    assert.equal(cfg.stakeProgramId.toBase58(), "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE");
  });
});
