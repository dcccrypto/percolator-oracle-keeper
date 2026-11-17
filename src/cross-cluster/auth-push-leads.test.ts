/**
 * Audit of three suspected bugs in auth-mark-pusher.ts (job J-20261117-K-BUG-AUTHPUSHQUARANTINE).
 * All three came out NOT real; these tests pin the behaviour so a regression shows up.
 *
 * Lead 1 (strikes never reset): covered by auth-mark-pusher.test.ts "clears strikes once a market pushes cleanly again";
 *   the reset is at the send() success path, and quarantine expiry also clears them. Here: the expiry path.
 * Lead 2 (unlanded send leaves lastSent ahead of chain): the nonce only has to be strictly increasing (gaps fine), so
 *   a never-landed send makes the next proposal lastSent+1 > chain, which is valid; nothing is rejected or refilled.
 * Lead 3 (solo never expires): getSoloMarkets filters on soloUntil > nowMs and the revert window is pruned on each note.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/auth-push-leads.test.ts
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
  SOLO_AFTER_LANDED_REVERTS,
  SOLO_MS,
  SOLO_STRIKE_WINDOW_MS,
  getSoloMarkets,
  pushAuthMarkBatch,
  reconcilePushOutcomes,
  resetPushLandingState,
} from "./auth-mark-pusher.ts";
import { nonComputeBudget } from "./test-ix.ts";
import type { PublicKey } from "@solana/web3.js";

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

function marketAccount(oracleObservation: bigint): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const v = new DataView(buf.buffer);
  v.setBigUint64(0, V17_MAGIC, true);
  v.setUint16(8, V17_EXPECTED_VERSION, true);
  v.setBigUint64(marketIdOff, 1n, true);
  v.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, oracleObservation, true);
  return buf;
}

type IxLike = { keys: Array<{ pubkey: { toBase58(): string } }>; data: Uint8Array; programId: PublicKey };
const seqOf = (ix: IxLike) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(27, true);

function chain(markets: string[], status: () => unknown) {
  const seqs: bigint[] = [];
  let sig = 0;
  return {
    seqs,
    conn: {
      async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
        return pks.map(() => ({ data: marketAccount(100n) })); // chain never advances: our sends never land
      },
      async simulateTransaction(tx: { instructions: IxLike[] }) {
        for (const ix of nonComputeBudget(tx.instructions)) seqs.push(seqOf(ix));
        return { value: { err: null } };
      },
      async sendRawTransaction() {
        return `sig${++sig}`;
      },
      async getSignatureStatuses(sigs: string[]) {
        return { value: sigs.map(() => status()) };
      },
    },
  };
}

const mkts = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
const asPushes = (ms: string[]) => ms.map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n }));

beforeEach(() => resetPushLandingState());

describe("lead 2: a send that never lands", () => {
  it("keeps proposing strictly increasing nonces above chain; an unlanded tx does not lower or stall them", async () => {
    const ms = mkts(1);
    const c = chain(ms, () => null); // status unknown: dropped
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
    await reconcilePushOutcomes(c.conn as never, Date.now() + 5_000);
    await reconcilePushOutcomes(c.conn as never, Date.now() + 200_000); // past give-up: counted unlanded
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 108n, BLOCKHASH, false);
    assert.deepEqual(c.seqs, [101n, 102n, 103n]); // gap vs chain (100) is accepted: only strict increase is required
  });
});

describe("lead 3: solo window", () => {
  async function landRevertAt(ms: string[], nowMs: number) {
    const c = chain(ms, () => ({ err: { InstructionError: [1, { Custom: 19 }] } }));
    await pushAuthMarkBatch(c.conn as never, Keypair.generate(), asPushes(ms), 100n, BLOCKHASH, false);
    await reconcilePushOutcomes(c.conn as never, nowMs);
  }

  it("a market stops being solo once SOLO_MS has elapsed (injected nowMs)", async () => {
    const ms = mkts(1);
    const t0 = Date.now() + 5_000;
    for (let i = 0; i < SOLO_AFTER_LANDED_REVERTS; i++) await landRevertAt(ms, t0);
    assert.deepEqual(getSoloMarkets(t0), ms);
    assert.deepEqual(getSoloMarkets(t0 + SOLO_MS - 1), ms);
    assert.deepEqual(getSoloMarkets(t0 + SOLO_MS + 1), []);
  });

  it("reverts spaced wider than the strike window never isolate (old timestamps are pruned)", async () => {
    const ms = mkts(1);
    const t0 = Date.now() + 5_000;
    for (let i = 0; i < 4; i++) await landRevertAt(ms, t0 + i * (SOLO_STRIKE_WINDOW_MS + 1));
    assert.deepEqual(getSoloMarkets(t0 + 4 * (SOLO_STRIKE_WINDOW_MS + 1)), []);
  });
});
