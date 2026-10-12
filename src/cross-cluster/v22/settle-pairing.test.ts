import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WEIGHT_BUDGET, SOLO_WEIGHT, loneLpCrankSuppressed, planSettleRound, portfolioWeight, weightBudgetFor } from "./settle-pairing.ts";
import { key, pf } from "./test-helpers.ts";

const LP = key(500);
const cps = (n: number, legs = 1) => Array.from({ length: n }, (_, i) => pf(i + 1, legs));

describe("SETTLE_PAIRING planner", () => {
  it("weights are 3 + legs; the budget follows the CU measurements", () => {
    assert.equal(portfolioWeight(pf(1, 1)), 4);
    assert.equal(portfolioWeight({ longLegs: 1, shortLegs: 1 }), 5);
    // 3+ legs is SOLO (position cap 4, worst settle 1,013,864 CU): the 14-leg Wave A weights (3 + legs) no longer apply
    assert.equal(portfolioWeight({ longLegs: 3, shortLegs: 2 }), SOLO_WEIGHT);
    assert.equal(weightBudgetFor(), DEFAULT_WEIGHT_BUDGET);
  });

  it("everything fits one tx: ONE tx [LP crank, refresh all], paired, same slot (atomic)", () => {
    const p = planSettleRound({ mode: "prefer", lp: LP, counterparties: cps(5) });
    assert.equal(p.txs.length, 1);
    assert.equal(p.txs[0].accrue, "lp");
    assert.equal(p.txs[0].settlesLp, true);
    assert.equal(p.txs[0].refresh.length, 5);
    assert.equal(p.paired, true);
    assert.equal(p.lpTxIndex, 0);
    assert.deepEqual(p.phases, [[0]]);
  });

  it("P above one tx: the LP settles ONLY in the LAST tx, after every counterparty tx; every counterparty is covered once", () => {
    const c = cps(30); // weight 4 each = 120 > 32
    const p = planSettleRound({ mode: "prefer", lp: LP, counterparties: c });
    assert.ok(p.txs.length > 1);
    assert.equal(p.paired, true);
    assert.equal(p.lpTxIndex, p.txs.length - 1);
    p.txs.slice(0, -1).forEach((t) => {
      assert.equal(t.settlesLp, false);
      assert.notEqual(t.accrue, "lp");
    });
    assert.equal(p.txs[p.txs.length - 1].settlesLp, true);
    const covered = p.txs.flatMap((t) => [...(t.accrue === "counterparty" && t.accrueTarget ? [t.accrueTarget.toBase58()] : []), ...t.refresh.map((r) => r.pubkey.toBase58())]);
    assert.equal(new Set(covered).size, 30);
    assert.equal(covered.length, 30);
    assert.deepEqual(p.unvisited, []);
    assert.equal(p.needsPushHold, true);
    // phase 1 = all counterparty txs (parallel), phase 2 = the LP tx
    assert.deepEqual(p.phases, [p.txs.slice(0, -1).map((t) => t.index), [p.txs.length - 1]]);
  });

  it("no tx exceeds the weight budget (3 + legs), heaviest first", () => {
    const c = [...cps(10, 1), ...cps(10, 2).map((x, i) => ({ ...x, pubkey: key(100 + i) }))];
    const p = planSettleRound({ mode: "prefer", lp: LP, counterparties: c, weightBudget: 32 });
    for (const t of p.txs) assert.ok(t.weight <= 32, `tx ${t.index} weight ${t.weight}`);
    const firstTxWeights = p.txs[0].refresh.map(portfolioWeight);
    assert.ok(portfolioWeight({ longLegs: 2, shortLegs: 0 }) >= Math.max(...p.txs[p.txs.length - 1].refresh.map(portfolioWeight), 0));
    assert.ok(firstTxWeights.length > 0);
  });

  it("accrue-only: via a flat ANCHOR when supplied (no counterparty is the accrue target), else via the tx's first counterparty", () => {
    const anchor = key(777);
    const withAnchor = planSettleRound({ mode: "prefer", lp: LP, counterparties: cps(30), anchor });
    withAnchor.txs.slice(0, -1).forEach((t) => {
      assert.equal(t.accrue, "anchor");
      assert.ok(t.accrueTarget?.equals(anchor));
    });
    const without = planSettleRound({ mode: "prefer", lp: LP, counterparties: cps(30) });
    without.txs.slice(0, -1).forEach((t) => {
      assert.equal(t.accrue, "counterparty");
      assert.ok(!t.refresh.some((r) => r.pubkey.equals(t.accrueTarget!)), "the accrue target is not refreshed twice");
    });
    // the LP is never the accrue target of a counterparty tx
    for (const pl of [withAnchor, without]) pl.txs.slice(0, -1).forEach((t) => assert.ok(!t.accrueTarget?.equals(LP)));
  });

  it("NEGATIVE CONTROL: mode off is the legacy #147 shape (LP crank in EVERY tx, unpaired)", () => {
    const p = planSettleRound({ mode: "off", lp: LP, counterparties: cps(30) });
    assert.ok(p.txs.length > 1);
    assert.ok(p.txs.every((t) => t.accrue === "lp" && t.settlesLp));
    assert.equal(p.paired, false);
    assert.equal(p.unpairedLpSettle, true);
    // the paired plan for the same input never settles the LP more than once
    const paired = planSettleRound({ mode: "prefer", lp: LP, counterparties: cps(30) });
    assert.equal(paired.txs.filter((t) => t.settlesLp).length, 1);
  });

  it("prefer: a round that cannot finish inside maxTxsPerRound settles the LP with counterparties unvisited and COUNTS it", () => {
    const p = planSettleRound({ mode: "prefer", lp: LP, counterparties: cps(60), maxTxsPerRound: 3 });
    assert.equal(p.paired, false);
    assert.equal(p.unpairedLpSettle, true);
    assert.ok(p.unvisited.length > 0);
    assert.equal(p.txs.length, 3);
  });

  it("strict: the same overflow leaves the LP OUT of the round (deferred), counterparties still go out", () => {
    const p = planSettleRound({ mode: "strict", lp: LP, counterparties: cps(60), maxTxsPerRound: 3 });
    assert.equal(p.lpDeferred, true);
    assert.equal(p.lpTxIndex, null);
    assert.ok(p.txs.every((t) => !t.settlesLp));
    assert.ok(p.txs.length > 0);
    assert.ok(p.unvisited.length > 0);
  });

  it("strict and prefer agree when the round fits (single tx and multi tx)", () => {
    for (const n of [4, 30]) {
      const a = planSettleRound({ mode: "strict", lp: LP, counterparties: cps(n) });
      const b = planSettleRound({ mode: "prefer", lp: LP, counterparties: cps(n) });
      assert.equal(a.paired, true);
      assert.deepEqual(a.txs.map((t) => t.refresh.length), b.txs.map((t) => t.refresh.length));
    }
  });

  it("LP with no counterparties: one tx, just the LP", () => {
    const p = planSettleRound({ mode: "strict", lp: LP, counterparties: [] });
    assert.equal(p.txs.length, 1);
    assert.equal(p.txs[0].refresh.length, 0);
    assert.equal(p.paired, true);
  });
});

describe("lone vault-LP crank suppression", () => {
  it("default (flag on, pairing off): never suppressed, on any market", () => {
    for (const isV22Market of [true, false]) assert.equal(loneLpCrankSuppressed({ loneLpCrankFlag: true, pairingActive: false, isV22Market }), false);
  });
  it("pairing active: suppressed on v2.2 markets ONLY; v1 / v2.1 markets keep the crank", () => {
    assert.equal(loneLpCrankSuppressed({ loneLpCrankFlag: true, pairingActive: true, isV22Market: true }), true);
    assert.equal(loneLpCrankSuppressed({ loneLpCrankFlag: true, pairingActive: true, isV22Market: false }), false);
  });
  it("VAULT_LP_LONE_CRANK=off suppresses everywhere", () => {
    for (const isV22Market of [true, false]) assert.equal(loneLpCrankSuppressed({ loneLpCrankFlag: false, pairingActive: false, isV22Market }), true);
  });
});
