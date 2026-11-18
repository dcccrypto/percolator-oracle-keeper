import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { execCtx, fakeExecConn, key } from "./test-helpers.ts";
import { simulateAndSend } from "./exec.ts";

const ix = (tag: number) => new TransactionInstruction({ programId: key(1), keys: [], data: Buffer.from([tag]) });
const hash = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => n)).toBase58();
const job = { job: "t", label: "extend-fallback", units: 200_000 };

test("extended simulation refusal is the outcome by contract (exec.ts F1 doc): base list is NOT sent", async () => {
  const f = fakeExecConn({
    simErr: (_d, i) => (i === 1 ? { InstructionError: [2, { Custom: 7 }] } : null),
    simAccounts: (_d, _i, want) => want.map(() => new Uint8Array([1])),
  });
  const out = await simulateAndSend(execCtx(f.conn), [ix(1)], { ...job, accounts: [key(9).toBase58()], extend: () => [ix(1), ix(2)] });
  assert.equal(out.kind, "refused");
  assert.equal(f.sent.length, 0);
});

test("verifyExtended fallback sends the base tx under the blockhash that is also used for the confirm deadline", async () => {
  const f = fakeExecConn({
    // sim 0: base clean; sim 1: extended -> BlockhashNotFound (forces refresh); sim 2: extended retry clean
    simErr: (_d, i) => (i === 1 ? "BlockhashNotFound" : null),
    simAccounts: (_d, _i, want) => want.map(() => new Uint8Array([1])),
  });
  let fetches = 0;
  const hashes = [hash(1), hash(2)];
  const heights = [100, 1000];
  (f.conn as unknown as { getLatestBlockhash: () => Promise<unknown> }).getLatestBlockhash = async () => {
    const i = Math.min(fetches++, 1);
    return { blockhash: hashes[i], lastValidBlockHeight: heights[i] };
  };
  let sentHash = "";
  const origSend = f.conn.sendRawTransaction.bind(f.conn);
  (f.conn as unknown as { sendRawTransaction: (r: Uint8Array) => Promise<string> }).sendRawTransaction = async (r) => {
    sentHash = Transaction.from(Buffer.from(r)).recentBlockhash!;
    return origSend(r);
  };
  const out = await simulateAndSend(execCtx(f.conn), [ix(1)], {
    ...job,
    accounts: [key(9).toBase58()],
    extend: () => [ix(1), ix(2)],
    verifyExtended: () => "reject extension",
  });
  assert.equal(out.kind, "sent");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].tags, [1], "base list sent");
  // the confirm deadline is derived from the refreshed hash (hashes[1]); the sent tx must carry that same hash
  assert.equal(sentHash, hashes[1]);
});
