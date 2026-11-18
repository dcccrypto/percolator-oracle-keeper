import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { CLOSE_LAYOUT_V21, CLOSE_PROGRESS_LEN, makeSharedCloseScan } from "./bankrupt-close-watch.ts";
import { makeLegacySharedCloseScan } from "./bankrupt-close-watch-legacy.fixture.ts";

test("differential: raw-bytes bucketing returns exactly what base58 bucketing did (5k random accounts)", async () => {
  const L = CLOSE_LAYOUT_V21;
  const sliceLen = L.closeOff + CLOSE_PROGRESS_LEN - 16;
  const markets = Array.from({ length: 12 }, () => Keypair.generate().publicKey);
  const unknown = Keypair.generate().publicKey; // never in the scan: both must return []
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const accs = Array.from({ length: 5000 }, () => {
    const data = Buffer.alloc(sliceLen);
    for (let i = 0; i < sliceLen; i++) data[i] = Math.floor(rnd() * 256);
    markets[Math.floor(rnd() * markets.length)].toBuffer().copy(data, 0);
    return { pubkey: Keypair.generate().publicKey, account: { data } };
  });
  const conn = { getProgramAccounts: async () => accs } as never;
  const a = makeLegacySharedCloseScan(90_000, () => 0);
  const b = makeSharedCloseScan(90_000, () => 0);
  let mismatches = 0;
  let total = 0;
  for (const m of [...markets, unknown]) {
    const ra = await a.forMarket(conn, markets[0], m, L);
    const rb = await b.forMarket(conn, markets[0], m, L);
    total += rb.length;
    if (ra.length !== rb.length) { mismatches++; continue; }
    for (let i = 0; i < ra.length; i++) {
      if (ra[i].pubkey.toBase58() !== rb[i].pubkey.toBase58() || Buffer.compare(Buffer.from(ra[i].account.data), Buffer.from(rb[i].account.data)) !== 0) mismatches++;
    }
  }
  assert.equal(total, 5000);
  assert.equal(mismatches, 0);
});
