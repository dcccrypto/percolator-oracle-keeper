import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObservationLedger, lifecycleLedger, resetLifecycleLedgerForTests } from "./lifecycle-ledger.ts";
import { pruneDeregisteredMarkets } from "../keeper-loop.ts";

const GAP = 120_000;
const observe = (l: ObservationLedger, t: number) => {
  l.noteTick(true, t);
  l.noteSourceCycle(true, t);
};

describe("ObservationLedger: wall-clock steps", () => {
  it("a BACKWARDS clock step never yields a negative / inflated sourceUnavailableMs", () => {
    const l = new ObservationLedger(GAP);
    observe(l, 1_000_000);
    l.recordSource("M", true, 1_050_000);
    observe(l, 1_060_000);
    // clock steps back 10 min
    const back = 460_000;
    observe(l, back);
    assert.equal(l.sourceUnavailableMs("M", back), 0);
    assert.equal(l.sourceAgeMs("M", back), 0);
    assert.ok(l.continuousMs(back) >= 0);
    const s = l.snapshot(back);
    assert.ok(s.continuousMs >= 0 && (s.tickRunMs ?? 0) >= 0 && (s.sourceRunMs ?? 0) >= 0);
  });

  it("a FORWARD step larger than maxGap restarts the window: a healthy market does not look unavailable", () => {
    const l = new ObservationLedger(GAP);
    observe(l, 0);
    l.recordSource("M", true, 10_000);
    observe(l, 20_000);
    const jump = 20_000 + 3_600_000;
    // before either loop notes again: not observing -> 0
    assert.equal(l.sourceUnavailableMs("M", jump), 0);
    // both loops note after the step; the source is re-read in the same cycle
    observe(l, jump + 1_000);
    l.recordSource("M", true, jump + 1_000);
    assert.equal(l.sourceUnavailableMs("M", jump + 2_000), 1_000);
    // even WITHOUT a fresh usable read the window restarted at the step, so it is bounded by time since the step
    const l2 = new ObservationLedger(GAP);
    observe(l2, 0);
    l2.recordSource("M", true, 10_000);
    observe(l2, 20_000);
    observe(l2, jump + 1_000);
    assert.equal(l2.sourceUnavailableMs("M", jump + 5_000), 4_000);
  });
});

describe("ObservationLedger: de-registration prune", () => {
  it("prune drops usableAt and pushLandedAt for markets outside the keep set", () => {
    const l = new ObservationLedger(GAP);
    l.recordSource("A", true, 1);
    l.recordSource("B", true, 1);
    l.recordPushLanded("A", 1);
    l.recordPushLanded("B", 1);
    l.prune(new Set(["A"]));
    assert.equal(l.lastUsableSourceAt("A"), 1);
    assert.equal(l.lastUsableSourceAt("B"), null);
    assert.equal(l.pushLandedSinceBoot("A"), true);
    assert.equal(l.pushLandedSinceBoot("B"), false);
  });

  it("the per-cycle prune (pruneDeregisteredMarkets) also prunes the process-wide ledger", () => {
    resetLifecycleLedgerForTests();
    lifecycleLedger.recordSource("KEEP", true, 1);
    lifecycleLedger.recordSource("GONE", true, 1);
    lifecycleLedger.recordPushLanded("GONE", 1);
    const state = { stats: new Map(), terminalMarkets: new Set<string>(), landedThisCycle: new Set<string>() };
    pruneDeregisteredMarkets(state as never, { markets: [{ marketAddress: "KEEP" }] } as never);
    assert.equal(lifecycleLedger.lastUsableSourceAt("KEEP"), 1);
    assert.equal(lifecycleLedger.lastUsableSourceAt("GONE"), null);
    assert.equal(lifecycleLedger.pushLandedSinceBoot("GONE"), false);
    resetLifecycleLedgerForTests();
  });
});
