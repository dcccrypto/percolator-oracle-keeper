import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { execCtx, fakeExecConn, key } from "./test-helpers.ts";
import { COMPUTE_IX_COUNT, simulateAndSend } from "./exec.ts";

const ix = (tag: number) => new TransactionInstruction({ programId: key(1), keys: [], data: Buffer.from([tag]) });
const hash = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => n)).toBase58();
const acct = key(9).toBase58();
const base = { job: "t", label: "verify", units: 200_000, accounts: [acct] };

/** fake conn whose blockhash advances on each fetch, recording the blockhash of each sent tx. */
function setup(simErr: (call: number) => unknown) {
  const f = fakeExecConn({ simAccounts: () => [new Uint8Array([1])], simErr: (_d, i) => simErr(i) });
  let n = 0;
  const lvbh: number[] = [];
  (f.conn as unknown as { getLatestBlockhash: () => Promise<unknown> }).getLatestBlockhash = async () => {
    n++;
    lvbh.push(n * 100);
    return { blockhash: hash(n), lastValidBlockHeight: n * 100 };
  };
  const sentHash: string[] = [];
  const origSend = f.conn.sendRawTransaction.bind(f.conn);
  (f.conn as unknown as { sendRawTransaction: (r: Uint8Array) => Promise<string> }).sendRawTransaction = async (raw) => {
    sentHash.push(Transaction.from(Buffer.from(raw)).recentBlockhash!);
    return origSend(raw);
  };
  return { f, sentHash };
}

test("lead 1: verifyExtended throwing must NOT send the unverified extended list", async () => {
  const { f } = setup(() => null);
  const out = await simulateAndSend(execCtx(f.conn), [ix(1)], {
    ...base,
    extend: () => [ix(2), ix(3)],
    verifyExtended: () => {
      throw new Error("boom");
    },
  });
  assert.equal(out.kind, "sent");
  assert.deepEqual(f.sent[0].tags, [1], "fell back to the first list");
});

test("lead 1b: verifyExtended returning a reason falls back to the first list (control)", async () => {
  const { f } = setup(() => null);
  await simulateAndSend(execCtx(f.conn), [ix(1)], { ...base, extend: () => [ix(2)], verifyExtended: () => "no" });
  assert.deepEqual(f.sent[0].tags, [1]);
});

test("lead 2: fallback after a blockhash refresh sends the first list on the CURRENT hash", async () => {
  // sim 0 ok (hash 1); sim 1 (extended) BlockhashNotFound -> refresh to hash 2; sim 2 ok; verify rejects -> fall back.
  const { f, sentHash } = setup((i) => (i === 1 ? "BlockhashNotFound" : null));
  const out = await simulateAndSend(execCtx(f.conn), [ix(1)], { ...base, extend: () => [ix(2)], verifyExtended: () => "no" });
  assert.equal(out.kind, "sent");
  assert.deepEqual(f.sent[0].tags, [1]);
  assert.equal(sentHash[0], hash(2), "sent tx must carry the refreshed blockhash that confirm watches");
});

test("lead 3: refusal index subtracts exactly the prelude actually built (with and without priority fee)", async () => {
  for (const pri of [undefined, 5_000]) {
    const f = fakeExecConn({ simErr: () => ({ InstructionError: [COMPUTE_IX_COUNT + (pri ? 1 : 0) + 1, { Custom: 1 }] }) });
    const out = await simulateAndSend(execCtx(f.conn), [ix(1), ix(2)], { job: "t", label: "i", units: 1, priorityMicroLamportsPerCu: pri });
    assert.equal(out.kind, "refused");
    if (out.kind === "refused") assert.equal(out.index, 1);
  }
});
