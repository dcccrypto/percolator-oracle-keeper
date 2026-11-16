import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, deriveStakePool } from "@percolatorct/sdk";
import { resetJobCounters } from "./exec.ts";
import { COMMIT_TARGET_BACKOFF_SLOTS, freshStakeCommitTargetState, stakeCommitTargetOnce } from "./stake-commit-target.ts";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { Keypair } from "@solana/web3.js";
import { customAt, execCtx, fakeExecConn, v22Ctx } from "./test-helpers.ts";

beforeEach(() => resetJobCounters());

function pendingPool(pendingSlot: bigint, cooldown = 150n): Uint8Array {
  const F = STAKE_POOL_FIELD_OFF_V5;
  const b = Buffer.alloc(STAKE_POOL_SIZE_V5);
  "SPOOL_V1".split("").forEach((c, i) => (b[F.reserved + i] = c.charCodeAt(0)));
  b[F.version] = 5;
  b[F.riskMode] = 1;
  b.writeBigUInt64LE(cooldown, 184);
  b.writeBigUInt64LE(4000n, F.pendingTargetBps);
  b.writeBigUInt64LE(pendingSlot, F.pendingTargetSlot);
  return new Uint8Array(b);
}

describe("stakeCommitTargetOnce edge branches", () => {
  const late = () => v22Ctx({ currentSlot: 400_000n });

  it("no pool account -> skipped, nothing simulated", async () => {
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late(), null, freshStakeCommitTargetState());
    assert.deepEqual(r, { kind: "skipped", reason: "no stake pool for this market" });
    assert.equal(f.sims.length, 0);
  });

  it("undecodable pool bytes -> skipped with a truncated reason", async () => {
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late(), new Uint8Array(4), freshStakeCommitTargetState());
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") {
      assert.match(r.reason, /^pool is not a v5 pool \(/);
      assert.ok(r.reason.length <= "pool is not a v5 pool ()".length + 80);
    }
    assert.equal(f.sims.length, 0);
  });

  it("a custom stakeProgramId derives the pool and selects the pool PDA in the instruction accounts", async () => {
    const other = Keypair.generate().publicKey;
    const ctx = late();
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), ctx, pendingPool(100_000n), freshStakeCommitTargetState(), { stakeProgramId: other });
    assert.equal(r.kind, "sent");
    const poolOther = deriveStakePool(ctx.market, other)[0].toBase58();
    const poolDefault = deriveStakePool(ctx.market, STAKE_PROGRAM_ID)[0].toBase58();
    assert.notEqual(poolOther, poolDefault);
    assert.ok(f.sent[0].keys[0].includes(poolOther));
    assert.ok(!f.sent[0].keys[0].includes(poolDefault));
  });

  it("backoff expires: refused at slot S backs off to S+150, then retries at S+150", async () => {
    const st = freshStakeCommitTargetState();
    const g = fakeExecConn({ simErr: () => customAt(0, 38) });
    const at = (n: bigint) => v22Ctx({ currentSlot: n });
    assert.equal((await stakeCommitTargetOnce(execCtx(g.conn), at(400_000n), pendingPool(100_000n), st)).kind, "refused");
    assert.equal((await stakeCommitTargetOnce(execCtx(g.conn), at(400_000n + COMMIT_TARGET_BACKOFF_SLOTS - 1n), pendingPool(100_000n), st)).kind, "backoff");
    assert.equal((await stakeCommitTargetOnce(execCtx(g.conn), at(400_000n + COMMIT_TARGET_BACKOFF_SLOTS), pendingPool(100_000n), st)).kind, "refused");
    assert.equal(g.sims.length, 2);
  });

  it("a thrown RPC error is 'failed', backed off, never counted as committed", async () => {
    const f = fakeExecConn();
    const conn = { ...f.conn, simulateTransaction: async () => { throw new Error("rpc exploded"); } } as unknown as typeof f.conn;
    const st = freshStakeCommitTargetState();
    const r = await stakeCommitTargetOnce(execCtx(conn), late(), pendingPool(100_000n), st);
    assert.equal(r.kind, "failed");
    assert.equal(st.committed, 0);
    assert.equal(st.backoffUntil.size, 1);
    assert.equal((await stakeCommitTargetOnce(execCtx(conn), late(), pendingPool(100_000n), st)).kind, "backoff");
    assert.equal(f.sent.length, 0);
  });
});
