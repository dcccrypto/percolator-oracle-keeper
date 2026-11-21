/** Bad chunkSize/concurrency (NaN, 0, negative, Infinity, fractional) must never yield a silent all-undefined result. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { getMultipleAccountsInfoChunked, MAX_ACCOUNTS_PER_RPC } from "./rpc-chunk.ts";

const BAD = [NaN, 0, -1, Infinity, -Infinity, 1.5];
function mkConn() {
  const sizes: number[] = [];
  return {
    sizes,
    conn: {
      async getMultipleAccountsInfo(pks: unknown[]) {
        if (pks.length > MAX_ACCOUNTS_PER_RPC) throw new Error("too many");
        sizes.push(pks.length);
        return pks.map(() => null);
      },
    },
  };
}
const keys = Array.from({ length: 250 }, () => Keypair.generate().publicKey);

for (const opt of ["chunkSize", "concurrency"] as const) {
  for (const bad of BAD) {
    it(`${opt}=${bad}: every key resolved (no undefined with failedKeys=0)`, async () => {
      const { conn, sizes } = mkConn();
      const r = await getMultipleAccountsInfoChunked(conn as never, keys, "processed", { [opt]: bad });
      assert.equal(r.infos.length, keys.length);
      assert.equal(r.infos.filter((i) => i === undefined).length, r.failedKeys);
      assert.equal(r.failedKeys, 0);
      assert.equal(r.infos.filter((i) => i === null).length, keys.length);
      assert.equal(sizes.reduce((a, b) => a + b, 0), keys.length);
      assert.ok(r.totalChunks >= 3);
    });
  }
}
it("empty keys with bad options is fine", async () => {
  const { conn } = mkConn();
  const r = await getMultipleAccountsInfoChunked(conn as never, [], "processed", { chunkSize: NaN, concurrency: NaN });
  assert.deepEqual(r, { infos: [], failedChunks: 0, failedKeys: 0, totalChunks: 0 });
});
