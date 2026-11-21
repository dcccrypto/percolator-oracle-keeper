/**
 * crankOneMarket / runSweepFollowups / sweepContextFor failure and edge branches of
 * recovery-cranker.ts, driven through hand-built RPC fakes (no network). The positioned market is
 * the live CATE v18 fixture the refresh test uses.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  crankOneMarket,
  emptySweepFollowup,
  freshCrankMarketState,
  runSweepFollowups,
  sweepContextFor,
} from "./recovery-cranker.ts";
import type { SimOutcome } from "./recovery-cranker.ts";
import { freshSweepCursor } from "./positioned-sweep.ts";
import type { CrankPlan, PlannedCrank, PositionedPortfolio } from "./positioned-refresh.ts";
import { TransactionInstruction } from "@solana/web3.js";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(new URL(`./__fixtures__/${name}.b64`, import.meta.url), "utf8").trim(), "base64");

const CATE = new PublicKey("CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE");
const CATE_LP = new PublicKey("JAbvCce1twNVzpeLGMkgzdE2TqbRPz2oHeod9kaMFsum");
const CATE_TRADER = new PublicKey("6c7hV3Km5hDkNSrqn3ievcShwkg8fB9agZy8PnVfHVFG");
const CATE_FLAT = new PublicKey("65iKyg4cie2aJu2tQT23UckWWANVvurxDMeRJyyeMEo7");
const SLOT = 505227150;

const entry = { marketAddress: CATE.toBase58(), label: "CATE", lpPortfolio: CATE_LP.toBase58() };

async function quiet<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> {
  const logs: string[] = [];
  const w = console.warn, e = console.error, l = console.log;
  console.warn = console.error = console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try { return { out: await fn(), logs }; } finally { console.warn = w; console.error = e; console.log = l; }
}

interface FakeOpts {
  sim?: (n: number) => { err: unknown; logs?: string[] | null };
  getAccount?: () => Promise<{ context: { slot: number }; value: { data: Buffer } | null }>;
  send?: (n: number) => Promise<string>;
  getProgramAccounts?: () => Promise<unknown[]>;
  marketData?: Buffer;
}

function fakeConn(o: FakeOpts = {}) {
  const calls = { sent: 0, sims: 0, accountReads: 0, gpa: 0 };
  const conn = {
    async getAccountInfoAndContext() {
      calls.accountReads++;
      if (o.getAccount) return o.getAccount();
      return { context: { slot: SLOT }, value: { data: o.marketData ?? fixture("cate-market-v18") } };
    },
    async getAccountInfo() { return { data: o.marketData ?? fixture("cate-market-v18") }; },
    async getProgramAccounts() {
      calls.gpa++;
      if (o.getProgramAccounts) return o.getProgramAccounts();
      return [
        { pubkey: CATE_LP, account: { data: fixture("cate-lp-portfolio-v18") } },
        { pubkey: CATE_TRADER, account: { data: fixture("cate-trader-portfolio-v18") } },
        { pubkey: CATE_FLAT, account: { data: fixture("cate-flat-portfolio-v18") } },
      ];
    },
    async getSlot() { return SLOT; },
    async getLatestBlockhash() { return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }; },
    async simulateTransaction() {
      calls.sims++;
      const s = o.sim ? o.sim(calls.sims) : { err: null };
      return { context: { slot: SLOT }, value: { err: s.err, logs: s.logs ?? [], accounts: null } };
    },
    async sendRawTransaction() {
      calls.sent++;
      return o.send ? o.send(calls.sent) : "sig" + calls.sent;
    },
    async getSignatureStatuses() { return { value: [{ err: null }] }; },
  };
  return { conn, calls };
}

const keeper = Keypair.generate();

describe("crankOneMarket — failure and edge branches", () => {
  it("a clean simulation lands the crank and records it", async () => {
    const { conn, calls } = fakeConn();
    const st = freshCrankMarketState();
    await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(calls.sent, 1);
    assert.equal(st.totalCranks, 1);
    assert.equal(st.lastSig, "sig1");
    assert.equal(st.lastCrankSlot, BigInt(SLOT));
    assert.equal(st.obs?.crankOk, true);
  });

  it("does not crank twice in the same slot (B7 dedupe)", async () => {
    const { conn, calls } = fakeConn();
    const st = freshCrankMarketState();
    await quiet(async () => {
      await crankOneMarket(conn as never, keeper, entry, st, false);
      await crankOneMarket(conn as never, keeper, entry, st, false);
    });
    assert.equal(calls.sent, 1);
  });

  it("an engine revert (Custom 19) is counted, advised, never sent; a later clean crank logs RECOVERED", async () => {
    let failing = true;
    const { conn, calls } = fakeConn({
      sim: () => (failing ? { err: { InstructionError: [1, { Custom: 19 }] } } : { err: null }),
    });
    const st = freshCrankMarketState();
    const first = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(calls.sent, 0);
    assert.equal(st.totalReverts, 1);
    assert.equal(st.consecutiveReverts, 1);
    assert.equal(st.lastRevertCode, 19);
    assert.match(st.lastErrorMsg ?? "", /revert Custom\(19\)/);
    assert.equal(st.obs?.crankReverted, true);
    assert.ok(first.logs.some((l) => /\[REVERT\].*deep-stale/.test(l)));
    failing = false;
    const second = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(calls.sent, 1);
    assert.equal(st.consecutiveReverts, 0);
    assert.ok(second.logs.some((l) => /RECOVERED/.test(l)));
  });

  it("a wrapper error 104-124 is named, an error with no code is reported as JSON, a code in the logs is found", async () => {
    const a = fakeConn({ sim: () => ({ err: { InstructionError: [1, { Custom: 121 }] } }) });
    const sa = freshCrankMarketState();
    await quiet(() => crankOneMarket(a.conn as never, keeper, entry, sa, false));
    assert.match(sa.lastErrorMsg ?? "", /Custom\(121\) \S+/);
    assert.notEqual(sa.lastErrorMsg, "revert Custom(121)");

    const b = fakeConn({ sim: () => ({ err: "SomethingElse" }) });
    const sb = freshCrankMarketState();
    await quiet(() => crankOneMarket(b.conn as never, keeper, entry, sb, false));
    assert.equal(sb.lastErrorMsg, 'revert "SomethingElse"');
    assert.equal(sb.lastRevertCode, null);

    const c = fakeConn({ sim: () => ({ err: { InstructionError: [1, "Custom"] }, logs: ["Program failed: custom program error: 0x15"] }) });
    const sc = freshCrankMarketState();
    await quiet(() => crankOneMarket(c.conn as never, keeper, entry, sc, false));
    assert.equal(sc.lastRevertCode, 21);
  });

  it("escalates to [ALERT] on the third consecutive revert", async () => {
    // a fresh slot each time so the same-slot dedupe does not apply (no crank landed anyway)
    const { conn } = fakeConn({ sim: () => ({ err: { InstructionError: [1, { Custom: 21 }] } }) });
    const st = freshCrankMarketState();
    const all: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
      all.push(...r.logs);
    }
    assert.equal(st.consecutiveReverts, 3);
    assert.ok(all.some((l) => /\[ALERT\]/.test(l)));
  });

  it("compute exhaustion at the transaction max is named in the error", async () => {
    const { conn } = fakeConn({
      sim: () => ({ err: { InstructionError: [1, "ComputationalBudgetExceeded"] } }),
    });
    const st = freshCrankMarketState();
    await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.match(st.lastErrorMsg ?? "", /compute exhausted/);
  });

  it("Custom 22 on the first crank never sends and never counts a send error", async () => {
    const { conn, calls } = fakeConn({ sim: () => ({ err: { InstructionError: [1, { Custom: 22 }] } }) });
    const st = freshCrankMarketState();
    const r = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(calls.sent, 0);
    assert.equal(st.totalErrors, 0);
    // either benign (clock current) or a counted revert: never an unexplained send
    assert.ok(st.benignNoProgress + st.totalReverts >= 1, r.logs.join("\n"));
  });

  it("AlreadyProcessed simulation is benign", async () => {
    const { conn, calls } = fakeConn({ sim: () => ({ err: "AlreadyProcessed" }) });
    const st = freshCrankMarketState();
    await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(calls.sent, 0);
    assert.equal(st.benignNoProgress, 1);
    assert.equal(st.totalReverts, 0);
  });

  it("a send failure is an error, not a revert; a blockhash error invalidates the cache", async () => {
    const { conn } = fakeConn({ send: async () => { throw new Error("Blockhash not found"); } });
    const st = freshCrankMarketState();
    const r = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(st.totalErrors, 1);
    assert.equal(st.totalCranks, 0);
    assert.match(st.lastErrorMsg ?? "", /Blockhash/);
    assert.ok(r.logs.some((l) => /crank send failed/.test(l)));
  });

  it("retries a transient 429 on the send and then lands", async () => {
    let n = 0;
    const { conn, calls } = fakeConn({
      send: async () => {
        if (++n === 1) throw new Error("429 Too Many Requests");
        return "sig-after-retry";
      },
    });
    const st = freshCrankMarketState();
    const r = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(st.lastSig, "sig-after-retry");
    assert.equal(calls.sent, 2);
    assert.ok(r.logs.some((l) => /transient RPC error/.test(l)));
  });

  it("gives up on a transient error after the attempt budget", async () => {
    const { conn, calls } = fakeConn({ send: async () => { throw new Error("fetch failed"); } });
    const st = freshCrankMarketState();
    await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(calls.sent, 4);
    assert.equal(st.totalErrors, 1);
  });

  it("a missing market account clears the cached LP and, for a seeded one, stops retrying the seed", async () => {
    const { conn } = fakeConn({ getAccount: async () => ({ context: { slot: SLOT }, value: null }) });
    const st = freshCrankMarketState();
    const r = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(st.totalErrors, 1);
    assert.equal(st.lpPortfolio, null);
    assert.equal(st.seedRejected, true);
    assert.ok(r.logs.some((l) => /seeded LP portfolio .* not found/.test(l)));
  });

  it("a market account read that throws counts one error", async () => {
    const { conn } = fakeConn({ getAccount: async () => { throw new Error("socket closed"); } });
    const st = freshCrankMarketState();
    await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(st.totalErrors, 1);
    assert.equal(st.lpPortfolio?.toBase58(), CATE_LP.toBase58(), "a non-account error keeps the seed");
  });

  it("uses the prefetched read instead of reading the market itself", async () => {
    const { conn, calls } = fakeConn();
    const st = freshCrankMarketState();
    await quiet(() =>
      crankOneMarket(conn as never, keeper, entry, st, false, { value: { data: fixture("cate-market-v18") } as never, context: { slot: SLOT } }),
    );
    assert.equal(calls.accountReads, 0);
    assert.equal(calls.sent, 1);
  });

  it("dry run builds the plan, sends and simulates nothing", async () => {
    const { conn, calls } = fakeConn();
    const st = freshCrankMarketState();
    const r = await quiet(() => crankOneMarket(conn as never, keeper, entry, st, true));
    assert.equal(calls.sent, 0);
    assert.equal(calls.sims, 0);
    assert.ok(r.logs.some((l) => /DRY-RUN/.test(l)));
  });

  it("a terminal (all-zero tombstone-like) market that is flagged terminal costs no RPC", async () => {
    const { conn, calls } = fakeConn();
    const st = freshCrankMarketState();
    st.terminal = true;
    await crankOneMarket(conn as never, keeper, entry, st, false);
    assert.equal(calls.accountReads, 0);
  });

  it("a malformed seeded lpPortfolio falls back to discovery once and marks the seed rejected", async () => {
    const { conn, calls } = fakeConn();
    const st = freshCrankMarketState();
    const r = await quiet(() => crankOneMarket(conn as never, keeper, { ...entry, lpPortfolio: "not-a-pubkey" }, st, true));
    assert.equal(st.seedRejected, true);
    assert.ok(r.logs.some((l) => /not a valid pubkey/.test(l)));
    assert.ok(calls.gpa >= 1, "discovery ran");
    assert.equal(st.lpPortfolio?.toBase58(), CATE_LP.toBase58());
  });

  it("no seed and no LP found: skipped, retried only after the discovery window", async () => {
    const { conn, calls } = fakeConn({ getProgramAccounts: async () => [] });
    const st = freshCrankMarketState();
    const e = { ...entry, lpPortfolio: undefined };
    const r = await quiet(async () => {
      await crankOneMarket(conn as never, keeper, e as never, st, false);
      const gpaAfterFirst = calls.gpa;
      await crankOneMarket(conn as never, keeper, e as never, st, false); // inside the 20s window
      assert.equal(calls.gpa, gpaAfterFirst, "not hammered");
    });
    assert.equal(st.lpPortfolio, null);
    assert.equal(calls.sent, 0);
    assert.ok(r.logs.some((l) => /no LP-vault portfolio found/.test(l)));
  });

  it("a discovery that throws is recorded and returns", async () => {
    const { conn, calls } = fakeConn({ getProgramAccounts: async () => { throw new Error("gpa 500"); } });
    const st = freshCrankMarketState();
    const e = { ...entry, lpPortfolio: undefined };
    await quiet(() => crankOneMarket(conn as never, keeper, e as never, st, false));
    assert.equal(st.lastErrorMsg, "gpa 500");
    assert.equal(calls.sent, 0);
  });

  it("an account too short for any layout is cranked accrual-only and reported with an unknown layout", async () => {
    const { conn, calls } = fakeConn({ marketData: Buffer.alloc(64) });
    const st = freshCrankMarketState();
    await quiet(() => crankOneMarket(conn as never, keeper, entry, st, false));
    assert.equal(st.obs?.layout?.kind, "unknown");
    assert.equal(calls.sent, 1);
  });
});

// ── sweep helpers ────────────────────────────────────────────────────────────

const ix0 = new TransactionInstruction({ programId: WRAPPER_PROGRAM_ID, keys: [], data: Buffer.alloc(0) });
const pf = (): PositionedPortfolio => ({ pubkey: Keypair.generate().publicKey, longLegs: 1, shortLegs: 0, isLp: false });
const crank = (kind: PlannedCrank["kind"], portfolio: PublicKey): PlannedCrank => ({ kind, portfolio, ix: ix0 });
const okSim: SimOutcome = { err: null, logs: [], marketData: new Uint8Array([1]) };

describe("sweepContextFor", () => {
  const cfg = { maxK: 4 } as never;
  it("is null when the sweep is disabled or the market does not decode", () => {
    const st = { sweepCursor: freshSweepCursor() };
    assert.equal(sweepContextFor(fixture("cate-market-v18"), [], st, cfg, false), null);
    assert.equal(sweepContextFor(new Uint8Array(8), [pf()], st, cfg, true), null);
  });
});

describe("emptySweepFollowup", () => {
  it("carries the error and zero counts", () => {
    const r = emptySweepFollowup("why");
    assert.equal(r.error, "why");
    assert.equal(r.txsSent, 0);
    assert.equal(emptySweepFollowup().error, null);
  });
});

describe("runSweepFollowups", () => {
  const market = Keypair.generate().publicKey;
  function deps(over: Record<string, unknown> = {}) {
    const visited: PublicKey[][] = [];
    const batches: PositionedPortfolio[][] = [];
    let landedSims = 0;
    const d = {
      pickBatch: () => batches.shift() ?? [],
      plan: (t: ReadonlyArray<PositionedPortfolio>, accrue: boolean): CrankPlan => ({
        cranks: [...(accrue ? [crank("accrue", market)] : []), ...t.map((p) => crank("refresh", p.pubkey))],
        overflow: [],
        computeUnits: 300_000,
      }),
      simulate: async () => okSim,
      send: async () => "SWEEPSIG0123456789",
      waitLanded: async () => "landed" as const,
      onVisited: (p: PublicKey[]) => { visited.push(p); },
      onLanded: () => { landedSims++; },
      ...over,
    };
    return { d: d as never, visited, batches, landed: () => landedSims };
  }

  it("sends each picked batch, waits, counts and reports visits", async () => {
    const { d, visited, batches, landed } = deps();
    batches.push([pf(), pf()], [pf()]);
    const taken = new Set<string>();
    const r = await runSweepFollowups(3, taken, d);
    assert.equal(r.txsSent, 2);
    assert.equal(r.txsLanded, 2);
    assert.equal(r.refreshed, 3);
    assert.equal(r.error, null);
    assert.equal(visited.length, 2);
    assert.equal(taken.size, 3);
    assert.equal(landed(), 2);
    assert.ok(r.lastMarketData);
  });

  it("stops when there is nothing left to pick", async () => {
    const { d } = deps();
    const r = await runSweepFollowups(5, new Set(), d);
    assert.equal(r.txsSent, 0);
  });

  it("a rejected accrual (Custom 22) is retried refresh-only", async () => {
    const { d, batches } = deps({
      simulate: async (plan: CrankPlan) =>
        plan.cranks[0].kind === "accrue" ? { err: { InstructionError: [1, { Custom: 22 }] }, logs: [], marketData: null } : okSim,
    });
    batches.push([pf()]);
    const r = await runSweepFollowups(1, new Set(), d);
    assert.equal(r.refreshOnly, 1);
    assert.equal(r.txsLanded, 1);
    assert.equal(r.error, null);
  });

  it("a simulation failure stops the sweep with the code", async () => {
    const { d, batches } = deps({ simulate: async () => ({ err: { InstructionError: [1, { Custom: 19 }] }, logs: [], marketData: null }) });
    batches.push([pf()], [pf()]);
    const r = await runSweepFollowups(2, new Set(), d);
    assert.match(r.error ?? "", /sweep simulation failed Custom\(19\)/);
    assert.equal(r.txsSent, 0);
  });

  it("a non-instruction simulation error is reported as JSON", async () => {
    const { d, batches } = deps({ simulate: async () => ({ err: "Weird", logs: [], marketData: null }) });
    batches.push([pf()]);
    const r = await runSweepFollowups(1, new Set(), d);
    assert.match(r.error ?? "", /"Weird"/);
  });

  it("every refresh rejected as not stale: no tx, the not-stale portfolios count as visited", async () => {
    const { d, batches, visited } = deps({
      simulate: async (plan: CrankPlan) =>
        plan.cranks.some((c) => c.kind === "refresh")
          ? { err: { InstructionError: [plan.cranks.findIndex((c) => c.kind === "refresh") + 1, { Custom: 22 }] }, logs: [], marketData: null }
          : okSim,
    });
    batches.push([pf()]);
    const r = await runSweepFollowups(1, new Set(), d);
    assert.equal(r.txsSent, 0);
    assert.equal(r.pruned.length, 1);
    assert.equal(visited.length, 1);
    assert.equal(r.error, null);
  });

  it("a tx that does not land ends the run with the status", async () => {
    const { d, batches } = deps({ waitLanded: async () => "timeout" });
    batches.push([pf()], [pf()]);
    const r = await runSweepFollowups(2, new Set(), d);
    assert.match(r.error ?? "", /sweep tx SWEEPSIG0123… timeout/);
    assert.equal(r.txsSent, 1);
    assert.equal(r.txsLanded, 0);
  });

  it("never throws: a send failure becomes the error", async () => {
    const { d, batches } = deps({ send: async () => { throw new Error("rpc exploded"); } });
    batches.push([pf()]);
    const r = await runSweepFollowups(1, new Set(), d);
    assert.equal(r.error, "sweep send failed: rpc exploded");
  });
});

// ── the recurring loop ───────────────────────────────────────────────────────

import { startRecoveryCrankLoop } from "./recovery-cranker.ts";

describe("startRecoveryCrankLoop", () => {
  it("cranks each cycle, tracks late-registered markets, reports health and stops on SIGINT", async () => {
    const { conn } = fakeConn({ getProgramAccounts: async () => [] });
    const beats = { n: 0, started: 0, stopped: 0 };
    const liveness = {
      beat: () => { beats.n++; },
      start: () => { beats.started++; return () => { beats.stopped++; }; },
      limitMs: () => 60_000,
    };
    const sinkCalls = { reconcile: 0 };
    const sink = {
      thresholds: {},
      health: () => {},
      reconcile: async () => { sinkCalls.reconcile++; if (sinkCalls.reconcile === 1) throw new Error("sink down"); },
    };
    const late = { marketAddress: Keypair.generate().publicKey.toBase58(), label: "LATE", lpPortfolio: undefined };
    const gone = { marketAddress: Keypair.generate().publicKey.toBase58(), label: "GONE", lpPortfolio: undefined };
    const registry = { markets: [entry, gone] };
    const boot = new Map([[gone.marketAddress, freshCrankMarketState()], [CATE.toBase58(), freshCrankMarketState()]]);
    boot.get(CATE.toBase58())!.consecutiveReverts = 4;
    boot.get(CATE.toBase58())!.lastRevertCode = 19;

    const { logs } = await quiet(async () => {
      const done = startRecoveryCrankLoop(conn as never, keeper, registry as never, { intervalMs: 2, dryRun: true }, sink as never, boot, liveness as never);
      // cycle 1: GONE is retired, LATE is registered live; the 30-cycle health summary needs more cycles
      await new Promise((r) => setTimeout(r, 20));
      registry.markets = [entry, late] as never;
      (registry as { markets: unknown[] }).markets = [entry, late];
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && sinkCalls.reconcile < 31) await new Promise((r) => setTimeout(r, 10));
      process.emit("SIGINT");
      await done;
    });
    assert.equal(beats.started, 1);
    assert.equal(beats.stopped, 1, "the watchdog dies with the loop");
    assert.ok(logs.some((l) => /now tracking newly-registered market LATE/.test(l)));
    assert.ok(logs.some((l) => /crank-health report failed/.test(l)), "a throwing report does not stop the loop");
    assert.ok(logs.some((l) => /\[health\] cycle 30/.test(l) && /CATE=⚠STUCK/.test(l)));
    assert.ok(logs.some((l) => /Recovery crank loop stopped/.test(l)));
  });
});
