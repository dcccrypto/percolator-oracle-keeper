/**
 * R3-M1 par - E3 gap monitor (p2b-earn-gap.ts): /health shape and values on a HAND-BUILT pot
 * (the SDK repo's worked example: planted source-credit + bucket records at asset 1 / domain 2,
 * a hand-edited ledger), the alert streak, and "never breaks on markets with no registry".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveLpBackingLedger, nonboundVaultPricingFromAccountsP2b } from "@percolatorct/sdk";
import { DEFAULT_EARN_GAP_CONFIG, EarnGapMonitor, earnGapConfigFromEnv, isNonBoundEarnVault } from "./p2b-earn-gap.ts";
import { PROGRAM, fakeConn, fxJson, registryBytes, snapshot } from "./p2b-test-helpers.ts";

interface PotFx {
  sourceCreditHex: string;
  bucketHex: string;
  ledgerAccountHex: string;
  asset1: { sourceCreditLong: number; backingLong: number };
  marketGroupOff: number;
  marketGroupHeaderLen: number;
  assetSlotLen: number;
}
const FX = fxJson<PotFx>("p2b-pot-records.json");
const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

/** A market account with the planted pot records of asset 1 (domain 2 = long). */
function plantedMarket(): Uint8Array {
  const m = new Uint8Array(FX.marketGroupOff + FX.marketGroupHeaderLen + 2 * FX.assetSlotLen);
  m[10] = 1;
  m.set(unhex(FX.sourceCreditHex), FX.asset1.sourceCreditLong);
  m.set(unhex(FX.bucketHex), FX.asset1.backingLong);
  return m;
}

/** Own-domain ledger of the worked example: principal 1,100 atoms, earnings watermark == bucket earnings (nothing to sync). */
function ownLedger(principal = 1_100): Uint8Array {
  const own = unhex(FX.ledgerAccountHex).slice();
  own.fill(0, 16 + 64, 16 + 80);
  new DataView(own.buffer).setBigUint64(16 + 64, BigInt(principal), true);
  new DataView(own.buffer).setBigUint64(16 + 144, 900_000_000_000_000_000_000n & ((1n << 64n) - 1n), true);
  new DataView(own.buffer).setBigUint64(16 + 152, 900_000_000_000_000_000_000n >> 64n, true);
  return own;
}

function vault(o: { label?: string; principal?: number; registry?: Uint8Array | null; market?: Uint8Array | null; slot?: number } = {}) {
  const s = snapshot({
    label: o.label ?? "EARN",
    marketData: o.market === undefined ? plantedMarket() : o.market,
    registryData: o.registry === undefined ? registryBytes({ bound: false, domain: 2, feeShareBps: 0 }) : o.registry,
  });
  const accounts = new Map<string, Uint8Array>();
  accounts.set(deriveLpBackingLedger(PROGRAM, s.market, 2)[0].toBase58(), ownLedger(o.principal ?? 1_100));
  const c = fakeConn({ accounts, slot: o.slot ?? 505_231_300 });
  return { s, c };
}

const quiet = () => undefined;
const mon = (cfg = DEFAULT_EARN_GAP_CONFIG, now = () => 0) => new EarnGapMonitor(cfg, PROGRAM, now, quiet);

describe("earnVaults /health record on the hand-built pot", () => {
  it("exact shape and values: entry 1100, exit 1032, gap 68 atoms = 618 bps; bigints are strings", async () => {
    const { s, c } = vault();
    const m = mon();
    await m.run(c.conn as never, [s]);
    const h = m.health();
    assert.equal(h.length, 1);
    assert.deepEqual(h[0], {
      market: s.ref.marketAddress,
      label: "EARN",
      domain: 2,
      entryNavAtoms: "1100",
      exitNavAtoms: "1032",
      parMinusE3Atoms: "68",
      parMinusE3Bps: 618,
      updatedSlot: 505_231_300,
    });
    for (const k of ["entryNavAtoms", "exitNavAtoms", "parMinusE3Atoms"] as const) assert.equal(typeof h[0][k], "string");
    assert.doesNotThrow(() => JSON.stringify(h));
  });

  it("agrees with the SDK helper called directly (nonboundVaultPricingFromAccountsP2b)", async () => {
    const { s, c } = vault();
    const m = mon();
    await m.run(c.conn as never, [s]);
    const p = nonboundVaultPricingFromAccountsP2b({ marketData: plantedMarket(), registryDomain: 2, feeShareBps: 0, ownLedgerData: ownLedger(), siblingLedgerData: null });
    assert.deepEqual([m.health()[0].entryNavAtoms, m.health()[0].exitNavAtoms, m.health()[0].parMinusE3Atoms, m.health()[0].parMinusE3Bps], [String(p.entryNavAtoms), String(p.exitNavAtoms), String(p.parMinusE3Atoms), p.parMinusE3Bps]);
  });

  it("reads exactly the two pot ledgers [\"lp_backing_ledger\", market, domain] and [... domain ^ 1] in ONE call", async () => {
    const { s, c } = vault();
    await mon().run(c.conn as never, [s]);
    assert.equal(c.count("getMultipleAccountsInfoAndContext"), 1);
    assert.deepEqual(c.calls[0].args, [2]);
  });

  it("a vault with no ledgers yet reports 0 / 0 / 0, not an error", async () => {
    const s = snapshot({ marketData: new Uint8Array(plantedMarket().length).map((_, i) => (i === 10 ? 1 : 0)), registryData: registryBytes({ bound: false, domain: 2, feeShareBps: 5000 }) });
    const c = fakeConn({ accounts: new Map(), slot: 7 });
    const m = mon();
    const alerts = await m.run(c.conn as never, [s]);
    assert.deepEqual(alerts, []);
    assert.deepEqual([m.health()[0].entryNavAtoms, m.health()[0].exitNavAtoms, m.health()[0].parMinusE3Atoms, m.health()[0].parMinusE3Bps], ["0", "0", "0", 0]);
  });

  it("a gap of 0 when the pot owes nothing (principal below the physical net)", async () => {
    const { s, c } = vault({ principal: 900 }); // physical net 1032 >= 900: E3 = par
    const m = mon();
    await m.run(c.conn as never, [s]);
    assert.deepEqual([m.health()[0].parMinusE3Atoms, m.health()[0].parMinusE3Bps], ["0", 0]);
  });
});

describe("eligibility: only NON-bound vaults that HAVE a registry", () => {
  it("no registry account: skipped, no RPC, no record, no throw", async () => {
    const { s, c } = vault({ registry: null });
    const m = mon();
    assert.deepEqual(await m.run(c.conn as never, [s]), []);
    assert.equal(c.calls.length, 0);
    assert.deepEqual(m.health(), []);
  });
  it("a BOUND vault is skipped (its exit is not E3-priced)", async () => {
    const { s, c } = vault({ registry: registryBytes({ bound: true, domain: 2 }) });
    const m = mon();
    await m.run(c.conn as never, [s]);
    assert.equal(c.calls.length, 0);
    assert.deepEqual(m.health(), []);
    assert.equal(isNonBoundEarnVault(s), false);
  });
  it("an unparseable registry or a missing market is skipped", async () => {
    assert.equal(isNonBoundEarnVault(vault({ registry: new Uint8Array(20) }).s), false);
    assert.equal(isNonBoundEarnVault(vault({ market: null }).s), false);
  });
  it("a market account the SDK cannot read (not a market) logs once, records nothing, and never throws", async () => {
    const { s, c } = vault({ market: new Uint8Array(6000) }); // kind byte 0
    const logs: string[] = [];
    const m = new EarnGapMonitor(DEFAULT_EARN_GAP_CONFIG, PROGRAM, () => 0, (l) => logs.push(l));
    await m.run(c.conn as never, [s]);
    await m.run(c.conn as never, [s]);
    assert.deepEqual(m.health(), []);
    assert.equal(logs.length, 1, "logged once");
  });
  it("a vault that leaves the set (retired / became bound) leaves /health", async () => {
    const { s, c } = vault();
    const m = mon();
    await m.run(c.conn as never, [s]);
    assert.equal(m.health().length, 1);
    await m.run(c.conn as never, []);
    assert.deepEqual(m.health(), []);
  });
});

describe("alert: gap > threshold for several consecutive cycles", () => {
  it("618 bps vs the default 100: silent for 2 cycles, ALERT on the 3rd, kept while it persists", async () => {
    const { s, c } = vault();
    const m = mon();
    assert.deepEqual(await m.run(c.conn as never, [s]), []);
    assert.deepEqual(await m.run(c.conn as never, [s]), []);
    const a = await m.run(c.conn as never, [s]);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "earn-par-e3-gap");
    assert.equal(a[0].severity, "warn");
    assert.equal(a[0].subject, "EARN");
    assert.equal(a[0].data?.parMinusE3Bps, 618);
    assert.equal(a[0].data?.parMinusE3Atoms, "68");
    assert.equal((await m.run(c.conn as never, [s])).length, 1);
  });

  it("the streak resets when the gap closes, so a flap does not alert", async () => {
    const m = mon();
    const bad = vault();
    const good = vault({ principal: 900 });
    good.s.ref.marketAddress = bad.s.ref.marketAddress; // same market key, different ledger state
    await m.run(bad.c.conn as never, [bad.s]);
    await m.run(bad.c.conn as never, [bad.s]);
    // gap closes: reading a vault whose ledger yields a zero gap under the SAME market key
    const sameKey = { ...good.s, market: bad.s.market, ref: bad.s.ref };
    const goodConn = fakeConn({ accounts: new Map([[deriveLpBackingLedger(PROGRAM, bad.s.market, 2)[0].toBase58(), ownLedger(900)]]) });
    assert.deepEqual(await m.run(goodConn.conn as never, [sameKey]), []);
    assert.deepEqual(await m.run(bad.c.conn as never, [bad.s]), [], "streak restarted: only 1 consecutive bad reading");
  });

  it("exactly at the threshold is NOT over it (> 100)", async () => {
    const { s, c } = vault();
    const m = mon({ ...DEFAULT_EARN_GAP_CONFIG, alertBps: 618, alertCycles: 1 });
    assert.deepEqual(await m.run(c.conn as never, [s]), []);
    const m2 = mon({ ...DEFAULT_EARN_GAP_CONFIG, alertBps: 617, alertCycles: 1 });
    assert.equal((await m2.run(c.conn as never, [s])).length, 1);
  });

  it("cadence: isDue honours the interval", async () => {
    let now = 1_000;
    const m = new EarnGapMonitor({ ...DEFAULT_EARN_GAP_CONFIG, intervalMs: 60_000 }, PROGRAM, () => now, quiet);
    assert.equal(m.isDue(), true);
    await m.run(vault().c.conn as never, []);
    assert.equal(m.isDue(), false);
    now += 60_000;
    assert.equal(m.isDue(), true);
  });
});

describe("earnGapConfigFromEnv", () => {
  it("defaults 60 s / 100 bps / 3 cycles; overrides; garbage rejected", () => {
    assert.deepEqual(earnGapConfigFromEnv({}), { intervalMs: 60_000, alertBps: 100, alertCycles: 3 });
    assert.deepEqual(earnGapConfigFromEnv({ EARN_GAP_INTERVAL_MS: "30000", EARN_GAP_ALERT_BPS: "250", EARN_GAP_ALERT_CYCLES: "2" }), { intervalMs: 30_000, alertBps: 250, alertCycles: 2 });
    assert.throws(() => earnGapConfigFromEnv({ EARN_GAP_ALERT_CYCLES: "0" }), /EARN_GAP_ALERT_CYCLES/);
  });
});
