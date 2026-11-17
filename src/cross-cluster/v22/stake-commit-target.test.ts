/**
 * stake-commit-target.ts: every branch.
 *
 * Lead 1 (the decode catch): it only sees bytes the caller already fetched, so it can never swallow an RPC error; a bad pool is
 * "skipped" (no simulation, no send, no backoff entry). A transient send/RPC failure is "failed" + backoff, never a definite
 * "no target".
 * Lead 2 (input checks): there are none on numbers beyond bigint compares; readSlot is a number converted with BigInt().
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
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
const late = () => v22Ctx({ currentSlot: 400_000n });

describe("stakeCommitTargetOnce branches", () => {
  it("constants", () => {
    assert.equal(STAKE_NO_PENDING_DEPLOY_TARGET, 40);
    assert.equal(STAKE_COMMIT_TARGET_UNITS, 60_000);
    assert.equal(COMMIT_TARGET_BACKOFF_SLOTS, 150n);
  });
  it("commitDueSlot: cooldown below, equal to and above the 216,000 floor", () => {
    assert.equal(commitDueSlot({ pendingTargetSlot: 10n, cooldownSlots: 0n }), 216_010n);
    assert.equal(commitDueSlot({ pendingTargetSlot: 10n, cooldownSlots: 216_000n }), 216_010n);
    assert.equal(commitDueSlot({ pendingTargetSlot: 10n, cooldownSlots: 216_001n }), 216_011n);
  });
  it("buildStakeCommitTargetIx: tag 33 against the given program", () => {
    const ix = buildStakeCommitTargetIx({ caller: key(1), pool: key(2), stakeProgramId: key(3) });
    assert.equal(ix.data[0], 33);
    assert.ok(ix.programId.equals(key(3)));
    assert.ok(ix.keys.some((k) => k.pubkey.equals(key(2)) && k.isWritable));
  });
  it("null pool data -> skipped (the caller passes null for a missing account), nothing simulated", async () => {
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late(), null, freshStakeCommitTargetState());
    assert.deepEqual(r, { kind: "skipped", reason: "no stake pool for this market" });
    assert.equal(f.sims.length, 0);
  });
  it("LEAD 1: undecodable bytes -> skipped with the reason; no simulation, no send, no backoff set (not a definite answer to act on)", async () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(10), new Uint8Array(STAKE_POOL_SIZE_V5)]) {
      const f = fakeExecConn();
      const st = freshStakeCommitTargetState();
      const r = await stakeCommitTargetOnce(execCtx(f.conn), late(), bad, st);
      assert.equal(r.kind, "skipped");
      if (r.kind === "skipped") assert.match(r.reason, /^pool is not a v5 pool \(/);
      assert.equal(f.sims.length, 0);
      assert.equal(f.sent.length, 0);
      assert.equal(st.backoffUntil.size, 0);
    }
    // a non-Error throw path is covered by String(e); a long message is cut to 80 chars
    const r = await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), late(), new Uint8Array(3), freshStakeCommitTargetState());
    if (r.kind === "skipped") assert.ok(r.reason.length <= "pool is not a v5 pool ()".length + 80);
  });
  it("the same pool becomes actionable on the next tick once good bytes arrive (a bad read does not stick)", async () => {
    const st = freshStakeCommitTargetState();
    const f = fakeExecConn();
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), late(), new Uint8Array(5), st)).kind, "skipped");
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), late(), pool(100_000n), st)).kind, "sent");
  });
  it("pendingTargetSlot 0 -> skipped no pending", async () => {
    const r = await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), late(), pool(0n), freshStakeCommitTargetState());
    assert.deepEqual(r, { kind: "skipped", reason: "no pending deploy target" });
  });
  it("waiting, then sent at the due slot; committed counter bumps only on sent", async () => {
    const st = freshStakeCommitTargetState();
    const w = await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), v22Ctx({ currentSlot: 5000n }), pool(4000n), st);
    assert.deepEqual(w, { kind: "waiting", dueSlot: 220_000n });
    assert.equal(st.committed, 0);
    const s = await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), late(), pool(100_000n), st);
    assert.equal(s.kind, "sent");
    assert.equal(st.committed, 1);
    const [poolKey] = deriveStakePool(late().market, STAKE_PROGRAM_ID);
    assert.ok(poolKey instanceof PublicKey);
  });
  it("dry-run -> dry-run, committed unchanged", async () => {
    const st = freshStakeCommitTargetState();
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn, true), late(), pool(100_000n), st);
    assert.equal(r.kind, "dry-run");
    assert.equal(st.committed, 0);
    assert.equal(f.sent.length, 0);
  });
  it("40 -> quiet + backoff; backoff holds until the due slot then retries (boundary)", async () => {
    const st = freshStakeCommitTargetState();
    const f = fakeExecConn({ simErr: () => customAt(0, 40) });
    const c = late(); // readSlot 400000
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), c, pool(100_000n), st)).kind, "quiet");
    const [k] = deriveStakePool(c.market, STAKE_PROGRAM_ID);
    assert.equal(st.backoffUntil.get(k.toBase58()), 400_000n + COMMIT_TARGET_BACKOFF_SLOTS);
    const held = v22Ctx({ currentSlot: 400_000n + COMMIT_TARGET_BACKOFF_SLOTS - 1n });
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), held, pool(100_000n), st)).kind, "backoff");
    const open = v22Ctx({ currentSlot: 400_000n + COMMIT_TARGET_BACKOFF_SLOTS });
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), open, pool(100_000n), st)).kind, "quiet");
    assert.equal(f.sims.length, 2);
  });
  it("other code -> refused + backoff", async () => {
    const st = freshStakeCommitTargetState();
    const f = fakeExecConn({ simErr: () => customAt(0, 38) });
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late(), pool(100_000n), st);
    assert.equal(r.kind, "refused");
    assert.equal(st.backoffUntil.size, 1);
    assert.equal(f.sent.length, 0);
  });
  it("LEAD 1 (transient RPC error): a throwing RPC during the send is 'failed' + backoff, never 'no target'/'quiet'", async () => {
    const st = freshStakeCommitTargetState();
    const f = fakeExecConn();
    const conn = { ...f.conn, getLatestBlockhash: async () => { throw new Error("fetch failed 503"); } } as typeof f.conn;
    const r = await stakeCommitTargetOnce(execCtx(conn), late(), pool(100_000n), st);
    assert.equal(r.kind, "failed");
    assert.equal(st.backoffUntil.size, 1);
    assert.equal(st.committed, 0);
  });
  it("LEAD 2: readSlot non-integer/NaN throws RangeError out of BigInt() (typed number from getSlot; documented, not reachable from RPC)", async () => {
    const bad = { ...late(), readSlot: NaN };
    await assert.rejects(stakeCommitTargetOnce(execCtx(fakeExecConn().conn), bad, pool(100_000n), freshStakeCommitTargetState()), RangeError);
    // a negative slot is a valid BigInt and simply reads as "waiting"
    const neg = { ...late(), readSlot: -1 };
    assert.equal((await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), neg, pool(100_000n), freshStakeCommitTargetState())).kind, "waiting");
  });
  it("honours an explicit stakeProgramId", async () => {
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), late(), pool(100_000n), freshStakeCommitTargetState(), { stakeProgramId: key(9) });
    assert.equal(r.kind, "sent");
  });
});
