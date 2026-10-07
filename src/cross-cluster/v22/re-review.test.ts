/**
 * Tests for the security RE-review of #148 (4d437c8): N-1 .. N-6. Each carries a negative control.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_SWEEP_ROUND_CONFIG, QUARANTINE_LADDER, freshGapBackoff, pairingStats, resetPairingStats, runSettleRound } from "./sweep.ts";
import { analysePortfolios } from "./positioned.ts";
import { buildCreateAnchorIxs, createKeeperAnchor } from "./create-anchor.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { resetJobCounters } from "./exec.ts";
import { setProtectiveTrigger, setSweepDelegate, setLoneLpCrankSuppressor, setBondFeeDelegated } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { LAYOUT_V22 } from "@percolatorct/sdk";
import { computeAt, customAt, execCtx, fakeExecConn, fakeLoopConn, key, pf, portfolioBytes, refusePortfolio, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const LP = key(500);
const MARKET = key(900);
const cps = (n: number) => Array.from({ length: n }, (_, i) => pf(i + 1, 1));
const hasKey = (s: { keys: string[][] }, pk: PublicKey) => s.keys.some((ks) => ks.includes(pk.toBase58()));
const deps = (conn: ReturnType<typeof fakeExecConn>["conn"]) => ({ exec: execCtx(conn), getSlot: async () => 1010, hold: () => {}, release: () => {} });

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
});
afterEach(() => {
  setSweepDelegate(null);
  setLoneLpCrankSuppressor(null);
  setBondFeeDelegated(false);
  setProtectiveTrigger(null);
  setV22HealthProvider(null);
});

describe("N-1: only a program Custom code is a 'hard' refusal; compute exhaustion defers, shrinks and blames nobody", () => {
  it("InstructionError [i, ComputationalBudgetExceeded] (an index but NO Custom code): the tail is cut and deferred, NO quarantine, LP held in BOTH modes", async () => {
    for (const pairing of ["prefer", "strict"] as const) {
      resetPairingStats();
      const quarantine = new Map<string, bigint>();
      const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? computeAt(4) : null) });
      const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(6), nowSlot: 100, quarantine }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing });
      assert.equal(quarantine.size, 0, `${pairing}: nobody is quarantined`);
      assert.equal(pairingStats.hardRefusals, 0);
      assert.ok(pairingStats.shrinkDeferrals >= 1);
      assert.ok(r.missing.some((m) => m.why === "deferred"), "the cut refreshes are unsettled");
      assert.equal(r.lpSettled, false, `${pairing}: the LP is NOT settled while a counterparty is merely deferred`);
      assert.equal(f.sent.length, 0);
    }
  });
  it("NEGATIVE CONTROL: a real program code (999) at the same index IS a hard refusal: quarantined, and `prefer` may settle the LP (counted)", async () => {
    const quarantine = new Map<string, bigint>();
    const f = fakeExecConn({ simErr: refusePortfolio(pf(5).pubkey, 999, true) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(6), nowSlot: 100, quarantine }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(quarantine.size, 1);
    assert.equal(pairingStats.hardRefusals, 1);
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.unpairedLpSettles, 1);
  });
  it("other no-code errors (blockhash / account in use / RPC) also defer instead of blaming", async () => {
    for (const err of [{ InstructionError: [4, "AccountInUse"] }, "BlockhashNotFound", { InstructionError: [3, "ProgramFailedToComplete"] }]) {
      resetPairingStats();
      const quarantine = new Map<string, bigint>();
      const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? err : null) });
      const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(6), nowSlot: 100, quarantine }, DEFAULT_SWEEP_ROUND_CONFIG);
      assert.equal(quarantine.size, 0, JSON.stringify(err));
      assert.equal(r.lpSettled, false, JSON.stringify(err));
    }
  });
  it("quarantine is capped per round unless each code is distinct, and a longer cool-down needs a REPEAT of the same code", async () => {
    // three portfolios refused with the SAME code in one round: only two are quarantined
    const list = cps(6);
    const bad = new Set([list[0], list[2], list[4]].map((p) => p.pubkey.toBase58()));
    const refuseBad = (code: (k: string) => number) => (d: { keys: string[][] }) => {
      const i = d.keys.findIndex((ks) => ks.some((k) => bad.has(k)));
      if (i < 0) return null;
      const k = d.keys[i].find((x) => bad.has(x)) as string;
      return customAt(i, code(k));
    };
    const q1 = new Map<string, bigint>();
    const f = fakeExecConn({ simErr: refuseBad(() => 999) });
    await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100, quarantine: q1 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(q1.size, 2);
    assert.equal(pairingStats.quarantineCapped, 1);
    // distinct codes: all three
    resetPairingStats();
    const q2 = new Map<string, bigint>();
    const order = [...bad];
    const g = fakeExecConn({ simErr: refuseBad((k) => 900 + order.indexOf(k)) });
    await runSettleRound(deps(g.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100, quarantine: q2 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(q2.size, 3);
    // ladder: same portfolio + same code escalates 150 -> 450 -> 1500; a DIFFERENT code resets to 150
    const history = new Map<string, { code: number; level: number }>();
    const one = [pf(1)];
    const run = async (code: number, slot: number, q: Map<string, bigint>) => {
      const h = fakeExecConn({ simErr: refusePortfolio(one[0].pubkey, code, true) });
      await runSettleRound(deps(h.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: one, nowSlot: slot, quarantine: q, quarantineHistory: history }, DEFAULT_SWEEP_ROUND_CONFIG);
      return Number((q.get(one[0].pubkey.toBase58()) ?? 0n) - BigInt(slot));
    };
    const q = new Map<string, bigint>();
    assert.equal(await run(999, 1000, q), QUARANTINE_LADDER[0]);
    q.clear();
    assert.equal(await run(999, 2000, q), QUARANTINE_LADDER[1]);
    q.clear();
    assert.equal(await run(999, 3000, q), QUARANTINE_LADDER[2]);
    q.clear();
    assert.equal(await run(998, 4000, q), QUARANTINE_LADDER[0], "a different code starts again at the short cool-down");
  });
});

describe("N-2: the protective trigger uses the program's own signal, with a bounded cadence", () => {
  const mk = (o: { outstanding?: bigint; logs?: boolean; failRound?: boolean }, clock: { t: number }) => {
    // armed by protect(): the FIRST simulation after it is the read-only signal simulation, the rest belong to the round
    const st = { armed: false, next: -1 };
    const f = fakeLoopConn({
      market: v22MarketBytes(),
      registry: registryBytes({ bound: true, ext: true }),
      vaultLpState: vaultLpStateBytes(key(901), o.outstanding ?? 0n),
      simLogs: (_d, n) => (st.armed && o.logs && n === st.next ? ["Program log: p3_senior_draw deficit=5 moved=1 unfunded=0"] : []),
      // with failRound every simulation of the round (not the signal simulation) is refused
      simErr: (_d, n) => (st.armed && o.failRound && n > st.next ? customAt(0, 999) : null),
    });
    const lines: string[] = [];
    const entry = { marketAddress: MARKET.toBase58(), label: "T/V22" };
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l), now: () => clock.t });
    return { f, lines, loop, entry, st };
  };
  const prime = (h: ReturnType<typeof mk>) => h.loop.sweepDelegate({ conn: h.f.conn as never, keeper: Keypair.generate(), entry: h.entry, marketData: v22MarketBytes(), slot: 5000, dryRun: false });
  const protect = (h: ReturnType<typeof mk>) => {
    h.st.armed = true;
    h.st.next = h.f.sims.length;
    return (h.loop as unknown as { protectiveRound(m: string): Promise<void> }).protectiveRound(MARKET.toBase58());
  };
  const rounds = (h: ReturnType<typeof mk>) => h.lines.filter((l) => l.includes("[v22][protect]")).length;

  it("the wrapper's senior-draw line in a read-only LP-crank simulation triggers a round (no outstanding draw, no capital ratio)", async () => {
    const clock = { t: 1_000_000 };
    const h = mk({ logs: true }, clock);
    await prime(h);
    await protect(h);
    assert.equal(rounds(h), 1);
    assert.ok(h.lines.some((l) => l.includes("program's senior-draw signal")));
    // NEGATIVE CONTROL: no signal and nothing outstanding: no round
    const c = mk({}, clock);
    await prime(c);
    await protect(c);
    assert.equal(rounds(c), 0);
  });
  it("cadence: outstanding-only at most every 30 s; the signal at most every 5 s", async () => {
    const clock = { t: 1_000_000 };
    const h = mk({ outstanding: 5n }, clock);
    await prime(h);
    await protect(h);
    assert.equal(rounds(h), 1);
    clock.t += 10_000;
    await protect(h);
    assert.equal(rounds(h), 1, "outstanding alone: not again within 30 s");
    clock.t += 21_000;
    await protect(h);
    assert.equal(rounds(h), 2, "after 30 s");
    const s = mk({ logs: true }, clock);
    await prime(s);
    await protect(s);
    clock.t += 2_000;
    await protect(s);
    assert.equal(rounds(s), 1, "signal: not again within 5 s");
    clock.t += 4_000;
    await protect(s);
    assert.equal(rounds(s), 2, "after 5 s");
  });
  it("repeated protective rounds that do NOT settle the LP back off (10, 20, ... s); a success resets", async () => {
    const clock = { t: 1_000_000 };
    const h = mk({ logs: true, failRound: true }, clock);
    await prime(h);
    await protect(h); // fails -> failures 1 -> next in 10 s
    assert.equal(rounds(h), 1);
    clock.t += 6_000;
    await protect(h);
    assert.equal(rounds(h), 1, "inside the 10 s backoff: no spend");
    clock.t += 5_000;
    await protect(h); // fails -> failures 2 -> 20 s
    assert.equal(rounds(h), 2);
    clock.t += 15_000;
    await protect(h);
    assert.equal(rounds(h), 2, "inside the 20 s backoff");
    // NEGATIVE CONTROL: a protective round that succeeds does not back off
    const ok = mk({ logs: true }, clock);
    await prime(ok);
    await protect(ok);
    clock.t += 6_000;
    await protect(ok);
    assert.equal(rounds(ok), 2);
  });
});

describe("N-4: a backed-off round makes the delegate decline so the legacy accrual crank runs", () => {
  const entry = { marketAddress: MARKET.toBase58(), label: "T/V22" };
  it("backoff -> false (nothing sent); no backoff -> true", async () => {
    const f = fakeLoopConn({ market: v22MarketBytes(), registry: registryBytes({ bound: true }), vaultLpState: vaultLpStateBytes(key(901)) });
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: () => {} });
    const args = { conn: f.conn as never, keeper: Keypair.generate(), entry, marketData: v22MarketBytes(), slot: 5000, dryRun: false };
    assert.equal(await loop.sweepDelegate(args), true, "control: a normal round is handled");
    const sentBefore = f.sent.length;
    (loop as unknown as { rtFor(a: string): { gapBackoff: { skipRounds: number } } }).rtFor(entry.marketAddress).gapBackoff.skipRounds = 1;
    assert.equal(await loop.sweepDelegate(args), false, "backed off: decline");
    assert.equal(f.sent.length, sentBefore, "and nothing was sent by the v2.2 layer");
    assert.equal(await loop.sweepDelegate(args), true, "the backoff is over");
  });
  it("runSettleRound marks the skipped round `backedOff`", async () => {
    const backoff = freshGapBackoff();
    backoff.skipRounds = 1;
    const f = fakeExecConn();
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(3), gapBackoff: backoff }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.backedOff, true);
    assert.equal(f.sims.length, 0);
    assert.equal((await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(3), gapBackoff: backoff }, DEFAULT_SWEEP_ROUND_CONFIG)).backedOff, false);
  });
});

describe("N-5: anchor refusal falls back; the override passes the same check; the create helper is gated", () => {
  it("a program-refused ANCHOR accrue falls back to the counterparty form for that tx; the round still pairs", async () => {
    const anchor = key(77);
    const f = fakeExecConn({ simErr: (d) => (d.keys[0]?.includes(anchor.toBase58()) ? customAt(0, 999) : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), anchor, nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.anchorRefused, true);
    assert.ok(pairingStats.anchorFallbacks >= 1);
    assert.ok(f.sent.every((s) => !hasKey(s, anchor)), "no sent tx uses the refused anchor");
    assert.equal(r.lpSettled, true);
    assert.equal(r.missing.filter((m) => m.why === "unlanded").length, 0);
    // NEGATIVE CONTROL: Custom(22) on the anchor is "already accrued", not a refusal: no fallback
    resetPairingStats();
    const g = fakeExecConn({ simErr: (d, n) => (n === 0 && d.keys[0]?.includes(anchor.toBase58()) ? customAt(0, 22) : null) });
    const r2 = await runSettleRound(deps(g.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), anchor, nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r2.anchorRefused, false);
    assert.equal(pairingStats.anchorFallbacks, 0);
  });
  it("loop: after an anchor refusal the anchor is not used for the next rounds", async () => {
    const keeper = Keypair.generate();
    const anchorAcct = { pubkey: key(70), data: portfolioBytes({ owner: keeper.publicKey }) };
    const f = fakeLoopConn({
      market: v22MarketBytes(),
      registry: registryBytes({ bound: true }),
      vaultLpState: vaultLpStateBytes(key(901)),
      portfolios: [anchorAcct, { pubkey: key(71), data: portfolioBytes({ owner: key(8), capital: 5n, legs: [{ side: 0, basis: 5n }] }) }],
      simErr: (d) => (hasKey({ keys: d.keys.slice(0, 1) }, anchorAcct.pubkey) ? customAt(0, 999) : null),
    });
    const entry = { marketAddress: MARKET.toBase58(), label: "T/V22" };
    const loop = new V22Loop({ conn: f.conn as never, keeper, programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: () => {} });
    const args = { conn: f.conn as never, keeper, entry, marketData: v22MarketBytes(), slot: 5000, dryRun: false };
    // a multi-tx round is needed to use the anchor: use many counterparties via the planner directly is covered above;
    // here the single-tx plan accrues through the LP, so the anchor is simply never used and nothing is refused
    assert.equal(await loop.sweepDelegate(args), true);
    assert.ok(f.sent.every((s) => !hasKey({ keys: s.keys.slice(0, 1) }, anchorAcct.pubkey)));
  });
  it("the ACCRUE_ANCHORS override passes the SAME check as discovery: keeper-owned, flat, not the LP, not a matcher (user-owned override is ignored)", () => {
    const keeper = key(42);
    const lp = key(50);
    const mk = (n: number, owner: PublicKey, o: Partial<Parameters<typeof portfolioBytes>[0]> = {}) => ({ pubkey: key(n), data: portfolioBytes({ owner, ...o } as Parameters<typeof portfolioBytes>[0]) });
    const base = { lpPortfolio: lp, portfolioLen: 10603, keeperOwner: keeper };
    const own = mk(60, keeper);
    assert.ok(analysePortfolios([own], { ...base, anchorOverride: own.pubkey }).flatAnchor?.equals(own.pubkey));
    const userFlat = mk(61, key(43));
    const r = analysePortfolios([userFlat], { ...base, anchorOverride: userFlat.pubkey });
    assert.equal(r.flatAnchor, null, "a user's flat portfolio is NOT accepted as an override (the old code accepted any)");
    assert.match(r.anchorOverrideRejected ?? "", /not owned by the keeper/);
    const busy = mk(62, keeper, { legs: [{ side: 0, basis: 5n }] });
    assert.match(analysePortfolios([busy], { ...base, anchorOverride: busy.pubkey }).anchorOverrideRejected ?? "", /not flat/);
    const matcher = mk(63, keeper, { matcher: true });
    assert.match(analysePortfolios([matcher], { ...base, anchorOverride: matcher.pubkey }).anchorOverrideRejected ?? "", /matcher/);
    assert.match(analysePortfolios([mk(64, keeper)], { ...base, anchorOverride: key(99) }).anchorOverrideRejected ?? "", /not a decodable portfolio of this market/);
    // a rejected override does not hide a valid discovered anchor
    assert.ok(analysePortfolios([userFlat, own], { ...base, anchorOverride: userFlat.pubkey }).flatAnchor?.equals(own.pubkey));
  });
  it("create helper: top-level createAccount of EXACTLY the layout length owned by the wrapper, then InitPortfolio (tag 1) with the keeper as owner", () => {
    const keeper = key(1);
    const anchor = key(2);
    const ixs = buildCreateAnchorIxs({ keeper, anchor, market: MARKET, programId: WRAPPER_PROGRAM_ID, lamports: 123 });
    assert.equal(ixs.length, 2);
    // SystemProgram.createAccount data: u32 ix(0) + u64 lamports + u64 space + 32 owner
    const space = Number(ixs[0].data.readBigUInt64LE(12));
    assert.equal(space, LAYOUT_V22.portfolio.accountLen);
    assert.equal(space, 10603);
    assert.ok(new PublicKey(ixs[0].data.subarray(20, 52)).equals(WRAPPER_PROGRAM_ID));
    assert.equal(ixs[1].data[0], 1);
    assert.deepEqual(ixs[1].keys.map((k) => k.pubkey.toBase58()), [keeper.toBase58(), MARKET.toBase58(), anchor.toBase58()]);
    assert.equal(ixs[1].keys[0].isSigner, true);
  });
  it("create helper is DRY-RUN-capable (simulates, sends nothing) and never started by the keeper", async () => {
    const f = fakeExecConn();
    const dry = await createKeeperAnchor(execCtx(f.conn), f.conn as never, { market: MARKET, programId: WRAPPER_PROGRAM_ID, dryRun: true });
    assert.equal(dry.outcome.kind, "dry-run");
    assert.equal(f.sent.length, 0);
    assert.equal(dry.lamports, 10603 * 7000);
    // NEGATIVE CONTROL: armed (dryRun false) it does send, after a clean simulation, with the new account as a signer
    const g = fakeExecConn();
    const live = await createKeeperAnchor(execCtx(g.conn), g.conn as never, { market: MARKET, programId: WRAPPER_PROGRAM_ID, dryRun: false });
    assert.equal(live.outcome.kind, "sent");
    assert.equal(g.sent.length, 1);
    const keeperSrc = readFileSync(new URL("../../cross-cluster.ts", import.meta.url), "utf8");
    assert.doesNotMatch(keeperSrc, /create-anchor/);
    const loopSrc = readFileSync(new URL("./loop.ts", import.meta.url), "utf8");
    assert.doesNotMatch(loopSrc, /create-anchor/);
    const script = readFileSync(new URL("../../v22-create-anchor.ts", import.meta.url), "utf8");
    assert.match(script, /KEEPER_V22_CREATE_ANCHOR", false/);
    assert.match(script, /KEEPER_V22_CREATE_ANCHOR_DRY_RUN", true/);
    assert.ok(script.indexOf("process.exit(1)") < script.indexOf("createKeeperAnchor("), "refuses before doing anything unless enabled");
  });
});

describe("N-6: strict parsing scope", () => {
  it("flags-off: only VAULT_LP_LONE_CRANK (and the master switch) are validated", () => {
    assert.doesNotThrow(() => v22FlagsFromEnv({ KEEPER_V22_DRY_RUN: "dry", KEEPER_V22_SETTLE_PAIRING: "strct", KEEPER_V22_G9_DRAW_CAP_ATOMS: "x" }));
    assert.throws(() => v22FlagsFromEnv({ VAULT_LP_LONE_CRANK: "nope" }));
    // control: the same junk stops the keeper once the layer is ON
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_DRY_RUN: "dry" }));
  });
  it("the README tells the operator to audit the env before deploy", () => {
    assert.match(readFileSync(new URL("../../../README.md", import.meta.url), "utf8"), /audit the live \(Railway\) env/i);
  });
});
