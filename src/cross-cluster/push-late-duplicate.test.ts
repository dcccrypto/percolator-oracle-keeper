/**
 * PushAuthMark late-duplicate Custom(19) (landed reverts, 2026-10-04).
 *
 * Live evidence (1000 txs touching Percolator 9EPm8nB8, deployment 7b8998ac): 46
 * landed `InstructionError [1, Custom(19)]`, every one landing 1-13 slots AFTER
 * a higher-nonce tx for the same markets, none sharing a nonce with another tx,
 * all aged 12-22 slots at landing vs 4-5 for a normal push. They are delayed
 * copies (RPC `maxRetries` rebroadcast) of a cycle whose successor was already
 * in flight. The wrapper rule is `proposed <= current -> EngineStale`.
 *
 * The fake models exactly that transport: a tx whose first delivery is dropped
 * is rebroadcast by the node iff the keeper asked for `maxRetries > 0`, and the
 * rebroadcast lands after everything sent since.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/push-late-duplicate.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
} from "@percolatorct/sdk";
import {
  pushAuthMarkBatch,
  reconcilePushOutcomes,
  resetPushLandingState,
  pushLandingStats,
  PUSH_SEND_OPTIONS,
} from "./auth-mark-pusher.ts";

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
const PRICE = 1_000_000n;
const ENGINE_STALE = 19;

type Push = { market: string; seq: bigint };
type IxLike = { keys: Array<{ pubkey: { toBase58(): string } }>; data: Uint8Array };
type SendOpts = { skipPreflight?: boolean; maxRetries?: number };

function marketAccount(oracleObservation: bigint): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, oracleObservation, true);
  return buf;
}

function decodePushes(ixs: IxLike[]): Push[] {
  return ixs.slice(1).map((ix) => ({
    market: ix.keys[1].pubkey.toBase58(),
    seq: new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(27, true),
  }));
}

/** Wrapper nonce rule + a node that rebroadcasts dropped txs only when asked to. */
function chain(marketsList: string[]) {
  const ledger = new Map(marketsList.map((m) => [m, 100n]));
  let lastSim: Push[] = [];
  const sent: Array<{ pushes: Push[]; opts: SendOpts; sig: string }> = [];

  const execute = (pushes: Push[], commit: boolean) => {
    const next = new Map(ledger);
    for (let i = 0; i < pushes.length; i++) {
      if (pushes[i].seq <= (next.get(pushes[i].market) ?? 0n)) return { InstructionError: [i + 1, { Custom: ENGINE_STALE }] };
      next.set(pushes[i].market, pushes[i].seq);
    }
    if (commit) for (const [k, v] of next) ledger.set(k, v);
    return null;
  };

  const conn = {
    async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
      return pks.map((pk) => ({ data: marketAccount(ledger.get(pk.toBase58()) ?? 0n) }));
    },
    async simulateTransaction(tx: { instructions: IxLike[] }) {
      lastSim = decodePushes(tx.instructions);
      return { value: { err: execute(lastSim, false) } };
    },
    async sendRawTransaction(_raw: Uint8Array, opts: SendOpts) {
      const sig = `sig${sent.length}`;
      sent.push({ pushes: lastSim, opts, sig });
      return sig;
    },
  };

  /**
   * Land the network's deliveries. `dropped` = indexes whose FIRST delivery was
   * lost. Everything else lands in send order; then the node rebroadcasts each
   * dropped tx that asked for retries, so the copy lands last.
   */
  function land(dropped: number[]) {
    const results: Array<{ i: number; copy: boolean; err: unknown }> = [];
    sent.forEach((s, i) => {
      if (!dropped.includes(i)) results.push({ i, copy: false, err: execute(s.pushes, true) });
    });
    for (const i of dropped) {
      if ((sent[i].opts.maxRetries ?? 0) > 0) results.push({ i, copy: true, err: execute(sent[i].pushes, true) });
    }
    return results;
  }

  return { conn, ledger, sent, land };
}

const markets = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
const asPushes = (ms: string[]) => ms.map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: PRICE }));

describe("late-duplicate Custom(19): a dropped cycle must not be resurrected after its successor", () => {
  beforeEach(() => resetPushLandingState());

  it("sends pushes without node-level rebroadcast", async () => {
    const ms = markets(3);
    const c = chain(ms);
    await pushAuthMarkBatch(c.conn as never, Keypair.generate(), asPushes(ms), 100n, BLOCKHASH, false);
    assert.equal(c.sent.length, 1);
    assert.equal(c.sent[0].opts.maxRetries, 0, "a stale push has no value once its successor is in flight");
    assert.equal(c.sent[0].opts.skipPreflight, true);
    assert.deepEqual({ ...PUSH_SEND_OPTIONS }, { skipPreflight: true, maxRetries: 0 });
  });

  it("no landed tx reverts when cycle N's first delivery is dropped and cycle N+1 lands", async () => {
    const ms = markets(13);
    const c = chain(ms);
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false); // cycle N (dropped)
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false); // cycle N+1

    const results = c.land([0]);
    const reverted = results.filter((r) => r.err !== null);
    assert.deepEqual(reverted, [], `landed reverts: ${JSON.stringify(reverted)}`);
    const newest = results.find((r) => r.i === 1 && !r.copy);
    assert.equal(newest?.err, null, "the newest cycle must land cleanly");
  });
});

/** Fake RPC for reconcilePushOutcomes. `statuses` maps signature -> status (absent = unknown to the cluster). */
function statusConn(statuses: Record<string, { err: unknown } | undefined>) {
  const calls: string[][] = [];
  return {
    calls,
    conn: {
      async getSignatureStatuses(sigs: string[]) {
        calls.push(sigs);
        return { value: sigs.map((s) => statuses[s] ?? null) };
      },
    },
  };
}

describe("reconcilePushOutcomes: landed push reverts are classified, not invisible", () => {
  beforeEach(() => resetPushLandingState());

  async function twoCycles(statusFor: (sigs: string[]) => Record<string, { err: unknown } | undefined>) {
    const ms = markets(2);
    const c = chain(ms);
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);
    return { sigs: c.sent.map((s) => s.sig), ...statusConn(statusFor(c.sent.map((s) => s.sig))) };
  }

  it("counts Custom(19) on an already-superseded push as a benign late duplicate", async () => {
    const stale = { err: { InstructionError: [1, { Custom: ENGINE_STALE }] } };
    const { sigs, conn } = await twoCycles((s) => ({ [s[0]]: stale, [s[1]]: { err: null } }));
    await reconcilePushOutcomes(conn as never, Date.now() + 10_000);
    assert.equal(pushLandingStats.lateDuplicateReverts, 1);
    assert.equal(pushLandingStats.landedOk, 1);
    assert.equal(pushLandingStats.otherReverts, 0);
    void sigs;
  });

  it("flags Custom(19) on the NEWEST push (nothing superseded it) and any other revert as real", async () => {
    const stale = { err: { InstructionError: [1, { Custom: ENGINE_STALE }] } };
    const lock = { err: { InstructionError: [2, { Custom: 21 }] } };
    const { conn } = await twoCycles((s) => ({ [s[0]]: lock, [s[1]]: stale }));
    await reconcilePushOutcomes(conn as never, Date.now() + 10_000);
    assert.equal(pushLandingStats.lateDuplicateReverts, 0);
    assert.equal(pushLandingStats.otherReverts, 2);
  });

  it("asks nothing of the RPC for txs too young to have landed, and keeps unknown ones until give-up", async () => {
    const { conn, calls } = await twoCycles(() => ({}));
    await reconcilePushOutcomes(conn as never, Date.now());
    assert.equal(calls.length, 0, "no RPC call while every tx is younger than the landing window");
    await reconcilePushOutcomes(conn as never, Date.now() + 10_000);
    assert.equal(calls.length, 1);
    assert.equal(pushLandingStats.unlanded, 0, "not yet given up on");
    await reconcilePushOutcomes(conn as never, Date.now() + 120_000);
    assert.equal(pushLandingStats.unlanded, 2);
  });

  it("never throws when the RPC fails", async () => {
    const { conn } = await twoCycles(() => ({}));
    const broken = { getSignatureStatuses: async () => { throw new Error("429"); } };
    await assert.doesNotReject(reconcilePushOutcomes(broken as never, Date.now() + 10_000));
    void conn;
  });
});
