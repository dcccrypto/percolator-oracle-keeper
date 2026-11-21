/**
 * Catch-up pacing (loop.ts): a backwards wall-clock step must not stall catch-up, and a bad
 * KEEPER_V22_CATCHUP_SPACING_MS must not disable pacing (NaN) or silently become 0 ("").
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
import { fakeLoopConn, key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const MARKET = key(900);
const NOW = 50_000n;
const ENV = "KEEPER_V22_CATCHUP_SPACING_MS";
const savedEnv = process.env[ENV];

beforeEach(() => { resetPairingStats(); resetJobCounters(); });
afterEach(() => {
  setSweepDelegate(null); setLoneLpCrankSuppressor(null); setBondFeeDelegated(false); setProtectiveTrigger(null); setV22HealthProvider(null);
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
});

function setup(o: { spacingMs?: number }) {
  const market = v22MarketBytes({ currentSlot: NOW, slotLast: NOW - 1500n });
  const f = fakeLoopConn({ readSlot: Number(NOW), market, registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(key(901), 0n), lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }) });
  const clock = { t: 1_000_000 };
  const lines: string[] = [];
  const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l), now: () => clock.t, catchupSpacingMs: o.spacingMs });
  const run = () => loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22" }, marketData: market, slot: Number(NOW), dryRun: false });
  return { f, clock, run, lines };
}

describe("catch-up pacing under a backwards clock step", () => {
  it("a clock that steps back an hour does not hold catch-up off until it catches up", async () => {
    const s = setup({ spacingMs: 1500 });
    await s.run();
    assert.equal(s.f.sent.length, 1);
    s.clock.t -= 3_600_000; // NTP step backwards
    await s.run();
    assert.equal(s.f.sent.length, 2, "negative age is expired, not paced");
    // pacing resumes against the new clock
    s.clock.t += 100;
    await s.run();
    assert.equal(s.f.sent.length, 2, "still paced inside the spacing after the reset");
  });
});

describe("KEEPER_V22_CATCHUP_SPACING_MS parsing", () => {
  for (const bad of ["abc", "", "-5", "0", "Infinity"]) {
    it(`${JSON.stringify(bad)} falls back to the 1500 ms default (pacing stays on)`, async () => {
      process.env[ENV] = bad;
      const s = setup({});
      await s.run();
      assert.equal(s.f.sent.length, 1);
      s.clock.t += 100;
      await s.run();
      assert.equal(s.f.sent.length, 1, "paced inside the default spacing");
      s.clock.t += 1500;
      await s.run();
      assert.equal(s.f.sent.length, 2);
    });
  }
  it("a valid decimal value is honoured", async () => {
    process.env[ENV] = "5000";
    const s = setup({});
    await s.run();
    s.clock.t += 3000;
    await s.run();
    assert.equal(s.f.sent.length, 1);
    s.clock.t += 2500;
    await s.run();
    assert.equal(s.f.sent.length, 2);
  });
});
