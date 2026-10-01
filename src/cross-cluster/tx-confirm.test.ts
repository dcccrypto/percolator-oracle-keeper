/** F6: the signature status decides whether a transaction landed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { confirmBySignature, customCodeOf } from "./tx-confirm.ts";
import type { ConfirmConnection } from "./tx-confirm.ts";

type Status = { err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" } | null;

function conn(o: { confirm: "ok" | "throw" | { err: unknown }; statuses: Status[] }) {
  let reads = 0;
  const c = {
    async confirmTransaction() {
      if (o.confirm === "throw") throw new Error("TransactionExpiredBlockheightExceededError: block height exceeded");
      return { context: { slot: 1 }, value: { err: o.confirm === "ok" ? null : o.confirm.err } };
    },
    async getSignatureStatuses() {
      const s = o.statuses[Math.min(reads, o.statuses.length - 1)] ?? null;
      reads++;
      return { context: { slot: 1 }, value: [s ? { slot: 1, confirmations: 1, ...s } : null] };
    },
  };
  return { c: c as unknown as ConfirmConnection, reads: () => reads };
}
const FAST = { statusRetries: 2, statusRetryDelayMs: 0 };

describe("confirmBySignature", () => {
  it("confirm ok -> landed (no status read needed)", async () => {
    const k = conn({ confirm: "ok", statuses: [] });
    assert.deepEqual(await confirmBySignature(k.c, "s", "b", 1, FAST), { status: "landed", signature: "s", via: "confirm" });
    assert.equal(k.reads(), 0);
  });
  it("block height exceeded but the status is confirmed -> landed (the SOLCAT/ANSEM case)", async () => {
    const k = conn({ confirm: "throw", statuses: [{ err: null, confirmationStatus: "confirmed" }] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "landed");
    assert.equal((r as { via: string }).via, "signature-status");
  });
  it("status 'processed' then 'finalized' -> keeps polling, then landed", async () => {
    const k = conn({ confirm: "throw", statuses: [{ err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "finalized" }] });
    assert.equal((await confirmBySignature(k.c, "s", "b", 1, FAST)).status, "landed");
    assert.equal(k.reads(), 2);
  });
  it("confirm returns value.err -> failed with its code (never 'landed')", async () => {
    const k = conn({ confirm: { err: { InstructionError: [1, { Custom: 41 }] } }, statuses: [] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "failed");
    assert.equal((r as { code: number }).code, 41);
  });
  it("timed out and the status shows an on-chain error -> failed", async () => {
    const k = conn({ confirm: "throw", statuses: [{ err: { InstructionError: [1, { Custom: 38 }] }, confirmationStatus: "confirmed" }] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "failed");
    assert.equal((r as { code: number }).code, 38);
  });
  it("timed out and no status after every re-check -> not-landed (retry next cycle)", async () => {
    const k = conn({ confirm: "throw", statuses: [null] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "not-landed");
    assert.equal(k.reads(), FAST.statusRetries + 1);
    assert.match((r as { reason: string }).reason, /block height exceeded/);
  });
});

describe("customCodeOf", () => {
  it("reads both the JSON and the hex form", () => {
    assert.equal(customCodeOf({ InstructionError: [1, { Custom: 56 }] }), 56);
    assert.equal(customCodeOf("custom program error: 0x26"), 38);
    assert.equal(customCodeOf("nope"), null);
  });
});
