/**
 * Tag 104 AdlWindDown cranks (p2b-wind-down.ts): the arm / wait / expired / dust decision, the
 * runner's simulate-first discipline, refusal classification (21/27/16/22), per-cycle bounds, and
 * the 150-slot mark-age rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS, parsePortfolioV17 } from "@percolatorct/sdk";
import {
  AdlWindDownRunner,
  DEFAULT_WIND_DOWN_CONFIG,
  classifyWindDownError,
  decideWindDown,
  readWindDownView,
  reduceOnlySide,
  selectLegHolders,
  windDownConfigFromEnv,
  windDownSimEffect,
} from "./p2b-wind-down.ts";
import type { LegHolder, WindDownConfig } from "./p2b-wind-down.ts";
import { ADL_ONE, KEEPER, PROGRAM, fakeConn, fx, patchedMarket, snapshot } from "./p2b-test-helpers.ts";

const NOW = 505_231_200;
const RO_SHORT = 861_700_000_000_000n; // a_short after an ADL (0.8617 ONE)
const BIG_OI = 50_000_000_000n;
const ie = (detail: unknown) => ({ InstructionError: [1, detail] });
const ARMED_LOG = "Program log: 0x68, 0x0, 0x7b6e1f2, 0x2328, 0x1e1d1e0";
const CLOSED_LOG = "Program log: 0x68, 0x1, 0x2faf080, 0x1, 0x1e1d1e0";

const roMarket = (extra: Parameters<typeof patchedMarket>[0] = {}) =>
  patchedMarket({ aShort: RO_SHORT, oiEffLong: BIG_OI, oiEffShort: BIG_OI, ...extra });

describe("readWindDownView / decideWindDown", () => {
  const view = (m: Uint8Array, now = NOW) => readWindDownView(m, 0, BigInt(now))!;

  it("a market with A = ADL_ONE on both sides is not close-only (real SOL bytes)", () => {
    const v = view(patchedMarket());
    assert.equal(v.adl.reduceOnly, false);
    assert.deepEqual(decideWindDown(v, 1_000_000n, 140), { kind: "not-close-only" });
  });

  it("reduce-only, no episode record -> ARM (needs no fresh mark)", () => {
    const v = view(roMarket({ markSlot: BigInt(NOW - 5000) })); // even a very old mark may arm
    assert.equal(v.slotsRemaining, null);
    assert.deepEqual(decideWindDown(v, 1_000_000n, 140), { kind: "arm" });
  });

  it("armed and inside the bound -> WAIT with the slots remaining", () => {
    const v = view(roMarket({ episodeSince: BigInt(NOW - 100) }));
    assert.equal(v.slotsRemaining, BigInt(ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS - 100));
    assert.deepEqual(decideWindDown(v, 1_000_000n, 140), { kind: "wait", slotsRemaining: 8_900n });
  });

  it("armed at exactly N slots ago -> expired -> CLOSE; one slot short -> wait", () => {
    assert.deepEqual(decideWindDown(view(roMarket({ episodeSince: BigInt(NOW - 9000) })), 1_000_000n, 140), { kind: "close", reason: "expired" });
    assert.deepEqual(decideWindDown(view(roMarket({ episodeSince: BigInt(NOW - 8999) })), 1_000_000n, 140), { kind: "wait", slotsRemaining: 1n });
  });

  it("a per-asset override (tag 105 tightened N) is honoured", () => {
    const m = roMarket({ episodeSince: BigInt(NOW - 300), episodeMaxSlots: 300 });
    assert.equal(view(m).episode.effectiveMaxEpisodeSlots, 300);
    assert.deepEqual(decideWindDown(view(m), 1_000_000n, 140), { kind: "close", reason: "expired" });
  });

  it("a reset bumps the epoch: the stored episode key no longer matches -> not armed -> ARM again, never close", () => {
    const m = patchedMarket({ aShort: RO_SHORT, oiEffLong: BIG_OI, oiEffShort: BIG_OI, epochLong: 1n, epochShort: 1n, episodeSince: BigInt(NOW - 20_000) });
    // re-key the market to a later epoch WITHOUT touching the stored record
    const b = Buffer.from(m);
    const e = 592 + 758 + 1024;
    b.writeBigUInt64LE(2n, e + 497);
    const v = view(new Uint8Array(b));
    assert.equal(v.slotsRemaining, null);
    assert.deepEqual(decideWindDown(v, 1_000_000n, 140), { kind: "arm" });
  });

  it("market_id is part of the key: a restarted asset (new market_id) must re-arm", () => {
    const m = patchedMarket({ aShort: RO_SHORT, oiEffLong: BIG_OI, oiEffShort: BIG_OI, marketId: 5n, episodeSince: BigInt(NOW - 20_000) });
    const b = Buffer.from(m);
    b.writeBigUInt64LE(6n, 592 + 758 + 1024);
    assert.deepEqual(decideWindDown(view(new Uint8Array(b)), 1_000_000n, 140), { kind: "arm" });
  });

  it("dust (<= 10^decimals atoms of notional) -> CLOSE even though never armed", () => {
    // 1.0 unit of OI at price 1.0 with 6 decimals = 1_000_000 atoms == the bound -> dust (inclusive)
    const v = view(patchedMarket({ aShort: RO_SHORT, oiEffLong: 1_000_000n, oiEffShort: 1_000_000n, effectivePriceE6: 1_000_000n }));
    assert.equal(v.notionalAtoms, 1_000_000n);
    assert.deepEqual(decideWindDown(v, 1_000_000n, 140), { kind: "close", reason: "dust" });
    // one atom above the bound is not dust
    const v2 = view(patchedMarket({ aShort: RO_SHORT, oiEffLong: 1_000_001n, oiEffShort: 1_000_000n, effectivePriceE6: 1_000_000n }));
    assert.deepEqual(decideWindDown(v2, 1_000_000n, 140), { kind: "arm" });
  });

  it("the dust bound scales with the collateral decimals", () => {
    const v = view(patchedMarket({ aShort: RO_SHORT, oiEffLong: 1_000_000n, oiEffShort: 1_000_000n, effectivePriceE6: 1_000_000n }));
    assert.equal(decideWindDown(v, 10n ** 9n, 140).kind, "close"); // 9 decimals
    assert.equal(decideWindDown(v, 10n ** 5n, 140).kind, "arm"); // 5 decimals
  });

  it("expired but the mark is older than 140 slots -> stale-mark (the program would answer 27 above 150)", () => {
    const m = roMarket({ episodeSince: BigInt(NOW - 9000), markSlot: BigInt(NOW - 141) });
    assert.deepEqual(decideWindDown(view(m), 1_000_000n, 140), { kind: "stale-mark", reason: "expired", ageSlots: 141n });
    const ok = roMarket({ episodeSince: BigInt(NOW - 9000), markSlot: BigInt(NOW - 140) });
    assert.deepEqual(decideWindDown(view(ok), 1_000_000n, 140), { kind: "close", reason: "expired" });
  });

  it("dust with a stale mark is stale-mark too (a close needs a fresh mark either way)", () => {
    const m = patchedMarket({ aShort: RO_SHORT, oiEffLong: 1n, oiEffShort: 1n, markSlot: BigInt(NOW - 500) });
    assert.equal(decideWindDown(view(m), 1_000_000n, 140).kind, "stale-mark");
  });

  it("returns null for a non-market / too-short buffer", () => {
    assert.equal(readWindDownView(new Uint8Array(100), 0, 1n), null);
  });
});

describe("reduceOnlySide", () => {
  it("the side whose A is below ADL_ONE; both -> the side with fewer holders", () => {
    assert.equal(reduceOnlySide({ aLong: ADL_ONE, aShort: RO_SHORT }, 5, 1), "short");
    assert.equal(reduceOnlySide({ aLong: RO_SHORT, aShort: ADL_ONE }, 1, 5), "long");
    assert.equal(reduceOnlySide({ aLong: RO_SHORT, aShort: RO_SHORT }, 4, 2), "short");
    assert.equal(reduceOnlySide({ aLong: RO_SHORT, aShort: RO_SHORT }, 2, 4), "long");
  });
});

describe("classification", () => {
  it("21 / 27 / 16 / 22 map to the documented refusals; unknown stays 'other'; compute is its own class", () => {
    assert.equal(classifyWindDownError(ie({ Custom: 21 })), "lagging-or-pending-mark");
    assert.equal(classifyWindDownError(ie({ Custom: 27 })), "oracle-stale");
    assert.equal(classifyWindDownError(ie({ Custom: 16 })), "stale-binding");
    assert.equal(classifyWindDownError(ie({ Custom: 22 })), "not-in-adl");
    assert.equal(classifyWindDownError(ie({ Custom: 99 })), "other");
    assert.equal(classifyWindDownError("AccountNotFound"), "other");
    assert.equal(classifyWindDownError(ie("ProgramFailedToComplete"), ["exceeded CUs meter at BPF instruction"]), "compute");
  });
  it("sol_log_64 lines: (104,1,..) = closed, (104,0,..) = armed, anything else = none", () => {
    assert.equal(windDownSimEffect([CLOSED_LOG]), "closed");
    assert.equal(windDownSimEffect(["Program X invoke [1]", ARMED_LOG]), "armed");
    assert.equal(windDownSimEffect(["Program log: 0x69, 0x1, 0x0"]), "none");
    assert.equal(windDownSimEffect(null), "none");
  });
});

// ── runner ───────────────────────────────────────────────────────────────────

function holder(n: number, side: "long" | "short", isLp = false): LegHolder {
  return { pubkey: Keypair.generate().publicKey, portfolioId: BigInt(100 + n), positionEpoch: BigInt(7 + n), longLegs: side === "long" ? 1 : 0, shortLegs: side === "short" ? 1 : 0, isLp };
}

function rig(o: { cfg?: Partial<WindDownConfig>; sims?: Array<{ err: unknown; logs?: string[] }>; holders?: LegHolder[]; walletLow?: boolean } = {}) {
  const c = fakeConn({ sims: o.sims });
  const logs: string[] = [];
  let fetches = 0;
  const holders = o.holders ?? [];
  const r = new AdlWindDownRunner({ ...DEFAULT_WIND_DOWN_CONFIG, ...o.cfg }, {
    programId: PROGRAM,
    conn: c.conn as never,
    keeper: KEEPER,
    fetchHolders: async () => { fetches++; return holders; },
    mintDecimals: async () => 6,
    walletLow: () => o.walletLow ?? false,
    confirm: { statusRetries: 0, statusRetryDelayMs: 1 },
    log: (l) => logs.push(l),
  });
  return { r, c, logs, fetches: () => fetches };
}
const snap = (m: Uint8Array) => snapshot({ marketData: m, slot: NOW, label: "PERC" });

describe("runner: arming", () => {
  it("not armed: ONE simulation + ONE send on the first holder; the wire is tag 104 / 27 B with the live binding; caller is NOT a signer", async () => {
    const hs = [holder(1, "long"), holder(2, "short"), holder(3, "short")];
    const g = rig({ holders: hs, sims: [{ err: null, logs: [ARMED_LOG] }] });
    const s = snap(roMarket());
    const out = await g.r.runMarket(s);
    assert.deepEqual(out, { kind: "acted", armed: 1, closed: 0, sims: 1, sent: 1 });
    assert.equal(g.c.sent.length, 1);
    const ix = g.c.sent[0].instructions[1];
    assert.equal(ix.data.length, 27);
    assert.equal(ix.data[0], 104);
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset);
    assert.equal(dv.getBigUint64(1, true), BigInt(NOW), "now_slot");
    assert.equal(dv.getUint16(9, true), 0, "asset_index");
    assert.equal(dv.getBigUint64(11, true), hs[0].portfolioId);
    assert.equal(dv.getBigUint64(19, true), hs[0].positionEpoch);
    assert.equal(ix.keys.length, 4, "[caller, market, portfolio, collateral mint]; AUTH_MARK has no oracle accounts");
    // [0] is the keeper (also the fee payer, so the decoded message shows it as a signer); the program needs no signature on it
    assert.ok(ix.keys[0].pubkey.equals(KEEPER.publicKey));
    assert.deepEqual(ix.keys.slice(1).map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, true], [false, false]]);
    assert.ok(ix.keys[1].pubkey.equals(s.market));
    assert.ok(ix.keys[2].pubkey.equals(hs[0].pubkey));
    assert.ok(ix.keys[3].pubkey.equals(new PublicKey(Buffer.from(roMarket()).subarray(48, 80))), "[3] = the market's collateral mint");
    assert.equal(g.r.stats.armed, 1);
  });

  it("armed and inside the bound: WAIT, no holder lookup, no simulation, no send", async () => {
    const g = rig({ holders: [holder(1, "short")] });
    const out = await g.r.runMarket(snap(roMarket({ episodeSince: BigInt(NOW - 10) })));
    assert.deepEqual(out, { kind: "skipped", why: "wait" });
    assert.equal(g.fetches(), 0);
    assert.equal(g.c.calls.length, 0);
    assert.equal(g.r.stats.waiting, 1);
  });

  it("an arming simulation that shows no 'armed' log (catch-up only) is not sent", async () => {
    const g = rig({ holders: [holder(1, "short")], sims: [{ err: null, logs: [] }] });
    const out = await g.r.runMarket(snap(roMarket()));
    assert.deepEqual(out, { kind: "acted", armed: 0, closed: 0, sims: 1, sent: 0 });
    assert.equal(g.c.sent.length, 0);
  });
});

describe("runner: closing", () => {
  const EXPIRED = () => snap(roMarket({ episodeSince: BigInt(NOW - 9000) }));

  it("expired: closes ONLY the holders on the reduce-only side (a_short < ONE -> shorts), each with its LIVE binding, sim before every send", async () => {
    const shorts = [holder(1, "short"), holder(2, "short")];
    const hs = [holder(3, "long"), shorts[0], holder(4, "long"), shorts[1]];
    const g = rig({ holders: hs, sims: [{ err: null, logs: [CLOSED_LOG] }] });
    const out = await g.r.runMarket(EXPIRED());
    assert.deepEqual(out, { kind: "acted", armed: 0, closed: 2, sims: 2, sent: 2 });
    assert.deepEqual(g.c.sent.map((t) => t.instructions[1].keys[2].pubkey.toBase58()), shorts.map((h) => h.pubkey.toBase58()));
    const bindings = g.c.sent.map((t) => { const d = new DataView(t.instructions[1].data.buffer, t.instructions[1].data.byteOffset); return [d.getBigUint64(11, true), d.getBigUint64(19, true)]; });
    assert.deepEqual(bindings, shorts.map((h) => [h.portfolioId, h.positionEpoch]));
    const order = g.c.calls.map((c) => c.fn).filter((f) => f === "simulateTransaction" || f === "sendRawTransaction");
    assert.deepEqual(order, ["simulateTransaction", "sendRawTransaction", "simulateTransaction", "sendRawTransaction"]);
  });

  it("dust: closes without any episode record", async () => {
    const m = patchedMarket({ aShort: RO_SHORT, oiEffLong: 500_000n, oiEffShort: 500_000n, effectivePriceE6: 1_000_000n });
    const g = rig({ holders: [holder(1, "short")], sims: [{ err: null, logs: [CLOSED_LOG] }] });
    assert.deepEqual(await g.r.runMarket(snap(m)), { kind: "acted", armed: 0, closed: 1, sims: 1, sent: 1 });
  });

  it("a close whose simulation would only ARM (bound not met on chain yet) is not sent", async () => {
    const g = rig({ holders: [holder(1, "short")], sims: [{ err: null, logs: [ARMED_LOG] }] });
    assert.deepEqual(await g.r.runMarket(EXPIRED()), { kind: "acted", armed: 0, closed: 0, sims: 1, sent: 0 });
    assert.equal(g.c.sent.length, 0);
  });

  it("per-market cap: at most maxSendsPerMarket sends, the rest are counted as capped", async () => {
    const hs = Array.from({ length: 6 }, (_, i) => holder(i, "short"));
    const g = rig({ holders: hs, cfg: { maxSendsPerMarket: 3 }, sims: [{ err: null, logs: [CLOSED_LOG] }] });
    const out = await g.r.runMarket(EXPIRED());
    assert.equal(out.kind === "acted" && out.sent, 3);
    assert.equal(g.c.sent.length, 3);
    assert.equal(g.r.stats.skippedCap, 1);
  });

  it("per-cycle cap spans markets and resets on beginCycle()", async () => {
    const mk = () => Array.from({ length: 3 }, (_, i) => holder(i, "short"));
    const g = rig({ holders: mk(), cfg: { maxSendsPerMarket: 3, maxSendsPerCycle: 4 }, sims: [{ err: null, logs: [CLOSED_LOG] }] });
    g.r.beginCycle();
    await g.r.runMarket(EXPIRED());
    await g.r.runMarket(EXPIRED());
    assert.equal(g.c.sent.length, 4, "3 + 1: the cycle cap, not the market cap, stopped the second market");
    await g.r.runMarket(EXPIRED());
    assert.equal(g.c.sent.length, 4, "still capped in the same cycle");
    g.r.beginCycle();
    await g.r.runMarket(EXPIRED());
    assert.equal(g.c.sent.length, 7, "a new cycle resets the global budget");
  });

  it("per-market simulation cap: refused holders cost sims, never sends", async () => {
    const hs = Array.from({ length: 10 }, (_, i) => holder(i, "short"));
    const g = rig({ holders: hs, cfg: { maxSimsPerMarket: 6 }, sims: [{ err: ie({ Custom: 21 }) }] });
    const out = await g.r.runMarket(EXPIRED());
    assert.equal(out.kind === "acted" && out.sims, 6);
    assert.equal(g.c.sent.length, 0);
    assert.equal(g.r.stats.refusals["lagging-or-pending-mark"], 6);
  });

  it("refusals are classified and counted, never raised, never sent", async () => {
    const hs = Array.from({ length: 5 }, (_, i) => holder(i, "short"));
    const g = rig({
      holders: hs,
      cfg: { maxSimsPerMarket: 10 },
      sims: [{ err: ie({ Custom: 21 }) }, { err: ie({ Custom: 27 }) }, { err: ie({ Custom: 16 }) }, { err: ie({ Custom: 22 }) }, { err: ie({ Custom: 5 }) }],
    });
    const out = await g.r.runMarket(EXPIRED());
    assert.equal(out.kind, "acted");
    assert.deepEqual(g.r.stats.refusals, { "lagging-or-pending-mark": 1, "oracle-stale": 1, "stale-binding": 1, "not-in-adl": 1, other: 1, compute: 0 });
    assert.equal(g.c.sent.length, 0);
  });

  it("a thrown RPC error is contained: the market is reported unreadable, nothing crashes", async () => {
    const g = rig({ holders: [holder(1, "short")] });
    g.c.conn.simulateTransaction = async () => { throw new Error("429"); };
    const out = await g.r.runMarket(EXPIRED());
    assert.deepEqual(out, { kind: "skipped", why: "unreadable" });
    assert.equal(g.c.sent.length, 0);
  });

  it("stale mark: no holder lookup, no simulation, counted", async () => {
    const g = rig({ holders: [holder(1, "short")] });
    const out = await g.r.runMarket(snap(roMarket({ episodeSince: BigInt(NOW - 9000), markSlot: BigInt(NOW - 200) })));
    assert.deepEqual(out, { kind: "skipped", why: "stale-mark" });
    assert.equal(g.fetches(), 0);
    assert.equal(g.c.calls.length, 0);
    assert.equal(g.r.stats.skippedStaleMark, 1);
  });

  it("wallet low: skipped before any lookup or simulation", async () => {
    const g = rig({ holders: [holder(1, "short")], walletLow: true });
    assert.deepEqual(await g.r.runMarket(EXPIRED()), { kind: "skipped", why: "wallet-low" });
    assert.equal(g.fetches(), 0);
    assert.equal(g.c.calls.length, 0);
  });

  it("dry-run: simulates, never sends", async () => {
    const g = rig({ holders: [holder(1, "short")], cfg: { dryRun: true }, sims: [{ err: null, logs: [CLOSED_LOG] }] });
    await g.r.runMarket(EXPIRED());
    assert.equal(g.c.sent.length, 0);
    assert.equal(g.c.count("simulateTransaction"), 1);
  });

  it("no holders: skipped", async () => {
    const g = rig({ holders: [] });
    assert.deepEqual(await g.r.runMarket(EXPIRED()), { kind: "skipped", why: "no-holders" });
  });

  it("a market that is not close-only costs nothing (no mint read, no holder lookup, no RPC)", async () => {
    const g = rig({ holders: [holder(1, "short")] });
    assert.deepEqual(await g.r.runMarket(snap(patchedMarket())), { kind: "none" });
    assert.equal(g.c.calls.length, 0);
    assert.equal(g.fetches(), 0);
  });
});

describe("runner: cooldown after a turn that sent nothing", () => {
  it("every holder refused -> the market is left alone for cooldownMs (no holder scan, no simulation), then retried", async () => {
    let now = 1_000_000;
    const c = fakeConn({ sims: [{ err: ie({ Custom: 21 }) }] });
    let fetches = 0;
    const r = new AdlWindDownRunner({ ...DEFAULT_WIND_DOWN_CONFIG, cooldownMs: 60_000 }, {
      programId: PROGRAM, conn: c.conn as never, keeper: KEEPER,
      fetchHolders: async () => { fetches++; return [holder(1, "short")]; },
      mintDecimals: async () => 6, now: () => now, log: () => undefined,
    });
    const s = snap(roMarket({ episodeSince: BigInt(NOW - 9000) }));
    await r.runMarket(s);
    assert.equal(fetches, 1);
    now += 20_000;
    assert.deepEqual(await r.runMarket(s), { kind: "skipped", why: "cooldown" });
    assert.equal(fetches, 1, "no second getProgramAccounts inside the cooldown");
    assert.equal(c.count("simulateTransaction"), 1);
    assert.equal(r.stats.skippedCooldown, 1);
    now += 41_000;
    await r.runMarket(s);
    assert.equal(fetches, 2, "retried after the cooldown");
  });

  it("a turn that SENT does not cool down (the next tick keeps closing)", async () => {
    let now = 1_000_000;
    const c = fakeConn({ sims: [{ err: null, logs: [CLOSED_LOG] }] });
    const r = new AdlWindDownRunner({ ...DEFAULT_WIND_DOWN_CONFIG, cooldownMs: 60_000, maxSendsPerMarket: 1 }, {
      programId: PROGRAM, conn: c.conn as never, keeper: KEEPER,
      fetchHolders: async () => [holder(1, "short"), holder(2, "short")],
      mintDecimals: async () => 6, now: () => now, log: () => undefined, confirm: { statusRetries: 0, statusRetryDelayMs: 1 },
    });
    const s = snap(roMarket({ episodeSince: BigInt(NOW - 9000) }));
    await r.runMarket(s);
    now += 20_000;
    const out = await r.runMarket(s);
    assert.equal(out.kind, "acted");
    assert.equal(c.sent.length, 2);
  });

  it("no holders: also cooled down", async () => {
    let now = 5;
    const c = fakeConn();
    let fetches = 0;
    const r = new AdlWindDownRunner(DEFAULT_WIND_DOWN_CONFIG, { programId: PROGRAM, conn: c.conn as never, keeper: KEEPER, fetchHolders: async () => { fetches++; return []; }, mintDecimals: async () => 6, now: () => now, log: () => undefined });
    const s = snap(roMarket({ episodeSince: BigInt(NOW - 9000) }));
    await r.runMarket(s);
    await r.runMarket(s);
    assert.equal(fetches, 1);
  });
});

describe("selectLegHolders (real v18 portfolio bytes)", () => {
  it("finds the SOL LP's short leg on asset 0 with its live (portfolio_id, position_epoch)", () => {
    const data = new Uint8Array(fx("sol-lp-portfolio-v18"));
    const pk = Keypair.generate().publicKey;
    const hs = selectLegHolders([{ pubkey: pk, data }, { pubkey: Keypair.generate().publicKey, data: new Uint8Array(10) }], 0);
    assert.equal(hs.length, 1);
    const p = parsePortfolioV17(data);
    assert.deepEqual([hs[0].longLegs, hs[0].shortLegs, hs[0].isLp, hs[0].portfolioId, hs[0].positionEpoch], [0, 1, true, p.portfolioId, p.matcherPositionEpoch]);
    assert.equal(selectLegHolders([{ pubkey: pk, data }], 3).length, 0, "no leg on asset 3");
  });

  it("a NON-zero live binding is read through (the fixture's own epoch is 0, so patch id 777 / epoch 42)", () => {
    const b = Buffer.from(fx("sol-lp-portfolio-v18"));
    b.writeBigUInt64LE(1n | (42n << 1n), 9531); // control: enabled bit | position_epoch << 1
    b.writeBigUInt64LE(777n, 9539); // portfolio_id
    const p = parsePortfolioV17(new Uint8Array(b));
    assert.deepEqual([p.portfolioId, p.matcherPositionEpoch], [777n, 42n], "sanity: the patch lands where the SDK reads");
    const hs = selectLegHolders([{ pubkey: Keypair.generate().publicKey, data: new Uint8Array(b) }], 0);
    assert.deepEqual([hs[0].portfolioId, hs[0].positionEpoch], [777n, 42n]);
  });
});

describe("windDownConfigFromEnv", () => {
  it("defaults", () => {
    const c = windDownConfigFromEnv({}, false);
    assert.deepEqual([c.maxSendsPerMarket, c.maxSendsPerCycle, c.maxSimsPerMarket, c.maxMarkAgeSlots, c.computeUnits], [3, 8, 6, 140, 600_000]);
    assert.equal(c.cooldownMs, 60_000);
  });
  it("the mark-age knob cannot exceed the program's own 150-slot bound; garbage is rejected", () => {
    assert.throws(() => windDownConfigFromEnv({ P2B_WIND_DOWN_MAX_MARK_AGE_SLOTS: "151" }, false), /P2B_WIND_DOWN_MAX_MARK_AGE_SLOTS/);
    assert.throws(() => windDownConfigFromEnv({ P2B_WIND_DOWN_MAX_PER_CYCLE: "0" }, false), /P2B_WIND_DOWN_MAX_PER_CYCLE/);
    assert.equal(windDownConfigFromEnv({ P2B_WIND_DOWN_MAX_PER_CYCLE: "2" }, true).dryRun, true);
  });
});
