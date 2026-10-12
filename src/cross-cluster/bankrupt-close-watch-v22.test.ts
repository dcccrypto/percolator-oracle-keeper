/**
 * Bankrupt-close watch on v2.2 (VERSION 19) portfolios — follow-up to K-3 (2026-10-10).
 * The watch used to query 9,563-byte portfolios at the v2.1 ledger offset 9,185 only, so it saw nothing on v2.2
 * (10,603 B, ledger at 10,225). The fake RPC below applies dataSize / memcmp / dataSlice HONESTLY, so a wrong size or
 * offset returns nothing, exactly as the real node would.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/bankrupt-close-watch-v22.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CLOSE_LAYOUT_V21,
  CLOSE_PROGRESS_LEN,
  closeLayoutForMarket,
  closeLayoutForVersion,
  decodeCloseProgress,
  makeSharedCloseScan,
  watchBankruptCloses,
} from "./bankrupt-close-watch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const SOL = new PublicKey("BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5");
const MARKET = fx("v22-sol-market-v19");
const LP = fx("v22-sol-lp-portfolio-v19");
const V22_OFF = 10_225;
const V21_OFF = 9_185;
const MAX = 509_500_000n;
const CFG = { wrapperProgramId: Keypair.generate().publicKey, warnSlots: 3_000n };

/** The real v2.2 SOL LP portfolio with an active, unfinalized close (residual 7) written at `off`. */
function withClose(off: number): Buffer {
  const b = Buffer.from(LP);
  b[off] = 1; b[off + 1] = 0; b[off + 2] = 0;
  b.writeBigUInt64LE(3n, off + 3);
  b.writeBigUInt64LE(MAX, off + 48);
  b.writeBigUInt64LE(7n, off + 168);
  return b;
}

type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string } };
function honestConn(portfolios: Array<{ pubkey: PublicKey; data: Buffer }>, nowSlot: bigint) {
  const calls: Array<{ filters: Filter[] }> = [];
  return {
    calls,
    conn: {
      async getMultipleAccountsInfo() { return [{ data: MARKET }]; },
      async getSlot() { return Number(nowSlot); },
      async getProgramAccounts(_p: PublicKey, o: { dataSlice?: { offset: number; length: number }; filters: Filter[] }) {
        calls.push({ filters: o.filters });
        return portfolios
          .filter((p) => o.filters.every((f) => {
            if (f.dataSize !== undefined) return p.data.length === f.dataSize;
            const want = f.memcmp!.bytes === "2" ? Buffer.from([1]) : new PublicKey(f.memcmp!.bytes).toBuffer(); // base58 "2" = [0x01]
            return p.data.subarray(f.memcmp!.offset, f.memcmp!.offset + want.length).equals(want);
          }))
          .map((p) => ({ pubkey: p.pubkey, account: { data: o.dataSlice ? p.data.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) : p.data } }));
      },
    },
  };
}

describe("bankrupt-close watch: v2.2 portfolio layout", () => {
  it("ledger offset = SDK resolvedPayoutReceiptOff - 184: v2.1 9,185 (the source-verified constant), v2.2 10,225 / 10,603 B", () => {
    assert.deepEqual(closeLayoutForVersion(18), CLOSE_LAYOUT_V21);
    assert.deepEqual(closeLayoutForVersion(19), { version: 19, accountLen: 10_603, closeOff: V22_OFF });
    assert.deepEqual(closeLayoutForMarket(MARKET), { version: 19, accountLen: 10_603, closeOff: V22_OFF });
  });
  it("NEGATIVE CONTROL: an unknown VERSION has no layout (skipped, never guessed)", () => {
    assert.equal(closeLayoutForVersion(20), null);
  });
  it("the real v2.2 LP portfolio decodes an idle ledger at 10,225 (all zero), and a close written there decodes", () => {
    assert.equal(LP.length, 10_603);
    assert.ok(LP.subarray(V22_OFF, V22_OFF + CLOSE_PROGRESS_LEN).every((x) => x === 0));
    assert.equal(decodeCloseProgress(new Uint8Array(LP))!.active, false);
    const c = decodeCloseProgress(new Uint8Array(withClose(V22_OFF)))!;
    assert.deepEqual([c.active, c.closeId, c.maxCloseSlot, c.residualRemaining], [true, 3n, MAX, 7n]);
  });
  it("an EXPIRED pending close on a v2.2 market is reported critical (per-market path and shared scan)", async () => {
    const pf = { pubkey: Keypair.generate().publicKey, data: withClose(V22_OFF) };
    const a = honestConn([pf], MAX + 1n);
    const o = await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG) as { kind: string; severity?: string };
    assert.equal(o.kind, "blocked");
    assert.equal(o.severity, "critical");
    assert.equal(a.calls[0].filters[0].dataSize, 10_603);
    const b = honestConn([pf], MAX - 100n);
    const o2 = await watchBankruptCloses(b.conn as never, SOL.toBase58(), CFG, makeSharedCloseScan()) as { kind: string; severity?: string };
    assert.deepEqual([o2.kind, o2.severity], ["blocked", "warn"]);
    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].filters[0].dataSize, 10_603);
  });
  it("NEGATIVE CONTROL: the v2.1 query (9,563 B, offset 9,185) finds nothing on the same v2.2 portfolio", async () => {
    const pf = { pubkey: Keypair.generate().publicKey, data: withClose(V22_OFF) };
    const a = honestConn([pf], MAX + 1n);
    const scan = makeSharedCloseScan();
    assert.deepEqual(await scan.forMarket(a.conn as never, CFG.wrapperProgramId, SOL, CLOSE_LAYOUT_V21), []);
  });
  it("NEGATIVE CONTROL: a close byte at the v2.1 offset inside a v2.2 portfolio is NOT mistaken for a ledger", async () => {
    const a = honestConn([{ pubkey: Keypair.generate().publicKey, data: withClose(V21_OFF) }], MAX + 1n);
    assert.equal((await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG)).kind, "nothing");
  });
});
