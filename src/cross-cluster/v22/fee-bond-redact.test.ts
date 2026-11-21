import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crankBondFee } from "./fee-bond.ts";
import type { V22Positioned } from "./positioned.ts";
import { execCtx, fakeExecConn, pf, v22Ctx } from "./test-helpers.ts";

const LEAK = "fetch failed https://x.helius-rpc.com/?api-key=SECRET";
const positioned = (cs: ReturnType<typeof pf>[]): V22Positioned => ({ all: cs, counterparties: cs, lp: pf(901, 2, { lp: true }), minLegAbs: new Map(), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 });

describe("crankBondFee: a thrown RPC error is redacted before it is returned", () => {
  it("a throw out of the run (outer catch) never carries the RPC api-key", async () => {
    const f = fakeExecConn();
    const exec = execCtx(f.conn);
    // Make the exec context itself throw (outside exec.send's own redacting catch).
    const bad = { ...exec, get keeper(): never { throw new Error(LEAK); } } as typeof exec;
    const r = await crankBondFee({ exec: bad, getSlot: async () => 1000 }, v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "failed");
    assert.ok(r.kind === "failed" && !r.error.includes("SECRET"), r.kind === "failed" ? r.error : "");
    assert.ok(r.kind === "failed" && r.error.includes("helius-rpc.com"));
  });
  it("a blockhash read that throws is redacted too (control: exec's own catch)", async () => {
    const f = fakeExecConn();
    (f.conn as any).getLatestBlockhash = async () => { throw new Error(LEAK); };
    const r = await crankBondFee({ exec: execCtx(f.conn), getSlot: async () => 1000 }, v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "failed");
    assert.ok(r.kind === "failed" && !r.error.includes("SECRET"), r.kind === "failed" ? r.error : "");
  });
});
