/**
 * stake-commit-target.ts: every branch of the CommitDeployTarget job, driven with real-shaped v5 stake pool bytes
 * (SDK layout offsets) and the fake exec connection. No RPC.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, deriveStakePool } from "@percolatorct/sdk";
import {
  COMMIT_TARGET_BACKOFF_SLOTS,
  STAKE_COMMIT_TARGET_UNITS,
  STAKE_NO_PENDING_DEPLOY_TARGET,
  buildStakeCommitTargetIx,
  commitDueSlot,
  freshStakeCommitTargetState,
  stakeCommitTargetOnce,
} from "./stake-commit-target.ts";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { customAt, execCtx, fakeExecConn, key, v22Ctx } from "./test-helpers.ts";

function pool(pendingSlot: bigint, cooldown = 150n): Uint8Array {
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

describe("stake-commit-target", () => {
  it("fresh state is empty", () => {
    const st = freshStakeCommitTargetState();
    assert.equal(st.committed, 0);
    assert.equal(st.backoffUntil.size, 0);
    assert.notEqual(freshStakeCommitTargetState().backoffUntil, st.backoffUntil, "each call gets its own map");
  });

  it("commitDueSlot: the timelock floor wins at/below 216,000, the cooldown above it", () => {
    assert.equal(commitDueSlot({ pendingTargetSlot: 10n, cooldownSlots: 0n }), 216_010n);
    assert.equal(commitDueSlot({ pendingTargetSlot: 10n, cooldownSlots: 216_000n }), 216_010n, "equal: either side");
    assert.equal(commitDueSlot({ pendingTargetSlot: 10n, cooldownSlots: 216_001n }), 216_011n);
  });

  it("buildStakeCommitTargetIx: tag 33, [anyone signer, pool writable, clock], on the given program", () => {
    const caller = Keypair.generate().publicKey;
    const poolKey = key(9);
    const prog = key(77);
    const ix = buildStakeCommitTargetIx({ caller, pool: poolKey, stakeProgramId: prog });
    assert.ok(ix.programId.equals(prog));
    assert.equal(ix.data[0], 33);
    assert.equal(ix.keys.length, 3);
    assert.ok(ix.keys[0].pubkey.equals(caller) && ix.keys[0].isSigner);
    assert.ok(ix.keys[1].pubkey.equals(poolKey) && ix.keys[1].isWritable && !ix.keys[1].isSigner);
    assert.ok(!ix.keys[2].isWritable && !ix.keys[2].isSigner, "clock is read-only");
  });

  it("no pool account -> skipped, nothing simulated", async () => {
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), v22Ctx(), null, freshStakeCommitTargetState());
    assert.deepEqual(r, { kind: "skipped", reason: "no stake pool for this market" });
    assert.equal(f.sims.length, 0);
  });

  it("bytes that are not a v5 pool -> skipped with the decode reason (bounded to 80 chars), nothing simulated", async () => {
    const f = fakeExecConn();
    for (const bad of [new Uint8Array(0), new Uint8Array(10), new Uint8Array(STAKE_POOL_SIZE_V5)]) {
      const r = await stakeCommitTargetOnce(execCtx(f.conn), v22Ctx({ currentSlot: 400_000n }), bad, freshStakeCommitTargetState());
      assert.equal(r.kind, "skipped");
      if (r.kind === "skipped") {
        assert.match(r.reason, /^pool is not a v5 pool \(/);
        assert.ok(r.reason.length <= "pool is not a v5 pool ()".length + 80);
      }
    }
    assert.equal(f.sims.length, 0);
    assert.equal(f.sent.length, 0);
  });

  it("a custom stake program id is used for both the pool derivation and the instruction", async () => {
    const prog = key(55);
    const late = v22Ctx({ currentSlot: 400_000n });
    const f = fakeExecConn();
    const st = freshStakeCommitTargetState();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late, pool(100_000n), st, { stakeProgramId: prog });
    assert.equal(r.kind, "sent");
    const [customPool] = deriveStakePool(late.market, prog);
    const [defaultPool] = deriveStakePool(late.market, STAKE_PROGRAM_ID);
    assert.notEqual(customPool.toBase58(), defaultPool.toBase58());
    assert.equal(f.sent[0].keys[0][1], customPool.toBase58());
    assert.equal(st.committed, 1);
  });

  it("the default stake program id is used when none is passed", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const f = fakeExecConn();
    await stakeCommitTargetOnce(execCtx(f.conn), late, pool(100_000n), freshStakeCommitTargetState());
    const [defaultPool] = deriveStakePool(late.market, STAKE_PROGRAM_ID);
    assert.equal(f.sent[0].keys[0][1], defaultPool.toBase58());
  });

  it("a high cooldown extends the wait beyond the 216,000 floor", async () => {
    const f = fakeExecConn();
    const now = 100_000n + 216_000n + 5n; // past the floor, inside a 300,000 cooldown
    const r = await stakeCommitTargetOnce(execCtx(f.conn), v22Ctx({ currentSlot: now }), pool(100_000n, 300_000n), freshStakeCommitTargetState());
    assert.deepEqual(r, { kind: "waiting", dueSlot: 400_000n });
    assert.equal(f.sims.length, 0);
  });

  it("backoff blocks until its slot, then the pool is tried again (boundary: now == until retries)", async () => {
    const st = freshStakeCommitTargetState();
    const g = fakeExecConn({ simErr: () => customAt(0, 38) });
    const t0 = 400_000n;
    const r0 = await stakeCommitTargetOnce(execCtx(g.conn), v22Ctx({ currentSlot: t0 }), pool(100_000n), st);
    assert.equal(r0.kind, "refused");
    const until = t0 + COMMIT_TARGET_BACKOFF_SLOTS;
    assert.deepEqual([...st.backoffUntil.values()], [until]);
    const mid = await stakeCommitTargetOnce(execCtx(g.conn), v22Ctx({ currentSlot: until - 1n }), pool(100_000n), st);
    assert.deepEqual(mid, { kind: "backoff", untilSlot: until });
    assert.equal(g.sims.length, 1);
    const f = fakeExecConn();
    const again = await stakeCommitTargetOnce(execCtx(f.conn), v22Ctx({ currentSlot: until }), pool(100_000n), st);
    assert.equal(again.kind, "sent");
  });

  it("backoff does not apply to another pool (keyed per pool)", async () => {
    const st = freshStakeCommitTargetState();
    st.backoffUntil.set(key(1).toBase58(), 10n ** 12n);
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), v22Ctx({ currentSlot: 400_000n }), pool(100_000n), st);
    assert.equal(r.kind, "sent");
  });

  it("nothing pending is skipped before the backoff or the timelock is consulted", async () => {
    const st = freshStakeCommitTargetState();
    const late = v22Ctx({ currentSlot: 400_000n });
    const [p] = deriveStakePool(late.market, STAKE_PROGRAM_ID);
    st.backoffUntil.set(p.toBase58(), 10n ** 12n);
    const r = await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), late, pool(0n), st);
    assert.deepEqual(r, { kind: "skipped", reason: "no pending deploy target" });
  });

  it("an RPC error while sending -> failed, backed off, committed not bumped", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const f = fakeExecConn();
    (f.conn as unknown as { sendRawTransaction: () => Promise<string> }).sendRawTransaction = async () => {
      throw new Error("rpc down");
    };
    const st = freshStakeCommitTargetState();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late, pool(100_000n), st);
    assert.equal(r.kind, "failed");
    assert.equal(st.committed, 0);
    assert.equal([...st.backoffUntil.values()][0], 400_000n + COMMIT_TARGET_BACKOFF_SLOTS);
    const next = await stakeCommitTargetOnce(execCtx(f.conn), late, pool(100_000n), st);
    assert.equal(next.kind, "backoff");
  });

  it("refused with a non-40 code returns the outcome and counts no commit; 40 is quiet with the code", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const g = fakeExecConn({ simErr: () => customAt(0, 38) });
    const st = freshStakeCommitTargetState();
    const r = await stakeCommitTargetOnce(execCtx(g.conn), late, pool(100_000n), st);
    assert.equal(r.kind, "refused");
    if (r.kind === "refused") assert.equal(r.outcome.kind, "refused");
    assert.equal(st.committed, 0);
    const q = fakeExecConn({ simErr: () => customAt(0, STAKE_NO_PENDING_DEPLOY_TARGET) });
    const qst = freshStakeCommitTargetState();
    const rq = await stakeCommitTargetOnce(execCtx(q.conn), late, pool(100_000n), qst);
    assert.deepEqual(rq, { kind: "quiet", code: 40 });
    assert.equal([...qst.backoffUntil.values()][0], 400_000n + COMMIT_TARGET_BACKOFF_SLOTS);
    assert.equal(q.sent.length, 0);
  });

  it("sent uses the commit CU limit; dry-run commits nothing and sets no backoff", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const f = fakeExecConn();
    const st = freshStakeCommitTargetState();
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), late, pool(100_000n), st)).kind, "sent");
    assert.equal(f.simUnits[0], STAKE_COMMIT_TARGET_UNITS);
    const d = fakeExecConn();
    const dst = freshStakeCommitTargetState();
    const r = await stakeCommitTargetOnce(execCtx(d.conn, true), late, pool(100_000n), dst);
    assert.equal(r.kind, "dry-run");
    assert.equal(dst.committed, 0);
    assert.equal(dst.backoffUntil.size, 0);
    assert.equal(d.sent.length, 0);
  });
});
