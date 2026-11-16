import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SWEEP_ROUND_CONFIG, DEFERRAL_ESCALATION_SLOTS, MAX_GAP_BACKOFF_ROUNDS, QUARANTINE_LADDER, SWEEP_MAX_PRUNES, buildMergedRoundSlots, buildSweepTxIxs,
  buildSweepTxSlots, freshGapBackoff, pairingStats, resetMergedSkipLog, resetPairingStats, runPlannedTx, runSettleRound, withRoundBlockhash,
} from "./sweep.ts";
import type { SweepDeps } from "./sweep.ts";
import { resetJobCounters, allJobCounters } from "./exec.ts";
import { computeAt, customAt, execCtx, fakeExecConn, key, pf } from "./test-helpers.ts";
import type { SentTx } from "./test-helpers.ts";
import { BLOCKHASH_MAX_AGE_MS } from "../blockhash-cache.ts";
import { buildRefreshCrankIx } from "../positioned-refresh.ts";
import { bindObservationRegistry, resetMultiAssetState } from "../multi-asset.ts";
import type { MarketEntry } from "../registry.ts";
import type { PlannedTx } from "./settle-pairing.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const LP = key(500);
const MARKET = key(900);
const cps = (n: number) => Array.from({ length: n }, (_, i) => pf(i + 1, 1));
const OBS = 5; // PermissionlessCrank tag

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
});

function deps(conn: ReturnType<typeof fakeExecConn>["conn"], extra: { dry?: boolean; holds?: string[]; releases?: string[]; slot?: () => number } = {}) {
  return {
    exec: execCtx(conn, extra.dry),
    getSlot: async () => (extra.slot ? extra.slot() : 1010),
    hold: (m: string) => extra.holds?.push(m),
    release: (m: string) => extra.releases?.push(m),
  };
}

describe("runSettleRound", () => {
  it("single-tx round: sends [LP crank, refresh x N] once, no push hold", async () => {
    const f = fakeExecConn();
    const holds: string[] = [];
    const r = await runSettleRound(deps(f.conn, { holds }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(5) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 6);
    assert.equal(r.lpSettled, true);
    assert.equal(r.plan.paired, true);
    assert.equal(holds.length, 0);
    assert.equal(pairingStats.singleTxRounds, 1);
    assert.equal(pairingStats.pairedLpSettles, 1);
    // the first instruction is the observation crank on the LP: its portfolio account is the LP
    assert.ok(f.sent[0].keys[0].includes(LP.toBase58()));
  });

  it("multi-tx round: the LP tx is sent LAST, after every counterparty tx landed; pushes held then released", async () => {
    const f = fakeExecConn();
    const holds: string[] = [];
    const releases: string[] = [];
    const r = await runSettleRound(deps(f.conn, { holds, releases }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(f.sent.length > 1);
    const lpIdx = f.sent.findIndex((s) => s.keys[0].includes(LP.toBase58()));
    assert.equal(lpIdx, f.sent.length - 1, "the LP tx is the last send");
    f.sent.slice(0, -1).forEach((s) => assert.ok(!s.keys[0].includes(LP.toBase58()), "no earlier tx touches the LP"));
    assert.equal(r.lpSettled, true);
    assert.equal(holds.length, 1);
    assert.equal(releases.length, 1);
    assert.equal(pairingStats.multiTxRounds, 1);
    assert.equal(pairingStats.pairedLpSettles, 1);
    assert.equal(pairingStats.unpairedLpSettles, 0);
  });

  it("NEGATIVE CONTROL: pairing off sends the LP crank in EVERY tx (the exposure this policy removes)", async () => {
    const f = fakeExecConn();
    await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "off" });
    assert.ok(f.sent.length > 1);
    assert.ok(f.sent.every((s) => s.keys[0].includes(LP.toBase58())));
  });

  it("residual window: the slot gap between phase 1 and the LP tx is measured; beyond maxGapSlots the LP tx is NOT sent", async () => {
    const f = fakeExecConn({ landedSlot: () => 1000 });
    const r = await runSettleRound(deps(f.conn, { slot: () => 1000 + 9 }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.lpSettled, false);
    assert.match(r.abandoned ?? "", /slot gap 9 > 8/);
    assert.equal(pairingStats.gapExceeded, 1);
    assert.ok(f.sent.every((s) => !s.keys[0].includes(LP.toBase58())));
    // within the window it is sent and the gap is recorded
    const g = fakeExecConn({ landedSlot: () => 1000 });
    const ok = await runSettleRound(deps(g.conn, { slot: () => 1000 + 3 }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(ok.lpSettled, true);
    assert.equal(pairingStats.lastGapSlots !== null, true);
  });

  it("phase 1 that does not LAND: the LP is NOT settled alone (strict and prefer), and nothing forces it later", async () => {
    // every counterparty tx lands but FAILS on chain with an unrelated code: phase 1 did not settle anything
    for (const pairing of ["strict", "prefer"] as const) {
      resetPairingStats();
      const conn = fakeExecConn({ confirmFail: () => 7 });
      for (let i = 0; i < 4; i++) {
        const r = await runSettleRound(deps(conn.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing });
        assert.equal(r.lpSettled, false, `${pairing} round ${i}`);
      }
      assert.equal(pairingStats.lpHeldPhase1Unlanded, 4, pairing);
      assert.ok(conn.sent.every((s) => !s.keys[0].includes(LP.toBase58())), pairing);
    }
  });

  it("a refresh the engine says is not stale (Custom(22)) is pruned and the tx re-simulated; the prune is counted", async () => {
    const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(3, 22) : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(5) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.pruned, 1);
    assert.equal(f.sent[0].tags.length, 5, "6 instructions minus the pruned refresh");
    assert.equal(pairingStats.prunedCurrent, 1);
  });

  it("an accrue crank that answers Custom(22) (an earlier tx accrued this slot) degrades to refresh-only; the LP still settles (as a refresh)", async () => {
    const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(0, 22) : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(2) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 3, "LP crank + 2 refreshes, no second accrue crank");
    assert.ok(f.sentData[0][0].length > f.sentData[0][1].length, "the first crank observes (A5-1: a hint-less first crank is ambiguous in a later slot)");
    assert.ok(f.sent[0].keys.some((k) => k.includes(LP.toBase58())));
    assert.equal(r.lpSettled, true);
  });

  it("band expected states (104/111/112/113) on a refresh drop that portfolio and are COUNTED as expected, not failures", async () => {
    for (const code of [104, 111, 112, 113]) {
      resetJobCounters();
      const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(2, code) : null) });
      await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(3) }, DEFAULT_SWEEP_ROUND_CONFIG);
      const c = allJobCounters().sweep;
      assert.equal(c.expected, 1, `code ${code}`);
      assert.equal(c.failed, 0);
      assert.equal(c.refused, 0);
      assert.ok(Object.keys(c.byError).some((k) => k.includes(`(${code})`)), "named in the counters");
    }
  });

  it("an UNEXPECTED refusal on the ACCRUE crank is a refusal and nothing is sent for that tx", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 999) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(3) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 0);
    assert.equal(r.lpSettled, false);
    assert.equal(allJobCounters().sweep.refused, 1);
  });

  it("dry-run: simulates, logs, sends NOTHING", async () => {
    const f = fakeExecConn();
    const lines: string[] = [];
    const d = deps(f.conn, { dry: true });
    d.exec.log = (l) => lines.push(l);
    await runSettleRound(d, { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(5) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 0);
    assert.ok(f.sims.length >= 1);
    assert.ok(lines.some((l) => l.includes("[DRY-RUN]") && l.includes("would send")));
    assert.equal(allJobCounters().sweep.dryRun >= 1, true);
  });

  it("buildSweepTxIxs: observation crank first, then refreshes; accrue none = refresh-only", () => {
    const owner = Keypair.generate().publicKey;
    const a = buildSweepTxIxs(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: cps(2) });
    assert.equal(a.length, 3);
    assert.equal(a[0].data[0], OBS);
    const b = buildSweepTxIxs(owner, MARKET, { accrue: "none", accrueTarget: null, refresh: cps(2) });
    assert.equal(b.length, 2);
  });
});

// ── coverage sweep: error / skip / partial-batch paths ──────────────────────────────────────────────────────────────
const keyOf = (p: { pubkey: PublicKey } | PublicKey) => ("pubkey" in p ? p.pubkey : p).toBase58();
/** The portfolio an instruction of a decoded tx cranks (account 2 of a crank). */
const portfolioAt = (d: SentTx, i: number) => d.keys[i][2];
/** An error at the first instruction that cranks any of `bad`, built with `mk(index)`. */
const failOn = (bad: PublicKey[], mk: (i: number) => unknown) => (d: SentTx): unknown => {
  const set = new Set(bad.map((b) => b.toBase58()));
  const i = d.keys.findIndex((_, j) => set.has(portfolioAt(d, j)));
  return i >= 0 ? mk(i) : null;
};
const planned = (accrue: PlannedTx["accrue"], accrueTarget: PublicKey | null, refresh: ReturnType<typeof cps>, settlesLp = false): PlannedTx => ({
  index: 0, accrue, accrueTarget, refresh, settlesLp, weight: 1,
});
const CTX = { market: MARKET, label: "T" };

describe("withRoundBlockhash", () => {
  function counting(over: Record<string, unknown> = {}) {
    let n = 0;
    const conn = {
      async getLatestBlockhash() {
        n++;
        return { blockhash: `bh${n}`, lastValidBlockHeight: 1 };
      },
      async simulateTransaction() {
        return { value: { err: null } };
      },
      async sendRawTransaction() {
        return "sig";
      },
      marker: 42,
      ...over,
    };
    const base = deps(fakeExecConn().conn);
    const d = withRoundBlockhash({ ...base, exec: { ...base.exec, conn: conn as never } }, () => clock);
    return { d, calls: () => n, conn: d.exec.conn as unknown as typeof conn & { getLatestBlockhash(a?: unknown): Promise<{ blockhash: string }> } };
  }
  let clock = 0;
  beforeEach(() => {
    clock = 0;
  });

  it("one fetch serves every call inside BLOCKHASH_MAX_AGE_MS; after it a fresh one is fetched", async () => {
    const { conn, calls } = counting();
    const [a, b] = await Promise.all([conn.getLatestBlockhash("confirmed"), conn.getLatestBlockhash("confirmed")]);
    assert.equal(a.blockhash, b.blockhash);
    assert.equal(calls(), 1);
    clock = BLOCKHASH_MAX_AGE_MS; // exactly at the age limit: still held
    assert.equal((await conn.getLatestBlockhash("confirmed")).blockhash, "bh1");
    clock = BLOCKHASH_MAX_AGE_MS + 1;
    assert.equal((await conn.getLatestBlockhash("confirmed")).blockhash, "bh2");
    assert.equal(calls(), 2);
    // a different commitment is a different cache key
    await conn.getLatestBlockhash("finalized");
    assert.equal(calls(), 3);
  });

  it("a FAILED fetch is not kept: the next call fetches again", async () => {
    let n = 0;
    const { conn } = counting({
      async getLatestBlockhash() {
        n++;
        if (n === 1) throw new Error("rpc down");
        return { blockhash: "ok", lastValidBlockHeight: 1 };
      },
    });
    await assert.rejects(conn.getLatestBlockhash(), /rpc down/);
    await new Promise((r) => setImmediate(r));
    assert.equal((await conn.getLatestBlockhash()).blockhash, "ok");
    assert.equal(n, 2);
  });

  it("a simulate answering BlockhashNotFound drops the held hash; other simulate results keep it", async () => {
    let err: unknown = null;
    const { conn, calls } = counting({
      async simulateTransaction() {
        return { value: { err } };
      },
    });
    await conn.getLatestBlockhash();
    await (conn as unknown as { simulateTransaction(): Promise<unknown> }).simulateTransaction();
    await conn.getLatestBlockhash();
    assert.equal(calls(), 1, "clean simulate keeps the hash");
    err = "BlockhashNotFound";
    await (conn as unknown as { simulateTransaction(): Promise<unknown> }).simulateTransaction();
    await conn.getLatestBlockhash();
    assert.equal(calls(), 2, "BlockhashNotFound clears it");
  });

  it("a send error (rejected OR thrown synchronously) drops the held hash and is rethrown; a good send passes through", async () => {
    let mode: "ok" | "reject" | "throw" = "ok";
    const { conn, calls } = counting({
      sendRawTransaction(): unknown {
        if (mode === "throw") throw new Error("sync boom");
        return mode === "reject" ? Promise.reject(new Error("async boom")) : Promise.resolve("sig-ok");
      },
    });
    const send = (conn as unknown as { sendRawTransaction(r: Uint8Array): Promise<string> }).sendRawTransaction;
    await conn.getLatestBlockhash();
    assert.equal(await send(new Uint8Array()), "sig-ok");
    await conn.getLatestBlockhash();
    assert.equal(calls(), 1);
    mode = "reject";
    await assert.rejects(send(new Uint8Array()), /async boom/);
    await conn.getLatestBlockhash();
    assert.equal(calls(), 2);
    mode = "throw";
    await assert.rejects(send(new Uint8Array()), /sync boom/);
    await conn.getLatestBlockhash();
    assert.equal(calls(), 3);
  });

  it("other members pass through (values as-is) and invalidateBlockhash clears the held hash", async () => {
    const { d, conn, calls } = counting();
    assert.equal((conn as unknown as { marker: number }).marker, 42);
    await conn.getLatestBlockhash();
    d.exec.invalidateBlockhash?.();
    await conn.getLatestBlockhash();
    assert.equal(calls(), 2);
  });
});

describe("buildSweepTxSlots / buildMergedRoundSlots", () => {
  const owner = Keypair.generate().publicKey;
  const VLP = key(777);
  const c = cps(3);

  it("liquidation cranks follow the flagged refresh; the vault LP rides only on the flagged refresh and its liq crank", () => {
    const flagged = new Set([keyOf(c[1])]);
    const slots = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: c, liquidate: flagged, vaultLpCounterparty: VLP });
    assert.deepEqual(slots.map((s) => s.kind), ["accrue", "refresh", "refresh", "liq", "refresh"]);
    const has = (i: number) => slots[i].ix.keys.some((k) => k.pubkey.equals(VLP));
    assert.deepEqual([0, 1, 2, 3, 4].map(has), [false, false, true, true, false]);
  });

  it("an accrue through a flagged counterparty gets its own liq crank right after the observation crank", () => {
    const slots = buildSweepTxSlots(owner, MARKET, { accrue: "counterparty", accrueTarget: c[0].pubkey, refresh: [c[1]], liquidate: new Set([keyOf(c[0])]), vaultLpCounterparty: VLP });
    assert.deepEqual(slots.map((s) => s.kind), ["accrue", "liq", "refresh"]);
    assert.equal(slots[0].ix.keys.some((k) => k.pubkey.equals(VLP)), false, "the observing crank never carries the vault LP");
    assert.equal(slots[1].ix.keys.some((k) => k.pubkey.equals(VLP)), true);
  });

  it("tail instructions are appended last with no key; accrue 'none' observes first even when flagged", () => {
    const tail = buildRefreshCrankIx(owner, MARKET, key(99));
    const slots = buildSweepTxSlots(owner, MARKET, { accrue: "none", accrueTarget: null, refresh: c, tail: [tail] });
    assert.deepEqual(slots.map((s) => s.kind), ["refresh", "refresh", "refresh", "tail"]);
    assert.equal(slots[3].key, null);
    assert.ok(slots[0].ix.data.length > slots[1].ix.data.length, "first crank observes");
  });

  it("merged slots: first counterparty observes, the rest and the LP are hint-less, LP last", () => {
    const m = buildMergedRoundSlots(owner, MARKET, [c[0].pubkey, c[1].pubkey], LP);
    assert.deepEqual(m.map((s) => s.role), ["observe", "refresh", "lp"]);
    assert.equal(m[2].key, LP.toBase58());
    assert.ok(m[0].ix.data.length > m[1].ix.data.length);
  });
});

describe("runPlannedTx: refusals, probes, shrinking and the prune budget", () => {
  it("a refresh that fails BY ITSELF without a code is probed out as a culprit; the rest of the tx lands", async () => {
    const c = cps(4);
    const f = fakeExecConn({ simErr: failOn([c[1].pubkey], (i) => computeAt(i)) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, c, true));
    assert.equal(r.outcome.kind, "sent");
    assert.deepEqual(r.pruned, [{ key: keyOf(c[1]), reason: "deferred", code: null, culprit: true }]);
    assert.deepEqual(r.noCodeKeys, [keyOf(c[1])]);
    assert.deepEqual(r.settled, [keyOf(c[0]), keyOf(c[2]), keyOf(c[3])]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 4, "accrue + 3 refreshes");
    assert.ok(!f.sent[0].keys.some((k) => k[2] === keyOf(c[1])));
    assert.equal(pairingStats.shrinkDeferrals, 1);
  });

  it("when the accrue crank alone fails without a code nobody is blamed: nothing is sent, every refresh is unlanded", async () => {
    const c = cps(3);
    const f = fakeExecConn({ simErr: failOn([LP], (i) => computeAt(i)) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, c, true));
    assert.equal(r.outcome.kind, "refused");
    assert.equal(f.sent.length, 0);
    assert.deepEqual(r.noCodeKeys, []);
    assert.deepEqual(r.unlanded, c.map(keyOf));
    assert.deepEqual(r.settled, []);
    assert.equal(pairingStats.shrinkDeferrals, 0);
  });

  it("a tx that is simply too heavy (nothing fails alone) is cut from the tail up to 3 times; the cut portfolios are deferred, nobody is a culprit", async () => {
    const c = cps(8);
    const f = fakeExecConn({ simErr: (d) => (d.tags.length > 5 ? computeAt(1) : null) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, c, true));
    assert.equal(r.outcome.kind, "sent");
    assert.equal(f.sent[0].tags.length, 5, "accrue + the 4 heaviest refreshes");
    assert.deepEqual(r.settled, c.slice(0, 4).map(keyOf));
    assert.deepEqual(r.pruned.map((p) => p.key), [6, 7, 4, 5].map((i) => keyOf(c[i])));
    assert.ok(r.pruned.every((p) => p.reason === "deferred" && p.code === null && p.culprit === undefined));
    assert.deepEqual(r.noCodeKeys, []);
    assert.equal(pairingStats.shrinkDeferrals, 2);
  });

  it("shrinking is bounded: still failing after 3 cuts the tx fails with the refused outcome and nothing is sent", async () => {
    const c = cps(8);
    const f = fakeExecConn({ simErr: (d) => (d.tags.length > 2 ? computeAt(1) : null) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, c, true));
    assert.equal(r.outcome.kind, "refused");
    assert.equal(f.sent.length, 0);
    assert.equal(pairingStats.shrinkDeferrals, 3);
    assert.equal(r.settled.length, 0);
    assert.equal(r.unlanded.length, 3, "only what is still in the tx after the cuts is unlanded; the cut ones are deferred");
  });

  it("a refresh-only tx with a single refresh failing without a code is not shrunk or probed: it fails", async () => {
    const f = fakeExecConn({ simErr: () => computeAt(0) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("none", null, cps(1)));
    assert.equal(r.outcome.kind, "refused");
    assert.equal(f.sims.length, 1);
    assert.equal(pairingStats.shrinkDeferrals, 0);
    assert.deepEqual(r.unlanded, [keyOf(cps(1)[0])]);
  });

  it("a refusal on the TAIL instruction (no victim) fails the tx for the caller to classify; the tail's own code can be declared expected", async () => {
    const tail = buildRefreshCrankIx(Keypair.generate().publicKey, MARKET, key(99));
    const f = fakeExecConn({ simErr: () => customAt(2, 38) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, cps(1), true), { tail: [tail], expected: new Set([38]) });
    assert.equal(r.outcome.kind, "refused");
    assert.equal((r.outcome as { code: number }).code, 38);
    assert.equal((r.outcome as { expected: boolean }).expected, true);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(r.pruned, []);
  });

  it("an anchor accrue the program refuses falls back to the counterparty form for this tx and flags anchorRefused", async () => {
    const c = cps(3);
    const ANCHOR = key(800);
    const f = fakeExecConn({ simErr: failOn([ANCHOR], (i) => customAt(i, 999)) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("anchor", ANCHOR, c));
    assert.equal(r.anchorRefused, true);
    assert.equal(pairingStats.anchorFallbacks, 1);
    assert.equal(r.outcome.kind, "sent");
    assert.equal(f.sent[0].tags.length, 3, "obs on the first counterparty + 2 refreshes");
    assert.equal(f.sent[0].keys[0][2], keyOf(c[0]));
    assert.deepEqual(r.settled, c.map(keyOf), "the accrue counterparty is settled by its own crank");
  });

  it("a counterparty accrue target refused with a HARD code is isolated and the next counterparty accrues instead; a BAND code is counted as expected", async () => {
    for (const [code, reason] of [[999, "hard"], [104, "band"]] as const) {
      resetPairingStats();
      const c = cps(3);
      const f = fakeExecConn({ simErr: failOn([c[0].pubkey], (i) => customAt(i, code)) });
      const r = await runPlannedTx(deps(f.conn), CTX, planned("counterparty", c[0].pubkey, c.slice(1)));
      assert.deepEqual(r.pruned, [{ key: keyOf(c[0]), reason, code }], reason);
      assert.equal(pairingStats.hardRefusals, reason === "hard" ? 1 : 0);
      assert.equal(pairingStats.bandExpected, reason === "band" ? 1 : 0);
      assert.equal(f.sent[0].keys[0][2], keyOf(c[1]), "next counterparty is the accrue target now");
      assert.deepEqual(r.settled, [keyOf(c[1]), keyOf(c[2])]);
    }
  });

  it("a counterparty accrue target refused with nobody left to accrue through fails the tx (nothing sent)", async () => {
    const c = cps(1);
    const f = fakeExecConn({ simErr: () => customAt(0, 999) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("counterparty", c[0].pubkey, []));
    assert.equal(r.outcome.kind, "refused");
    assert.equal(f.sent.length, 0);
    assert.deepEqual(r.unlanded, [keyOf(c[0])]);
  });

  it("a SECOND Custom(22) at the first crank of the refresh-only retry is not a prune: the tx fails and nothing is marked settled", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 22) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, cps(2), true));
    assert.equal(pairingStats.accrueAlreadyDone, 1);
    assert.equal(r.droppedAccrue, true);
    assert.equal(r.outcome.kind, "refused");
    assert.deepEqual(r.pruned, []);
    assert.deepEqual(r.settled, []);
    assert.equal(f.sims.length, 2);
    assert.equal(f.sims[1].tags.length, 3, "retry is refresh-only: the LP became a plain refresh, 2 + 1");
  });

  it("a landed failure with Custom(22) re-sends refresh-only once, keeping the first send in `retried`", async () => {
    const f = fakeExecConn({ confirmFail: (i) => (i === 0 ? 22 : null) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, cps(2), true));
    assert.equal(f.sent.length, 2);
    assert.equal(r.retried.length, 1);
    assert.equal((r.retried[0] as { landed: string }).landed, "failed");
    assert.equal(r.droppedAccrue, true);
    assert.equal(pairingStats.accrueAlreadyDone, 1);
    assert.equal(r.outcome.kind === "sent" && r.outcome.landed, "landed");
    // it is only done once: a second landed 22 is returned as the failure
    const g = fakeExecConn({ confirmFail: () => 22 });
    const r2 = await runPlannedTx(deps(g.conn), CTX, planned("lp", LP, cps(2), true));
    assert.equal(g.sent.length, 2);
    assert.equal(r2.outcome.kind === "sent" && r2.outcome.landed, "failed");
    assert.deepEqual(r2.settled, []);
  });

  it("every crank pruned: live = a failed outcome (the LP never settled), dry-run = an empty dry-run", async () => {
    const mk = () => fakeExecConn({ simErr: () => customAt(0, 999) });
    const live = await runPlannedTx(deps(mk().conn), CTX, planned("none", null, cps(1)));
    assert.equal(live.outcome.kind, "failed");
    assert.match((live.outcome as { error: string }).error, /every crank of the tx was pruned/);
    assert.equal(pairingStats.hardRefusals, 1);
    const dry = await runPlannedTx(deps(mk().conn, { dry: true }), CTX, planned("none", null, cps(1)));
    assert.equal(dry.outcome.kind, "dry-run");
    assert.equal((dry.outcome as { ixCount: number }).ixCount, 0);
    assert.deepEqual(dry.settled, []);
    assert.equal(dry.pruned.length, 1);
  });

  it("the prune budget is bounded: a tx that keeps being refused fails with 'prune budget exhausted' and sends nothing", async () => {
    const f = fakeExecConn({ simErr: () => customAt(1, 999) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, cps(SWEEP_MAX_PRUNES + 6), true));
    assert.equal(r.outcome.kind, "failed");
    assert.match((r.outcome as { error: string }).error, /prune budget exhausted/);
    assert.equal(f.sent.length, 0);
    assert.equal(r.pruned.length, SWEEP_MAX_PRUNES + 4);
    assert.ok(r.pruned.every((p) => p.reason === "hard"));
  });

  it("a Custom(22) refusal on a refresh is 'current' (counted, not a refusal) and the lpGate sees only the non-current prunes", async () => {
    const c = cps(3);
    const seen: string[][] = [];
    const f = fakeExecConn({ simErr: failOn([c[0].pubkey], (i) => customAt(i, 22)) });
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, c, true), { lpGate: (p) => (seen.push(p.map((x) => x.key)), null) });
    assert.equal(r.outcome.kind, "sent");
    assert.deepEqual(r.pruned.map((p) => p.reason), ["current"]);
    assert.deepEqual(seen, [[]]);
    assert.equal(pairingStats.prunedCurrent, 1);
  });

  it("a gate that returns a reason holds the send: outcome held, nothing sent", async () => {
    const f = fakeExecConn();
    const r = await runPlannedTx(deps(f.conn), CTX, planned("lp", LP, cps(2), true), { lpGate: () => "strict: hold" });
    assert.equal(r.outcome.kind, "held");
    assert.equal(f.sent.length, 0);
    assert.deepEqual(r.unlanded, cps(2).map(keyOf));
    // a gate on a tx that does not settle the LP is never consulted
    const g = fakeExecConn();
    const r2 = await runPlannedTx(deps(g.conn), CTX, planned("counterparty", cps(1)[0].pubkey, []), { lpGate: () => "never" });
    assert.equal(r2.outcome.kind, "sent");
  });
});

describe("runSettleRound: quarantine, deferrals, gap backoff, rent, protective", () => {
  it("gap backoff: a backed-off round runs nothing and counts down; a protective round ignores the backoff", async () => {
    const f = fakeExecConn();
    const backoff = { level: 2, skipRounds: 2 };
    const a = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: cps(3), gapBackoff: backoff }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(a.backedOff, true);
    assert.equal(a.txsSent, 0);
    assert.match(a.abandoned ?? "", /gap backoff: 1 more round/);
    assert.equal(backoff.skipRounds, 1);
    assert.equal(pairingStats.gapBackoffRounds, 1);
    assert.equal(pairingStats.rounds, 0, "a skipped round is not a round");
    assert.equal(f.sent.length, 0);
    const p = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: cps(3), gapBackoff: backoff, protective: true }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(p.backedOff, false);
    assert.equal(p.lpSettled, true);
    assert.equal(backoff.skipRounds, 1, "untouched");
    assert.equal(pairingStats.protectiveRounds, 1);
    assert.equal(backoff.level, 0, "a settled LP resets the backoff level");
  });

  it("an exceeded gap escalates the backoff 1, 2, then stays capped; a later in-window round resets it", async () => {
    const backoff = freshGapBackoff();
    const levels: number[] = [];
    for (let i = 0; i < 3; i++) {
      const f = fakeExecConn({ landedSlot: () => 1000 });
      const r = await runSettleRound(deps(f.conn, { slot: () => 1020 }), CTX, { lp: LP, counterparties: cps(30), gapBackoff: backoff }, DEFAULT_SWEEP_ROUND_CONFIG);
      assert.match(r.abandoned ?? "", new RegExp(`backing off ${backoff.skipRounds} round`));
      levels.push(backoff.level);
      backoff.skipRounds = 0; // let the next round run
    }
    assert.deepEqual(levels, [1, 2, MAX_GAP_BACKOFF_ROUNDS]);
    assert.equal(pairingStats.gapExceeded, 3);
    assert.equal(pairingStats.consecutiveGapExceeded, 3);
    assert.equal(pairingStats.maxGapSlots, 20);
    const ok = fakeExecConn({ landedSlot: () => 1000 });
    const r = await runSettleRound(deps(ok.conn, { slot: () => 1002 }), CTX, { lp: LP, counterparties: cps(30), gapBackoff: backoff }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.lpSettled, true);
    assert.equal(backoff.level, 0);
    assert.equal(pairingStats.consecutiveGapExceeded, 0);
  });

  it("a protective round skips the slot-gap check entirely (getSlot is never asked)", async () => {
    let asked = 0;
    const f = fakeExecConn({ landedSlot: () => 1000 });
    const d = deps(f.conn);
    d.getSlot = async () => (asked++, 5000);
    const r = await runSettleRound(d, CTX, { lp: LP, counterparties: cps(30), protective: true }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(asked, 0);
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.gapExceeded, 0);
  });

  it("quarantined counterparties are not planned but are MISSING; an expired quarantine entry is removed and the portfolio is planned", async () => {
    const c = cps(4);
    const quarantine = new Map<string, bigint>([[keyOf(c[0]), 2_000n], [keyOf(c[1]), 1_000n]]);
    const f = fakeExecConn();
    const r = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: c, quarantine, nowSlot: 1_000 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.deepEqual(r.missing, [{ key: keyOf(c[0]), why: "quarantined" }]);
    assert.equal(quarantine.has(keyOf(c[1])), false, "expired entry dropped");
    assert.equal(quarantine.has(keyOf(c[0])), true);
    assert.equal(pairingStats.quarantinedNow, 1);
    const touched = f.sent[0].keys.map((k) => k[2]);
    assert.ok(!touched.includes(keyOf(c[0])));
    assert.ok(touched.includes(keyOf(c[1])));
    // prefer settles the LP anyway, counted as an unpaired settle (a counterparty was missed)
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.unpairedLpSettles, 1);
    assert.equal(pairingStats.pairedLpSettles, 0);
  });

  it("a program refusal quarantines the portfolio on a ladder: same code again = next rung (capped), a different code starts over", async () => {
    const c = cps(3);
    const bad = c[1].pubkey;
    const quarantine = new Map<string, bigint>();
    const history = new Map<string, { code: number; level: number }>();
    const go = async (code: number, nowSlot: number) => {
      const f = fakeExecConn({ simErr: failOn([bad], (i) => customAt(i, code)) });
      return runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: c, quarantine, quarantineHistory: history, nowSlot }, DEFAULT_SWEEP_ROUND_CONFIG);
    };
    const r1 = await go(999, 10_000);
    assert.deepEqual(r1.missing.map((m) => [m.key, m.why]), [[keyOf(bad), "hard"]]);
    assert.equal(quarantine.get(keyOf(bad)), 10_000n + BigInt(QUARANTINE_LADDER[0]));
    assert.deepEqual(history.get(keyOf(bad)), { code: 999, level: 0 });
    quarantine.clear();
    await go(999, 10_000);
    assert.equal(quarantine.get(keyOf(bad)), 10_000n + BigInt(QUARANTINE_LADDER[1]));
    quarantine.clear();
    await go(999, 10_000);
    quarantine.clear();
    await go(999, 10_000);
    assert.equal(quarantine.get(keyOf(bad)), 10_000n + BigInt(QUARANTINE_LADDER[QUARANTINE_LADDER.length - 1]), "capped at the last rung");
    quarantine.clear();
    await go(998, 10_000);
    assert.deepEqual(history.get(keyOf(bad)), { code: 998, level: 0 });
    assert.equal(quarantine.get(keyOf(bad)), 10_000n + BigInt(QUARANTINE_LADDER[0]));
    assert.equal(pairingStats.hardRefusals, 5);
  });

  it("a band refusal is quarantined too, and the quarantine cap stops one bad code from quarantining the whole book", async () => {
    const c = cps(6);
    const bad = c.slice(0, 4).map((p) => p.pubkey);
    const quarantine = new Map<string, bigint>();
    // every refusal carries the same code; each portfolio is refused one re-simulation at a time
    const f = fakeExecConn({ simErr: failOn(bad, (i) => customAt(i, 999)) });
    const r = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: c, quarantine, nowSlot: 50 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.pruned, 4);
    assert.equal(quarantine.size, 2, "MAX_QUARANTINES_PER_ROUND");
    assert.equal(pairingStats.quarantineCapped, 2);
    assert.equal(r.missing.filter((m) => m.why === "hard").length, 4, "all four are still reported missing");
    // a distinct code is NOT capped
    resetPairingStats();
    const q2 = new Map<string, bigint>();
    const g = fakeExecConn({ simErr: (d) => {
      const i = d.keys.findIndex((_, j) => bad.some((b) => b.toBase58() === portfolioAt(d, j)));
      return i < 0 ? null : customAt(i, 900 + bad.findIndex((b) => b.toBase58() === portfolioAt(d, i)));
    } });
    await runSettleRound(deps(g.conn), CTX, { lp: LP, counterparties: c, quarantine: q2, nowSlot: 50 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(q2.size, 4);
    assert.equal(pairingStats.quarantineCapped, 0);
  });

  it("strict holds the LP on a refused counterparty (held, counted); prefer sends it and counts the unpaired settle", async () => {
    const c = cps(3);
    const bad = c[0].pubkey;
    const strict = fakeExecConn({ simErr: failOn([bad], (i) => customAt(i, 999)) });
    const s = await runSettleRound(deps(strict.conn), CTX, { lp: LP, counterparties: c }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "strict" });
    assert.equal(s.lpSettled, false);
    assert.equal(strict.sent.length, 0);
    assert.match(s.abandoned ?? "", /^strict: 1 counterparties/);
    assert.equal(pairingStats.lpHeldCounterpartyMiss, 1);
    resetPairingStats();
    const prefer = fakeExecConn({ simErr: failOn([bad], (i) => customAt(i, 999)) });
    const p = await runSettleRound(deps(prefer.conn), CTX, { lp: LP, counterparties: c }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(p.lpSettled, true);
    assert.equal(pairingStats.unpairedLpSettles, 1);
    assert.equal(pairingStats.pairedLpSettles, 0);
  });

  it("multi-tx: a refused counterparty in phase 1 holds the LP tx under strict (never sent) and lets prefer send it, unpaired", async () => {
    const c = cps(30);
    const bad = c[0].pubkey;
    const mk = () => fakeExecConn({ simErr: failOn([bad], (i) => customAt(i, 999)) });
    const s = mk();
    const rs = await runSettleRound(deps(s.conn), CTX, { lp: LP, counterparties: c }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "strict" });
    assert.equal(rs.lpSettled, false);
    assert.match(rs.abandoned ?? "", /^strict:/);
    assert.equal(pairingStats.lpHeldCounterpartyMiss, 1);
    assert.ok(s.sent.every((t) => !t.keys[0].includes(LP.toBase58())));
    assert.equal(rs.txsSent, s.sent.length);
    resetPairingStats();
    const p = mk();
    const rp = await runSettleRound(deps(p.conn), CTX, { lp: LP, counterparties: c }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(rp.lpSettled, true);
    assert.equal(pairingStats.unpairedLpSettles, 1);
    assert.ok(p.sent[p.sent.length - 1].keys[0].includes(LP.toBase58()));
  });

  it("a portfolio that fails alone without a code holds the LP twice, then on the 3rd consecutive failure is ESCALATED (quarantined, missing hard) and prefer proceeds", async () => {
    const c = cps(3);
    const bad = c[1].pubkey;
    const deferrals = new Map<string, number>();
    const quarantine = new Map<string, bigint>();
    const go = async () => {
      const f = fakeExecConn({ simErr: failOn([bad], (i) => computeAt(i)) });
      return { f, r: await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: c, deferrals, quarantine, nowSlot: 700 }, DEFAULT_SWEEP_ROUND_CONFIG) };
    };
    for (let i = 1; i <= 2; i++) {
      const { f, r } = await go();
      assert.equal(r.lpSettled, false, `round ${i}`);
      assert.equal(f.sent.length, 0);
      assert.equal(deferrals.get(keyOf(bad)), i);
      assert.deepEqual(r.escalated, []);
      assert.ok(r.missing.some((m) => m.key === keyOf(bad) && m.why === "deferred"));
    }
    assert.equal(pairingStats.lpHeldPhase1Unlanded, 2);
    const { f, r } = await go();
    assert.deepEqual(r.escalated, [keyOf(bad)]);
    assert.equal(pairingStats.deferralEscalations, 1);
    assert.equal(quarantine.get(keyOf(bad)), 700n + BigInt(DEFERRAL_ESCALATION_SLOTS));
    assert.ok(r.missing.some((m) => m.key === keyOf(bad) && m.why === "hard"));
    assert.equal(r.lpSettled, true, "prefer proceeds past an escalated portfolio");
    assert.equal(f.sent.length, 1);
    assert.ok(!f.sent[0].keys.some((k) => k[2] === keyOf(bad)));
    assert.equal(pairingStats.unpairedLpSettles, 1);
    // a portfolio that later settles forgets its streak
    const ok = fakeExecConn();
    await runSettleRound(deps(ok.conn), CTX, { lp: LP, counterparties: c, deferrals }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(deferrals.has(keyOf(bad)), false);
  });

  it("strict still holds the LP on an escalated portfolio", async () => {
    const c = cps(3);
    const bad = c[1].pubkey;
    const deferrals = new Map<string, number>([[keyOf(bad), 2]]);
    const f = fakeExecConn({ simErr: failOn([bad], (i) => computeAt(i)) });
    const r = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: c, deferrals }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "strict" });
    assert.deepEqual(r.escalated, [keyOf(bad)]);
    assert.equal(r.lpSettled, false);
    assert.equal(f.sent.length, 0);
  });

  it("a protective round never holds the LP, even with an unlanded counterparty tx", async () => {
    const f = fakeExecConn({ confirmFail: (_i, t) => (t.keys[0].includes(LP.toBase58()) ? null : 7) });
    const r = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: cps(30), protective: true }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.lpHeldPhase1Unlanded, 0);
    assert.equal(pairingStats.unpairedLpSettles, 1, "missed counterparties make this an unpaired settle");
  });

  it("rent (tag 106) runs AFTER the LP, one tx per due+settled portfolio, at most `max`; never when the LP did not settle", async () => {
    const c = cps(4);
    let owner = Keypair.generate().publicKey;
    const build = (p: { pubkey: PublicKey }) => buildRefreshCrankIx(owner, MARKET, p.pubkey);
    const dd = (conn: ReturnType<typeof fakeExecConn>["conn"]) => {
      const d = deps(conn);
      owner = d.exec.keeper.publicKey;
      return d;
    };
    const due = new Set([keyOf(c[1]), keyOf(c[2]), key(9999).toBase58()]);
    const f = fakeExecConn();
    const r = await runSettleRound(dd(f.conn), CTX, { lp: LP, counterparties: c, rent: { due, build } }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 2, "the round tx + ONE rent tx (default max 1)");
    assert.equal(r.rentSettled.length, 1);
    assert.ok(due.has(r.rentSettled[0]));
    assert.equal(f.sent[1].tags.length, 1);
    assert.equal(pairingStats.rentSettlesInRound, 1);
    assert.equal(allJobCounters()["rent-106"].sent, 1);
    resetPairingStats();
    const g = fakeExecConn();
    const r2 = await runSettleRound(dd(g.conn), CTX, { lp: LP, counterparties: c, rent: { due, build, max: 5 } }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r2.rentSettled.length, 2);
    assert.equal(g.sent.length, 3);
    // the LP did not settle (its tx failed on chain): no rent at all
    const h = fakeExecConn({ confirmFail: () => 7 });
    const r3 = await runSettleRound(dd(h.conn), CTX, { lp: LP, counterparties: c, rent: { due, build } }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r3.lpSettled, false);
    assert.deepEqual(r3.rentSettled, []);
    assert.equal(h.sent.length, 1);
    // a portfolio that is due but did not settle this round is skipped
    const i = fakeExecConn({ simErr: failOn([c[1].pubkey], (j) => customAt(j, 999)) });
    const r4 = await runSettleRound(dd(i.conn), CTX, { lp: LP, counterparties: c, rent: { due: new Set([keyOf(c[1])]), build } }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.deepEqual(r4.rentSettled, []);
    assert.equal(i.sent.length, 1);
  });

  it("an exception inside the round is contained: abandoned names it, and the push hold is still released", async () => {
    const f = fakeExecConn({ landedSlot: () => 1000 });
    const holds: string[] = [];
    const releases: string[] = [];
    const d = deps(f.conn, { holds, releases });
    d.getSlot = async () => {
      throw new Error("slot rpc exploded");
    };
    const r = await runSettleRound(d, CTX, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.abandoned, "round failed: slot rpc exploded");
    assert.equal(r.lpSettled, false);
    assert.deepEqual(holds, [MARKET.toBase58()]);
    assert.deepEqual(releases, [MARKET.toBase58()]);
  });

  it("pairing off never holds the market pushes", async () => {
    const f = fakeExecConn();
    const holds: string[] = [];
    await runSettleRound(deps(f.conn, { holds }), CTX, { lp: LP, counterparties: cps(30) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "off" });
    assert.equal(holds.length, 0);
  });

  it("when the LP tx is a single-tx round and a counterparty refresh lands nothing, the held reason is counted", async () => {
    // single tx, culprit without a code: the gate holds the LP tx itself (non-strict reason)
    const c = cps(2);
    const f = fakeExecConn({ simErr: failOn([c[0].pubkey], (i) => computeAt(i)) });
    const r = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: c }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.lpSettled, false);
    assert.match(r.abandoned ?? "", /did not land or was deferred/);
    assert.equal(pairingStats.lpHeldPhase1Unlanded, 1);
    assert.equal(pairingStats.lpHeldCounterpartyMiss, 0);
  });

  it("plan results: unvisited counterparties are reported missing 'unplanned' when the tx cap is reached", async () => {
    const f = fakeExecConn();
    const r = await runSettleRound(deps(f.conn), CTX, { lp: LP, counterparties: cps(60) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, maxTxsPerRound: 2 });
    const unplanned = r.missing.filter((m) => m.why === "unplanned");
    assert.ok(unplanned.length > 0);
    assert.equal(unplanned.length, r.plan.unvisited.length);
  });
});

describe("runSettleRound: MERGED_ROUND on a multi-asset market", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ADDITIONS = JSON.parse(readFileSync(join(here, "..", "..", "..", "registry-additions-v22-multiasset.json"), "utf8")) as { markets: MarketEntry[] };
  const M2XHS = "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw";
  const MA = new PublicKey(M2XHS);
  const MLP = new PublicKey("6w14eZR3S4e1AxkWEtruGZ6dRSj2mDaNsWtfcKZ3Dg4W");
  const four = (n: number) => ({ ...pf(n, 4), lossWeight: BigInt(n) });
  const four2 = [four(11), four(12)];
  const go = (f: ReturnType<typeof fakeExecConn>, extra: Partial<Parameters<typeof runSettleRound>[2]> = {}, cfg = DEFAULT_SWEEP_ROUND_CONFIG, lines: string[] = []) => {
    const d = deps(f.conn);
    d.exec.log = (l) => lines.push(l);
    return runSettleRound(d, { market: MA, label: "2xhs" }, { lp: MLP, lpWeight: 1_000, counterparties: four2, ...extra }, cfg);
  };
  beforeEach(() => {
    resetMergedSkipLog();
    bindObservationRegistry(() => [structuredClone(ADDITIONS.markets.find((m) => m.marketAddress === M2XHS)!)]);
  });
  afterEach(() => resetMultiAssetState());

  it("a clean merged round: one tx, LP last, rent afterwards, the gap backoff level reset", async () => {
    const f = fakeExecConn();
    const backoff = { level: 2, skipRounds: 0 };
    const d = deps(f.conn);
    const build = (p: { pubkey: PublicKey }) => buildRefreshCrankIx(d.exec.keeper.publicKey, MA, p.pubkey);
    const r = await runSettleRound(d, { market: MA, label: "2xhs" }, { lp: MLP, lpWeight: 1_000, counterparties: four2, gapBackoff: backoff, rent: { due: new Set([keyOf(four2[0])]), build } }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.merged, true);
    assert.equal(f.sent.length, 2, "merged tx + the rent tx");
    assert.equal(f.sent[0].tags.length, 3);
    assert.equal(r.lpSettled, true);
    assert.equal(backoff.level, 0);
    assert.equal(pairingStats.mergedRounds, 1);
    assert.equal(pairingStats.pairedLpSettles, 1);
    assert.deepEqual(r.rentSettled, [keyOf(four2[0])]);
    assert.equal(r.txsSent, 1, "txsSent counts the round's sends (rent is reported by rentSettled)");
  });

  it("dry-run merges without sending, and counts no send", async () => {
    const f = fakeExecConn();
    const d = deps(f.conn, { dry: true });
    const r = await runSettleRound(d, { market: MA, label: "2xhs" }, { lp: MLP, lpWeight: 1_000, counterparties: four2 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.merged, true);
    assert.equal(r.txsSent, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(r.lpSettled, true);
  });

  it("every merged-round skip reason is named once per minute; a changed reason logs again", async () => {
    const lines: string[] = [];
    const reasons: Array<[string, () => Promise<unknown>]> = [
      ["pairing off", () => go(fakeExecConn(), { lpWeight: 3, counterparties: [...four2, four(13), four(14), four(15), four(16)] }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "off" }, lines)],
      ["protective round", () => go(fakeExecConn(), { protective: true }, DEFAULT_SWEEP_ROUND_CONFIG, lines)],
      ["plan not fully paired", () => go(fakeExecConn(), { counterparties: [...four2, four(13), four(14), four(15), four(16)] }, { ...DEFAULT_SWEEP_ROUND_CONFIG, maxTxsPerRound: 2 }, lines)],
      ["LP hold: strict", () => go(fakeExecConn(), { counterparties: four2, quarantine: new Map([[keyOf(four2[0]), 99n]]) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "strict" }, lines)],
    ];
    for (const [why, run] of reasons) {
      lines.length = 0;
      await run();
      await run();
      const merged = lines.filter((l) => l.includes("[v22][merged]"));
      assert.equal(merged.length, 1, why + ": rate limited " + lines.join("|"));
      assert.ok(merged[0].includes(why), `${why}: ${merged[0]}`);
      assert.equal(pairingStats.mergedRounds, 0, why);
    }
  });

  it("a merged tx that simulates over the CU line, or does not fit one packet, falls back to the phased plan (counted)", async () => {
    const over = fakeExecConn({ simUnitsConsumed: () => 2_000_000 });
    const r = await go(over);
    assert.equal(pairingStats.mergedFallbacks, 1);
    assert.equal(r.merged, undefined);
    assert.equal(r.lpSettled, true);
    assert.equal(over.sent.length, 3);
    resetPairingStats();
    const many = Array.from({ length: 30 }, (_, i) => ({ ...pf(1000 + i, 1), lossWeight: BigInt(i) }));
    const lines: string[] = [];
    await go(fakeExecConn(), { counterparties: many, lpWeight: 1_000 }, { ...DEFAULT_SWEEP_ROUND_CONFIG, maxTxsPerRound: 12 }, lines);
    assert.ok(lines.some((l) => /do not fit one packet/.test(l)), lines.join("\n"));
    assert.equal(pairingStats.mergedFallbacks, 1);
  });

  it("units unknown (null) on the merged simulation falls back; a thrown simulation is contained as a fallback", async () => {
    const f = fakeExecConn({ simUnitsConsumed: () => null as unknown as number });
    const lines: string[] = [];
    await go(f, {}, DEFAULT_SWEEP_ROUND_CONFIG, lines);
    assert.ok(lines.some((l) => /simulated n\/a CU/.test(l)), lines.join("\n"));
    const boom = fakeExecConn();
    const base = deps(boom.conn);
    let n = 0;
    (base.exec.conn as unknown as { simulateTransaction: () => Promise<never> }).simulateTransaction = async () => {
      n++;
      throw new Error("sim transport down");
    };
    const out: string[] = [];
    base.exec.log = (l) => out.push(l);
    const r = await runSettleRound(base, { market: MA, label: "2xhs" }, { lp: MLP, lpWeight: 1_000, counterparties: four2 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(n >= 1);
    assert.equal(r.lpSettled, false);
    assert.equal(boom.sent.length, 0);
  });

  it("a merged tx that LANDS FAILED is not followed by the phased plan: abandoned, one send, the LP not settled", async () => {
    const f = fakeExecConn({ confirmFail: () => 7 });
    const r = await go(f);
    assert.equal(f.sent.length, 1);
    assert.equal(r.txsSent, 1);
    assert.equal(r.abandoned, "merged round tx did not land");
    assert.equal(r.lpSettled, false);
    assert.equal(pairingStats.mergedRounds, 0);
  });

  it("every counterparty already current (22 on each non-observing crank, LP too): all counted settled, LP settled via the drop", async () => {
    const f = fakeExecConn({ simErr: (d) => {
      // index 0 observes; any hint-less crank answers 22 while it is still in the tx
      return d.tags.length > 1 ? customAt(1, 22) : null;
    } });
    const r = await go(f);
    assert.equal(r.merged, true);
    assert.equal(pairingStats.mergedDroppedCurrent, 2);
    assert.deepEqual(f.sent[0].tags, [5], "only the observing crank is sent");
    assert.equal(r.lpSettled, true);
    assert.ok(r.settled.includes(MLP.toBase58()));
    assert.ok(r.settled.includes(keyOf(four2[1])));
  });
});
