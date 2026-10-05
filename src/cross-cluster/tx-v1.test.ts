/**
 * TX_V1: PushAuthMark batches as Solana v1 transactions (SIMD-0385 / SIMD-0296), flag-gated,
 * with legacy fallback ONLY on a format rejection (or a v1 budget error found in preflight).
 *
 * Negative controls:
 *   - TX_V1=off sends byte-identical legacy txs: the sha256 of every wire is pinned to the
 *     output of the BASE commit's pusher (32cc1399) run through the same harness
 *     (tx-v1-test-helpers.ts legacyGoldenScenarios).
 *   - An on-chain error never causes a fallback or a resend; TX_V1=on never downgrades.
 *
 * Wires are decoded with web3.js 1.99 (VersionedTransaction.deserialize), independent of the
 * SDK encoder that produced them.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/tx-v1.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Connection, MessageV1, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import { TX_V1_FEATURE_ID, V1RpcError } from "@percolatorct/sdk";
import {
  pushAuthMarkBatch,
  parseFailingPush,
  getQuarantinedMarkets,
  reconcilePushOutcomes,
  pushLandingStats,
  resetPushLandingState,
  WRAPPER_PROGRAM_ID,
} from "./auth-mark-pusher.ts";
import {
  isFormatRejection,
  parseTxV1Settings,
  resetTxV1ForTests,
  sendWire,
  simulateWire,
  txV1Stats,
  DEFAULT_PUSH_CU_BASE,
  DEFAULT_PUSH_CU_PER_MARKET,
  DEFAULT_LOADED_OVERHEAD_BYTES,
  LOADED_HEADROOM,
} from "./tx-v1.ts";
import {
  GOLDEN_BLOCKHASH,
  GOLDEN_NOW_SLOT,
  legacyGoldenScenarios,
  marketAccount,
  marketsInWire,
  seededKeypair,
  seededMarkets,
} from "./tx-v1-test-helpers.ts";

const WRAPPER = WRAPPER_PROGRAM_ID.toBase58();
const keeper = seededKeypair(7, 0);
/** Slab tail so the loaded-size model sees a realistic size (live slabs are 33,900 B). */
const SLAB_EXTRA = 1_000;

/** Produced by the BASE commit 32cc1399 (pre-v1 pusher) via legacyGoldenScenarios. */
const GOLDEN = {
  clean30: {
    sent: [
      "ffdca0d49b9fff5221e3743983916624a22e1fc2a58e3559e977e026ebef55ba",
      "b801c53cb4d717d657f9c8f4fe3d45c9263fc4a9cd51426c6422c2e1034d34b2",
      "d02390118041b67de2dfafb1ea24446fc3a342f696d37f2dea2267902a8c6c0d",
    ],
    pushed: 30,
    skipped: [] as string[],
  },
  locked30: {
    sent: [
      "50d5b7a71b55d90846d51348dc0255e8c27e3e4a42059500a1870a12484d1373",
      "32d5d6b24c84418fbc5fe9b442ddc37dad0bd4eb9b77758879aa1ef8540d3698",
      "bcbde9fc349d76d09d071368108945ef11f7d20a379dad279b24cabb7c1d01cb",
    ],
    pushed: 29,
    skipped: ["FKKG3EomrKWcFjd2UsKUZqKivKfHudiGfYk25a47sFzw"],
  },
  opaque15: {
    sent: [
      "8a1d32904498e1ffa6700fdb8332492594d9e2c4ac412b1dae4cedc41f2e5030",
      "5c34292ebf63b19edbf3584875afc3c350ed90a879fcc35aa00207f4d724633d",
      "f23c316577089dd11e4941c42da228df9179c62278f82f7d041307313b122b33",
      "90435383880c3e80af9f08861943b963d77c5ef4aad96aef9b032400011a3f11",
      "2cdd2fdea90bd85157cbe7c19e0321a225cc7f7b10149daa1b0a96171dfe140d",
      "a288caccdc6f3b57765b16c62078ca772f2d49924e9165387b2af29db2ef7f11",
      "cc420319a8f87ac5bb73374f7c38e0a3551f5bd3cac122723207e6ae1d2b5cd3",
      "7423e130598a59002544957fb426b6d2effd4cc4176bbd49446f58a5f061f8af",
      "a6f593a81b459a7bd83aac750e4e33fb99b945257ba852cfbd548969daa0fe66",
      "dacecb560da403132ac9e61d16840bf419ba1817b700ecc7bccd0c638ca5a73f",
      "d5a8229d8c63ff78571909b3524117fd0854caa38116c8357c1be7af03ff4188",
      "19f57432b1a22e24bc4a2cf5e55fcf277addf6dc004e3f22df249f6a4c2b7a1e",
      "ac918d53706adf11c3e4f1489af3a48e6f6ad897fb824f1d871efd2408f6463d",
    ],
    pushed: 14,
    skipped: ["5hdx9nK358KWsmHH7gAPwKX8JYtXtJLhhARfcpZQHJ96"],
  },
};

const FORMAT_REJECTION = "failed to deserialize transaction: unsupported transaction version";
/** JSON-RPC "invalid params": what a node answers for bytes it cannot decode/sanitize. */
const FORMAT_REJECTION_CODE = -32602;

interface MockOpts {
  markets: string[];
  /** Feature gate account reports v1 active. */
  v1Active?: boolean;
  /** Markets that revert Custom(21) (in either format). */
  locked?: Set<string>;
  /** v1 simulate returns a JSON-RPC decode error. */
  v1SimReject?: boolean;
  /** v1 send: the node answers a JSON-RPC format rejection (code -32602); web3.js throws SendTransactionError. */
  v1SendReject?: boolean;
  /** v1 simulate returns this tx error (e.g. a budget error). */
  v1SimErr?: unknown;
  /** Any send throws this (non-format) error. */
  sendError?: string;
  /** v1 simulate: these markets exceed the CU meter at their own instruction (ComputationalBudgetExceeded). */
  v1BudgetMarkets?: Set<string>;
  /** Slab tail bytes (default SLAB_EXTRA). */
  slabExtra?: number;
  /** Status every accepted send of this format reports (getSignatureStatuses); unset = not found. */
  autoStatus?: { v1?: unknown; legacy?: unknown };
}

interface Attempt {
  format: "v1" | "legacy";
  wire: Uint8Array;
  accepted: boolean;
  markets: string[];
}

function mockConn(o: MockOpts) {
  const attempts: Attempt[] = [];
  const sims: Array<{ format: "v1" | "legacy"; markets: string[] }> = [];
  /** Simulates and sends in call order ("sim:<n markets>" / "send:<n markets>"). */
  const events: string[] = [];
  const statuses = new Map<string, unknown>();
  let featureReads = 0;
  const evalPushes = (ms: string[], offset: number): unknown => {
    const at = ms.findIndex((m) => o.locked?.has(m));
    return at >= 0 ? { InstructionError: [at + offset, { Custom: 21 }] } : null;
  };
  const conn = {
    commitment: "confirmed",
    async getAccountInfo(pk: { equals(o: unknown): boolean }) {
      if (pk.equals(TX_V1_FEATURE_ID)) {
        featureReads++;
        return o.v1Active ? { data: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]) } : null;
      }
      return null;
    },
    async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
      return pks.map((pk) => (o.markets.includes(pk.toBase58()) ? { data: marketAccount(100n, o.slabExtra ?? SLAB_EXTRA) } : null));
    },
    async simulateTransaction(tx: { instructions: Array<{ keys: Array<{ pubkey: { toBase58(): string } }> }> }) {
      const ms = tx.instructions.slice(1).map((ix) => ix.keys[1]!.pubkey.toBase58());
      sims.push({ format: "legacy", markets: ms });
      events.push(`sim:${ms.length}`);
      return { value: { err: evalPushes(ms, 1), logs: [] } };
    },
    async _rpcRequest(method: string, args: unknown[]) {
      const wire = Buffer.from(args[0] as string, "base64");
      if (method === "sendTransaction") {
        // Reached only through the web3.js-shaped sendRawTransaction below.
        return o.v1SendReject && wire[0] === 0x81
          ? { error: { code: FORMAT_REJECTION_CODE, message: FORMAT_REJECTION } }
          : { result: "unused" };
      }
      assert.equal(method, "simulateTransaction");
      assert.equal(wire[0], 0x81, "the raw simulate path is only used for v1");
      if (o.v1SimReject) return { error: { code: FORMAT_REJECTION_CODE, message: FORMAT_REJECTION } };
      const ms = marketsInWire(wire, WRAPPER);
      sims.push({ format: "v1", markets: ms });
      events.push(`sim:${ms.length}`);
      const budgetAt = ms.findIndex((x) => o.v1BudgetMarkets?.has(x));
      const lockedAt = ms.findIndex((x) => o.locked?.has(x));
      if (budgetAt >= 0 && (lockedAt < 0 || budgetAt < lockedAt)) {
        return { result: { value: { err: { InstructionError: [budgetAt, "ComputationalBudgetExceeded"] }, logs: [] } } };
      }
      return { result: { value: { err: o.v1SimErr ?? evalPushes(ms, 0), logs: [] } } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      const wire = Uint8Array.from(raw);
      const format = wire[0] === 0x81 ? "v1" : "legacy";
      const a: Attempt = { format, wire, accepted: false, markets: marketsInWire(wire, WRAPPER) };
      attempts.push(a);
      events.push(`send:${a.markets.length}`);
      if (format === "v1" && o.v1SendReject) {
        // Exactly what web3.js 1.99 sendEncodedTransaction does with a JSON-RPC error reply:
        // ask the transport, then throw a SendTransactionError carrying only the MESSAGE.
        const r = (await this._rpcRequest("sendTransaction", [Buffer.from(wire).toString("base64"), {}])) as {
          error?: { message: string };
        };
        if (r.error) throw new SendTransactionError({ action: "send", signature: "", transactionMessage: r.error.message });
      }
      if (o.sendError) throw new Error(o.sendError);
      a.accepted = true;
      const sig = `sig${attempts.length}`;
      const st = o.autoStatus?.[format];
      if (st !== undefined) statuses.set(sig, st);
      return sig;
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map((s) => statuses.get(s) ?? null) };
    },
  };
  return {
    conn,
    attempts,
    sims,
    events,
    statuses,
    accepted: () => attempts.filter((a) => a.accepted),
    featureReads: () => featureReads,
  };
}

const asPushes = (ms: string[]) => ms.map((m, i) => ({ marketAddress: m, assetIndex: 0, priceE6: 2_000_000n + BigInt(i) }));
const cycle = (conn: unknown, ms: string[], slot = GOLDEN_NOW_SLOT) =>
  pushAuthMarkBatch(conn as never, keeper, asPushes(ms), slot, GOLDEN_BLOCKHASH, false);
/** The K-2 canary is opt-in per test (it waits on signature statuses); every other test runs with it off. */
const settings = (env: Record<string, string>) => resetTxV1ForTests(parseTxV1Settings({ TX_V1_CANARY_CYCLES: "0", ...env }));

/** Every market of `ms` appears in exactly one accepted send. */
function assertEachPushedOnce(accepted: Attempt[], ms: string[]): void {
  const seen = accepted.flatMap((a) => a.markets);
  assert.equal(seen.length, new Set(seen).size, "no market may be sent twice");
  assert.deepEqual([...seen].sort(), [...ms].sort(), "every market sent exactly once");
}

beforeEach(() => resetTxV1ForTests());

describe("TX_V1=off (default): legacy path unchanged", () => {
  it("default settings are off", () => {
    assert.equal(parseTxV1Settings({}).mode, "off");
  });

  it("sends byte-identical legacy txs to the base commit (golden sha256 from 32cc1399)", async () => {
    resetTxV1ForTests();
    const got = await legacyGoldenScenarios(pushAuthMarkBatch as never);
    assert.deepEqual(got, GOLDEN);
  });

  it("does not read the feature gate or touch the raw transport when off", async () => {
    const ms = seededMarkets(10, 5);
    const m = mockConn({ markets: ms, v1Active: true });
    await cycle(m.conn, ms);
    assert.equal(m.featureReads(), 0);
    assert.ok(m.attempts.every((a) => a.format === "legacy"));
  });
});

describe("TX_V1=auto on a v1 cluster: fewer txs", () => {
  it("39 markets: 3 legacy txs -> 1 v1 tx carrying all 39, budget in the config mask", async () => {
    const ms = seededMarkets(11, 39);
    settings({});
    const legacy = mockConn({ markets: ms, v1Active: true });
    await cycle(legacy.conn, ms);
    assert.equal(legacy.accepted().length, 3, "legacy baseline: 13 + 13 + 13");

    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "0" });
    const v1 = mockConn({ markets: ms, v1Active: true });
    const res = await cycle(v1.conn, ms, GOLDEN_NOW_SLOT + 1n);
    assert.equal(v1.accepted().length, 1);
    assert.equal(res.pushedMarkets.length, 39);
    assert.deepEqual(v1.accepted()[0]!.markets, ms, "order preserved");
    assert.deepEqual({ txs: txV1Stats.lastCycleTxs, baseline: txV1Stats.lastCycleBaselineTxs, format: txV1Stats.lastFormat }, { txs: 1, baseline: 3, format: "v1" });

    const vt = VersionedTransaction.deserialize(v1.accepted()[0]!.wire);
    assert.equal(vt.version, 1);
    const msg = vt.message as MessageV1;
    assert.ok(v1.accepted()[0]!.wire.length <= 4096);
    const slabLen = marketAccount(100n, SLAB_EXTRA).length;
    assert.deepEqual(
      { ...msg.transactionConfig },
      {
        computeUnitLimit: DEFAULT_PUSH_CU_BASE + 39 * DEFAULT_PUSH_CU_PER_MARKET,
        loadedAccountsDataSizeLimit: Math.ceil((DEFAULT_LOADED_OVERHEAD_BYTES + 39 * (slabLen + 64)) * LOADED_HEADROOM),
        heapSize: null,
        priorityFee: null,
      },
    );
    // No ComputeBudget instruction in v1: every instruction is a push, same payload shape as legacy.
    for (const [i, ix] of msg.compiledInstructions.entries()) {
      assert.equal(msg.staticAccountKeys[ix.programIdIndex]!.toBase58(), WRAPPER);
      assert.equal(ix.data.length, 35);
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      assert.equal(dv.getBigUint64(19, true), 2_000_000n + BigInt(i), "mark_e6");
      assert.equal(dv.getBigUint64(11, true), GOLDEN_NOW_SLOT + 1n, "now_slot");
    }
  });

  it("48 markets (the live devnet set size), TX_V1_PUSH_MAX_MARKETS=0: 4 legacy txs -> 1 v1 tx", async () => {
    const ms = seededMarkets(12, 48);
    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "0" });
    const m = mockConn({ markets: ms, v1Active: true });
    await cycle(m.conn, ms);
    assert.equal(m.accepted().length, 1);
    assert.equal(txV1Stats.lastCycleBaselineTxs, 4);
    assertEachPushedOnce(m.accepted(), ms);
  });

  it("K-1(b): TX_V1_PUSH_MAX_MARKETS defaults to 16 (48 markets -> 16 + 16 + 16); 0 is explicit only", async () => {
    assert.equal(parseTxV1Settings({}).pushMaxMarkets, 16);
    assert.equal(parseTxV1Settings({ TX_V1_PUSH_MAX_MARKETS: "0" }).pushMaxMarkets, 0);
    const ms = seededMarkets(15, 48);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true });
    await cycle(m.conn, ms);
    assert.deepEqual(m.accepted().map((a) => a.markets.length), [16, 16, 16]);
    assertEachPushedOnce(m.accepted(), ms);
  });

  it("TX_V1_PUSH_MAX_MARKETS caps markets per v1 tx (39 at 20 -> 20 + 19)", async () => {
    const ms = seededMarkets(13, 39);
    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "20" });
    const m = mockConn({ markets: ms, v1Active: true });
    await cycle(m.conn, ms);
    assert.deepEqual(m.accepted().map((a) => a.markets.length), [20, 19]);
    assert.ok(m.accepted().every((a) => a.format === "v1"));
  });

  it("auto on a cluster WITHOUT v1 stays legacy", async () => {
    const ms = seededMarkets(14, 20);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: false });
    await cycle(m.conn, ms);
    assert.ok(m.attempts.length > 0 && m.attempts.every((a) => a.format === "legacy"));
  });
});

describe("fallback only on a FORMAT rejection, never lost or duplicated", () => {
  it("v1 rejected at send: the same markets go out in legacy, each exactly once; v1 suspended next cycle", async () => {
    const ms = seededMarkets(20, 39);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true, v1SendReject: true });
    const res = await cycle(m.conn, ms);
    assert.equal(m.attempts.filter((a) => a.format === "v1").length, 1, "one v1 attempt");
    assert.ok(m.accepted().every((a) => a.format === "legacy"));
    assert.equal(m.accepted().length, 3);
    assertEachPushedOnce(m.accepted(), ms);
    assert.equal(res.pushedMarkets.length, 39);
    assert.equal(txV1Stats.fallbacks, 1);

    const before = m.attempts.length;
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n);
    assert.ok(m.attempts.slice(before).every((a) => a.format === "legacy"), "suspended: no v1 re-probe every cycle");
  });

  it("v1 rejected at preflight (JSON-RPC decode error): legacy, each market once, no v1 send", async () => {
    const ms = seededMarkets(21, 30);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true, v1SimReject: true });
    await cycle(m.conn, ms);
    assert.equal(m.attempts.filter((a) => a.format === "v1").length, 0);
    assertEachPushedOnce(m.accepted(), ms);
    assert.equal(txV1Stats.fallbacks, 1);
  });

  it("a tx-level v1 BUDGET error (loaded size: names no market) in preflight re-sends in legacy and strikes no market", async () => {
    const ms = seededMarkets(22, 26);
    settings({ TX_V1: "auto", TX_V1_RETRY_AFTER_REJECT_MS: "0" });
    for (let c = 0; c < 4; c++) {
      const m = mockConn({ markets: ms, v1Active: true, v1SimErr: "MaxLoadedAccountsDataSizeExceeded" });
      await cycle(m.conn, ms, GOLDEN_NOW_SLOT + BigInt(c));
      assertEachPushedOnce(m.accepted(), ms);
      assert.ok(m.accepted().every((a) => a.format === "legacy"));
    }
    assert.deepEqual(getQuarantinedMarkets().filter((q) => ms.includes(q)), [], "budget errors are not market faults");
  });
});

describe("K-3: a budget error is attributed to its market, not a global switch", () => {
  it("one market over the CU meter: prefix sent in v1, that market in legacy, the rest stays v1; no suspension, no strike", async () => {
    const ms = seededMarkets(23, 16);
    const heavy = ms[5]!;
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true, v1BudgetMarkets: new Set([heavy]) });
    const res = await cycle(m.conn, ms);
    assert.deepEqual(
      m.accepted().map((a) => [a.format, a.markets]),
      [
        ["v1", ms.slice(0, 5)],
        ["v1", ms.slice(6)],
        ["legacy", [heavy]],
      ],
    );
    assertEachPushedOnce(m.accepted(), ms);
    assert.equal(res.pushedMarkets.length, 16);
    assert.equal(txV1Stats.fallbacks, 0, "v1 is kept for the other markets");
    assert.deepEqual(getQuarantinedMarkets().filter((q) => ms.includes(q)), []);
    const before = m.attempts.length;
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n);
    assert.equal(m.attempts[before]!.format, "v1", "not suspended");
  });

  it("budget errors on more than 2 (V1_BUDGET_MARKETS_PER_CYCLE) distinct markets in one cycle suspend v1", async () => {
    const ms = seededMarkets(24, 16);
    const heavy = new Set([ms[2]!, ms[6]!, ms[11]!]);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true, v1BudgetMarkets: heavy });
    const res = await cycle(m.conn, ms);
    assertEachPushedOnce(m.accepted(), ms);
    assert.equal(res.pushedMarkets.length, 16);
    assert.equal(txV1Stats.fallbacks, 1);
    // Sent in v1: the three proven prefixes (each proven before its budget hit); everything else legacy.
    assert.deepEqual(m.accepted().filter((a) => a.format === "v1").map((a) => a.markets), [ms.slice(0, 2), ms.slice(3, 6), ms.slice(7, 11)]);
    const before = m.attempts.length;
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n);
    assert.ok(m.attempts.slice(before).every((a) => a.format === "legacy"), "suspended");
  });

  it("chunkPushesV1 splits when the summed loaded-accounts size would exceed the configured limit", async () => {
    const extra = 5_000_000;
    const slab = marketAccount(100n, extra).length;
    const ms = seededMarkets(25, 8);
    // overhead 2,000,000 + 3 x (slab + 64) fits 20,000,000; 4 do not.
    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "0", TX_V1_LOADED_ACCOUNTS_BYTES: "20000000" });
    assert.ok(2_000_000 + 3 * (slab + 64) <= 20_000_000 && 2_000_000 + 4 * (slab + 64) > 20_000_000);
    const m = mockConn({ markets: ms, v1Active: true, slabExtra: extra });
    await cycle(m.conn, ms);
    assert.deepEqual(m.accepted().map((a) => a.markets.length), [3, 3, 2]);
    assertEachPushedOnce(m.accepted(), ms);
  });

  it("chunkPushesV1 splits when the DERIVED limit (with headroom) would pass the 64 MiB cap", async () => {
    const extra = 100_000;
    const slab = marketAccount(100n, extra).length;
    const overhead = 53_000_000;
    const max = Math.floor((64 * 1024 * 1024) / LOADED_HEADROOM - overhead) / (slab + 64);
    const per = Math.floor(max);
    assert.ok(per >= 2 && per < 20);
    const ms = seededMarkets(26, 20);
    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "0", TX_V1_LOADED_OVERHEAD_BYTES: String(overhead) });
    const m = mockConn({ markets: ms, v1Active: true, slabExtra: extra });
    await cycle(m.conn, ms);
    const sizes = m.accepted().map((a) => a.markets.length);
    assert.ok(sizes.every((n) => n <= per) && sizes[0] === per, JSON.stringify({ sizes, per }));
    for (const a of m.accepted()) {
      const cfg = (VersionedTransaction.deserialize(a.wire).message as MessageV1).transactionConfig;
      assert.ok((cfg.loadedAccountsDataSizeLimit ?? 0) <= 64 * 1024 * 1024);
      assert.ok((cfg.loadedAccountsDataSizeLimit ?? 0) >= overhead + a.markets.length * (slab + 64), "limit covers what it loads");
    }
    assertEachPushedOnce(m.accepted(), ms);
  });
});

describe("an on-chain error never falls back or resends", () => {
  it("K-1(a): a reverting market is excluded (v1 ix index); the prefix its simulate proved is SENT FIRST, then the rest", async () => {
    const ms = seededMarkets(30, 39);
    const bad = ms[17]!;
    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "0" });
    const m = mockConn({ markets: ms, v1Active: true, locked: new Set([bad]) });
    const res = await cycle(m.conn, ms);
    assert.deepEqual(
      m.accepted().map((a) => a.markets),
      [ms.slice(0, 17), ms.slice(18)],
      "proven prefix 0..16, culprit 17 excluded, remainder 18..38",
    );
    assert.deepEqual(m.events, ["sim:39", "send:17", "sim:21", "send:21"], "the prefix goes out before the remainder is re-simulated");
    assert.deepEqual(res.skippedMarkets, [bad]);
    assert.equal(txV1Stats.fallbacks, 0);
    assert.ok(m.attempts.every((a) => a.format === "v1"));
  });

  it("K-1(a): several bad markets: each proven prefix is sent before the next isolation simulate", async () => {
    const ms = seededMarkets(34, 16);
    const bad = new Set([ms[3]!, ms[9]!, ms[10]!]);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true, locked: bad });
    const res = await cycle(m.conn, ms);
    assert.deepEqual(m.events, ["sim:16", "send:3", "sim:12", "send:5", "sim:6", "sim:5", "send:5"]);
    assertEachPushedOnce(m.accepted(), ms.filter((x) => !bad.has(x)));
    assert.deepEqual([...res.skippedMarkets].sort(), [...bad].sort());
  });

  it("K-1(c): isolation re-simulations are capped per cycle; the rest waits (not struck, not quarantined)", async () => {
    const ms = seededMarkets(35, 16);
    const bad = new Set([ms[1]!, ms[3]!, ms[5]!, ms[7]!, ms[9]!]);
    settings({ TX_V1: "auto", TX_V1_ISOLATION_MAX_SIMS: "2" });
    const m = mockConn({ markets: ms, v1Active: true, locked: bad });
    const res = await cycle(m.conn, ms);
    assert.equal(m.sims.length, 3, "first simulate + 2 isolation re-simulations");
    assert.deepEqual(m.accepted().map((a) => a.markets), [ms.slice(0, 1), ms.slice(2, 3), ms.slice(4, 5)]);
    assert.equal(txV1Stats.lastCycleIsolationSims, 2);
    assert.equal(txV1Stats.isolationCapHits, 1);
    // ms[5] (bad) and everything after it wait for the next cycle; only the 3 PROVEN culprits were struck.
    assert.equal(res.skippedMarkets.length, 16 - 3);
    assert.deepEqual(getQuarantinedMarkets().filter((q) => ms.includes(q)), []);
    assert.equal(parseTxV1Settings({}).isolationMaxSims, 8);
    assert.throws(() => parseTxV1Settings({ TX_V1_ISOLATION_MAX_SIMS: "0" }), /TX_V1_ISOLATION_MAX_SIMS/);
  });

  it("a non-format send error is recorded and NOT resent in any format", async () => {
    const ms = seededMarkets(31, 39);
    settings({ TX_V1: "auto", TX_V1_PUSH_MAX_MARKETS: "0" });
    const m = mockConn({
      markets: ms,
      v1Active: true,
      sendError: "failed to send transaction: Transaction simulation failed: Error processing Instruction 4: custom program error: 0x15",
    });
    const res = await cycle(m.conn, ms);
    assert.equal(m.attempts.length, 1, "one attempt, no resend");
    assert.equal(res.pushedMarkets.length, 0);
    assert.equal(res.skippedMarkets.length, 39);
    assert.equal(txV1Stats.fallbacks, 0);
  });

  it("a network error on a v1 send is not resent (it may have been accepted)", async () => {
    const ms = seededMarkets(32, 10);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true, sendError: "fetch failed" });
    await cycle(m.conn, ms);
    assert.equal(m.attempts.length, 1);
    assert.equal(txV1Stats.fallbacks, 0);
  });
});

describe("format rejection is classified by JSON-RPC CODE only (SDK-3)", () => {
  /** A real web3.js 1.99 Connection whose transport is stubbed (nothing leaves the process). */
  const realConn = (reply: (method: string) => unknown, calls: string[] = []) => {
    const c = new Connection("http://127.0.0.1:9", "confirmed");
    (c as unknown as { _rpcRequest: unknown })._rpcRequest = async (method: string) => {
      calls.push(method);
      return reply(method);
    };
    return c;
  };
  const someWire = Uint8Array.from([0x81, 1, 2, 3]);

  it("real web3.js sendRawTransaction drops the code; sendWire recovers it from the same reply", async () => {
    const conn = realConn(() => ({ jsonrpc: "2.0", id: "1", error: { code: FORMAT_REJECTION_CODE, message: FORMAT_REJECTION } }));
    // Baseline: what web3.js itself throws carries no code (so a code-only classifier sees nothing).
    const plain = await conn.sendRawTransaction(someWire, { skipPreflight: true, maxRetries: 0 }).catch((e: unknown) => e);
    assert.ok(plain instanceof SendTransactionError);
    assert.equal(isFormatRejection(plain), false);
    const typed = await sendWire(conn, someWire, { skipPreflight: true, maxRetries: 0 }).catch((e: unknown) => e);
    assert.ok(typed instanceof V1RpcError);
    assert.equal((typed as V1RpcError).code, FORMAT_REJECTION_CODE);
    assert.equal(isFormatRejection(typed), true);
  });

  it("other JSON-RPC codes (e.g. -32002 preflight failure, -32005 node behind) are NOT format rejections", async () => {
    for (const code of [-32002, -32005, -32603]) {
      const conn = realConn(() => ({ jsonrpc: "2.0", id: "1", error: { code, message: "unsupported transaction version / too large" } }));
      const e = await sendWire(conn, someWire, { skipPreflight: true, maxRetries: 0 }).catch((x: unknown) => x);
      assert.equal((e as V1RpcError).code, code);
      assert.equal(isFormatRejection(e), false, `code ${code}`);
    }
  });

  it("simulateWire turns a JSON-RPC error reply into a coded V1RpcError", async () => {
    const conn = realConn(() => ({ jsonrpc: "2.0", id: "1", error: { code: FORMAT_REJECTION_CODE, message: FORMAT_REJECTION } }));
    const e = await simulateWire(conn, someWire).catch((x: unknown) => x);
    assert.ok(e instanceof V1RpcError && e.code === FORMAT_REJECTION_CODE && isFormatRejection(e));
  });

  it("sendWire honours the dry-run hard stop (connection.sendRawTransaction replaced): the transport is never reached", async () => {
    const calls: string[] = [];
    const conn = realConn(() => ({ result: "sig" }), calls);
    conn.sendRawTransaction = () => {
      throw new Error("DRY-RUN: transaction send blocked at the connection");
    };
    await assert.rejects(sendWire(conn, someWire, { skipPreflight: true }), /DRY-RUN/);
    assert.deepEqual(calls, []);
  });

  it("plain Error TEXT that looks like a format rejection is never one: recorded, NOT resent in legacy", async () => {
    const ms = seededMarkets(33, 10);
    settings({ TX_V1: "auto" });
    for (const text of [
      `failed to send transaction: ${FORMAT_REJECTION}`,
      "fetch failed: request entity too large (-32602)",
      "transaction version (1) is not supported",
    ]) {
      const m = mockConn({ markets: ms, v1Active: true, sendError: text });
      const res = await cycle(m.conn, ms);
      assert.equal(m.attempts.length, 1, `one attempt, no resend: ${text}`);
      assert.equal(m.attempts[0]!.format, "v1");
      assert.equal(res.pushedMarkets.length, 0);
      assert.equal(txV1Stats.fallbacks, 0);
    }
  });
});

describe("TX_V1=on: fails closed only on detection; a runtime rejection never skips a cycle (K-4)", () => {
  it("cluster without v1: nothing simulated, nothing sent, every market skipped", async () => {
    const ms = seededMarkets(40, 12);
    settings({ TX_V1: "on" });
    const m = mockConn({ markets: ms, v1Active: false });
    const res = await cycle(m.conn, ms);
    assert.equal(m.attempts.length, 0);
    assert.equal(m.sims.length, 0);
    assert.deepEqual([...res.skippedMarkets].sort(), [...ms].sort());
    assert.equal(txV1Stats.failClosedCycles, 1);
  });

  it("a send-time format rejection under TX_V1=on falls back to legacy for THAT cycle; the next cycle tries v1 again", async () => {
    const ms = seededMarkets(41, 12);
    settings({ TX_V1: "on" });
    const m = mockConn({ markets: ms, v1Active: true, v1SendReject: true });
    const res = await cycle(m.conn, ms);
    assert.equal(m.attempts.filter((a) => a.format === "v1").length, 1, "one v1 attempt");
    assert.ok(m.accepted().length > 0 && m.accepted().every((a) => a.format === "legacy"));
    assertEachPushedOnce(m.accepted(), ms);
    assert.equal(res.pushedMarkets.length, 12, "no market skipped");
    assert.equal(txV1Stats.fallbacks, 1);
    const before = m.attempts.length;
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n);
    assert.equal(m.attempts[before]!.format, "v1", "on is not suspended: v1 is tried again next cycle");
  });

  it("a preflight format rejection or v1 budget error under TX_V1=on still pushes every market (legacy)", async () => {
    const ms = seededMarkets(42, 20);
    for (const o of [{ v1SimReject: true }, { v1SimErr: "MaxLoadedAccountsDataSizeExceeded" }]) {
      settings({ TX_V1: "on" });
      const m = mockConn({ markets: ms, v1Active: true, ...o });
      const res = await cycle(m.conn, ms);
      assert.equal(m.attempts.filter((a) => a.format === "v1").length, 0);
      assertEachPushedOnce(m.accepted(), ms);
      assert.equal(res.pushedMarkets.length, 20, JSON.stringify(o));
    }
  });
});

describe("K-2: landing canary and the sent-vs-landed alert", () => {
  const CONFIRMED = { err: null, confirmationStatus: "confirmed", slot: 1, confirmations: 1 };
  const canaryEnv = { TX_V1: "auto", TX_V1_CANARY_CYCLES: "2", TX_V1_CANARY_TIMEOUT_MS: "30" };
  const health = async () =>
    ((await import("./tx-v1.ts")).txV1HealthFields() as {
      txV1: {
        canary: { required: number; active: boolean; passed: number; failures: number; lastResult: string | null };
        landing: { v1TxsSent: number; v1LandedOk: number; sentSinceLastLandedOk: number; stalled: boolean };
        suspendedKind: string | null;
      };
    }).txV1;

  it("defaults: 5 canary cycles, 10 s", () => {
    const d = parseTxV1Settings({});
    assert.deepEqual({ c: d.canaryCycles, t: d.canaryTimeoutMs }, { c: 5, t: 10_000 });
    assert.throws(() => parseTxV1Settings({ TX_V1_CANARY_TIMEOUT_MS: "0" }), /TX_V1_CANARY_TIMEOUT_MS/);
  });

  it("confirmed v1 txs pass the canary; after N cycles it stops reading statuses inline", async () => {
    resetPushLandingState();
    const ms = seededMarkets(60, 20);
    settings(canaryEnv);
    const m = mockConn({ markets: ms, v1Active: true, autoStatus: { v1: CONFIRMED } });
    let reads = 0;
    const gss = m.conn.getSignatureStatuses.bind(m.conn);
    m.conn.getSignatureStatuses = async (sigs: string[]) => {
      reads++;
      return gss(sigs);
    };
    for (let c = 0; c < 3; c++) await cycle(m.conn, ms, GOLDEN_NOW_SLOT + BigInt(c));
    const h = await health();
    assert.deepEqual({ passed: h.canary.passed, active: h.canary.active, last: h.canary.lastResult }, { passed: 2, active: false, last: "confirmed" });
    assert.equal(reads, 2, "one inline status read per canary cycle, none after");
    assert.equal(h.landing.v1LandedOk, 4, "2 canary cycles x 2 v1 txs (16 + 4)");
    assert.ok(m.accepted().every((a) => a.format === "v1"));
  });

  it("an UNLANDED canary v1 tx: re-pushed in legacy (same markets, once), v1 suspended; landed ones are not re-sent", async () => {
    resetPushLandingState();
    const ms = seededMarkets(61, 20);
    settings(canaryEnv);
    const m = mockConn({ markets: ms, v1Active: true });
    // First v1 tx (16 markets) lands; the second (4 markets) never shows up.
    const send = m.conn.sendRawTransaction.bind(m.conn);
    m.conn.sendRawTransaction = async (raw: Uint8Array) => {
      const sig = await send(raw);
      if (sig === "sig1") m.statuses.set(sig, CONFIRMED);
      return sig;
    };
    const res = await cycle(m.conn, ms);
    assert.deepEqual(
      m.accepted().map((a) => [a.format, a.markets.length]),
      [
        ["v1", 16],
        ["v1", 4],
        ["legacy", 4],
      ],
    );
    assert.deepEqual(m.accepted()[2]!.markets, ms.slice(16), "exactly the unlanded tx's markets");
    // Same observation sequence as the unlanded v1 push (at most one of them can land).
    const seqOf = (w: Uint8Array) =>
      VersionedTransaction.deserialize(w).message.compiledInstructions
        .filter((ix) => ix.data.length === 35)
        .map((ix) => new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(27, true));
    assert.deepEqual(seqOf(m.accepted()[2]!.wire), seqOf(m.accepted()[1]!.wire));
    assert.equal(res.pushedMarkets.length, 20);
    assert.equal(new Set(res.pushedMarkets).size, 20);
    const h = await health();
    assert.deepEqual({ f: h.canary.failures, last: h.canary.lastResult, kind: h.suspendedKind }, { f: 1, last: "unlanded", kind: "landing" });
    assert.equal(txV1Stats.landingSuspensions, 1);
    const before = m.attempts.length;
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n);
    assert.ok(m.attempts.slice(before).every((a) => a.format === "legacy"), "suspended");
  });

  it("a canary v1 tx seen PROCESSED (landed, unconfirmed) is never re-pushed and suspends nothing", async () => {
    resetPushLandingState();
    const ms = seededMarkets(62, 10);
    settings(canaryEnv);
    const m = mockConn({ markets: ms, v1Active: true, autoStatus: { v1: { err: null, confirmationStatus: "processed", slot: 1, confirmations: 0 } } });
    await cycle(m.conn, ms);
    assert.deepEqual(m.accepted().map((a) => a.format), ["v1"]);
    const h = await health();
    assert.deepEqual({ last: h.canary.lastResult, passed: h.canary.passed, f: h.canary.failures }, { last: "inconclusive", passed: 0, f: 0 });
    assert.equal(txV1Stats.landingSuspensions, 0);
  });

  it("an unreadable status (RPC error) never triggers a re-push", async () => {
    resetPushLandingState();
    const ms = seededMarkets(63, 10);
    settings(canaryEnv);
    const m = mockConn({ markets: ms, v1Active: true });
    m.conn.getSignatureStatuses = async () => {
      throw new Error("429");
    };
    await cycle(m.conn, ms);
    assert.deepEqual(m.accepted().map((a) => a.format), ["v1"]);
    assert.equal(txV1Stats.landingSuspensions, 0);
  });

  it("/health flags v1TxsSent growing while no v1 tx is seen landed OK", async () => {
    resetPushLandingState();
    const ms = seededMarkets(64, 16);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true });
    for (let c = 0; c < 20; c++) await cycle(m.conn, ms, GOLDEN_NOW_SLOT + BigInt(c));
    let h = await health();
    assert.deepEqual({ sent: h.landing.v1TxsSent, ok: h.landing.v1LandedOk, stalled: h.landing.stalled }, { sent: 20, ok: 0, stalled: true });
    m.statuses.set("sig20", CONFIRMED);
    await reconcilePushOutcomes(m.conn as never, Date.now() + 10_000);
    h = await health();
    assert.deepEqual({ ok: h.landing.v1LandedOk, since: h.landing.sentSinceLastLandedOk, stalled: h.landing.stalled }, { ok: 1, since: 0, stalled: false });
  });
});

describe("landed v1 reverts are classified with the v1 instruction offset", () => {
  it("a superseded Custom(19) at ix 0 of a v1 tx is a late duplicate, not an 'other' revert", async () => {
    resetPushLandingState();
    const ms = seededMarkets(50, 5);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: true });
    await cycle(m.conn, ms);
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n); // higher nonces sent for the same markets
    assert.equal(m.accepted().length, 2);
    m.statuses.set("sig1", { err: { InstructionError: [0, { Custom: 19 }] } });
    m.statuses.set("sig2", { err: null });
    await reconcilePushOutcomes(m.conn as never, Date.now() + 10_000);
    assert.deepEqual({ late: pushLandingStats.lateDuplicateReverts, other: pushLandingStats.otherReverts, ok: pushLandingStats.landedOk }, { late: 1, other: 0, ok: 1 });
    // The benign late duplicate must NOT suspend v1.
    assert.equal(txV1Stats.landingSuspensions, 0);
    const before = m.attempts.length;
    await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 2n);
    assert.equal(m.attempts[before]!.format, "v1");
  });

  for (const mode of ["auto", "on"] as const) {
    it(`K-1(d): any other LANDED v1 revert suspends v1 (${mode}); the next cycle is legacy`, async () => {
      resetPushLandingState();
      const ms = seededMarkets(51, 5);
      settings({ TX_V1: mode });
      const m = mockConn({ markets: ms, v1Active: true });
      await cycle(m.conn, ms);
      m.statuses.set("sig1", { err: { InstructionError: [2, { Custom: 21 }] } });
      await reconcilePushOutcomes(m.conn as never, Date.now() + 10_000);
      assert.equal(pushLandingStats.otherReverts, 1);
      assert.equal(txV1Stats.landingSuspensions, 1);
      const before = m.attempts.length;
      await cycle(m.conn, ms, GOLDEN_NOW_SLOT + 1n);
      assert.ok(m.attempts.length > before && m.attempts.slice(before).every((a) => a.format === "legacy"));
      const h = (await import("./tx-v1.ts")).txV1HealthFields() as { txV1: { suspended: boolean; suspendedKind: string } };
      assert.deepEqual({ s: h.txV1.suspended, k: h.txV1.suspendedKind }, { s: true, k: "landing" });
    });
  }

  it("K-1(d): a landed LEGACY revert does not touch v1", async () => {
    resetPushLandingState();
    const ms = seededMarkets(52, 5);
    settings({ TX_V1: "auto" });
    const m = mockConn({ markets: ms, v1Active: false }); // auto on a cluster without v1 -> legacy
    await cycle(m.conn, ms);
    m.statuses.set("sig1", { err: { InstructionError: [2, { Custom: 21 }] } });
    await reconcilePushOutcomes(m.conn as never, Date.now() + 10_000);
    assert.equal(pushLandingStats.otherReverts, 1);
    assert.equal(txV1Stats.landingSuspensions, 0);
  });
});

describe("parsing", () => {
  it("parseFailingPush: v1 offset 0 maps ix i to push i; legacy default unchanged", () => {
    assert.deepEqual(parseFailingPush({ InstructionError: [0, { Custom: 19 }] }, 3, 0), { position: 0, custom: 19 });
    assert.deepEqual(parseFailingPush({ InstructionError: [2, { Custom: 21 }] }, 3, 0), { position: 2, custom: 21 });
    assert.equal(parseFailingPush({ InstructionError: [3, { Custom: 21 }] }, 3, 0), null);
    assert.equal(parseFailingPush({ InstructionError: [0, { Custom: 19 }] }, 3), null, "legacy: ix 0 is ComputeBudget");
  });

  it("parseTxV1Settings validates", () => {
    assert.equal(parseTxV1Settings({ TX_V1: "auto" }).mode, "auto");
    assert.equal(parseTxV1Settings({ TX_V1: "ON" }).mode, "on");
    assert.throws(() => parseTxV1Settings({ TX_V1: "yes please" }), /TX_V1/);
    assert.throws(() => parseTxV1Settings({ TX_V1_HEAP_BYTES: "1000" }), /TX_V1_HEAP_BYTES/);
    assert.throws(() => parseTxV1Settings({ TX_V1_PUSH_MAX_MARKETS: "65" }), /TX_V1_PUSH_MAX_MARKETS/);
    assert.throws(() => parseTxV1Settings({ TX_V1_PUSH_CU_PER_MARKET: "10" }), /TX_V1_PUSH_CU_PER_MARKET/);
    assert.equal(parseTxV1Settings({ TX_V1_LOADED_ACCOUNTS_BYTES: "5000000" }).loadedAccountsBytes, 5_000_000);
  });
});

describe("/health", () => {
  it("adds `txV1` only when TX_V1 is not off", async () => {
    const { txV1HealthFields } = await import("./tx-v1.ts");
    resetTxV1ForTests();
    assert.deepEqual(txV1HealthFields(), {});
    settings({ TX_V1: "auto" });
    const h = txV1HealthFields() as { txV1: { mode: string; lastCycleTxs: number; lastCycleBaselineTxs: number } };
    assert.equal(h.txV1.mode, "auto");
    assert.ok("lastCycleTxs" in h.txV1 && "lastCycleBaselineTxs" in h.txV1);
  });
});
