/**
 * lifecycle-resolve.ts: boundaries of every guard, the expected-code set pinned to the program's error ordinals, the
 * maturity inequality against the program's own, keeper-continuity through the real ObservationLedger (restart / failed read /
 * gap), the pre-send checks, and resolveStaleOnce's failure paths (failed getSlot / getAccountInfo, result mapping).
 *
 * Program proof (percolator-prog d27f3d73, src/v16_program.rs):
 *   - PercolatorError enum :1455-1500, ordinals by position: EngineStale = 19, EngineLockActive = 21, OracleStale = 27.
 *   - handle_resolve_stale_permissionless :29266 refuses mode != Live (EngineLockActive), authenticated_slot < current_slot
 *     (EngineStale), then !permissionless_stale_matured (OracleStale).
 *   - permissionless_stale_matured :12514: stale_slots != 0 && now_slot.saturating_sub(last_good_oracle_slot) >= stale_slots.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { assetSlotsOff, layoutById } from "../market-layout.ts";
import { staleResolveWindow } from "../market-state.ts";
import { LIFECYCLE_DEFAULTS } from "./flags.ts";
import type { LifecycleConfig } from "./flags.ts";
import { classifyMarket } from "./lifecycle-classify.ts";
import type { MarketLifecycle } from "./lifecycle-classify.ts";
import { ObservationLedger } from "./lifecycle-ledger.ts";
import {
  PRE_SEND_CHECKS,
  RESOLVE_EXPECTED_CODES,
  RESOLVE_GUARDS,
  TAG_RESOLVE_STALE_PERMISSIONLESS,
  decideResolve,
  preSendVerdict,
  resolveStaleOnce,
} from "./lifecycle-resolve.ts";
import type { ResolveInput } from "./lifecycle-resolve.ts";
import { fakeExecConn, key, v22MarketBytes } from "./test-helpers.ts";

const L = layoutById("v2.2-b");
const MODE_OFF = 592 + 674;
const STALE = 18_000n;
const NOW = 1_000_000n;
const keeper = Keypair.generate();
const MIN = 1_800_000;

function market(o: { stale?: bigint; lastGood?: bigint; authority?: PublicKey; resolved?: boolean; recovery?: boolean } = {}): Uint8Array {
  const b = Buffer.from(v22MarketBytes());
  b.writeBigUInt64LE(o.stale ?? STALE, 16 + 136);
  b.writeBigUInt64LE(o.lastGood ?? NOW, 16 + 152);
  if (o.authority) Buffer.from(o.authority.toBytes()).copy(b, assetSlotsOff(L) + 120);
  if (o.resolved) b[MODE_OFF] = 1;
  if (o.recovery) b[MODE_OFF] = 2;
  return new Uint8Array(b);
}

const cfg = (o: Partial<LifecycleConfig> = {}): LifecycleConfig => ({ ...LIFECYCLE_DEFAULTS, minObservationMs: MIN, ...o });

function lcOf(age: bigint, o: { stale?: bigint; authority?: PublicKey; resolved?: boolean } = {}): MarketLifecycle {
  return classifyMarket({
    data: market({ lastGood: NOW - age, stale: o.stale, authority: o.authority ?? keeper.publicKey, resolved: o.resolved }),
    readSlot: NOW,
    registered: true,
    keeper: keeper.publicKey,
    keeperLandedPush: true,
    keeperObservedMs: 3_600_000,
    neverConnectedGraceSlots: 1_500n,
    quietMs: 0,
    deadInterestMs: 14 * 86_400_000,
  });
}

function green(o: Partial<ResolveInput> = {}): ResolveInput {
  return {
    mode: "on",
    lc: lcOf(20_000n),
    continuousMs: 3_600_000,
    sourceUnavailableMs: 3_600_000,
    maturedCount: 0,
    allowlisted: false,
    sourceLossHold: false,
    groupLossHold: false,
    resolvedThisCycle: 0,
    attempt: undefined,
    nowMs: 10_000_000,
    cfg: cfg(),
    ...o,
  };
}
const guardOf = (i: ResolveInput) => {
  const d = decideResolve(i);
  return d.action === "hold" ? d.guard : "resolve";
};

describe("expected codes are exactly the program's refusals of tag 39 (prog d27f3d73 enum :1455-1500)", () => {
  it("19 EngineStale, 21 EngineLockActive, 27 OracleStale; nothing else", () => {
    const enumOrder = [
      "InvalidMagic", "InvalidVersion", "AlreadyInitialized", "NotInitialized", "InvalidAccountKind", "InvalidAccountLen", "ExpectedSigner",
      "ExpectedWritable", "Unauthorized", "InvalidInstruction", "InvalidMint", "InvalidTokenAccount", "InvalidVaultAccount", "InvalidTokenProgram",
      "EngineInvalidConfig", "EngineArithmeticOverflow", "EngineProvenanceMismatch", "EngineHiddenLeg", "EngineInvalidLeg", "EngineStale",
      "EngineBStale", "EngineLockActive", "EngineNonProgress", "EngineRecoveryRequired", "EngineCounterOverflow", "EngineCounterUnderflow",
      "OracleInvalid", "OracleStale",
    ];
    assert.equal(enumOrder.indexOf("EngineStale"), 19);
    assert.equal(enumOrder.indexOf("EngineLockActive"), 21);
    assert.equal(enumOrder.indexOf("OracleStale"), 27);
    assert.deepEqual([...RESOLVE_EXPECTED_CODES].sort((a, b) => a - b), [19, 21, 27]);
    assert.equal(TAG_RESOLVE_STALE_PERMISSIONLESS, 39);
  });
});

describe("matured gate equals the program's age >= permissionless_resolve_stale_slots", () => {
  const w = (age: bigint, stale = STALE) => staleResolveWindow(market({ lastGood: NOW - age, stale }), NOW);
  it("boundary: stale-1 not matured, stale matured, stale+1 matured", () => {
    assert.equal(w(STALE - 1n)?.matured, false);
    assert.equal(w(STALE)?.matured, true);
    assert.equal(w(STALE + 1n)?.matured, true);
  });
  it("last_good in the future (saturating_sub = 0) is not matured; window 0 is disabled", () => {
    assert.equal(staleResolveWindow(market({ lastGood: NOW + 50n }), NOW)?.matured, false);
    assert.equal(w(10_000_000n, 0n)?.enabled, false);
  });
  it("the guard follows: age stale-1 holds on matured, age stale resolves", () => {
    assert.equal(guardOf(green({ lc: lcOf(STALE - 1n) })), "matured");
    assert.equal(guardOf(green({ lc: lcOf(STALE) })), "resolve");
  });
});

describe("guard boundaries (>= and < exactly at the threshold)", () => {
  it("mode off holds; not-live holds; no window holds", () => {
    assert.equal(guardOf(green({ mode: "off" })), "mode-enabled");
    assert.equal(guardOf(green({ lc: lcOf(20_000n, { resolved: true }) })), "market-live");
    assert.equal(guardOf(green({ lc: lcOf(20_000n, { stale: 0n }) })), "window-enabled");
  });
  it("keeper-continuity: min-1 holds, min resolves", () => {
    assert.equal(guardOf(green({ continuousMs: MIN - 1 })), "keeper-continuity");
    assert.equal(guardOf(green({ continuousMs: MIN })), "resolve");
  });
  it("source-unavailable: min-1 holds a pushable market, min resolves", () => {
    assert.equal(guardOf(green({ sourceUnavailableMs: MIN - 1 })), "source-unavailable");
    assert.equal(guardOf(green({ sourceUnavailableMs: MIN })), "resolve");
  });
  it("mass-maturity: threshold resolves, threshold+1 holds", () => {
    assert.equal(guardOf(green({ maturedCount: cfg().massThreshold })), "resolve");
    assert.equal(guardOf(green({ maturedCount: cfg().massThreshold + 1 })), "mass-maturity");
  });
  it("not-attempted: inside retry holds, at retry resolves, landed holds forever", () => {
    const r = cfg().resolveRetryMs;
    const nowMs = 10_000_000;
    assert.equal(guardOf(green({ attempt: { atMs: nowMs - r + 1, landed: false } })), "not-attempted");
    assert.equal(guardOf(green({ attempt: { atMs: nowMs - r, landed: false } })), "resolve");
    assert.equal(guardOf(green({ attempt: { atMs: 0, landed: true } })), "not-attempted");
  });
  it("cycle-bound: max-1 resolves, max holds", () => {
    const m = cfg().maxResolvesPerCycle;
    assert.equal(guardOf(green({ resolvedThisCycle: m - 1 })), "resolve");
    assert.equal(guardOf(green({ resolvedThisCycle: m })), "cycle-bound");
  });
  it("source-group-loss / source-health only bind pushable markets", () => {
    assert.equal(guardOf(green({ groupLossHold: true })), "source-group-loss");
    assert.equal(guardOf(green({ sourceLossHold: true })), "source-health");
    const foreign = lcOf(20_000n, { authority: key(9) });
    assert.equal(guardOf(green({ lc: foreign, groupLossHold: true, sourceLossHold: true, sourceUnavailableMs: 0 })), "resolve");
  });
  it("every guard has a unique name", () => {
    const names = RESOLVE_GUARDS.map((g) => g.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("keeper-continuity through the real ObservationLedger", () => {
  const MAXGAP = 120_000;
  const mk = () => new ObservationLedger(MAXGAP);
  const step = (l: ObservationLedger, ok: boolean, t: number) => {
    l.noteTick(ok, t);
    l.noteSourceCycle(ok, t);
  };
  it("a fresh ledger (keeper restart) has continuousMs 0, so every resolve holds on keeper-continuity", () => {
    const l = mk();
    assert.equal(l.continuousMs(5_000_000), 0);
    assert.equal(guardOf(green({ continuousMs: l.continuousMs(5_000_000) })), "keeper-continuity");
  });
  it("resolves only once min ms of unbroken observation has passed since boot", () => {
    const l = mk();
    const t0 = 1_000_000;
    for (let t = t0; t <= t0 + MIN; t += 60_000) step(l, true, t);
    assert.equal(l.continuousMs(t0 + MIN), MIN);
    assert.equal(guardOf(green({ continuousMs: l.continuousMs(t0 + MIN) })), "resolve");
    assert.equal(guardOf(green({ continuousMs: l.continuousMs(t0 + MIN - 60_000) })), "keeper-continuity");
  });
  it("one failed read resets the run", () => {
    const l = mk();
    const t0 = 1_000_000;
    for (let t = t0; t <= t0 + MIN; t += 60_000) step(l, true, t);
    step(l, false, t0 + MIN + 60_000);
    step(l, true, t0 + MIN + 120_000);
    assert.equal(l.continuousMs(t0 + MIN + 120_000), 0);
  });
  it("a gap above maxGap restarts the run, and a loop silent past maxGap is not observing now", () => {
    const l = mk();
    step(l, true, 0);
    step(l, true, 60_000);
    step(l, true, 60_000 + MAXGAP + 1);
    assert.equal(l.continuousMs(60_000 + MAXGAP + 1), 0);
    assert.equal(l.continuousMs(60_000 + 2 * MAXGAP + 5), 0);
  });
  it("only one of the two loops observing is not continuity", () => {
    const l = mk();
    for (let t = 0; t <= MIN; t += 60_000) l.noteTick(true, t);
    assert.equal(l.continuousMs(MIN), 0);
  });
});

describe("pre-send checks", () => {
  const lg = NOW - 20_000n;
  const inp = (o: Partial<Parameters<typeof preSendVerdict>[0]> = {}) => ({
    expectedLastGoodOracleSlot: lg,
    fresh: market({ lastGood: lg }) as Uint8Array | null,
    freshOwnerIsWrapper: true,
    clusterSlot: NOW as bigint | null,
    ...o,
  });
  it("clean read passes", () => assert.equal(preSendVerdict(inp()), null));
  it("unreadable account or slot -> readable", () => {
    assert.match(preSendVerdict(inp({ fresh: null }))!, /re-read/);
    assert.match(preSendVerdict(inp({ clusterSlot: null }))!, /re-read/);
  });
  it("foreign owner, resolved, recovery, matured boundary, price moved", () => {
    assert.match(preSendVerdict(inp({ freshOwnerIsWrapper: false }))!, /not owned/);
    assert.match(preSendVerdict(inp({ fresh: market({ lastGood: lg, resolved: true }) }))!, /mode is no longer Live/);
    assert.match(preSendVerdict(inp({ fresh: market({ lastGood: lg, recovery: true }) }))!, /mode is no longer Live/);
    assert.match(preSendVerdict(inp({ clusterSlot: lg + STALE - 1n }))!, /no longer matured/);
    assert.equal(preSendVerdict(inp({ clusterSlot: lg + STALE })), null);
    assert.match(preSendVerdict(inp({ fresh: market({ lastGood: lg + 1n }) }))!, /no longer matured/);
    assert.match(preSendVerdict(inp({ fresh: market({ lastGood: lg - 1n }) }))!, /moved/);
  });
  it("window switched off on chain -> not matured", () => {
    assert.match(preSendVerdict(inp({ fresh: market({ lastGood: lg, stale: 0n }) }))!, /no longer matured/);
  });
  it("defensive 'unreadable' branches fire when the earlier checks are removed", () => {
    const onlyMatured = PRE_SEND_CHECKS.filter((c) => c.name === "still-matured");
    assert.equal(preSendVerdict(inp({ fresh: null }), onlyMatured), "unreadable");
    assert.equal(preSendVerdict(inp({ clusterSlot: null }), onlyMatured), "unreadable");
    const onlyPrice = PRE_SEND_CHECKS.filter((c) => c.name === "price-not-advanced");
    assert.equal(preSendVerdict(inp({ fresh: null }), onlyPrice), "unreadable");
    assert.equal(preSendVerdict(inp({ clusterSlot: null }), onlyPrice), "unreadable");
  });
});

describe("resolveStaleOnce failure paths", () => {
  const m = key(700);
  const lg = NOW - 20_000n;
  const okInfo = async () => ({ data: Buffer.from(market({ lastGood: lg })), owner: WRAPPER_PROGRAM_ID });
  function setup(o: { getSlot?: () => Promise<number>; getAccountInfo?: () => Promise<unknown>; code?: number } = {}) {
    const f = fakeExecConn({ slot: () => Number(NOW), simErr: o.code === undefined ? undefined : () => ({ InstructionError: [2, { Custom: o.code }] }) });
    const conn = Object.assign(f.conn, { getAccountInfo: o.getAccountInfo ?? okInfo, ...(o.getSlot ? { getSlot: o.getSlot } : {}) });
    const d = {
      conn: conn as never,
      exec: { conn: conn as never, keeper, dryRun: false, log: () => {}, confirm: { statusRetries: 0, statusRetryDelayMs: 0 } },
      programId: WRAPPER_PROGRAM_ID,
      market: m,
      label: "T",
      mode: "on" as const,
      expectedLastGoodOracleSlot: lg,
      reguard: () => null,
      log: () => {},
    };
    return { f, d };
  }
  it("a failed getSlot is not replaced by a guessed slot: held, nothing simulated or sent", async () => {
    const { f, d } = setup({ getSlot: async () => { throw new Error("rpc down"); } });
    assert.deepEqual(await resolveStaleOnce(d), { kind: "held", reason: "could not re-read the market / the cluster slot" });
    assert.equal(f.sims.length, 0);
    assert.equal(f.sent.length, 0);
  });
  it("a failed getAccountInfo is held the same way", async () => {
    const { f, d } = setup({ getAccountInfo: async () => { throw new Error("rpc down"); } });
    assert.equal((await resolveStaleOnce(d)).kind, "held");
    assert.equal(f.sent.length, 0);
  });
  it("19/21/27 are refused as expected; an unexpected code (8) is refused as not expected; never sent", async () => {
    for (const [code, expected] of [[21, true], [19, true], [27, true], [8, false]] as const) {
      const { f, d } = setup({ code });
      const r = await resolveStaleOnce(d);
      assert.equal(r.kind, "refused", `code ${code}`);
      if (r.kind === "refused") assert.equal(r.expected, expected, `code ${code}`);
      assert.equal(f.sent.length, 0);
    }
  });
});
