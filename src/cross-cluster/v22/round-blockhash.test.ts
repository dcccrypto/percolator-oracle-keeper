import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { withRoundBlockhash } from "./sweep.ts";
import type { SweepDeps } from "./sweep.ts";
import { execCtx, fakeExecConn, key } from "./test-helpers.ts";
import { simulateAndSend } from "./exec.ts";

const ix = () => new TransactionInstruction({ programId: key(1), keys: [], data: Buffer.from([7]) });
const job = { job: "sweep", label: "bh", units: 200_000 };
const hash = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => n & 0xff)).toBase58();

function counting() {
  const f = fakeExecConn();
  let n = 0;
  let fail = false;
  const orig = f.conn.getLatestBlockhash.bind(f.conn);
  (f.conn as unknown as { getLatestBlockhash: () => Promise<unknown> }).getLatestBlockhash = async () => {
    n++;
    if (fail) throw new Error("rpc down");
    return orig();
  };
  const deps: SweepDeps = { exec: execCtx(f.conn), getSlot: async () => 1 };
  return { f, deps, calls: () => n, setFail: (v: boolean) => (fail = v) };
}

test("one blockhash fetch is shared by concurrent and later callers in a round", async () => {
  const c = counting();
  const d = withRoundBlockhash(c.deps);
  const rs = await Promise.all([1, 2, 3].map(() => d.exec.conn.getLatestBlockhash("confirmed")));
  await d.exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), 1);
  assert.ok(rs.every((r) => r.blockhash === rs[0].blockhash));
});

test("a fresh round fetches again", async () => {
  const c = counting();
  await withRoundBlockhash(c.deps).exec.conn.getLatestBlockhash("confirmed");
  await withRoundBlockhash(c.deps).exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), 2);
});

test("a failed fetch is not kept; an old one expires", async () => {
  const c = counting();
  let t = 0;
  const d = withRoundBlockhash(c.deps, () => t);
  c.setFail(true);
  await assert.rejects(d.exec.conn.getLatestBlockhash("confirmed"));
  c.setFail(false);
  await d.exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), 2);
  t = 20_000;
  await d.exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), 3);
});

test("a sendRawTransaction error clears the held blockhash so later txs refetch", async () => {
  const c = counting();
  (c.f.conn as unknown as { sendRawTransaction: () => Promise<string> }).sendRawTransaction = async () => {
    throw new Error("TransactionExpiredBlockheightExceededError");
  };
  const d = withRoundBlockhash(c.deps);
  await d.exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), 1);
  await assert.rejects(d.exec.conn.sendRawTransaction(new Uint8Array([1])), /TransactionExpired/);
  await d.exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), 2);
});

test("a confirmation expiry (block height exceeded) clears the held blockhash so later txs refetch", async () => {
  const c = counting();
  (c.f.conn as unknown as { getSignatureStatuses: () => Promise<unknown> }).getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [null],
  });
  (c.f.conn as unknown as { getBlockHeight: () => Promise<number> }).getBlockHeight = async () => 1_000_001;
  const d = withRoundBlockhash(c.deps);
  const out = await simulateAndSend(d.exec, [ix()], job);
  assert.equal(out.kind, "sent");
  if (out.kind === "sent") {
    assert.equal(out.landed, "not-landed");
  }
  const fetchesAfterSend = c.calls();
  await d.exec.conn.getLatestBlockhash("confirmed");
  assert.equal(c.calls(), fetchesAfterSend + 1);
});

test("simulate BlockhashNotFound retries exactly once and then succeeds", async () => {
  const hashes: string[] = [];
  let sims = 0;
  let fetches = 0;
  const f = fakeExecConn({
    simErr: (_ixs, callIndex) => (callIndex === 0 ? "BlockhashNotFound" : null),
  });
  (f.conn as unknown as { getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }> }).getLatestBlockhash = async () => {
    fetches++;
    return { blockhash: hash(fetches), lastValidBlockHeight: 1_000_000 };
  };
  const origSim = f.conn.simulateTransaction.bind(f.conn);
  (f.conn as unknown as { simulateTransaction: (tx: { message: { recentBlockhash: string } }, cfg?: unknown) => Promise<unknown> }).simulateTransaction = async (tx, cfg) => {
    hashes.push(tx.message.recentBlockhash);
    sims++;
    return origSim(tx as never, cfg as never);
  };
  const d = withRoundBlockhash({ exec: { ...execCtx(f.conn), dryRun: true }, getSlot: async () => 1 });
  const out = await simulateAndSend(d.exec, [ix()], job);
  assert.equal(out.kind, "dry-run");
  assert.equal(sims, 2);
  assert.equal(fetches, 2);
  assert.equal(hashes.length, 2);
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(hashes[0], hash(1));
  assert.equal(hashes[1], hash(2));
});

test("simulate BlockhashNotFound retries exactly once and then refuses (no second retry)", async () => {
  let sims = 0;
  let fetches = 0;
  const f = fakeExecConn({ simErr: () => "BlockhashNotFound" });
  (f.conn as unknown as { getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }> }).getLatestBlockhash = async () => {
    fetches++;
    return { blockhash: hash(fetches), lastValidBlockHeight: 1_000_000 };
  };
  const origSim = f.conn.simulateTransaction.bind(f.conn);
  (f.conn as unknown as { simulateTransaction: (tx: unknown, cfg?: unknown) => Promise<unknown> }).simulateTransaction = async (tx, cfg) => {
    sims++;
    return origSim(tx as never, cfg as never);
  };
  const d = withRoundBlockhash({ exec: { ...execCtx(f.conn), dryRun: true }, getSlot: async () => 1 });
  const out = await simulateAndSend(d.exec, [ix()], job);
  assert.equal(out.kind, "refused");
  if (out.kind === "refused") assert.equal(out.code, null);
  assert.equal(sims, 2);
  assert.equal(fetches, 2);
});

test("other simulate errors are not retried", async () => {
  let sims = 0;
  let fetches = 0;
  const f = fakeExecConn({ simErr: () => ({ InstructionError: [2, { Custom: 22 }] }) });
  (f.conn as unknown as { getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }> }).getLatestBlockhash = async () => {
    fetches++;
    return { blockhash: hash(fetches), lastValidBlockHeight: 1_000_000 };
  };
  const origSim = f.conn.simulateTransaction.bind(f.conn);
  (f.conn as unknown as { simulateTransaction: (tx: unknown, cfg?: unknown) => Promise<unknown> }).simulateTransaction = async (tx, cfg) => {
    sims++;
    return origSim(tx as never, cfg as never);
  };
  const d = withRoundBlockhash({ exec: { ...execCtx(f.conn), dryRun: true }, getSlot: async () => 1 });
  const out = await simulateAndSend(d.exec, [ix()], job);
  assert.equal(out.kind, "refused");
  if (out.kind === "refused") assert.equal(out.code, 22);
  assert.equal(sims, 1);
  assert.equal(fetches, 1);
});
