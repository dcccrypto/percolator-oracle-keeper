/**
 * Literal-pinned regression test for the auth-mark-pusher's wrapper program id
 * (2026-07-17 fresh devnet triple cutover — security/auth-mark-pusher-version-gate).
 *
 * auth-mark-pusher.ts sources WRAPPER_PROGRAM_ID directly from the SDK's
 * PROGRAM_IDS_V17.percolator constant (not an env var). Asserting
 * `WRAPPER_PROGRAM_ID.toBase58() === PROGRAM_IDS_V17.percolator` would be a
 * vacuous self-check — both sides read the same constant, so the assertion
 * can never fail regardless of which program the SDK actually points at.
 *
 * These tests instead pin the LITERAL fresh wrapper address so a future SDK
 * bump that silently reverts (or drifts) the devnet default is caught here,
 * independent of whatever PROGRAM_IDS_V17 currently contains. They also pin
 * the LITERAL superseded (2026-06-26) wrapper address as a must-not-equal
 * guard — the old wrapper is still live on devnet with ~152 existing markets,
 * so accidentally targeting it again would silently push marks to the wrong
 * program's markets (or fail with a signer/owner mismatch there).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/auth-mark-pusher.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

// Fresh devnet triple — deployed + upgraded 2026-07-17, hash-verified on-chain.
const FRESH_WRAPPER = "DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj";

// Superseded 2026-06-26 wrapper — still live on devnet with ~152 existing
// markets, but no longer the SDK default. Must NOT be what this file targets.
const OLD_WRAPPER = "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9";

describe("auth-mark-pusher WRAPPER_PROGRAM_ID — fresh triple cutover (2026-07-17)", () => {
  it("targets the fresh devnet wrapper (literal pin, not a re-import of the SDK constant)", () => {
    assert.equal(WRAPPER_PROGRAM_ID.toBase58(), FRESH_WRAPPER);
  });

  it("does NOT target the superseded 2026-06-26 wrapper", () => {
    assert.notEqual(WRAPPER_PROGRAM_ID.toBase58(), OLD_WRAPPER);
  });
});

// ── Batch poisoning (2026-07-27) ──────────────────────────────────────────────
//
// PushAuthMark is atomic per transaction: if ANY market in the batch is
// ineligible (engine locked -> Custom(21), slot regression -> Custom(19), junk
// slab -> Custom(8)), the WHOLE transaction reverts and every healthy market
// batched with it silently misses its price. Reproduced on devnet: `[good]`
// lands, `[good, good]` lands, `[good, junk]` reverts entirely.
//
// The old send loop made this invisible AND unrecoverable:
//   - `skipPreflight: true` with no confirmation -> a reverting chunk never errored
//   - `pushedCount += chunk.length` on SEND -> the keeper reported success
//   - no health filter -> the same bad market poisoned every subsequent cycle
//
// These tests drive pushAuthMarkBatch against a fake Connection so the
// isolate-and-quarantine behaviour is verified without touching devnet.

import { Keypair } from "@solana/web3.js";
import { pushAuthMarkBatch, getQuarantinedMarkets } from "./auth-mark-pusher.ts";

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

/**
 * Connection stub. `badMarkets` revert in simulation; anything else passes.
 * Records which market sets were simulated and which were actually sent.
 */
function fakeConn(badMarkets: Set<string>) {
  const simulated: string[][] = [];
  const sent: string[][] = [];
  return {
    simulated,
    sent,
    conn: {
      // The tx carries one ComputeBudget ix then one PushAuthMark ix per market;
      // the market is account index 1 of each push ix (see ACCOUNTS_PUSH_AUTH_MARK).
      async simulateTransaction(tx: { instructions: Array<{ keys: Array<{ pubkey: { toBase58(): string } }> }> }) {
        const markets = tx.instructions.slice(1).map((ix) => ix.keys[1].pubkey.toBase58());
        simulated.push(markets);
        const err = markets.some((m) => badMarkets.has(m)) ? { InstructionError: [1, { Custom: 8 }] } : null;
        return { value: { err } };
      },
      async sendRawTransaction() {
        sent.push(simulated[simulated.length - 1]);
        return "sig" + sent.length;
      },
    },
  };
}

/** Distinct, valid base58 pubkeys — module quarantine state is shared across tests. */
function markets(n: number): string[] {
  return Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
}

describe("pushAuthMarkBatch — one bad market must not freeze the others", () => {
  it("isolates the offender and still pushes every healthy market", async () => {
    const [a, b, bad, c] = markets(4);
    const { conn, sent } = fakeConn(new Set([bad]));
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [a, b, bad, c].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n })),
      100n,
      BLOCKHASH,
      false,
    );

    // 3 of 4 pushed — the bad one dropped, the healthy ones NOT taken down with it.
    assert.equal(res.count, 3);
    assert.equal(res.pushed, true);
    const sentMarkets = sent.flat();
    assert.deepEqual(new Set(sentMarkets), new Set([a, b, c]));
    assert.ok(!sentMarkets.includes(bad), "the reverting market must never be sent");

    // Per-market outcome — the caller (keeper-loop) stamps lastPushAt from
    // these. Reporting the whole input batch as pushed is what made a frozen
    // price look fresh on /health.
    assert.deepEqual(new Set(res.pushedMarkets), new Set([a, b, c]));
    assert.deepEqual(res.skippedMarkets, [bad]);
  });

  it("does NOT report a reverting single-market push as success (phantom-success guard)", async () => {
    const [bad] = markets(1);
    const { conn, sent } = fakeConn(new Set([bad]));
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [{ marketAddress: bad, assetIndex: 0, priceE6: 1_000_000n }],
      100n,
      BLOCKHASH,
      false,
    );
    assert.equal(res.count, 0);
    assert.equal(res.pushed, false);
    assert.equal(sent.length, 0);
    assert.deepEqual(res.pushedMarkets, []);
    assert.deepEqual(res.skippedMarkets, [bad], "a revert must be reported as skipped, not pushed");
  });

  it("quarantines a repeat offender after 3 strikes so it stops costing a cycle", async () => {
    const [good, bad] = markets(2);
    const { conn, simulated } = fakeConn(new Set([bad]));
    const keeper = Keypair.generate();
    const pushes = [good, bad].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n }));

    for (let i = 0; i < 3; i++) {
      await pushAuthMarkBatch(conn as never, keeper, pushes, 100n, BLOCKHASH, false);
    }
    assert.ok(getQuarantinedMarkets().includes(bad), "3 reverts should quarantine the market");

    // 4th cycle: the bad market is filtered out BEFORE chunking, so it is never
    // simulated again — and the good market still gets its price.
    const before = simulated.length;
    const res = await pushAuthMarkBatch(conn as never, keeper, pushes, 100n, BLOCKHASH, false);
    assert.equal(res.count, 1);
    assert.deepEqual(res.pushedMarkets, [good]);
    assert.deepEqual(res.skippedMarkets, [bad], "a quarantined market must be reported as skipped");
    for (const set of simulated.slice(before)) {
      assert.ok(!set.includes(bad), "a quarantined market must not be simulated");
    }
  });

  it("clears strikes once a market pushes cleanly again", async () => {
    const [flaky] = markets(1);
    const keeper = Keypair.generate();
    const push = [{ marketAddress: flaky, assetIndex: 0, priceE6: 1_000_000n }];

    // Two strikes (one short of quarantine)…
    const failing = fakeConn(new Set([flaky]));
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);

    // …then it recovers, which must reset the counter…
    const healthy = fakeConn(new Set());
    await pushAuthMarkBatch(healthy.conn as never, keeper, push, 100n, BLOCKHASH, false);

    // …so two further failures still do not quarantine it.
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);
    assert.ok(!getQuarantinedMarkets().includes(flaky), "a clean push must reset the strike count");
  });
});
