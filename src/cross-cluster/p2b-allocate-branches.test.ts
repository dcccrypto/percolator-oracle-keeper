/**
 * Tag 103 allocation cranks: branch coverage for the paths p2b-allocate.test.ts leaves open —
 * default clock / rand / log fallbacks, env edge values, beforeSend re-sign, on-chain failure and
 * not-landed classification, unclassified simulation errors, failure-streak pacing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_ALLOCATE_CONFIG, VaultLpAllocator, allocateConfigFromEnv } from "./p2b-allocate.ts";
import type { AllocateConfig } from "./p2b-allocate.ts";
import { KEEPER, PROGRAM, fakeConn, patchedMarket, registryBytes, snapshot, vaultLpStateBytes } from "./p2b-test-helpers.ts";

const ie = (detail: unknown) => ({ InstructionError: [1, detail] });
const CFG: AllocateConfig = { ...DEFAULT_ALLOCATE_CONFIG, intervalMs: 60_000, jitter: 0 };

function snap(label = "SOL") {
  return snapshot({
    label,
    registryData: registryBytes({ bound: true }),
    marketData: patchedMarket(),
    vaultLpData: vaultLpStateBytes({ lp: Keypair.generate().publicKey, outstanding: 0n }),
  });
}

function rig(o: { cfg?: Partial<AllocateConfig>; sims?: Array<{ err: unknown; logs?: string[] }>; confirmErr?: unknown; beforeSend?: (m: never, l: string) => Promise<void> } = {}) {
  let now = 1_000_000;
  const c = fakeConn({ sims: o.sims, confirmErr: o.confirmErr });
  const logs: string[] = [];
  const a = new VaultLpAllocator({ ...CFG, ...o.cfg }, {
    programId: PROGRAM,
    conn: c.conn as never,
    keeper: KEEPER,
    now: () => now,
    rand: () => 0,
    log: (l) => logs.push(l),
    confirm: { statusRetries: 0, statusRetryDelayMs: 1 },
    beforeSend: o.beforeSend as never,
  });
  return { a, c, logs, advance: (ms: number) => { now += ms; } };
}

async function due(r: ReturnType<typeof rig>, s: ReturnType<typeof snap>) {
  await r.a.runMarket(s); // rand 0 -> stagger 0 -> due immediately
}

describe("tag 103: default clock / rand / log fallbacks", () => {
  it("with no now/rand/log deps: real clock + Math.random stagger inside one interval, console.log used", async () => {
    const c = fakeConn({ sims: [{ err: ie({ Custom: 7 }) }] });
    const a = new VaultLpAllocator({ ...CFG, intervalMs: 1_000 }, { programId: PROGRAM, conn: c.conn as never, keeper: KEEPER });
    const s = snap();
    assert.equal(await a.runMarket(s), "not-due", "first sight is staggered even with default rand");
    assert.equal(c.count("simulateTransaction"), 0);
    const orig = console.log;
    const lines: string[] = [];
    console.log = (l: string) => { lines.push(l); };
    try {
      // wait out the maximum stagger (< 1 s) on the real clock
      await new Promise((r) => setTimeout(r, 1_050));
      assert.equal(await a.runMarket(s), "refused");
    } finally {
      console.log = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Custom\(7\)/);
    assert.equal(c.sent.length, 0);
  });
});

describe("allocateConfigFromEnv edges", () => {
  it("blank / whitespace values fall back to the default; bounds are inclusive; non-integers and NaN are rejected", () => {
    const blank = allocateConfigFromEnv({ P2B_ALLOCATE_INTERVAL_MS: "  ", P2B_ALLOCATE_CU: "" }, false);
    assert.equal(blank.intervalMs, 60_000);
    assert.equal(blank.computeUnits, DEFAULT_ALLOCATE_CONFIG.computeUnits);
    const lo = allocateConfigFromEnv({ P2B_ALLOCATE_INTERVAL_MS: "1000", P2B_ALLOCATE_JITTER_PCT: "0", P2B_ALLOCATE_CU: "50000" }, false);
    assert.deepEqual([lo.intervalMs, lo.jitter, lo.computeUnits], [1_000, 0, 50_000]);
    const hi = allocateConfigFromEnv({ P2B_ALLOCATE_INTERVAL_MS: "86400000", P2B_ALLOCATE_JITTER_PCT: "90", P2B_ALLOCATE_CU: "1400000" }, false);
    assert.deepEqual([hi.intervalMs, hi.jitter, hi.computeUnits], [86_400_000, 0.9, 1_400_000]);
    assert.throws(() => allocateConfigFromEnv({ P2B_ALLOCATE_INTERVAL_MS: "1000.5" }, false), /an integer/);
    assert.throws(() => allocateConfigFromEnv({ P2B_ALLOCATE_CU: "abc" }, false), /P2B_ALLOCATE_CU/);
    assert.throws(() => allocateConfigFromEnv({ P2B_ALLOCATE_CU: "49999" }, false), /P2B_ALLOCATE_CU/);
    assert.throws(() => allocateConfigFromEnv({ P2B_ALLOCATE_JITTER_PCT: "-1" }, false), /a number/);
    assert.equal(allocateConfigFromEnv({}, true).dryRun, true);
  });
});

describe("tag 103: simulation / landing outcomes", () => {
  it("an unclassified simulation error (no Custom code): failed, never sent, logged", async () => {
    const r = rig({ sims: [{ err: "AccountNotFound" }] });
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "failed");
    assert.equal(r.c.sent.length, 0);
    assert.equal(r.a.stats.failed, 1);
    assert.match(r.logs.join("\n"), /simulation error "AccountNotFound"/);
  });

  it("the same refused code is logged once but counted every time", async () => {
    const r = rig({ sims: [{ err: ie({ Custom: 42 }) }] });
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "refused");
    r.advance(60_001);
    assert.equal(await r.a.runMarket(s), "refused");
    assert.equal(r.a.stats.refusedCodes["42"], 2);
    assert.equal(r.logs.filter((l) => l.includes("Custom(42)")).length, 1);
    assert.equal(r.c.sent.length, 0);
  });

  it("a tx that lands failed on chain (not Custom(100)): failed, counted, alert streak starts", async () => {
    const r = rig({ sims: [{ err: null }], confirmErr: ie({ Custom: 5 }) });
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "failed");
    assert.equal(r.a.stats.sent, 1);
    assert.equal(r.a.stats.failed, 1);
    assert.match(r.logs.join("\n"), /landed but failed on chain/);
  });

  it("beforeSend runs, may throw without blocking, and the send is re-signed on a fresh blockhash", async () => {
    let called = 0;
    const r = rig({ sims: [{ err: null }], beforeSend: async () => { called++; throw new Error("guard down"); } });
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "sent");
    assert.equal(called, 1);
    assert.equal(r.c.count("getLatestBlockhash"), 2, "fresh blockhash after the hook");
    assert.equal(r.c.sent.length, 1);
  });

  it("beforeSend also runs in dry-run, and dry-run still never sends nor re-fetches a blockhash", async () => {
    let called = 0;
    const r = rig({ cfg: { dryRun: true }, sims: [{ err: null }], beforeSend: async () => { called++; } });
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "dry-run");
    assert.equal(called, 1);
    assert.equal(r.c.sent.length, 0);
    assert.equal(r.c.count("getLatestBlockhash"), 1);
  });
});

describe("tag 103: failure pacing", () => {
  it("each consecutive hard failure doubles the wait (capped at 2^4) and a non-failure resets it", async () => {
    const r = rig({ cfg: { maxBackoffMs: 10_000_000 }, sims: [{ err: "AccountNotFound" }, { err: "AccountNotFound" }, { err: ie({ Custom: 100 }) }] });
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "failed"); // streak 1 -> 2x
    r.advance(119_999);
    assert.equal(await r.a.runMarket(s), "not-due");
    r.advance(2);
    assert.equal(await r.a.runMarket(s), "failed"); // streak 2 -> 4x
    r.advance(239_999);
    assert.equal(await r.a.runMarket(s), "not-due");
    r.advance(2);
    assert.equal(await r.a.runMarket(s), "no-room"); // clears streak -> 1x
    assert.equal(r.a.activeAlerts(1).length, 0);
    r.advance(60_001);
    assert.equal(await r.a.runMarket(s), "no-room");
  });

  it("an exception that is not an Error is stringified into the alert", async () => {
    const r = rig();
    (r.c.conn as { getLatestBlockhash: unknown }).getLatestBlockhash = async () => { throw "boom-string"; };
    const s = snap("WEIRD");
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "failed");
    const alerts = r.a.activeAlerts(1);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].message, /boom-string/);
    assert.equal(alerts[0].subject, "WEIRD");
    assert.equal(r.a.activeAlerts(2).length, 0, "below minStreak no alert");
  });
});

describe("tag 103: remaining landing / account branches", () => {
  it("a tx that never lands (expired blockhash): failed with the retry-next-turn log, never a no-room", async () => {
    const r = rig({ sims: [{ err: null }] });
    const conn = r.c.conn as unknown as { getSignatureStatuses: unknown; getBlockHeight: unknown };
    conn.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [null] });
    conn.getBlockHeight = async () => 10 ** 12;
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "failed");
    assert.equal(r.a.stats.sent, 1);
    assert.equal(r.a.stats.landed, 0);
    assert.equal(r.a.stats.noRoom, 0);
    assert.match(r.logs.join("\n"), /not landed \(retry next turn\)/);
  });

  it("a landed tx whose simulation reported no unitsConsumed logs '?' instead of throwing", async () => {
    const r = rig({ sims: [{ err: null }] });
    const conn = r.c.conn as unknown as { simulateTransaction: (...a: unknown[]) => Promise<{ value: { unitsConsumed?: number } }> };
    const orig = conn.simulateTransaction.bind(conn);
    conn.simulateTransaction = async (...a: unknown[]) => {
      const res = await orig(...a);
      delete res.value.unitsConsumed;
      return res;
    };
    const s = snap();
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "sent");
    assert.match(r.logs.join("\n"), /simulated \? CU/);
  });

  it("no registry bytes in the snapshot: eligibility already refuses, so nothing is simulated or sent", async () => {
    const r = rig({ sims: [{ err: null }] });
    const s = snapshot({ registryData: null, marketData: patchedMarket(), vaultLpData: vaultLpStateBytes({ lp: Keypair.generate().publicKey, outstanding: 0n }) });
    await due(r, s);
    assert.equal(await r.a.runMarket(s), "ineligible");
    assert.equal(r.c.count("simulateTransaction"), 0);
  });
});
