import { test } from "node:test";
import assert from "node:assert/strict";
import { withRoundBlockhash } from "./sweep.ts";
import type { SweepDeps } from "./sweep.ts";
import { execCtx, fakeExecConn } from "./test-helpers.ts";

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
  return { deps, calls: () => n, setFail: (v: boolean) => (fail = v) };
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
