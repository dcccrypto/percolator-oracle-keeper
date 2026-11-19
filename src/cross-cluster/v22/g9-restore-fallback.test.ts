import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideG9, freshG9State, g9Once } from "./g9.ts";
import { execCtx, fakeExecConn, v22Ctx } from "./test-helpers.ts";
import { PublicKey } from "@solana/web3.js";

function unitsWithReceivable(market: PublicKey): Uint8Array {
  const b = Buffer.alloc(16 + 192);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(19, 8);
  b[10] = 13;
  Buffer.from(market.toBytes()).copy(b, 16);
  b[16 + 136] = 1;
  b.writeBigUInt64LE(10n, 16 + 80); // backstopReceivableAtoms
  return new Uint8Array(b);
}
const args = { allowAnyOracleMode: false, mainnetBuild: false, drawCapAtoms: 7n, dryRun: false };

/** make the n-th simulateTransaction call throw (an RPC error -> ExecOutcome {kind:'failed'}) */
function throwOnSims(f: ReturnType<typeof fakeExecConn>, bad: (i: number) => boolean) {
  const orig = f.conn.simulateTransaction.bind(f.conn);
  let i = 0;
  (f.conn as any).simulateTransaction = async (...a: any[]) => {
    if (bad(i++)) throw new Error("RPC 503");
    return (orig as any)(...a);
  };
}

describe("g9 restore: a transport-failed mode 3 must not strand the repayment for 1,500 slots", () => {
  it("mode 3 RPC-fails, mode 1 would succeed: mode 1 is tried and sent in the same sweep", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn();
    throwOnSims(f, (i) => i === 0);
    const r = await g9Once(execCtx(f.conn), ctx, unitsWithReceivable(ctx.market), freshG9State(), args);
    assert.equal(r.action.kind, "restore");
    assert.equal(r.outcome?.kind, "sent");
    assert.equal(f.sentData[0][0][1], 1, "fell through to mode 1 (RESTORE)");
  });
  it("both modes transport-fail: the restore is not stamped, so the next sweep retries instead of waiting 1,500 slots", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn();
    throwOnSims(f, () => true);
    const st = freshG9State();
    const acct = unitsWithReceivable(ctx.market);
    const r = await g9Once(execCtx(f.conn), ctx, acct, st, args);
    assert.equal(r.outcome?.kind, "failed");
    const units = { g9PendingSlot: 0n, backstopReceivableAtoms: 10n };
    assert.equal(decideG9(ctx, units, BigInt(ctx.readSlot) + 1n, false, st).kind, "restore");
  });
});
