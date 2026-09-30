/**
 * B13 (E2E 2026-09-30): Resolved markets and CloseSlab tombstones are not
 * cranked, raise no crank/slot-lag alerts, and are skipped by the Live-only
 * fee jobs (78, 87). Real SOL/TEXTIT bytes, mode byte (abs 1218) / kind patched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { crankOneMarket, freshCrankMarketState, reportCrankHealth } from "./recovery-cranker.ts";
import { AlertSink, DEFAULT_THRESHOLDS } from "./alerting.ts";
import { pushStakeFeesOnce } from "./stake-fee-pusher.ts";
import { crankLpFeesOnce } from "./lp-fee-cranker.ts";
import { isTerminalMarket } from "./terminal-insurance.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const KEEPER = Keypair.generate();
const resolvedSol = (): Buffer => { const b = Buffer.from(fx("sol-market-v18-fees")); b[592 + 626] = 1; return b; };
const recoverySol = (): Buffer => { const b = Buffer.from(fx("sol-market-v18-fees")); b[592 + 626] = 2; return b; };
const tombstoneSol = (): Buffer => { const b = Buffer.from(fx("sol-market-v18-fees").subarray(0, 64)); b[10] = 8; return b; };

function crankConn(data: Buffer) {
  const calls = { reads: 0, tx: 0 };
  const conn = {
    async getAccountInfoAndContext() { calls.reads++; return { context: { slot: 505_700_000 }, value: { data, owner: WRAPPER, lamports: 1, executable: false } }; },
    async getLatestBlockhash() { calls.tx++; return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
    async simulateTransaction() { calls.tx++; return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 19 }] }, logs: [] } }; },
    async sendRawTransaction() { calls.tx++; return "sig"; },
    async getProgramAccounts() { calls.tx++; return []; },
  };
  return { conn, calls };
}
const entry = { marketAddress: SOL, label: "SOL", lpPortfolio: Keypair.generate().publicKey.toBase58() };

describe("B13 — the crank loop leaves Resolved/closed markets alone", () => {
  it("fixture sanity: live SOL is not terminal; patched resolved / tombstone are", () => {
    assert.equal(isTerminalMarket(new Uint8Array(fx("sol-market-v18-fees"))), false);
    assert.equal(isTerminalMarket(new Uint8Array(resolvedSol())), true);
    assert.equal(isTerminalMarket(new Uint8Array(tombstoneSol())), true);
  });

  for (const [name, data] of [["resolved", resolvedSol()], ["tombstone", tombstoneSol()]] as const) {
    it(`${name}: no crank tx, no observation, and the market is not even re-read afterwards`, async () => {
      const c = crankConn(data);
      const st = freshCrankMarketState();
      st.consecutiveReverts = 9; // it WAS reverting before resolve
      await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
      assert.equal(c.calls.tx, 0, "no blockhash / simulate / send");
      assert.equal(st.terminal, true);
      assert.equal(st.obs, null);
      assert.equal(st.consecutiveReverts, 0);
      await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
      assert.equal(c.calls.reads, 1, "terminal is final: no further RPC");
    });
  }

  it("an open crank-reverts + slot-lag alert for it RESOLVES once the market is terminal", async () => {
    const lines: string[] = [];
    const sink = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, log: (l) => lines.push(l), logError: (l) => lines.push(l), now: () => 0 });
    const st = freshCrankMarketState();
    st.consecutiveReverts = 5; st.totalReverts = 5; st.lastRevertCode = 19;
    st.obs = { chainSlot: 1_000n, engineSlot: 0n, crankOk: false, crankReverted: true, lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0, adl: null };
    const states = new Map([[SOL, st]]);
    const reg = { markets: [{ label: "SOL", marketAddress: SOL }] } as never;
    const first = await reportCrankHealth(reg, states as never, 1, sink);
    assert.deepEqual(first.map((a) => a.kind).sort(), ["crank-reverts", "slot-lag"]);
    await crankOneMarket(crankConn(resolvedSol()).conn as never, KEEPER, entry, st, false);
    const after = await reportCrankHealth(reg, states as never, 2, sink);
    assert.deepEqual(after, []);
    assert.equal(lines.filter((l) => l.startsWith("[ALERT-RESOLVED]")).length, 2);
  });

  it("a Live market is still cranked (control)", async () => {
    const c = crankConn(fx("sol-market-v18-fees"));
    const st = freshCrankMarketState();
    await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
    assert.ok(c.calls.tx > 0);
    assert.equal(st.terminal, false);
  });
});

describe("B13 — Live-only fee jobs skip terminal markets locally", () => {
  it("stake-fee (tag 87): skipped, no simulation", async () => {
    let sims = 0;
    const conn = {
      async getMultipleAccountsInfo() { return [{ data: resolvedSol(), owner: WRAPPER, lamports: 1, executable: false }, { data: fx("sol-stake-pool-v18"), owner: STAKE, lamports: 1, executable: false }]; },
      async simulateTransaction() { sims++; throw new Error("must not simulate"); },
    };
    const o = await pushStakeFeesOnce(conn as never, KEEPER, SOL, false, { wrapperProgramId: WRAPPER, stakeProgramId: STAKE, minRealShares: 0n, maxDeadShareBps: 100n, minPushAtoms: 1n });
    assert.equal(o.kind, "skipped");
    assert.match((o as { reason: string }).reason, /Resolved\/closed/);
    assert.equal(sims, 0);
  });
  it("lp-fee (tag 78): skipped, no send", async () => {
    let sends = 0;
    const conn = {
      async getMultipleAccountsInfo() { return [{ data: Buffer.alloc(176) }, { data: tombstoneSol() }]; },
      async sendRawTransaction() { sends++; return "sig"; },
    };
    assert.equal(await crankLpFeesOnce(conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(sends, 0);
  });
});

describe("Recovery (mode 2, expired-close valve)", () => {
  it("the crank loop KEEPS cranking a Recovery market (its bounded step is the path to Resolved)", async () => {
    const c = crankConn(recoverySol());
    const st = freshCrankMarketState();
    await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
    assert.ok(c.calls.tx > 0, "cranked");
    assert.equal(st.terminal, false);
  });
  it("a market that turns Resolved between cycles is skipped from the next cycle on", async () => {
    let data = recoverySol();
    const calls = { tx: 0 };
    const conn2 = {
      async getAccountInfoAndContext() { return { context: { slot: 505_700_000 }, value: { data, owner: WRAPPER, lamports: 1, executable: false } }; },
      async getLatestBlockhash() { calls.tx++; return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async simulateTransaction() { calls.tx++; return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [] } }; },
      async sendRawTransaction() { calls.tx++; data = resolvedSol(); return "sig"; }, // this crank moved it Recovery -> Resolved
      async getProgramAccounts() { return []; },
    };
    const st = freshCrankMarketState();
    await crankOneMarket(conn2 as never, KEEPER, entry, st, false);
    const after = calls.tx;
    assert.ok(after > 0);
    await crankOneMarket(conn2 as never, KEEPER, { ...entry }, { ...st, lastCrankSlot: null }, false);
    assert.equal(calls.tx, after, "no crank on the now-Resolved market");
  });
  it("stake-fee (tag 87) skips a Recovery market", async () => {
    const conn3 = {
      async getMultipleAccountsInfo() { return [{ data: recoverySol(), owner: WRAPPER, lamports: 1, executable: false }, { data: fx("sol-stake-pool-v18"), owner: STAKE, lamports: 1, executable: false }]; },
      async simulateTransaction() { throw new Error("must not simulate"); },
    };
    const o = await pushStakeFeesOnce(conn3 as never, KEEPER, SOL, false, { wrapperProgramId: WRAPPER, stakeProgramId: STAKE, minRealShares: 0n, maxDeadShareBps: 100n, minPushAtoms: 1n });
    assert.equal(o.kind, "skipped");
  });
});
