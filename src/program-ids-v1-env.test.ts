/**
 * End-to-end with the switch OFF (today's relaunch keeper): no program env at
 * all still resolves every builder to ETDLAdi / VmpVUArR, whatever the SDK's
 * own defaults become after the 9.0.0 re-pin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";

for (const k of ["KEEPER_DEVNET_V21", "WRAPPER_PROGRAM_ID", "PROGRAM_ID", "STAKE_PROGRAM_ID", "MATCHER_PROGRAM_ID", "NFT_PROGRAM_ID"]) delete process.env[k];

describe("KEEPER_DEVNET_V21 off reaches every builder as ETDLAdi", () => {
  it("auth-mark-pusher, recovery-cranker, positioned-refresh, liveness-repair, stake-fee", async () => {
    const ids = await import("./program-ids.ts");
    const pusher = await import("./cross-cluster/auth-mark-pusher.ts");
    const cranker = await import("./cross-cluster/recovery-cranker.ts");
    const refresh = await import("./cross-cluster/positioned-refresh.ts");
    const repair = await import("./cross-cluster/liveness-repair.ts");
    const stake = await import("./cross-cluster/stake-fee-pusher.ts");
    const W = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
    const k = Keypair.generate().publicKey;
    assert.equal(ids.PROGRAM_IDS_RESOLVED.programSet, "v1");
    assert.equal(pusher.WRAPPER_PROGRAM_ID.toBase58(), W, "register-poll expectedOwner is this export");
    assert.equal(cranker.buildCrankIx(k, k, k).programId.toBase58(), W);
    assert.equal(refresh.buildRefreshCrankIx(k, k, k).programId.toBase58(), W);
    assert.equal(repair.buildExpireBackingBucketIx(k, 0).programId.toBase58(), W);
    const cfg = stake.stakeFeeConfigFromEnv({});
    assert.equal(cfg.wrapperProgramId.toBase58(), W);
    assert.equal(cfg.stakeProgramId.toBase58(), "VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w");
  });
});
