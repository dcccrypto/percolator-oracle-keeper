/**
 * Bond fee crank (78) and stake sync (stake 31) failure alerts through the real V22Loop: a `fee-job-failed` warn after 3
 * consecutive failed RUNS of one job on one market, resolved by the next healthy run; quiet / expected outcomes never count.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@percolatorct/sdk";
import { AlertSink, DEFAULT_THRESHOLDS } from "../alerting.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { V22Loop, bondFeeVerdict } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { customAt, fakeLoopConn, key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";
import { allJobCounters, resetJobCounters } from "./exec.ts";

const MARKET = key(31);
const LP = key(32);

function poolBytes(): Uint8Array {
  const F = STAKE_POOL_FIELD_OFF_V5;
  const b = Buffer.alloc(STAKE_POOL_SIZE_V5);
  "SPOOL_V1".split("").forEach((c, i) => (b[F.reserved + i] = c.charCodeAt(0)));
  b[F.version] = 5;
  b[F.riskMode] = 1; // FIRST_LOSS, pool mode 0
  b.writeBigUInt64LE(150n, F.syncCooldownSlots);
  return new Uint8Array(b);
}

function harness(env: Record<string, string>, o: Parameters<typeof fakeLoopConn>[0]) {
  const now = { t: 1_000_000 };
  const lines: string[] = [];
  const errs: string[] = [];
  const f = fakeLoopConn(o);
  const markets = [{ marketAddress: MARKET.toBase58(), label: "JOB/T" }];
  const sink = new AlertSink({ thresholds: { ...DEFAULT_THRESHOLDS }, now: () => now.t, log: (l) => lines.push(l), logError: (l) => errs.push(l) });
  const keeper = Keypair.generate();
  const loop = new V22Loop({
    conn: f.conn as never,
    keeper,
    programId: WRAPPER_PROGRAM_ID,
    markets: () => markets,
    flags: v22FlagsFromEnv({ KEEPER_V22: "on", ...env }),
    dryRun: false,
    alertSink: sink,
    feeIntervalMs: 1,
    now: () => now.t,
    log: () => {},
  });
  const fired = () => errs.filter((l) => l.startsWith("[ALERT]") && l.includes('"kind":"fee-job-failed"'));
  const resolved = () => lines.filter((l) => l.startsWith("[ALERT-RESOLVED]") && l.includes('"kind":"fee-job-failed"'));
  // each tick: past the stake-sync interval and its one-cooldown backoff
  const tick = async (slots = 200) => {
    now.t += 61_000;
    o.readSlot = (o.readSlot ?? 5000) + slots;
    await loop.tick();
  };
  const round = () => loop.sweepDelegate({ conn: f.conn as never, keeper, entry: markets[0], marketData: o.market, slot: o.readSlot ?? 5000, dryRun: false } as never);
  return { loop, f, fired, resolved, tick, round, markets };
}

const stakeBase = () => ({ market: v22MarketBytes(), lpAccount: poolBytes(), readSlot: 5000 });
const feeBase = () => ({ market: v22MarketBytes(), registry: registryBytes({ bound: true, ext: true, bond: true }), vaultLpState: vaultLpStateBytes(LP), readSlot: 5000 });

describe("v2.2 job-failure alerts: stake sync", () => {
  it("refused every run: silent twice, warn on the 3rd, RESOLVED by the next clean sync", async () => {
    let refuse = true;
    const h = harness({ KEEPER_V22_STAKE_SYNC: "on" }, { ...stakeBase(), simErr: () => (refuse ? customAt(0, 40) : null) });
    await h.tick();
    await h.tick();
    assert.equal(h.fired().length, 0, "two failed runs: no alert yet");
    await h.tick();
    assert.equal(h.fired().length, 1);
    assert.match(h.fired()[0], /"severity":"warn"/);
    assert.match(h.fired()[0], /"subject":"stake-sync JOB\/T"/);
    assert.match(h.fired()[0], /v2\.2 stake-sync failed 3x consecutively/);
    refuse = false;
    await h.tick();
    assert.equal(h.resolved().length, 1, "a clean run clears it");
  });

  it("quiet 43 every run never alerts", async () => {
    const h = harness({ KEEPER_V22_STAKE_SYNC: "on" }, { ...stakeBase(), simErr: () => customAt(0, 43) });
    for (let i = 0; i < 6; i++) await h.tick();
    assert.equal(h.f.sims.length, 6, "control: the job ran every tick");
    assert.equal(h.fired().length, 0);
  });

  for (const code of [37, 43]) {
    it(`a landed-failed ${code} is quiet: it resets the streak`, async () => {
      let mode: "refuse" | "land" = "refuse";
      const h = harness({ KEEPER_V22_STAKE_SYNC: "on" }, { ...stakeBase(), simErr: () => (mode === "refuse" ? customAt(0, 40) : null), confirmFail: () => code });
      await h.tick();
      await h.tick();
      mode = "land";
      await h.tick();
      assert.equal(h.f.sent.length, 1, "control: the tx landed");
      mode = "refuse";
      await h.tick();
      await h.tick();
      assert.equal(h.fired().length, 0, "2 + 2 failed runs around a quiet one");
    });
  }

  it("a landed-failed 44 (diverged) is neutral: the streak is kept across it", async () => {
    let mode: "refuse" | "land" = "refuse";
    const h = harness({ KEEPER_V22_STAKE_SYNC: "on" }, { ...stakeBase(), simErr: () => (mode === "refuse" ? customAt(0, 40) : null), confirmFail: () => 44 });
    await h.tick();
    await h.tick();
    mode = "land";
    await h.tick();
    assert.equal(h.f.sent.length, 1, "control: the tx landed");
    assert.equal(h.fired().length, 0);
    mode = "refuse";
    await h.tick(3_100); // past the 20-cooldown divergence backoff
    assert.equal(h.fired().length, 1, "third failed run");
  });

  it("a market that leaves the registry drops its streak and resolves its alert", async () => {
    const h = harness({ KEEPER_V22_STAKE_SYNC: "on" }, { ...stakeBase(), simErr: () => customAt(0, 40) });
    for (let i = 0; i < 3; i++) await h.tick();
    assert.equal(h.fired().length, 1);
    const row = h.markets.pop()!;
    await h.tick();
    assert.equal(h.resolved().length, 1);
    h.markets.push(row);
    await h.tick();
    await h.tick();
    assert.equal(h.fired().length, 1, "back in the registry: the streak restarts at zero");
  });
});

describe("v2.2 job-failure alerts: bond fee crank (78)", () => {
  it("timer path: a non-band refusal 3 runs in a row alerts", async () => {
    const h = harness({ KEEPER_V22_FEE_CRANK_BOND: "on" }, { ...feeBase(), simErr: () => customAt(1, 7) });
    await h.tick();
    await h.tick();
    assert.equal(h.fired().length, 0);
    await h.tick();
    assert.equal(h.fired().length, 1);
    assert.match(h.fired()[0], /v2\.2 fee-78 failed 3x consecutively/);
  });

  it("timer path: an expected band refusal (112) 6 runs in a row, or 38 on every run, never alerts", async () => {
    for (const code of [112, 38]) {
      const h = harness({ KEEPER_V22_FEE_CRANK_BOND: "on" }, { ...feeBase(), simErr: () => customAt(1, code) });
      for (let i = 0; i < 6; i++) await h.tick();
      assert.ok(h.f.sims.length >= 6, "control: 78 was simulated every run");
      assert.equal(h.f.sent.length, 0);
      assert.equal(h.fired().length, 0, `code ${code}`);
    }
  });

  it("timer path: a landed-failed 38 (cranked by someone else meanwhile) resets the streak", async () => {
    let mode: "refuse" | "land" = "refuse";
    const h = harness({ KEEPER_V22_FEE_CRANK_BOND: "on" }, { ...feeBase(), simErr: () => (mode === "refuse" ? customAt(1, 7) : null), confirmFail: () => 38 });
    await h.tick();
    await h.tick();
    mode = "land";
    await h.tick();
    assert.equal(h.f.sent.length, 1, "control: the tx landed");
    mode = "refuse";
    await h.tick();
    await h.tick();
    assert.equal(h.fired().length, 0);
  });

  it("one run that makes three sends counts once: no alert after one run, an alert after three", async () => {
    // [LP crank, 78]: the LP crank answers 22 (accrued this slot) and is dropped; the LP refresh is refused and pruned; 78 alone is refused
    resetJobCounters();
    const codes = [22, 5, 7];
    const h = harness({ KEEPER_V22_FEE_CRANK_BOND: "on" }, { ...feeBase(), simErr: (_t: unknown, i: number) => customAt(0, codes[i % 3]) });
    await h.tick();
    assert.equal(h.f.sims.length, 3, "control: three sends in one run");
    assert.equal(allJobCounters()["fee-78"].refused, 3);
    assert.equal(h.fired().length, 0);
    await h.tick();
    await h.tick();
    assert.equal(h.f.sims.length, 9);
    assert.equal(h.fired().length, 1);
  });

  it("after-round path: a refusal reported as a deferral alerts after 3 rounds; an expected band refusal never does", async () => {
    for (const code of [7, 112]) {
      resetJobCounters();
      const portfolios = [
        { pubkey: LP, data: portfolioBytes({ owner: key(9), capital: 1000n, legs: [{ side: 1, basis: 25n }] }) },
        { pubkey: key(33), data: portfolioBytes({ owner: key(8), capital: 5n, legs: [{ side: 0, basis: 5n }] }) },
      ];
      const h = harness({ KEEPER_V22_SWEEP: "on", KEEPER_V22_FEE_CRANK_BOND: "on" }, { ...feeBase(), portfolios, simErr: (t: { tags: number[] }) => (t.tags.includes(78) ? customAt(0, code) : null) });
      for (let i = 0; i < 3; i++) {
        await h.round();
        await h.tick(0); // same slot: no catch-up, so every call runs a full round
      }
      const lastFee = (h.loop.healthFields() as { markets: Record<string, { fee78?: string }> }).markets[MARKET.toBase58()].fee78;
      assert.equal(lastFee, "after-round deferred", "control: 78 ran at the end of a round and was deferred");
      const c = allJobCounters()["fee-78"];
      assert.equal(c.refused + c.expected, 3, "control: one 78 per round");
      assert.equal(h.fired().length, code === 7 ? 1 : 0, `code ${code}`);
    }
  });

  it("verdicts: an expected refusal is healthy on both the refused and the deferred result", () => {
    const refused = (expected: boolean) => ({ kind: "refused" as const, code: 112, index: 0, name: "PriceBandTooNarrow(112)", expected, logs: [] });
    assert.equal(bondFeeVerdict({ kind: "refused", outcome: refused(true), shape: "lp-only-unpaired" }), null);
    assert.equal(bondFeeVerdict({ kind: "deferred", detail: "after-round: 78 refused", outcome: refused(true) }), null);
    assert.equal(bondFeeVerdict({ kind: "deferred", detail: "after-round: 78 refused", outcome: refused(false) }), "refused PriceBandTooNarrow(112)");
    assert.equal(bondFeeVerdict({ kind: "nothing", detail: "no new LP fees (38)" }), null);
    assert.equal(bondFeeVerdict({ kind: "skipped", reason: "not-bond" }), null);
    assert.equal(bondFeeVerdict({ kind: "deferred", detail: "held" }), undefined);
  });
});
