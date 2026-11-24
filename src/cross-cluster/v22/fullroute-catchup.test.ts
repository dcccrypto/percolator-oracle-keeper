/**
 * Full crank routing (wrapper agent/J-20261124-PROG-FULLROUTE): every crank commits the engine's canonical path, which
 * covers at most 32 slots per asset per call (V16_MAX_ACCRUAL_PATH_STEPS), whatever max_accrual_dt_slots is. The keeper
 * counts catch-up cranks in 32-slot windows, and since a 20 s cycle (~50 slots) now always starts one window behind, a
 * cycle that catches the market up runs its round in the same cycle on a fresh read.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { resetJobCounters } from "./exec.ts";
import { resetPairingStats } from "./sweep.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { setSweepDelegate, setLoneLpCrankSuppressor, setBondFeeDelegated, setProtectiveTrigger } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { CATCHUP_CRANK_CU, CATCHUP_PATH_CRANK_CU, V16_MAX_ACCRUAL_PATH_STEPS, catchupCrankCount, catchupCrankCuEstimate, crankPathStepsFromEnv, crankWindowSlots } from "../positioned-refresh.ts";
import { fakeLoopConn, key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const MARKET = key(910);
const DT = 150n; // v22MarketBytes: max_accrual_dt_slots
const NOW = 60000n;

beforeEach(() => { resetPairingStats(); resetJobCounters(); delete process.env.KEEPER_V22_CRANK_PATH_STEPS; });
afterEach(() => { setSweepDelegate(null); setLoneLpCrankSuppressor(null); setBondFeeDelegated(false); setProtectiveTrigger(null); setV22HealthProvider(null); delete process.env.KEEPER_V22_CRANK_PATH_STEPS; });

describe("crank window under full routing", () => {
  it("one crank covers min(max_accrual_dt_slots, 32) slots; 0 = the single-segment wrapper", () => {
    assert.equal(V16_MAX_ACCRUAL_PATH_STEPS, 32n);
    assert.equal(crankWindowSlots(150n, 32n), 32n);
    assert.equal(crankWindowSlots(500n, 32n), 32n);
    assert.equal(crankWindowSlots(20n, 32n), 20n);
    assert.equal(crankWindowSlots(150n, 0n), 150n);
    assert.equal(crankWindowSlots(0n, 32n), 0n);
  });
  it("catch-up past 32 slots: floor(gap / 32) bounded cranks before the accrual (capped per tx)", () => {
    assert.deepEqual([1n, 31n, 32n, 50n, 100n, 500n].map((g) => catchupCrankCount(g, 500n, 32n)), [0, 0, 1, 1, 3, 15]);
    assert.equal(catchupCrankCount(32n * 100n, 500n, 32n), 40); // MAX_CATCHUP_CRANKS
    // legacy (single-segment wrapper): the same gaps against a 500-slot window
    assert.deepEqual([1n, 31n, 32n, 50n, 100n, 500n].map((g) => catchupCrankCount(g, 500n, 0n)), [0, 0, 0, 0, 0, 1]);
  });
  it("KEEPER_V22_CRANK_PATH_STEPS: default 32, 0 = legacy, junk = default", () => {
    assert.equal(crankPathStepsFromEnv({}), 32n);
    assert.equal(crankPathStepsFromEnv({ KEEPER_V22_CRANK_PATH_STEPS: "0" }), 0n);
    assert.equal(crankPathStepsFromEnv({ KEEPER_V22_CRANK_PATH_STEPS: "16" }), 16n);
    assert.equal(crankPathStepsFromEnv({ KEEPER_V22_CRANK_PATH_STEPS: "-3" }), 32n);
    assert.equal(crankPathStepsFromEnv({ KEEPER_V22_CRANK_PATH_STEPS: "abc" }), 32n);
    assert.equal(catchupCrankCount(50n, DT), 1, "default env = full routing");
  });
  it("static catch-up CU estimate: a 32-step path crank (120k) under full routing, 45k for the single-segment wrapper", () => {
    assert.equal(catchupCrankCuEstimate(32n), CATCHUP_PATH_CRANK_CU);
    assert.equal(CATCHUP_PATH_CRANK_CU, 120_000);
    assert.equal(catchupCrankCuEstimate(0n), CATCHUP_CRANK_CU);
    assert.ok(CATCHUP_PATH_CRANK_CU >= Math.ceil(108_574 * 1.08), "covers the measured bounded 32-step crank");
  });
});

/**
 * Runs one sweep cycle. `gaps[i]` is the gap the market reads after `i` sent txs (the chain moves and each landed
 * catch-up closes some of it), so the loop's re-reads see the effect of what it sent.
 */
async function cycle(gaps: bigint[]) {
  const bytes = gaps.map((g) => v22MarketBytes({ currentSlot: NOW, slotLast: NOW - g }));
  const holder: { f: ReturnType<typeof fakeLoopConn> | null } = { f: null };
  const opts = {
    readSlot: Number(NOW),
    get market() {
      const n = holder.f ? holder.f.sent.length : 0;
      return bytes[Math.min(n, bytes.length - 1)];
    },
    registry: registryBytes({ bound: true, ext: true, bond: false }),
    vaultLpState: vaultLpStateBytes(key(911), 0n),
    lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }),
  };
  const f = fakeLoopConn(opts as never);
  holder.f = f;
  const lines: string[] = [];
  const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22FR" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l: string) => lines.push(l), catchupSpacingMs: 0 } as never);
  const handled = await loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22FR" }, marketData: bytes[0], slot: Number(NOW), dryRun: false });
  return { f, lines, handled };
}

const catchupLines = (lines: string[]) => lines.filter((l) => l.includes("[v22][catchup]"));
const roundRan = (lines: string[]) => lines.some((l) => l.includes("[v22][sweep]") && /PAIRED|UNPAIRED/.test(l));

describe("v22 loop under full routing: catch-up, then the round in the same cycle", () => {
  it("steady state (50 slots = one 20 s cycle, under max_accrual_dt 150): one catch-up crank, then the round runs", async () => {
    const r = await cycle([50n, 10n]);
    assert.equal(r.handled, true);
    assert.equal(catchupLines(r.lines).length, 1, r.lines.join("\n"));
    assert.ok(catchupLines(r.lines)[0].includes("1 catch-up crank(s)"), r.lines.join("\n"));
    assert.deepEqual(r.f.sent[0].tags, [5], "one bounded observation crank");
    assert.ok(r.f.sent.length >= 2, "the round sent its own tx after the catch-up");
    assert.ok(roundRan(r.lines), r.lines.join("\n"));
  });
  it("a window boundary crossed while the catch-up lands: one more catch-up tx (re-read), then the round", async () => {
    const r = await cycle([50n, 40n, 5n]);
    assert.equal(catchupLines(r.lines).length, 2, r.lines.join("\n"));
    assert.deepEqual(r.f.sent[0].tags, [5]);
    assert.deepEqual(r.f.sent[1].tags, [5]);
    assert.ok(roundRan(r.lines), r.lines.join("\n"));
  });
  it("far behind (500 slots): at most CATCHUP_TXS_PER_CYCLE (2) catch-up txs, no round this cycle", async () => {
    const r = await cycle([500n, 350n, 200n, 50n]);
    assert.equal(r.handled, true);
    assert.equal(catchupLines(r.lines).length, 2, r.lines.join("\n"));
    assert.ok(catchupLines(r.lines)[0].includes("15 catch-up crank(s) wanted") || /\(15 wanted\)/.test(catchupLines(r.lines)[0]), catchupLines(r.lines)[0]);
    assert.ok(!roundRan(r.lines), "the round waits for a later cycle");
    assert.ok(r.f.sent.every((s) => s.tags.every((t: number) => t === 5)), "catch-up cranks only");
  });
  it("legacy mode (KEEPER_V22_CRANK_PATH_STEPS=0): a 50-slot gap is inside the 150-slot window, no catch-up", async () => {
    process.env.KEEPER_V22_CRANK_PATH_STEPS = "0";
    const r = await cycle([50n]);
    assert.equal(catchupLines(r.lines).length, 0, r.lines.join("\n"));
    assert.ok(roundRan(r.lines), r.lines.join("\n"));
  });
  it("legacy mode keeps the old shape: one catch-up tx and no round in that cycle", async () => {
    process.env.KEEPER_V22_CRANK_PATH_STEPS = "0";
    const r = await cycle([DT * 2n + 5n, 5n]);
    assert.equal(catchupLines(r.lines).length, 1, r.lines.join("\n"));
    assert.equal(r.f.sent.length, 1);
    assert.ok(!roundRan(r.lines));
  });
});
