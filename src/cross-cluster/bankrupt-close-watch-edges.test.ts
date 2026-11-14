/**
 * Edge behaviour of the bankrupt-close watch that the fixture tests do not reach: bad inputs, RPC failures,
 * mixed expired/soon ledgers, the shared scan cache (TTL + in-flight coalescing), env parsing and the fee-job wrapper.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/bankrupt-close-watch-edges.test.ts
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
  CLOSE_PROGRESS_OFF,
  bankruptCloseWatchConfigFromEnv,
  closeLayoutForMarket,
  decodeCloseProgress,
  hasPendingResidual,
  makeBankruptCloseWatchJob,
  makeSharedCloseScan,
  watchBankruptCloses,
} from "./bankrupt-close-watch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const MARKET = fx("v22-sol-market-v19");
const LP = fx("v22-sol-lp-portfolio-v19");
const SOL = new PublicKey("BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5");
const OFF = 10_225;
const WRAPPER = Keypair.generate().publicKey;
const CFG = { wrapperProgramId: WRAPPER, warnSlots: 3_000n };

function ledger(max: bigint, residual: bigint, flags: { finalized?: boolean; canceled?: boolean } = {}): Buffer {
  const b = Buffer.from(LP);
  b[OFF] = 1;
  b[OFF + 1] = flags.finalized ? 1 : 0;
  b[OFF + 2] = flags.canceled ? 1 : 0;
  b.writeBigUInt64LE(9n, OFF + 3);
  b.writeUInt32LE(4, OFF + 11);
  b.writeBigUInt64LE(max, OFF + 48);
  b.writeBigUInt64LE(residual & 0xffff_ffff_ffff_ffffn, OFF + 168);
  b.writeBigUInt64LE(residual >> 64n, OFF + 176);
  return b;
}

/** Fake conn: the program-accounts reply is a list of full portfolios, sliced as asked. */
function fake(portfolios: Buffer[], nowSlot: number, market: Buffer | null = MARKET) {
  const calls = { gpa: 0, slot: 0 };
  return {
    calls,
    conn: {
      async getMultipleAccountsInfo() { return [market ? { data: market } : null]; },
      async getSlot() { calls.slot++; return nowSlot; },
      async getProgramAccounts(_p: PublicKey, o: { dataSlice?: { offset: number; length: number } }) {
        calls.gpa++;
        return portfolios.map((p) => ({
          pubkey: Keypair.generate().publicKey,
          account: { data: o.dataSlice ? p.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) : p },
        }));
      },
    },
  };
}

describe("watchBankruptCloses: inputs and failures", () => {
  it("an unparseable market address is a failure, not a throw", async () => {
    const a = fake([], 1);
    assert.deepEqual(await watchBankruptCloses(a.conn as never, "not-a-pubkey", CFG), { kind: "failed", error: "unparseable market address" });
    assert.equal(a.calls.gpa, 0);
  });
  it("a market account that is missing reads as nothing to watch", async () => {
    const a = fake([], 1, null);
    assert.deepEqual(await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG), { kind: "nothing" });
    assert.equal(a.calls.gpa, 0);
  });
  it("a market whose VERSION the SDK does not know is never scanned (marketMode already refuses it, so the later 'skipped' guard is defence in depth)", async () => {
    const m = Buffer.from(MARKET);
    m.writeUInt16LE(99, 8);
    assert.equal(closeLayoutForMarket(m), null);
    const a = fake([ledger(10n, 1n)], 1, m);
    const o = await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG);
    assert.deepEqual(o, { kind: "nothing" });
    assert.equal(a.calls.gpa, 0);
  });
  it("a market account too short to carry a VERSION has no layout", () => {
    assert.equal(closeLayoutForMarket(new Uint8Array(9)), null);
  });
  it("an RPC error on getProgramAccounts becomes a bounded 'read failed'", async () => {
    const a = fake([], 1);
    a.conn.getProgramAccounts = async () => { throw new Error("x".repeat(500)); };
    const o = await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG) as { kind: string; error: string };
    assert.equal(o.kind, "failed");
    assert.ok(o.error.startsWith("read failed: xxx"));
    assert.equal(o.error.length, "read failed: ".length + 120);
  });
  it("a non-Error throw is stringified", async () => {
    const a = fake([], 1);
    a.conn.getSlot = async () => { throw "boom"; };
    a.conn.getProgramAccounts = async () => [{ pubkey: Keypair.generate().publicKey, account: { data: ledger(10n, 1n).subarray(OFF, OFF + CLOSE_PROGRESS_LEN) } }] as never;
    assert.deepEqual(await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG), { kind: "failed", error: "read failed: boom" });
  });
  it("a truncated ledger slice is ignored rather than decoded", async () => {
    const a = fake([ledger(10n, 1n)], 1);
    a.conn.getProgramAccounts = async () => [{ pubkey: Keypair.generate().publicKey, account: { data: new Uint8Array(50) } }] as never;
    const o = await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG);
    assert.deepEqual(o, { kind: "nothing" });
    assert.equal(a.calls.slot, 0);
  });
});

describe("watchBankruptCloses: classification", () => {
  it("finalized, canceled and zero-residual ledgers never alert (and never cost a getSlot)", async () => {
    const a = fake([ledger(10n, 5n, { finalized: true }), ledger(10n, 5n, { canceled: true }), ledger(10n, 0n)], 1_000_000);
    assert.deepEqual(await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG), { kind: "nothing" });
    assert.equal(a.calls.slot, 0);
  });
  it("a pending close far from expiry reports nothing, with a count in the detail", async () => {
    const a = fake([ledger(1_000_000n, 5n)], 100);
    assert.deepEqual(await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG), { kind: "nothing", detail: "1 pending bankrupt close(s), none near expiry" });
  });
  it("the boundary slot == max_close_slot is still warn (not yet expired); one slot later is critical", async () => {
    const warn = await watchBankruptCloses(fake([ledger(500n, 5n)], 500).conn as never, SOL.toBase58(), CFG) as { severity: string; reason: string };
    assert.equal(warn.severity, "warn");
    assert.match(warn.reason, /0 slots left/);
    const crit = await watchBankruptCloses(fake([ledger(500n, 5n)], 501).conn as never, SOL.toBase58(), CFG) as { severity: string; reason: string };
    assert.equal(crit.severity, "critical");
    assert.match(crit.reason, /expired 1 slots ago/);
  });
  it("warn window edge: exactly warnSlots away warns, warnSlots + 1 away does not", async () => {
    const at = await watchBankruptCloses(fake([ledger(4_000n, 5n)], 1_000).conn as never, SOL.toBase58(), CFG) as { kind: string };
    assert.equal(at.kind, "blocked");
    const past = await watchBankruptCloses(fake([ledger(4_001n, 5n)], 1_000).conn as never, SOL.toBase58(), CFG) as { kind: string };
    assert.equal(past.kind, "nothing");
  });
  it("expired wins over soon when both exist, and only the expired portfolio is named", async () => {
    const a = fake([ledger(900n, 5n), ledger(1_100n, 5n)], 1_000);
    const o = await watchBankruptCloses(a.conn as never, SOL.toBase58(), CFG) as { severity: string; reason: string };
    assert.equal(o.severity, "critical");
    assert.match(o.reason, /max_close_slot 900/);
    assert.doesNotMatch(o.reason, /max_close_slot 1100/);
    assert.match(o.reason, /close #9, asset 4, residual 5/);
  });
  it("several soon-to-expire portfolios are all listed", async () => {
    const o = await watchBankruptCloses(fake([ledger(1_100n, 5n), ledger(1_200n, 6n)], 1_000).conn as never, SOL.toBase58(), CFG) as { reason: string };
    assert.match(o.reason, /100 slots left.*; .*200 slots left/);
  });
});

describe("decode helpers", () => {
  it("a residual above 2^64 decodes from both halves", () => {
    const big = (1n << 70n) + 3n;
    assert.equal(decodeCloseProgress(new Uint8Array(ledger(1n, big)))!.residualRemaining, big);
  });
  it("short buffers decode to null (full and slice)", () => {
    assert.equal(decodeCloseProgress(new Uint8Array(100)), null);
    assert.equal(decodeCloseProgress(new Uint8Array(CLOSE_PROGRESS_LEN - 1), true), null);
  });
  it("an unknown-length full account reads at the v2.1 offset", () => {
    const d = new Uint8Array(CLOSE_PROGRESS_OFF + CLOSE_PROGRESS_LEN + 1);
    d[CLOSE_PROGRESS_OFF] = 1;
    assert.equal(decodeCloseProgress(d)!.active, true);
  });
  it("hasPendingResidual needs active, not finalized, not canceled, residual != 0", () => {
    const base = { active: true, finalized: false, canceled: false, closeId: 0n, assetIndex: 0, maxCloseSlot: 0n, residualRemaining: 1n };
    assert.equal(hasPendingResidual(base), true);
    assert.equal(hasPendingResidual({ ...base, active: false }), false);
    assert.equal(hasPendingResidual({ ...base, finalized: true }), false);
    assert.equal(hasPendingResidual({ ...base, canceled: true }), false);
    assert.equal(hasPendingResidual({ ...base, residualRemaining: 0n }), false);
  });
});

describe("makeSharedCloseScan", () => {
  const sliceOf = (marketKey: PublicKey, closeBytes: Buffer) => {
    // dataSlice offset 16 .. closeOff + 184: market key first, ledger at the tail
    const len = OFF + CLOSE_PROGRESS_LEN - 16;
    const s = Buffer.alloc(len);
    marketKey.toBuffer().copy(s, 0);
    closeBytes.copy(s, OFF - 16);
    return s;
  };
  const layout = { version: 19, accountLen: 10_603, closeOff: OFF };

  it("one getProgramAccounts serves concurrent callers, then the cache until the TTL passes", async () => {
    let t = 0;
    let gpa = 0;
    const other = Keypair.generate().publicKey;
    const conn = {
      async getProgramAccounts() {
        gpa++;
        await new Promise((r) => setTimeout(r, 5));
        return [
          { pubkey: Keypair.generate().publicKey, account: { data: sliceOf(SOL, ledger(10n, 1n).subarray(OFF, OFF + CLOSE_PROGRESS_LEN) as Buffer) } },
          { pubkey: Keypair.generate().publicKey, account: { data: sliceOf(SOL, ledger(11n, 1n).subarray(OFF, OFF + CLOSE_PROGRESS_LEN) as Buffer) } },
          { pubkey: Keypair.generate().publicKey, account: { data: sliceOf(other, ledger(12n, 1n).subarray(OFF, OFF + CLOSE_PROGRESS_LEN) as Buffer) } },
        ];
      },
    };
    const scan = makeSharedCloseScan(1_000, () => t);
    const [a, b, c] = await Promise.all([
      scan.forMarket(conn as never, WRAPPER, SOL, layout),
      scan.forMarket(conn as never, WRAPPER, other, layout),
      scan.forMarket(conn as never, WRAPPER, Keypair.generate().publicKey, layout),
    ]);
    assert.equal(gpa, 1);
    assert.equal(a.length, 2);
    assert.equal(b.length, 1);
    assert.equal(c.length, 0);
    assert.equal(decodeCloseProgress(new Uint8Array(a[0].account.data), true)!.maxCloseSlot, 10n);
    t = 1_000; // exactly the TTL: still cached
    await scan.forMarket(conn as never, WRAPPER, SOL, layout);
    assert.equal(gpa, 1);
    t = 1_001; // past the TTL: refetch
    await scan.forMarket(conn as never, WRAPPER, SOL, layout);
    assert.equal(gpa, 2);
  });
  it("a failed fetch is not cached: the next caller retries", async () => {
    let gpa = 0;
    const conn = { async getProgramAccounts() { gpa++; if (gpa === 1) throw new Error("rpc down"); return []; } };
    const scan = makeSharedCloseScan();
    await assert.rejects(scan.forMarket(conn as never, WRAPPER, SOL, layout), /rpc down/);
    assert.deepEqual(await scan.forMarket(conn as never, WRAPPER, SOL, layout), []);
    assert.equal(gpa, 2);
  });
  it("the default layout is v2.1", async () => {
    let seen: { filters: Array<{ dataSize?: number }> } | undefined;
    const conn = { async getProgramAccounts(_p: PublicKey, o: never) { seen = o; return []; } };
    await makeSharedCloseScan().forMarket(conn as never, WRAPPER, SOL);
    assert.equal(seen!.filters[0].dataSize, CLOSE_LAYOUT_V21.accountLen);
  });
});

describe("config and job wrapper", () => {
  it("env: default 3,000, trimmed value, blank = default, junk throws", () => {
    assert.equal(bankruptCloseWatchConfigFromEnv({}, WRAPPER).warnSlots, 3_000n);
    assert.equal(bankruptCloseWatchConfigFromEnv({ ALERT_BANKRUPT_CLOSE_WARN_SLOTS: "  " }, WRAPPER).warnSlots, 3_000n);
    assert.equal(bankruptCloseWatchConfigFromEnv({ ALERT_BANKRUPT_CLOSE_WARN_SLOTS: " 120 " }, WRAPPER).warnSlots, 120n);
    assert.equal(bankruptCloseWatchConfigFromEnv({ ALERT_BANKRUPT_CLOSE_WARN_SLOTS: "0" }, WRAPPER).warnSlots, 0n);
    assert.equal(bankruptCloseWatchConfigFromEnv({}, WRAPPER).wrapperProgramId, WRAPPER);
    for (const bad of ["-1", "1.5", "abc", "1e3"]) {
      assert.throws(() => bankruptCloseWatchConfigFromEnv({ ALERT_BANKRUPT_CLOSE_WARN_SLOTS: bad }, WRAPPER), /non-negative integer/);
    }
  });
  it("the job runs the watch for a market and shares one scan across markets", async () => {
    const job = makeBankruptCloseWatchJob(CFG);
    assert.equal(job.name, "bankrupt-close-watch");
    const a = fake([ledger(500n, 5n)], 600);
    const ctx = { conn: a.conn } as never;
    const o1 = await job.run(ctx, { marketAddress: SOL.toBase58(), label: "SOL" }) as { kind: string; severity?: string };
    assert.deepEqual([o1.kind, o1.severity], ["blocked", "critical"]);
    const o2 = await job.run(ctx, { marketAddress: SOL.toBase58(), label: "SOL" }) as { kind: string };
    assert.equal(o2.kind, "blocked");
    assert.equal(a.calls.gpa, 1);
  });
});
