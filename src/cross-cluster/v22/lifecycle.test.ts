/**
 * Market lifecycle (lifecycle*.ts): classifier bands, every stale-resolve guard WITH a negative control (the test removes
 * that single guard from the list and shows the unsafe input then gets through), the tag-39 encoder against the deployed
 * handler, the engine end to end on a fake Connection, discovery, and warn-band fee forcing.
 *
 * Nothing here touches a network: every connection is a recording fake.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { assetSlotsOff, engineSlotBase, layoutById } from "../market-layout.ts";
import { decodeTerminalState, isTerminalMarket, staleResolveWindow } from "../market-state.ts";
import { getPushDeadline, isKnownTerminal, resetPushDeadlines } from "../push-deadline.ts";
import { V22FlagError, v22FlagsFromEnv, LIFECYCLE_DEFAULTS } from "./flags.ts";
import type { LifecycleConfig } from "./flags.ts";
import { buildV22MarketCtx } from "./market.ts";
import type { V22MarketCtx } from "./market.ts";
import { classifyMarket, observeQuiet, openInterestIsZero, priceBandOf, quietMsOf, tradeFeeAccrualSum } from "./lifecycle-classify.ts";
import type { ClassifyInput, MarketLifecycle } from "./lifecycle-classify.ts";
import { ObservationLedger } from "./lifecycle-ledger.ts";
import { PRE_SEND_CHECKS, RESOLVE_GUARDS, buildStaleResolveIx, decideResolve, preSendVerdict, resolveStaleOnce } from "./lifecycle-resolve.ts";
import type { PreSendInput, ResolveInput } from "./lifecycle-resolve.ts";
import { MARKET_HEADER_V22, LifecycleEngine } from "./lifecycle.ts";
import type { Alert } from "../alerting.ts";
import { fakeExecConn, key, v22MarketBytes } from "./test-helpers.ts";

const L = layoutById("v2.2-b");
const GROUP = L.groupOff;
const MODE_OFF = 592 + 674; // market-state.ts GROUP_V19.mode
const STALE = 18_000n;
const SLOT_NOW = 1_000_000n;
const keeper = Keypair.generate();
const OTHER = Keypair.generate().publicKey;

/** A v2.2 market with the lifecycle-relevant words set. */
function market(o: { staleSlots?: bigint; lastGood?: bigint; authority?: PublicKey; resolved?: boolean; oi?: bigint; feeSum?: bigint; lifecycle?: number } = {}): Uint8Array {
  const b = Buffer.from(v22MarketBytes({ lifecycle: o.lifecycle }));
  b.writeBigUInt64LE(o.staleSlots ?? STALE, 16 + 136);
  b.writeBigUInt64LE(o.lastGood ?? SLOT_NOW, 16 + 152);
  if (o.authority) Buffer.from(o.authority.toBytes()).copy(b, assetSlotsOff(L) + 120);
  if (o.resolved) b[MODE_OFF] = 1;
  if (o.oi) b.writeBigUInt64LE(o.oi, engineSlotBase(L, 0) + 289);
  if (o.feeSum) b.writeBigUInt64LE(o.feeSum, 16 + 464);
  return new Uint8Array(b);
}
const ageToLastGood = (age: bigint): bigint => SLOT_NOW - age;

const cfg = (o: Partial<LifecycleConfig> = {}): LifecycleConfig => ({ ...LIFECYCLE_DEFAULTS, minObservationMs: 1_800_000, ...o });

function cin(data: Uint8Array, o: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    data,
    readSlot: SLOT_NOW,
    registered: true,
    keeper: keeper.publicKey,
    keeperLandedPush: true,
    keeperObservedMs: 3_600_000,
    neverConnectedGraceSlots: 1_500n,
    quietMs: 0,
    deadInterestMs: 14 * 86_400_000,
    ...o,
  };
}

describe("classifier: DEAD-PRICE bands (same inequality as the program's permissionless_stale_matured)", () => {
  const band = (age: bigint) => priceBandOf(market({ lastGood: ageToLastGood(age) }), SLOT_NOW);
  it("fresh below 50%, warn from exactly 50%, matured from exactly 100%", () => {
    assert.equal(band(8_999n).kind, "fresh");
    assert.equal(band(9_000n).kind, "warn", "50% is the warn edge");
    assert.equal(band(17_999n).kind, "warn");
    assert.equal(band(18_000n).kind, "matured", "age >= stale_slots matures (program: saturating_sub >= window)");
    assert.equal(band(100_000n).kind, "matured");
    const w = staleResolveWindow(market({ lastGood: ageToLastGood(18_000n) }), SLOT_NOW);
    assert.equal(w?.enabled && w.matured, true, "agrees with market-state.ts staleResolveWindow");
  });
  it("stale_slots = 0 is no-window (never resolvable, never attempted); a Resolved market is terminal", () => {
    const nw = classifyMarket(cin(market({ staleSlots: 0n, lastGood: ageToLastGood(900_000n), authority: keeper.publicKey })));
    assert.equal(nw.price.kind, "no-window");
    assert.deepEqual(nw.classes, ["no-resolve-window"]);
    const t = classifyMarket(cin(market({ resolved: true })));
    assert.deepEqual(t.classes, ["terminal"]);
    assert.equal(t.terminal, "resolved");
  });
  it("classes: warn and matured are reported with their age", () => {
    const w = classifyMarket(cin(market({ lastGood: ageToLastGood(10_000n), authority: keeper.publicKey })));
    assert.deepEqual(w.classes, ["dead-price-warn"]);
    const m = classifyMarket(cin(market({ lastGood: ageToLastGood(20_000n), authority: keeper.publicKey })));
    assert.deepEqual(m.classes, ["dead-price-matured"]);
    assert.equal(m.keeperCanPush, true);
  });
});

describe("classifier: NEVER-CONNECTED", () => {
  const old = ageToLastGood(5_000n); // well past the 1,500-slot grace, inside the window
  it("no registry row", () => {
    assert.equal(classifyMarket(cin(market({ lastGood: old, authority: keeper.publicKey }), { registered: false })).neverConnected, "no-registry-row");
  });
  it("registered, but oracle authority is not this keeper (#3661)", () => {
    const lc = classifyMarket(cin(market({ lastGood: old, authority: OTHER })));
    assert.equal(lc.neverConnected, "not-oracle-authority");
    assert.equal(lc.keeperCanPush, false);
  });
  it("registered, keeper is the authority, but no push of this keeper ever landed since it observed for the grace period", () => {
    const m = market({ lastGood: old, authority: keeper.publicKey });
    assert.equal(classifyMarket(cin(m, { keeperLandedPush: false })).neverConnected, "no-accepted-push");
    assert.equal(classifyMarket(cin(m, { keeperLandedPush: false, keeperObservedMs: 60_000 })).neverConnected, null, "a keeper that has only just booted names nobody");
    assert.equal(classifyMarket(cin(m, { keeperLandedPush: true })).neverConnected, null);
  });
  it("a market whose price is younger than the grace is never named (new, or pushed by someone a moment ago)", () => {
    const m = market({ lastGood: ageToLastGood(1_499n), authority: OTHER });
    assert.equal(classifyMarket(cin(m, { registered: false })).neverConnected, null);
  });
});

describe("classifier: DEAD-INTEREST and the quiet clock", () => {
  const fresh = market({ lastGood: ageToLastGood(100n), authority: keeper.publicKey });
  it("priced + OI 0 + quiet for 14 days = dead-interest; 13 days is not", () => {
    assert.equal(classifyMarket(cin(fresh, { quietMs: 14 * 86_400_000 })).deadInterest, true);
    assert.equal(classifyMarket(cin(fresh, { quietMs: 13 * 86_400_000 })).deadInterest, false);
  });
  it("open interest > 0 is never dead-interest", () => {
    assert.equal(openInterestIsZero(market({ oi: 5n })), false);
    assert.equal(classifyMarket(cin(market({ lastGood: ageToLastGood(100n), authority: keeper.publicKey, oi: 5n }), { quietMs: 99 * 86_400_000 })).deadInterest, false);
  });
  it("a price already in the warn band is DEAD-PRICE, not dead-interest", () => {
    const lc = classifyMarket(cin(market({ lastGood: ageToLastGood(10_000n), authority: keeper.publicKey }), { quietMs: 99 * 86_400_000 }));
    assert.equal(lc.deadInterest, false);
    assert.deepEqual(lc.classes, ["dead-price-warn"]);
  });
  it("the quiet clock: starts at first sight, survives unchanged observations, restarts on a fee-counter change or OI", () => {
    let q = observeQuiet(undefined, { oiZero: true, feeSum: 10n, nowMs: 1_000 });
    assert.equal(quietMsOf(q, 5_000), 4_000);
    q = observeQuiet(q, { oiZero: true, feeSum: 10n, nowMs: 3_000 });
    assert.equal(q.quietSinceMs, 1_000, "unchanged counters: the clock keeps running");
    q = observeQuiet(q, { oiZero: true, feeSum: 11n, nowMs: 4_000 });
    assert.equal(q.quietSinceMs, 4_000, "a trade-fee accrual restarts it");
    q = observeQuiet(q, { oiZero: false, feeSum: 11n, nowMs: 6_000 });
    assert.equal(q.quietSinceMs, 6_000, "OI > 0 restarts it");
    q = observeQuiet(q, { oiZero: null, feeSum: 11n, nowMs: 7_000 });
    assert.equal(q.quietSinceMs, 7_000, "an unreadable OI never counts as quiet");
    assert.equal(tradeFeeAccrualSum(market({ feeSum: 42n })), 42n);
  });
});

// ── the ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("ObservationLedger: keeper-outage evidence", () => {
  const MIN = 60_000;
  it("0 right after boot; counts only while BOTH loops observe; a failed read or a gap restarts it", () => {
    const l = new ObservationLedger(10_000);
    assert.equal(l.continuousMs(0), 0);
    l.noteTick(true, 0);
    assert.equal(l.continuousMs(1), 0, "the push loop has not been seen");
    l.noteSourceCycle(true, 0);
    for (let t = 5_000; t <= MIN; t += 5_000) {
      l.noteTick(true, t);
      l.noteSourceCycle(true, t);
    }
    assert.equal(l.continuousMs(MIN), MIN);
    l.noteTick(false, MIN + 5_000); // an RPC failure
    assert.equal(l.continuousMs(MIN + 5_000), 0);
    l.noteTick(true, MIN + 10_000);
    l.noteSourceCycle(true, MIN + 10_000);
    assert.equal(l.continuousMs(MIN + 10_000), 0, "restarted from the first good note after the failure");
    l.noteTick(true, MIN + 40_000); // 30 s of silence from the tick loop (> 10 s max gap)
    assert.equal(l.continuousMs(MIN + 40_000), 0, "a gap restarts it");
  });
  it("a loop that has gone quiet is not observing NOW", () => {
    const l = new ObservationLedger(10_000);
    l.noteTick(true, 0);
    l.noteSourceCycle(true, 0);
    l.noteTick(true, 5_000);
    l.noteSourceCycle(true, 5_000);
    assert.equal(l.continuousMs(5_000), 5_000);
    assert.equal(l.continuousMs(60_000), 0, "both loops silent for 55 s");
  });
  it("sourceUnavailableMs is measured inside the continuous window and reset by a usable source", () => {
    const l = new ObservationLedger(10_000);
    for (let t = 0; t <= 40_000; t += 5_000) {
      l.noteTick(true, t);
      l.noteSourceCycle(true, t);
    }
    assert.equal(l.sourceUnavailableMs("m", 40_000), 40_000);
    l.recordSource("m", true, 30_000);
    assert.equal(l.sourceUnavailableMs("m", 40_000), 10_000);
    assert.equal(l.sourceUnavailableMs("never-seen", 40_000), 40_000, "no usable source ever seen = unavailable for the whole window");
    assert.equal(l.sourceUnavailableMs("m", 90_000), 0, "no continuous observation = no evidence");
  });
});

// ── the resolve guards, each with a negative control ───────────────────────────────────────────────────────────────

function lcOf(o: { age?: bigint; authority?: PublicKey; registered?: boolean; landed?: boolean; staleSlots?: bigint } = {}): MarketLifecycle {
  return classifyMarket(cin(market({ lastGood: ageToLastGood(o.age ?? 20_000n), authority: o.authority ?? keeper.publicKey, staleSlots: o.staleSlots }), { registered: o.registered ?? true, keeperLandedPush: o.landed ?? true }));
}

/** An input that passes every guard: matured, pushable, source dead for an hour, keeper healthy for an hour. */
function green(o: Partial<ResolveInput> = {}): ResolveInput {
  return {
    mode: "on",
    lc: lcOf(),
    continuousMs: 3_600_000,
    sourceUnavailableMs: 3_600_000,
    maturedCount: 0,
    resolvedThisCycle: 0,
    attempt: undefined,
    nowMs: 10_000_000,
    cfg: cfg(),
    ...o,
  };
}
const without = (...names: string[]) => RESOLVE_GUARDS.filter((g) => !names.includes(g.name));

describe("stale resolve guards: the green input resolves", () => {
  it("every guard passes", () => {
    assert.deepEqual(decideResolve(green()), { action: "resolve" });
  });
});

describe("stale resolve guards: each blocks its unsafe input, and the test fails (the unsafe input resolves) if the guard is removed", () => {
  const cases: Array<{ guard: string; bad: ResolveInput; alsoRemove?: string[] }> = [
    { guard: "mode-enabled", bad: green({ mode: "off" }) },
    { guard: "market-live", bad: green({ lc: classifyMarket(cin(market({ resolved: true }))) }), alsoRemove: ["matured"] },
    { guard: "window-enabled", bad: green({ lc: lcOf({ staleSlots: 0n }) }), alsoRemove: ["matured"] },
    { guard: "matured", bad: green({ lc: lcOf({ age: 10_000n }) }) },
    { guard: "keeper-continuity", bad: green({ continuousMs: 60_000 }) },
    { guard: "mass-maturity", bad: green({ maturedCount: 4 }) },
    { guard: "source-unavailable", bad: green({ sourceUnavailableMs: 60_000 }) },
    { guard: "not-attempted", bad: green({ attempt: { atMs: 9_900_000, landed: false } }) },
    { guard: "not-attempted", bad: green({ attempt: { atMs: 0, landed: true } }) },
    { guard: "cycle-bound", bad: green({ resolvedThisCycle: 1 }) },
  ];
  for (const c of cases) {
    it(`${c.guard}`, () => {
      const held = decideResolve(c.bad);
      assert.equal(held.action, "hold");
      assert.equal(held.action === "hold" ? held.guard : null, c.guard, "the named guard is what held it");
      // NEGATIVE CONTROL: the same input with this guard (and its redundant twin) removed goes through.
      assert.deepEqual(decideResolve(c.bad, without(c.guard, ...(c.alsoRemove ?? []))), { action: "resolve" }, `without ${c.guard} the unsafe input would resolve`);
    });
  }
  it("a retry is allowed once the cool-down has passed", () => {
    assert.deepEqual(decideResolve(green({ attempt: { atMs: 0, landed: false } })), { action: "resolve" });
  });
});

describe("stale resolve guards: (b) the source rule only applies to markets the keeper can push", () => {
  it("a usable source blocks a pushable market (push, do not resolve)", () => {
    const d = decideResolve(green({ sourceUnavailableMs: 0 }));
    assert.equal(d.action === "hold" && d.guard, "source-unavailable");
  });
  it("a foreign-authority / unregistered market has no keeper source to wait for: only maturity and continuity apply", () => {
    for (const lc of [lcOf({ authority: OTHER }), lcOf({ registered: false })]) {
      assert.equal(lc.keeperCanPush, false);
      assert.deepEqual(decideResolve(green({ lc, sourceUnavailableMs: 0 })), { action: "resolve" });
      assert.equal(decideResolve(green({ lc, sourceUnavailableMs: 0, continuousMs: 0 })).action, "hold", "but a keeper that was not observing still never resolves it");
    }
  });
});

describe("pre-send re-verification (d): each unsafe re-read blocks, and the check(s) that catch it are load-bearing", () => {
  const matured = market({ lastGood: ageToLastGood(20_000n) });
  const ok: PreSendInput = { expectedLastGoodOracleSlot: ageToLastGood(20_000n), fresh: matured, freshOwnerIsWrapper: true, clusterSlot: SLOT_NOW };
  it("passes when nothing changed", () => assert.equal(preSendVerdict(ok), null));
  const cases: Array<{ name: string; bad: PreSendInput }> = [
    { name: "unreadable", bad: { ...ok, fresh: null } },
    { name: "foreign owner", bad: { ...ok, freshOwnerIsWrapper: false } },
    { name: "already resolved", bad: { ...ok, fresh: market({ lastGood: ageToLastGood(20_000n), resolved: true }) } },
    { name: "a push landed (no longer matured)", bad: { ...ok, fresh: market({ lastGood: ageToLastGood(100n) }), expectedLastGoodOracleSlot: ageToLastGood(100n) } },
    { name: "last_good_oracle_slot moved since the decision", bad: { ...ok, expectedLastGoodOracleSlot: ageToLastGood(20_500n) } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      assert.notEqual(preSendVerdict(c.bad), null);
      // NEGATIVE CONTROL: the set of checks that fire on this input, removed together, lets it through.
      const firing = PRE_SEND_CHECKS.filter((x) => x.check(c.bad) !== null).map((x) => x.name);
      assert.ok(firing.length >= 1);
      assert.equal(preSendVerdict(c.bad, PRE_SEND_CHECKS.filter((x) => !firing.includes(x.name))), null, `without ${firing.join("+")} it would be sent`);
    });
  }
  it("owner and price-not-advanced are each the SOLE catcher of their case (removing just that check lets it through)", () => {
    assert.equal(preSendVerdict(cases[1].bad, PRE_SEND_CHECKS.filter((x) => x.name !== "owner")), null);
    assert.equal(preSendVerdict(cases[4].bad, PRE_SEND_CHECKS.filter((x) => x.name !== "price-not-advanced")), null);
  });
});

// ── the tag-39 encoder against the deployed handler ────────────────────────────────────────────────────────────────

describe("tag 39 ResolveStalePermissionless: bytes and accounts vs percolator-prog aca02ba6 v16_program.rs", () => {
  it("wire = [39, now_slot u64 LE] (9 bytes, decode at :9735, encode at :10651); ONE account: market, writable, no signer (handler :27625)", () => {
    const m = key(77);
    const ix = buildStaleResolveIx(WRAPPER_PROGRAM_ID, m, 123_456_789n);
    const want = Buffer.alloc(9);
    want[0] = 39;
    want.writeBigUInt64LE(123_456_789n, 1);
    assert.deepEqual([...ix.data], [...want]);
    assert.equal(ix.programId.toBase58(), WRAPPER_PROGRAM_ID.toBase58());
    assert.equal(ix.keys.length, 1);
    assert.equal(ix.keys[0].pubkey.toBase58(), m.toBase58());
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[0].isSigner, false);
  });
});

// ── the executor ───────────────────────────────────────────────────────────────────────────────────────────────────

function execConnWith(data: Uint8Array | null, slot = Number(SLOT_NOW), owner: PublicKey = WRAPPER_PROGRAM_ID) {
  const f = fakeExecConn({ slot: () => slot });
  const conn = Object.assign(f.conn, {
    async getAccountInfo() {
      return data ? { data: Buffer.from(data), owner } : null;
    },
  });
  return { ...f, conn };
}

describe("resolveStaleOnce: re-read, re-verify, then send (or not)", () => {
  const m = key(500);
  const lg = ageToLastGood(20_000n);
  const base = (conn: ReturnType<typeof execConnWith>["conn"], over: { mode?: "on" | "dry"; reguard?: () => string | null; dryRun?: boolean } = {}) => ({
    conn: conn as never,
    exec: { conn: conn as never, keeper, dryRun: over.dryRun ?? false, log: () => {}, confirm: { statusRetries: 0, statusRetryDelayMs: 0 } },
    programId: WRAPPER_PROGRAM_ID,
    market: m,
    label: "T",
    mode: over.mode ?? ("on" as const),
    expectedLastGoodOracleSlot: lg,
    reguard: over.reguard ?? (() => null),
    log: () => {},
  });
  it("on: simulates once, sends exactly one tag-39 tx with the market as its only account", async () => {
    const f = execConnWith(market({ lastGood: lg }));
    const r = await resolveStaleOnce(base(f.conn));
    assert.equal(r.kind, "sent");
    assert.equal(f.sims.length, 1);
    assert.deepEqual(f.sent.map((s) => s.tags), [[39]]);
    assert.deepEqual(f.sent[0].keys, [[m.toBase58()]]);
  });
  it("dry: simulates, sends NOTHING", async () => {
    const f = execConnWith(market({ lastGood: lg }));
    const r = await resolveStaleOnce(base(f.conn, { mode: "dry" }));
    assert.equal(r.kind, "dry-run");
    assert.equal(f.sims.length, 1);
    assert.equal(f.sent.length, 0);
  });
  it("global dry-run also sends nothing even in mode on", async () => {
    const f = execConnWith(market({ lastGood: lg }));
    assert.equal((await resolveStaleOnce(base(f.conn, { dryRun: true }))).kind, "dry-run");
    assert.equal(f.sent.length, 0);
  });
  it("(d) the re-read says Resolved / not matured / price advanced / foreign owner / unreadable: nothing is simulated or sent", async () => {
    for (const [name, f] of [
      ["resolved", execConnWith(market({ lastGood: lg, resolved: true }))],
      ["not matured", execConnWith(market({ lastGood: ageToLastGood(100n) }))],
      ["advanced", execConnWith(market({ lastGood: lg + 5n }))],
      ["foreign owner", execConnWith(market({ lastGood: lg }), Number(SLOT_NOW), Keypair.generate().publicKey)],
      ["missing", execConnWith(null)],
    ] as const) {
      const r = await resolveStaleOnce(base(f.conn));
      assert.equal(r.kind, "held", name);
      assert.equal(f.sims.length, 0, name);
      assert.equal(f.sent.length, 0, name);
    }
  });
  it("a guard that fails after the simulation (loop stalled meanwhile) holds the send; negative control: without it the tx goes", async () => {
    const f1 = execConnWith(market({ lastGood: lg }));
    const r1 = await resolveStaleOnce(base(f1.conn, { reguard: () => "keeper-continuity: stalled" }));
    assert.deepEqual(r1, { kind: "held", reason: "keeper-continuity: stalled" });
    assert.equal(f1.sent.length, 0);
    const f2 = execConnWith(market({ lastGood: lg }));
    assert.equal((await resolveStaleOnce(base(f2.conn))).kind, "sent");
    assert.equal(f2.sent.length, 1);
  });
  it("a simulation the program refuses (27 not matured) is never sent through", async () => {
    const f = fakeExecConn({ slot: () => Number(SLOT_NOW), simErr: () => ({ InstructionError: [2, { Custom: 27 }] }) });
    const conn = Object.assign(f.conn, { async getAccountInfo() { return { data: Buffer.from(market({ lastGood: lg })), owner: WRAPPER_PROGRAM_ID }; } });
    const r = await resolveStaleOnce(base(conn as never));
    assert.equal(r.kind, "refused");
    assert.equal(f.sent.length, 0);
  });
});

// ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeSink {
  reconciled: Array<{ scope: string; alerts: Alert[] }> = [];
  fired: Alert[] = [];
  async reconcile(scope: string, alerts: Alert[]) {
    this.reconciled.push({ scope, alerts });
    return [];
  }
  async fire(_scope: string, a: Alert) {
    this.fired.push(a);
    return true;
  }
  active(scope: string): Alert[] {
    return [...this.reconciled].reverse().find((r) => r.scope === scope)?.alerts ?? [];
  }
}

interface World {
  now: number;
  markets: Map<string, Uint8Array>;
  registered: Set<string>;
  conn: ReturnType<typeof fakeExecConn>["conn"] & Record<string, unknown>;
  exec: ReturnType<typeof fakeExecConn>;
  gpaCalls: Array<{ filters: unknown[]; dataSlice?: unknown }>;
  slotFails: boolean;
}

function world(): World {
  const exec = fakeExecConn({ slot: () => Number(SLOT_NOW) });
  const w = { now: 100_000_000, markets: new Map<string, Uint8Array>(), registered: new Set<string>(), exec, gpaCalls: [] as World["gpaCalls"], slotFails: false } as World;
  w.conn = Object.assign(exec.conn, {
    async getSlot() {
      if (w.slotFails) throw new Error("rpc down");
      return Number(SLOT_NOW);
    },
    async getAccountInfo(pk: PublicKey) {
      const d = w.markets.get(pk.toBase58());
      return d ? { data: Buffer.from(d), owner: WRAPPER_PROGRAM_ID } : null;
    },
    async getProgramAccounts(_p: PublicKey, c: { filters: unknown[]; dataSlice?: unknown }) {
      w.gpaCalls.push(c);
      return [...w.markets.keys()].map((k) => ({ pubkey: new PublicKey(k), account: { data: Buffer.alloc(0), owner: WRAPPER_PROGRAM_ID, lamports: 1, executable: false } }));
    },
    async getMultipleAccountsInfoAndContext(pks: PublicKey[]) {
      return { context: { slot: Number(SLOT_NOW) }, value: pks.map((pk) => (w.markets.has(pk.toBase58()) ? { data: Buffer.from(w.markets.get(pk.toBase58()) as Uint8Array), owner: WRAPPER_PROGRAM_ID, lamports: 1, executable: false } : null)) };
    },
  }) as never;
  return w;
}

let addrSeq = 2_000;
function addMarket(w: World, data: Uint8Array, registered = true): { addr: string; ctx: V22MarketCtx } {
  const addr = key(addrSeq++).toBase58();
  w.markets.set(addr, data);
  if (registered) w.registered.add(addr);
  const load = buildV22MarketCtx({ marketAddress: addr, label: `M${addrSeq}`, programId: WRAPPER_PROGRAM_ID, data, readSlot: Number(SLOT_NOW), registryData: null, vaultLpStateData: null });
  if (!load.ok) throw new Error(`fixture market did not load: ${load.reason} ${load.detail}`);
  return { addr, ctx: load.ctx };
}

function engineFor(w: World, over: Partial<LifecycleConfig> = {}, extra: { dryRun?: boolean; forceFees?: (c: V22MarketCtx) => Promise<string>; ledger?: ObservationLedger } = {}) {
  const sink = new FakeSink();
  const ledger = extra.ledger ?? new ObservationLedger(120_000);
  const logs: string[] = [];
  const e = new LifecycleEngine({
    conn: w.conn as never,
    keeper,
    programId: WRAPPER_PROGRAM_ID,
    cfg: cfg({ discoveryMs: 0, ...over }),
    dryRun: extra.dryRun ?? false,
    registered: (m) => w.registered.has(m),
    sink,
    forceFees: extra.forceFees,
    ledger,
    store: null,
    now: () => w.now,
    log: (s) => logs.push(s),
  });
  return { e, sink, ledger, logs };
}

/** Prime the ledger as if the keeper had been healthy for `ms` (a tick every 20 s, a push cycle every 5 s). */
function primeLedger(l: ObservationLedger, w: World, ms: number): void {
  for (let t = w.now - ms; t <= w.now; t += 5_000) {
    l.noteSourceCycle(true, t);
    if ((t - (w.now - ms)) % 20_000 === 0) l.noteTick(true, t);
  }
  l.noteTick(true, w.now);
}

async function runTick(e: LifecycleEngine, w: World, ctxs: V22MarketCtx[]): Promise<void> {
  e.beginTick();
  for (const c of ctxs) e.observe(c);
  await e.endTick();
}

const matured = (o: Parameters<typeof market>[0] = {}) => market({ lastGood: ageToLastGood(20_000n), ...o });

describe("engine: default OFF changes nothing on chain", () => {
  it("a matured foreign-authority market is classified, alerted and reported, and NOTHING is simulated or sent", async () => {
    const w = world();
    const { addr, ctx } = addMarket(w, matured({ authority: OTHER }));
    const { e, sink, ledger } = engineFor(w); // staleResolve defaults to off
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sims.length, 0);
    assert.equal(w.exec.sent.length, 0);
    const h = e.healthFields() as { staleResolve: string; counts: Record<string, number>; markets: Record<string, { classes: string[]; resolve: { decision: string; guard: string } }> };
    assert.equal(h.staleResolve, "off");
    assert.equal(h.markets[addr].classes.includes("dead-price-matured"), true);
    assert.equal(h.markets[addr].classes.includes("never-connected"), true);
    assert.equal(h.markets[addr].resolve.guard, "mode-enabled");
    assert.equal(sink.active("v22-lifecycle:never-connected").length, 1);
    assert.equal(sink.active("v22-lifecycle:dead-price-matured").length, 1);
  });
});

describe("engine: stale resolve on", () => {
  it("resolves a matured market the keeper cannot push, ONCE, after a healthy observation window; the terminal path then sees it", async () => {
    const w = world();
    const { addr, ctx } = addMarket(w, matured({ authority: OTHER }));
    resetPushDeadlines();
    const { e, sink, ledger } = engineFor(w, { staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, [ctx]);
    assert.deepEqual(w.exec.sent.map((s) => s.tags), [[39]]);
    assert.deepEqual(w.exec.sent[0].keys, [[addr]]);
    assert.equal(sink.fired.filter((a) => a.kind === "stale-resolve-sent").length, 1);
    assert.equal(isKnownTerminal(addr), true, "the push loop stops pushing it");
    assert.equal(getPushDeadline(addr)?.terminal, "resolved");
    // The market after the program resolved it: the terminal-insurance job's FIRST branch decodes Resolved and winds it down.
    const resolved = matured({ authority: OTHER, resolved: true });
    assert.equal(decodeTerminalState(resolved)?.kind, "resolved");
    assert.equal(isTerminalMarket(resolved), true);
    // Idempotent: the same market on the next tick (even if the RPC still showed it Live) is never sent again.
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 1);
  });

  it("(c) a keeper that has just booted does not resolve; negative control: the same world with a healthy history does", async () => {
    const w = world();
    const { ctx } = addMarket(w, matured({ authority: OTHER }));
    const boot = engineFor(w, { staleResolve: "on" }); // empty ledger
    await runTick(boot.e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0, "boot: no continuous observation yet");
    const healthy = engineFor(w, { staleResolve: "on" });
    primeLedger(healthy.ledger, w, 3_600_000);
    await runTick(healthy.e, w, [ctx]);
    assert.equal(w.exec.sent.length, 1);
  });

  it("(c) an RPC failure on the tick restarts the clock: no resolve on the tick that failed", async () => {
    const w = world();
    const { ctx } = addMarket(w, matured({ authority: OTHER }));
    const { e, ledger } = engineFor(w, { staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    w.slotFails = true;
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0);
    w.slotFails = false;
    w.now += 20_000;
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0, "continuous observation restarted by the failure");
  });

  it("(b) a pushable market with a usable source is NOT resolved (it is pushed); once the source has been dead for the window it is", async () => {
    const w = world();
    const { addr, ctx } = addMarket(w, matured({ authority: keeper.publicKey }));
    const { e, ledger } = engineFor(w, { staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    ledger.recordSource(addr, true, w.now - 1_000);
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0);
    const view = e.view(addr);
    assert.equal(view?.resolve?.guard, "source-unavailable");
    // the source dies: 31 minutes without a usable price, keeper healthy throughout
    w.now += 31 * 60_000;
    primeLedger(ledger, w, 3_600_000);
    ledger.recordSource(addr, true, w.now - 3_500_000);
    const { e: e2 } = engineFor(w, { staleResolve: "on" }, { ledger });
    await runTick(e2, w, [ctx]);
    assert.equal(w.exec.sent.length, 1);
  });

  it("a mass outage resolves NOTHING: 4 pushable markets matured while their source is usable, alert critical", async () => {
    const w = world();
    const ms = [0, 1, 2, 3].map(() => addMarket(w, matured({ authority: keeper.publicKey })));
    const { e, sink, ledger } = engineFor(w, { staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    for (const m of ms) ledger.recordSource(m.addr, true, w.now - 1_000);
    await runTick(e, w, ms.map((m) => m.ctx));
    assert.equal(w.exec.sent.length, 0);
    assert.equal((e.healthFields() as { massHold: boolean }).massHold, true);
    assert.equal(sink.active("v22-lifecycle:resolve-held")[0]?.severity, "critical");
  });

  it("the legitimate backlog does NOT trip the mass guard: 5 foreign-authority matured markets drain one per tick", async () => {
    const w = world();
    const ms = [0, 1, 2, 3, 4].map(() => addMarket(w, matured({ authority: OTHER })));
    const { e, ledger } = engineFor(w, { staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, ms.map((m) => m.ctx));
    assert.equal((e.healthFields() as { massHold: boolean }).massHold, false);
    assert.equal(w.exec.sent.length, 1, "bounded to maxResolvesPerCycle = 1 per tick");
    await runTick(e, w, ms.map((m) => m.ctx));
    assert.equal(w.exec.sent.length, 2, "the next tick takes the next one");
    const sentMarkets = new Set(w.exec.sent.map((s) => s.keys[0][0]));
    assert.equal(sentMarkets.size, 2, "never the same market twice");
  });

  it("stale_slots = 0 is classified and never attempted", async () => {
    const w = world();
    const { addr, ctx } = addMarket(w, market({ staleSlots: 0n, lastGood: ageToLastGood(900_000n), authority: OTHER }));
    const { e, ledger } = engineFor(w, { staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0);
    assert.equal(w.exec.sims.length, 0);
    assert.deepEqual(e.view(addr)?.classes.includes("no-resolve-window"), true);
  });

  it("dry: logs 'would resolve', simulates, sends nothing, and does not repeat inside the retry window", async () => {
    const w = world();
    const { ctx } = addMarket(w, matured({ authority: OTHER }));
    const { e, ledger, logs } = engineFor(w, { staleResolve: "dry" });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, [ctx]);
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0);
    assert.equal(w.exec.sims.length, 1);
    assert.equal(logs.filter((l) => /would resolve/.test(l)).length, 1);
  });

  it("a global DRY_RUN forces dry even with KEEPER_V22_STALE_RESOLVE=on", async () => {
    const w = world();
    const { ctx } = addMarket(w, matured({ authority: OTHER }));
    const { e, ledger } = engineFor(w, { staleResolve: "on" }, { dryRun: true });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, [ctx]);
    assert.equal(w.exec.sent.length, 0);
    assert.equal((e.healthFields() as { staleResolve: string }).staleResolve, "dry");
  });
});

describe("engine: discovery of wrapper markets with no registry row", () => {
  it("one keys-only gPA on the market header, only unregistered markets are read and classed NEVER-CONNECTED, cadence respected", async () => {
    const w = world();
    const reg = addMarket(w, market({ lastGood: ageToLastGood(100n), authority: keeper.publicKey }));
    const unreg = addMarket(w, matured({ authority: keeper.publicKey }), false);
    const { e, ledger } = engineFor(w, { discoveryMs: 600_000 });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, [reg.ctx]);
    assert.equal(w.gpaCalls.length, 1);
    const call = w.gpaCalls[0] as { filters: Array<{ memcmp: { offset: number; bytes: string; encoding: string } }>; dataSlice: { offset: number; length: number } };
    assert.deepEqual(call.dataSlice, { offset: 0, length: 0 }, "keys only: cheap");
    assert.equal(call.filters.length, 1);
    assert.equal(call.filters[0].memcmp.offset, 0);
    assert.equal(Buffer.from(call.filters[0].memcmp.bytes, "base64").equals(MARKET_HEADER_V22), true);
    assert.equal(MARKET_HEADER_V22.length, 11, "magic 8 + VERSION 19 (u16) + kind 1");
    const h = e.healthFields() as { markets: Record<string, { classes: string[]; registered: boolean }>; counts: { unregisteredTracked: number } };
    assert.equal(h.counts.unregisteredTracked, 1);
    assert.equal(h.markets[unreg.addr].registered, false);
    assert.equal(h.markets[unreg.addr].classes.includes("never-connected"), true);
    assert.equal(h.markets[reg.addr], undefined, "a healthy registered market is not listed");
    w.now += 20_000;
    await runTick(e, w, [reg.ctx]);
    assert.equal(w.gpaCalls.length, 1, "no second scan inside discoveryMs");
    w.now += 600_000;
    await runTick(e, w, [reg.ctx]);
    assert.equal(w.gpaCalls.length, 2);
  });

  it("an unregistered matured market is resolved by tag 39 (no row: no keeper source to wait for)", async () => {
    const w = world();
    const unreg = addMarket(w, matured({ authority: keeper.publicKey }), false);
    const { e, ledger } = engineFor(w, { discoveryMs: 600_000, staleResolve: "on" });
    primeLedger(ledger, w, 3_600_000);
    await runTick(e, w, []);
    assert.deepEqual(w.exec.sent.map((s) => s.keys[0][0]), [unreg.addr]);
  });

  it("discovery off (0) makes no gPA call", async () => {
    const w = world();
    addMarket(w, matured(), false);
    const { e } = engineFor(w, { discoveryMs: 0 });
    await runTick(e, w, []);
    assert.equal(w.gpaCalls.length, 0);
  });
});

describe("warn-band fee forcing (tags 78 / 87 + stake 12)", () => {
  const warn = () => market({ lastGood: ageToLastGood(12_000n), authority: keeper.publicKey });
  it("forces a fee round for a warn-band registry market every spacing, not for fresh or matured markets", async () => {
    const w = world();
    const calls: string[] = [];
    const fresh = addMarket(w, market({ lastGood: ageToLastGood(100n), authority: keeper.publicKey }));
    const warned = addMarket(w, warn());
    const dead = addMarket(w, matured({ authority: keeper.publicKey }));
    const { e } = engineFor(w, { warnBandFees: true }, { forceFees: async (c) => (calls.push(c.marketAddress), "78 cranked; 87+12 done") });
    await runTick(e, w, [fresh.ctx, warned.ctx, dead.ctx]);
    assert.deepEqual(calls, [warned.addr]);
    w.now += 30_000;
    await runTick(e, w, [warned.ctx]);
    assert.equal(calls.length, 1, "inside the spacing: not again");
    w.now += 31_000;
    await runTick(e, w, [warned.ctx]);
    assert.equal(calls.length, 2, "forced again once the spacing passed, whatever the normal fee cadence");
    assert.equal(e.view(warned.addr)?.fees, "78 cranked; 87+12 done");
  });
  it("is bounded per tick and closest-to-maturity first", async () => {
    const w = world();
    const calls: string[] = [];
    const a = addMarket(w, market({ lastGood: ageToLastGood(9_500n), authority: keeper.publicKey }));
    const b = addMarket(w, market({ lastGood: ageToLastGood(17_000n), authority: keeper.publicKey }));
    const c = addMarket(w, market({ lastGood: ageToLastGood(12_000n), authority: keeper.publicKey }));
    const { e } = engineFor(w, { warnBandFees: true, warnBandFeeMaxPerTick: 2 }, { forceFees: async (x) => (calls.push(x.marketAddress), "ok") });
    await runTick(e, w, [a.ctx, b.ctx, c.ctx]);
    assert.deepEqual(calls, [b.addr, c.addr]);
  });
  it("flag off (the default): nothing is forced (negative control)", async () => {
    const w = world();
    const calls: string[] = [];
    const warned = addMarket(w, warn());
    const { e } = engineFor(w, {}, { forceFees: async (c) => (calls.push(c.marketAddress), "ok") });
    await runTick(e, w, [warned.ctx]);
    assert.equal(calls.length, 0);
  });
  it("unregistered markets (no vault, no pool) are not forced", async () => {
    const w = world();
    const calls: string[] = [];
    const warned = addMarket(w, warn(), false);
    const { e } = engineFor(w, { warnBandFees: true }, { forceFees: async (c) => (calls.push(c.marketAddress), "ok") });
    await runTick(e, w, [warned.ctx]);
    assert.equal(calls.length, 0);
  });
});

describe("flags", () => {
  it("defaults: classifier ON (read-only), stale resolve OFF, fee forcing OFF", () => {
    const f = v22FlagsFromEnv({ KEEPER_V22: "on" });
    assert.equal(f.lifecycle.classify, true);
    assert.equal(f.lifecycle.staleResolve, "off");
    assert.equal(f.lifecycle.warnBandFees, false);
    assert.equal(v22FlagsFromEnv({}).lifecycle.staleResolve, "off");
  });
  it("KEEPER_V22_STALE_RESOLVE: off | dry | on only; yes/1/true (the usual boolean words) are refused for an irreversible action", () => {
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_STALE_RESOLVE: "dry" }).lifecycle.staleResolve, "dry");
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_STALE_RESOLVE: " ON " }).lifecycle.staleResolve, "on");
    for (const bad of ["yes", "1", "true", "enabled", "of"]) assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_STALE_RESOLVE: bad }), V22FlagError, bad);
    assert.equal(v22FlagsFromEnv({ KEEPER_V22_STALE_RESOLVE: "on" }).lifecycle.staleResolve, "off", "the layer is off: the variable is not even read");
  });
  it("numeric knobs are validated; a relative state-file path is refused", () => {
    const f = v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_STALE_RESOLVE_MASS_THRESHOLD: "7", KEEPER_V22_DEAD_INTEREST_DAYS: "30", KEEPER_V22_LIFECYCLE_DISCOVERY_MS: "0", KEEPER_V22_LIFECYCLE_STATE_FILE: "/tmp/x.json" });
    assert.equal(f.lifecycle.massThreshold, 7);
    assert.equal(f.lifecycle.deadInterestDays, 30);
    assert.equal(f.lifecycle.discoveryMs, 0);
    assert.equal(f.lifecycle.stateFile, "/tmp/x.json");
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_STALE_RESOLVE_MAX_PER_CYCLE: "0" }), V22FlagError);
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIFECYCLE_STATE_FILE: "rel.json" }), V22FlagError);
  });
});

beforeEach(() => resetPushDeadlines());

describe("V22Loop wiring", () => {
  it("tick feeds the engine: /health gains v22.lifecycle (additive), nothing is sent with the defaults", async () => {
    const { V22Loop } = await import("./loop.ts");
    const { fakeLoopConn, registryBytes } = await import("./test-helpers.ts");
    const mk = market({ lastGood: ageToLastGood(12_000n), authority: Keypair.generate().publicKey });
    const f = fakeLoopConn({ market: mk, registry: registryBytes({}), readSlot: Number(SLOT_NOW) });
    const addr = key(3_000).toBase58();
    const alerts: string[] = [];
    const loop = new V22Loop({
      conn: f.conn as never,
      keeper,
      programId: WRAPPER_PROGRAM_ID,
      markets: () => [{ marketAddress: addr, label: "W", lpPortfolio: undefined }],
      flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIFECYCLE_DISCOVERY_MS: "0" }),
      dryRun: false,
      alertSink: { reconcile: async (scope) => (alerts.push(scope), []) },
      log: () => {},
    });
    await loop.tick();
    const h = loop.healthFields() as { lifecycle: { enabled: boolean; staleResolve: string; counts: Record<string, number> }; markets: Record<string, { lifecycle?: { priceBand: string } }> };
    assert.equal(h.lifecycle.enabled, true);
    assert.equal(h.lifecycle.staleResolve, "off");
    assert.equal(h.lifecycle.counts.deadPriceWarn, 1);
    assert.equal(h.markets[addr].lifecycle?.priceBand, "warn");
    assert.equal(f.sent.length, 0);
    assert.ok(alerts.some((s) => s.startsWith("v22-lifecycle:")));
    // KEEPER_V22_LIFECYCLE=off removes the block entirely
    const off = new V22Loop({ conn: f.conn as never, keeper, programId: WRAPPER_PROGRAM_ID, markets: () => [], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIFECYCLE: "off" }), dryRun: false, log: () => {} });
    assert.equal("lifecycle" in off.healthFields(), false);
  });
});
