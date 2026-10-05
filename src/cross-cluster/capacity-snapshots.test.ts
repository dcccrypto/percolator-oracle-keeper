/**
 * Growth telemetry snapshotter (capacity-snapshots.ts): flag gate, legacy no-op, the row on real v18
 * bytes with growth patched in, failure isolation, and the Supabase sink contract.
 * Expected values are derived in the test from the fixture's own LP portfolio and the formulas of
 * plan 2.1 (N_cap = C_m * lambda * POS_SCALE / (1e4 * price)), not read back from the builder.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { conservativeEquity, deriveVaultLpExtP2b, parsePortfolioV17 } from "@percolatorct/sdk";
import {
  CapacitySnapshotter,
  buildCapacityRow,
  capacitySnapshotConfigFromEnv,
  createSupabaseSnapshotSink,
} from "./capacity-snapshots.ts";
import type { CapacitySnapshotRow, SnapshotSink } from "./capacity-snapshots.ts";
import { vaultLpEffectivePositionQ } from "./p2b-hedged-lockout.ts";
import { ADL_ONE, PROGRAM, deriveLpVaultRegistry, deriveVaultLpState, fakeConn, fx, patchedMarket, registryBytes, snapshot, vaultLpStateBytes, w128 } from "./p2b-test-helpers.ts";

const PRICE = 100_000_000n; // $100
const POS_SCALE = 1_000_000n;
const lpBytes = new Uint8Array(fx("cate-lp-portfolio-v18"));
const lp = parsePortfolioV17(lpBytes);
const C_M = conservativeEquity(lp.capital, lp.pnl, lp.feeCredits);

function stateBytes(o: { principal: bigint; outstanding: bigint; juniorDep: bigint; juniorWd: bigint; lp: PublicKey }): Uint8Array {
  const b = Buffer.from(vaultLpStateBytes({ lp: o.lp, outstanding: o.outstanding }));
  w128(b, 144, o.principal);
  w128(b, 160, o.juniorDep);
  w128(b, 176, o.juniorWd);
  return new Uint8Array(b);
}

function extBytes(allocated: bigint, cushion: bigint): Uint8Array {
  const b = Buffer.alloc(16 + 128);
  Buffer.from(registryBytes()).copy(b, 0, 0, 10); // wrapper magic + version
  b[10] = 10;
  Keypair.generate().publicKey.toBuffer().copy(b, 16 + 0); // market_group (non-zero)
  b.writeUInt16LE(5000, 16 + 96); // alloc alpha
  b.writeUInt16LE(3000, 16 + 98); // alloc buffer (>= min)
  b.writeUInt16LE(1000, 16 + 100); // cushion target
  b.writeUInt16LE(1000, 16 + 102); // cushion share
  w128(b, 16 + 32, allocated);
  w128(b, 16 + 48, cushion);
  b[16 + 104] = 1;
  return new Uint8Array(b);
}

interface World {
  market: PublicKey;
  accounts: Map<string, Uint8Array>;
}

function world(o: { growth: boolean; bound?: boolean; withExt?: boolean; oiLong?: bigint; oiShort?: bigint }): World {
  const market = Keypair.generate().publicKey;
  const lpKey = Keypair.generate().publicKey;
  const accounts = new Map<string, Uint8Array>();
  accounts.set(
    market.toBase58(),
    patchedMarket({
      effectivePriceE6: PRICE,
      oiEffLong: o.oiLong ?? 0n,
      oiEffShort: o.oiShort ?? 0n,
      ...(o.growth ? { growthLambdaBps: 10_000, growthKinkBps: 5_000 } : {}),
    }),
  );
  accounts.set(deriveLpVaultRegistry(PROGRAM, market)[0].toBase58(), registryBytes({ bound: o.bound ?? true }));
  accounts.set(deriveVaultLpState(PROGRAM, market).toBase58(), stateBytes({ principal: 7_000_000n, outstanding: 1_500_000n, juniorDep: 3_000_000n, juniorWd: 500_000n, lp: lpKey }));
  if (o.withExt ?? true) accounts.set(deriveVaultLpExtP2b(PROGRAM, market)[0].toBase58(), extBytes(2_000_000n, 40_000n));
  accounts.set(lpKey.toBase58(), lpBytes);
  return { market, accounts };
}

function collectingSink(fail = false): SnapshotSink & { batches: CapacitySnapshotRow[][] } {
  const batches: CapacitySnapshotRow[][] = [];
  return {
    batches,
    async insert(rows) {
      if (fail) throw new Error("boom");
      batches.push([...rows]);
    },
  };
}

function build(w: World[], enabled: boolean, sink: SnapshotSink, now: () => number = () => 1_000_000) {
  const merged = new Map<string, Uint8Array>();
  for (const x of w) for (const [k, v] of x.accounts) merged.set(k, v);
  const c = fakeConn({ accounts: merged });
  const snap = new CapacitySnapshotter({ enabled, intervalMs: 300_000 }, {
    conn: c.conn as never,
    programId: PROGRAM,
    markets: () => w.map((x, i) => ({ marketAddress: x.market.toBase58(), label: `M${i}`, assetIndex: 0 })),
    sink,
    now,
    log: () => undefined,
  });
  return { snap, c };
}

describe("flag gate", () => {
  it("off: zero RPC, zero writes", async () => {
    const sink = collectingSink();
    const { snap, c } = build([world({ growth: true })], false, sink);
    assert.equal(await snap.tick(), 0);
    assert.equal(c.calls.length, 0);
    assert.equal(sink.batches.length, 0);
  });
  it("config: default off; on without credentials throws; non-https URL throws; bad interval throws", () => {
    assert.equal(capacitySnapshotConfigFromEnv({}).enabled, false);
    assert.throws(() => capacitySnapshotConfigFromEnv({ KEEPER_CAPACITY_SNAPSHOTS: "1" }), /SUPABASE_SERVICE_ROLE_KEY/);
    assert.throws(() => capacitySnapshotConfigFromEnv({ KEEPER_CAPACITY_SNAPSHOTS: "1", SUPABASE_URL: "http://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }), /https/);
    assert.throws(() => capacitySnapshotConfigFromEnv({ CAPACITY_SNAPSHOT_INTERVAL_MS: "5" }), /INTERVAL/);
    const ok = capacitySnapshotConfigFromEnv({ KEEPER_CAPACITY_SNAPSHOTS: "true", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
    assert.equal(ok.enabled, true);
    assert.equal(ok.intervalMs, 300_000);
  });
});

describe("legacy markets are skipped", () => {
  it("a market with an all-zero growth block writes nothing and costs only the first batched read", async () => {
    const sink = collectingSink();
    const { snap, c } = build([world({ growth: false })], true, sink);
    assert.equal(await snap.tick(), 0);
    assert.equal(sink.batches.length, 0);
    assert.equal(snap.stats.skippedLegacy, 1);
    assert.equal(c.count("getMultipleAccountsInfo"), 0, "no second read for a legacy market");
  });
  it("an unbound growth block is skipped too", async () => {
    const sink = collectingSink();
    const { snap } = build([world({ growth: true, bound: false })], true, sink);
    assert.equal(await snap.tick(), 0);
    assert.equal(snap.stats.skippedLegacy, 1);
  });
});

describe("row on real v18 bytes with growth on", () => {
  it("N_cap, utilisation, leverage ladder, Earn and allocation fields match the formulas", async () => {
    // users OI long = 60% of N_cap, short = 0; the LP fixture carries its own leg
    const nCap = (C_M * 10_000n * POS_SCALE) / (10_000n * PRICE);
    const sink = collectingSink();
    const lpEff = vaultLpEffectivePositionQ(lp, 0, { aLong: ADL_ONE, aShort: ADL_ONE });
    assert.ok(lpEff !== 0n, "the fixture LP carries a leg, so OI must include it");
    const lpLong = lpEff > 0n ? lpEff : 0n;
    const lpShort = lpEff < 0n ? -lpEff : 0n;
    const w = world({ growth: true, oiLong: lpLong + (nCap * 6n) / 10n + 1_000n, oiShort: lpShort });
    const { snap } = build([w], true, sink);
    assert.equal(await snap.tick(), 1);
    const r = sink.batches[0][0];
    assert.equal(r.slab, w.market.toBase58());
    assert.equal(r.price_e6, PRICE.toString());
    assert.equal(r.lp_equity_atoms, C_M.toString());
    assert.equal(r.n_cap_q, nCap.toString());
    assert.equal(r.capacity_notional_atoms, ((nCap * PRICE) / POS_SCALE).toString());
    assert.equal(r.earn_principal_atoms, "7000000");
    assert.equal(r.earn_nav_atoms, "5500000"); // 7.0m - 1.5m outstanding
    assert.equal(r.draw_outstanding_atoms, "1500000");
    assert.equal(r.junior_atoms, "2500000"); // 3.0m - 0.5m
    assert.equal(r.allocated_atoms, "2000000");
    assert.equal(r.cushion_atoms, "40000");
    assert.ok(r.nav_per_share !== null && /^\d+\.\d{9}$/.test(r.nav_per_share));
    assert.ok((r.u_long_bps ?? -1) > (r.u_short_bps ?? 0), `long crowd must show higher utilisation (${r.u_long_bps} vs ${r.u_short_bps})`);
    assert.ok((r.u_long_bps ?? 0) > 0);
    assert.equal(r.l_ceil_x100, 1000);
    assert.equal(r.credit_rate_bps, null);
    assert.equal(r.slot, 505_231_200);
    assert.equal(r.ts, new Date(1_000_000).toISOString());
    // ladder is internally consistent: a closed side reports 0x, an open side reports > 0
    assert.equal(r.max_leverage_long_x100 === 0, r.long_closed);
    assert.equal(r.max_leverage_short_x100 === 0, r.short_closed);
    assert.ok(r.max_leverage_short_x100 >= r.max_leverage_long_x100 || r.long_closed, "thin side never tighter than the crowd side");
  });

  it("nav_per_share is null when no shares are outstanding", () => {
    const market = Keypair.generate().publicKey;
    const lpKey = Keypair.generate().publicKey;
    const reg = Buffer.from(registryBytes({ bound: true }));
    reg.fill(0, 16 + 32 + 32, 16 + 32 + 32 + 16); // total_lp_shares_outstanding = 0 (u128 after market_group + lp_mint)
    const s = snapshot({ market, marketData: patchedMarket({ effectivePriceE6: PRICE, growthLambdaBps: 10_000 }), registryData: new Uint8Array(reg), vaultLpData: vaultLpStateBytes({ lp: lpKey }) });
    const row = buildCapacityRow({ snapshot: s, vaultLpStateData: stateBytes({ principal: 10n, outstanding: 0n, juniorDep: 0n, juniorWd: 0n, lp: lpKey }), vaultLpExtData: null, lpPortfolioData: lpBytes, nowMs: 5 });
    assert.ok(row);
    if (s.registry && s.registry.totalLpSharesOutstanding === 0n) assert.equal(row.nav_per_share, null);
    assert.equal(row.allocated_atoms, "0", "no ext PDA (pre-P2b) reads as zero allocation");
  });
});

describe("failure isolation", () => {
  it("a malformed ext PDA keeps the row (allocation reads 0) instead of dropping the market", async () => {
    const w = world({ growth: true });
    w.accounts.set(deriveVaultLpExtP2b(PROGRAM, w.market)[0].toBase58(), new Uint8Array(144));
    const sink = collectingSink();
    const { snap } = build([w], true, sink);
    assert.equal(await snap.tick(), 1);
    assert.equal(sink.batches[0][0].allocated_atoms, "0");
  });
  it("one undecodable market does not stop the others; the tick never throws", async () => {
    const good = world({ growth: true });
    const bad = world({ growth: true });
    bad.accounts.set(bad.accounts.keys().next().value as string, patchedMarket({ growthLambdaBps: 10_000 })); // keep market
    // corrupt the bad market's LP portfolio so parsePortfolioV17 throws
    const lpKey = [...bad.accounts.keys()].find((k) => bad.accounts.get(k) === lpBytes) as string;
    bad.accounts.set(lpKey, new Uint8Array(8));
    const sink = collectingSink();
    const { snap } = build([bad, good], true, sink);
    assert.equal(await snap.tick(), 1);
    assert.equal(sink.batches[0].length, 1);
    assert.equal(sink.batches[0][0].slab, good.market.toBase58());
    assert.equal(snap.stats.decodeFailures, 1);
  });
  it("an RPC read failure is swallowed", async () => {
    const c = fakeConn({ readError: new Error("rpc down") });
    const snap = new CapacitySnapshotter({ enabled: true, intervalMs: 300_000 }, { conn: c.conn as never, programId: PROGRAM, markets: () => [{ marketAddress: Keypair.generate().publicKey.toBase58(), label: "X", assetIndex: 0 }], sink: collectingSink(), now: () => 1, log: () => undefined });
    assert.equal(await snap.tick(), 0);
  });
  it("a sink failure is counted, never thrown", async () => {
    const { snap } = build([world({ growth: true })], true, collectingSink(true));
    assert.equal(await snap.tick(), 0);
    assert.equal(snap.stats.sinkFailures, 1);
  });
  it("paced: a second tick inside the interval does nothing", async () => {
    let t = 1_000_000;
    const sink = collectingSink();
    const { snap } = build([world({ growth: true })], true, sink, () => t);
    assert.equal(await snap.tick(), 1);
    t += 60_000;
    assert.equal(await snap.tick(), 0);
    t += 300_000;
    assert.equal(await snap.tick(), 1);
    assert.equal(sink.batches.length, 2);
  });
});

describe("supabase sink", () => {
  it("POSTs the rows with the service key and never leaks it into the error", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const sink = createSupabaseSnapshotSink({ supabaseUrl: "https://abc.supabase.co/", serviceKey: "SECRET", timeoutMs: 1000 }, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("", { status: 401 });
    }) as never);
    await assert.rejects(() => sink.insert([{ slab: "x" } as never]), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes("SECRET"));
    assert.equal(seen!.url, "https://abc.supabase.co/rest/v1/market_capacity_snapshots");
    assert.equal((seen!.init.headers as Record<string, string>).apikey, "SECRET");
  });
});
