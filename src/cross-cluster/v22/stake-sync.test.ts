/**
 * stake-sync.ts (KEEPER_V22_STAKE_SYNC) branch coverage: skip, backoff, quiet, waiting, diverged, refused, failed, not-landed
 * and dry-run paths. Offline: fake conn only. Does not touch the job-failure alert code (open #251).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@percolatorct/sdk";
import { allJobCounters, resetJobCounters } from "./exec.ts";
import { DIVERGED_BACKOFF_COOLDOWNS, freshStakeSyncState, stakeSyncOnce } from "./stake-sync.ts";
import { customAt, execCtx, fakeExecConn, v22Ctx } from "./test-helpers.ts";
import type { ExecContext } from "./exec.ts";

beforeEach(() => resetJobCounters());

function poolBytes(o: { lastSync?: bigint; cooldown?: bigint; riskMode?: number; poolMode?: number } = {}): Uint8Array {
  const F = STAKE_POOL_FIELD_OFF_V5;
  const b = Buffer.alloc(STAKE_POOL_SIZE_V5);
  "SPOOL_V1".split("").forEach((c, i) => (b[F.reserved + i] = c.charCodeAt(0)));
  b[F.version] = 5;
  b[F.riskMode] = o.riskMode ?? 1;
  if (o.poolMode !== undefined) b[F.poolMode] = o.poolMode;
  b.writeBigUInt64LE(o.lastSync ?? 0n, F.lastSyncSlot);
  b.writeBigUInt64LE(o.cooldown ?? 150n, F.syncCooldownSlots);
  return new Uint8Array(b);
}
const P = { intervalMs: 0, nowMs: 1 };
const NOW = 5000n; // v22Ctx read slot

function logged(f: ReturnType<typeof fakeExecConn>, dry = false): { exec: ExecContext; lines: string[] } {
  const lines: string[] = [];
  return { exec: { ...execCtx(f.conn, dry), log: (l: string) => lines.push(l) }, lines };
}

describe("stake-sync: skips before any RPC", () => {
  it("no pool account -> skipped, zero RPC", async () => {
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), null, freshStakeSyncState(), P);
    assert.deepEqual(r, { kind: "skipped", reason: "no stake pool for this market" });
    assert.equal(f.sims.length, 0);
  });
  it("bytes that are not a v5 pool -> skipped with the decode reason (truncated to 80 chars)", async () => {
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), new Uint8Array(10), freshStakeSyncState(), P);
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") {
      assert.match(r.reason, /^pool is not a v5 pool \(/);
      assert.ok(r.reason.length <= "pool is not a v5 pool ()".length + 80);
    }
    assert.equal(f.sims.length, 0);
  });
  it("a non FIRST_LOSS risk mode is skipped (tag 31 would answer InvalidPoolMode)", async () => {
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ riskMode: 0 }), freshStakeSyncState(), P);
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.match(r.reason, /FIRST_LOSS insurance-mode only \(risk mode 0, pool mode 0\)/);
    assert.equal(f.sims.length, 0);
  });
  it("FIRST_LOSS but pool mode != 0 is skipped too", async () => {
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ poolMode: 1 }), freshStakeSyncState(), P);
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.match(r.reason, /pool mode 1/);
    assert.equal(f.sims.length, 0);
  });
  it("the wall-clock interval gate skips a second attempt inside the window, then allows it after", async () => {
    const f = fakeExecConn();
    const st = freshStakeSyncState();
    const a = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes(), st, { intervalMs: 1000, nowMs: 10_000 });
    assert.equal(a.kind, "sent");
    const b = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes(), st, { intervalMs: 1000, nowMs: 10_500 });
    assert.deepEqual(b, { kind: "skipped", reason: "interval" });
    assert.equal(f.sims.length, 1);
    const c = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes(), st, { intervalMs: 1000, nowMs: 11_000 });
    assert.equal(c.kind, "sent");
  });
  it("nowMs defaults to the wall clock (interval gate still records an attempt)", async () => {
    const f = fakeExecConn();
    const st = freshStakeSyncState();
    await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes(), st, { intervalMs: 60_000 });
    const [ms] = [...st.lastAttemptMs.values()];
    assert.ok(Math.abs(Date.now() - ms) < 5000);
  });
});

describe("stake-sync: local cooldown pre-check (37)", () => {
  it("inside last_sync + cooldown -> quiet 37, no simulation, no attempt recorded", async () => {
    const f = fakeExecConn();
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ lastSync: NOW - 10n, cooldown: 150n }), st, P);
    assert.deepEqual(r, { kind: "quiet", code: 37 });
    assert.equal(f.sims.length, 0);
    assert.equal(st.lastAttemptMs.size, 0);
  });
  it("exactly at last_sync + cooldown the keeper tries (boundary)", async () => {
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ lastSync: NOW - 150n, cooldown: 150n }), freshStakeSyncState(), P);
    assert.equal(r.kind, "sent");
  });
  it("last_sync 0 (never synced) never trips the pre-check even with a huge cooldown", async () => {
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ lastSync: 0n, cooldown: 1_000_000n }), freshStakeSyncState(), P);
    assert.equal(r.kind, "sent");
  });
});

describe("stake-sync: simulation refusals", () => {
  it("37 / 43 from the program are quiet and set no backoff", async () => {
    for (const code of [37, 43]) {
      const f = fakeExecConn({ simErr: () => customAt(0, code) });
      const st = freshStakeSyncState();
      const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes(), st, P);
      assert.deepEqual(r, { kind: "quiet", code });
      assert.equal(st.backoffUntil.size, 0, `code ${code}`);
      assert.equal(f.sent.length, 0);
    }
    assert.equal(allJobCounters()["stake-sync"].expected, 2);
  });
  it("21 EngineLockActive: waiting for one cooldown, logged as not-a-failure, no retry until then", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 21) });
    const { exec, lines } = logged(f);
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.equal(r.kind, "waiting");
    if (r.kind === "waiting") {
      assert.equal(r.code, 21);
      assert.equal(r.untilSlot, NOW + 150n);
    }
    assert.ok(lines.some((l) => l.includes("EngineLockActive(21)") && l.includes("not a failure")));
    assert.equal(st.diverged, 0);
    const again = await stakeSyncOnce(exec, v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.deepEqual(again, { kind: "backoff", untilSlot: NOW + 150n });
    assert.equal(f.sims.length, 1);
    assert.equal(allJobCounters()["stake-sync"].expected, 1);
  });
  it("44 diverged: counter bumps, backs off DIVERGED_BACKOFF_COOLDOWNS cooldowns; backoff lifts at the boundary slot", async () => {
    const f = fakeExecConn({ simErr: (_d, i) => (i === 0 ? customAt(0, 44) : null) });
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ cooldown: 100n }), st, P);
    assert.equal(r.kind, "diverged");
    assert.equal(st.diverged, 1);
    const until = NOW + 100n * DIVERGED_BACKOFF_COOLDOWNS;
    assert.equal(st.backoffUntil.values().next().value, until);
    const inside = await stakeSyncOnce(execCtx(f.conn), v22Ctx({ currentSlot: until - 1n }), poolBytes({ cooldown: 100n }), st, P);
    assert.equal(inside.kind, "backoff");
    const atEnd = await stakeSyncOnce(execCtx(f.conn), v22Ctx({ currentSlot: until }), poolBytes({ cooldown: 100n }), st, P);
    assert.equal(atEnd.kind, "sent");
  });
  it("another stake code (not quiet) is `refused`, named in the log, backed off one cooldown", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 40) });
    const { exec, lines } = logged(f);
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.equal(r.kind, "refused");
    assert.equal(st.backoffUntil.values().next().value, NOW + 150n);
    assert.ok(lines.some((l) => l.includes("refused") && l.includes("backing off one cooldown (150 slots)")));
    assert.equal(allJobCounters()["stake-sync"].refused, 1);
  });
  it("a refusal with no program code at all (null) is `refused`, backed off one cooldown", async () => {
    const f = fakeExecConn({ simErr: () => ({ InstructionError: [2, "InvalidAccountData"] }) });
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.equal(r.kind, "refused");
    if (r.kind === "refused") assert.equal(r.outcome.kind === "refused" && r.outcome.code, null);
    assert.equal(st.backoffUntil.values().next().value, NOW + 150n);
  });
});

describe("stake-sync: RPC errors, landing, dry-run", () => {
  it("a simulate RPC error is `failed`, logged, and sets NO backoff (retried next interval)", async () => {
    const f = fakeExecConn();
    (f.conn as unknown as { simulateTransaction: () => Promise<never> }).simulateTransaction = async () => {
      throw new Error("fetch failed");
    };
    const { exec, lines } = logged(f);
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes(), st, P);
    assert.equal(r.kind, "failed");
    assert.ok(lines.some((l) => l.includes("failed: fetch failed")));
    assert.equal(st.backoffUntil.size, 0);
    assert.equal(allJobCounters()["stake-sync"].failed, 1);
  });
  it("a send RPC error is `failed` as well", async () => {
    const f = fakeExecConn();
    (f.conn as unknown as { sendRawTransaction: () => Promise<never> }).sendRawTransaction = async () => {
      throw new Error("send blew up");
    };
    const r = await stakeSyncOnce(execCtx(f.conn), v22Ctx(), poolBytes(), freshStakeSyncState(), P);
    assert.equal(r.kind, "failed");
  });
  it("sent and landed: kind sent, no landed-failure log line", async () => {
    const f = fakeExecConn();
    const { exec, lines } = logged(f);
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes(), freshStakeSyncState(), P);
    assert.equal(r.kind, "sent");
    assert.equal(f.sent[0].tags[0], 31);
    assert.equal(lines.length, 0);
  });
  it("landed-failed 21 is waiting (like the simulated 21) and logs both the landing and the h-lock line", async () => {
    const f = fakeExecConn({ confirmFail: () => 21 });
    const { exec, lines } = logged(f);
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.equal(r.kind, "waiting");
    assert.ok(lines.some((l) => l.includes("landed but failed on chain (code 21)")));
    assert.ok(lines.some((l) => l.includes("EngineLockActive(21)")));
    assert.equal(st.backoffUntil.values().next().value, NOW + 150n);
  });
  it("landed-failed 37 / 43 is quiet; landed-failed unknown code is `failed` with a one-cooldown backoff", async () => {
    const q = fakeExecConn({ confirmFail: () => 43 });
    assert.deepEqual(await stakeSyncOnce(execCtx(q.conn), v22Ctx(), poolBytes(), freshStakeSyncState(), P), { kind: "quiet", code: 43 });
    const o = fakeExecConn({ confirmFail: () => 40 });
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(execCtx(o.conn), v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.equal(r.kind, "failed");
    assert.equal(st.backoffUntil.values().next().value, NOW + 150n);
  });
  it("landed-failed with no decodable code logs `code none` and is `failed`", async () => {
    const f = fakeExecConn();
    (f.conn as unknown as { getSignatureStatuses: () => Promise<unknown> }).getSignatureStatuses = async () => ({
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 1, err: "AccountNotFound", confirmationStatus: "confirmed" }],
    });
    const { exec, lines } = logged(f);
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes({ cooldown: 150n }), st, P);
    assert.equal(r.kind, "failed");
    assert.ok(lines.some((l) => l.includes("code none")));
    assert.equal(st.backoffUntil.values().next().value, NOW + 150n);
  });
  it("never seen landed (blockhash expired): `failed`, logged `not landed`, no backoff", async () => {
    const f = fakeExecConn();
    (f.conn as unknown as { getSignatureStatuses: () => Promise<unknown> }).getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [null] });
    (f.conn as unknown as { getBlockHeight: () => Promise<number> }).getBlockHeight = async () => 2_000_000;
    const { exec, lines } = logged(f);
    const st = freshStakeSyncState();
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes(), st, P);
    assert.equal(r.kind, "failed");
    assert.ok(lines.some((l) => l.includes("not landed")));
    assert.equal(st.backoffUntil.size, 0);
    assert.equal(allJobCounters()["stake-sync"].notLanded, 1);
  });
  it("dry-run: simulated, never sent, kind dry-run", async () => {
    const f = fakeExecConn();
    const { exec } = logged(f, true);
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes(), freshStakeSyncState(), P);
    assert.equal(r.kind, "dry-run");
    assert.equal(f.sims.length, 1);
    assert.equal(f.sent.length, 0);
  });
  it("a missing exec.log is tolerated on every logging path", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 21) });
    const exec: ExecContext = { ...execCtx(f.conn), log: undefined };
    const r = await stakeSyncOnce(exec, v22Ctx(), poolBytes(), freshStakeSyncState(), P);
    assert.equal(r.kind, "waiting");
  });
});
