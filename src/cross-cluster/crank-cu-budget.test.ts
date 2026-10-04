/**
 * OTC crank reverts, 2026-10-03/04: ProgramFailedToComplete in streaks of 3-8
 * cycles on OTC/USDC (6Y4bfYLW…), occasionally backpack / CATE / BOBO / Jimothy.
 *
 * Root cause (measured from landed keeper cranks, wrapper 7c906e45): the
 * accrual crank costs ~61k CU when the mark has not moved but 120k-162k right
 * after a mark move, above the planner's 150k estimate; a trader refresh costs
 * up to ~151k against a 130k estimate. With only two positioned portfolios the
 * plan had no averaging slack (limit 410k vs 162k + 151k + 110k = 423k), and
 * resolveCrankPlan treated the out-of-compute refresh as an engine rejection:
 * it pruned the refresh (shrinking the budget with it) twice, ending on an
 * accrual-only 150k plan that itself ran out at the accrual -> revert.
 *
 * These tests drive the real planCrankTx + resolveCrankPlan through a metered
 * simulator that charges each crank its measured cost against the plan's CU
 * limit and fails the way the runtime does ("exceeded CUs meter").
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/crank-cu-budget.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  ACCRUAL_TX_CU_HEADROOM,
  ACCRUE_CRANK_CU,
  LIQUIDATE_CRANK_CU,
  MAX_TX_CU,
  REFRESHES_PER_OVERFLOW_TX,
  REFRESH_CRANK_CU,
  chunkOverflowTargets,
  isComputeExhaustion,
  planCrankTx,
  planRefreshTx,
} from "./positioned-refresh.ts";
import type { CrankPlan, PlannedCrank, PositionedPortfolio } from "./positioned-refresh.ts";
import { resolveCrankPlan, refreshPruneBudget } from "./recovery-cranker.ts";
import type { SimOutcome } from "./recovery-cranker.ts";

const owner = PublicKey.unique();
const market = PublicKey.unique();
const lp = PublicKey.unique();
const trader = PublicKey.unique();

/** Measured on devnet 2026-10-04 (OTC landed cranks), worst observed per crank. */
const OTC_ACCRUE_AFTER_MOVE = 162_212;
const OTC_TRADER_REFRESH = 151_076;
const OTC_LP_REFRESH = 110_206;
/** Accrual-only cost after an up-tick, reproduced by simulation (PushAuthMark + crank). */
const OTC_ACCRUE_UPTICK_SIM = 157_139;
/** The compute-budget instruction itself. */
const CB_IX_CU = 150;

const otcTargets = (): PositionedPortfolio[] => [
  { pubkey: trader, longLegs: 1, shortLegs: 0, isLp: false },
  { pubkey: lp, longLegs: 0, shortLegs: 1, isLp: true },
];

const otcCost = (c: PlannedCrank): number => {
  if (c.kind === "accrue") return OTC_ACCRUE_AFTER_MOVE;
  if (c.kind === "catchup") return 27_500;
  if (c.kind === "refresh") return c.portfolio.equals(lp) ? OTC_LP_REFRESH : OTC_TRADER_REFRESH;
  return 200_000;
};

/** Simulator that meters each crank against plan.computeUnits like the SVM does. */
function meteredSim(cost: (c: PlannedCrank, plan: CrankPlan) => number, calls?: CrankPlan[]) {
  return async (plan: CrankPlan): Promise<SimOutcome> => {
    calls?.push(plan);
    let left = plan.computeUnits - CB_IX_CU;
    for (let i = 0; i < plan.cranks.length; i++) {
      const need = cost(plan.cranks[i], plan);
      if (need > left) {
        return {
          err: { InstructionError: [i + 1, "ProgramFailedToComplete"] },
          logs: [
            `Program W consumed ${left} of ${left} compute units`,
            "Program W failed: exceeded CUs meter at BPF instruction",
          ],
          marketData: null,
        };
      }
      left -= need;
    }
    return { err: null, logs: [], marketData: null };
  };
}

const build = (catchup = 0) => (t: ReadonlyArray<PositionedPortfolio>): CrankPlan =>
  planCrankTx({ owner, market, lpPortfolio: lp, catchup, refreshTargets: t });

describe("OTC ProgramFailedToComplete streaks (2026-10-04): crank CU budget", () => {
  it("worst measured OTC cycle: accrual + both refreshes simulate clean in ONE plan, nothing pruned", async () => {
    const calls: CrankPlan[] = [];
    const r = await resolveCrankPlan(build(), otcTargets(), meteredSim(otcCost, calls), undefined, refreshPruneBudget(2));
    assert.equal(r.sim.err, null, `reverted: ${JSON.stringify(r.sim.err)}`);
    assert.deepEqual(r.plan.cranks.map((c) => c.kind), ["accrue", "refresh", "refresh"]);
    assert.equal(r.pruned.length, 0);
    assert.equal(calls.length, 1, "fits the planned budget without a boost");
    assert.ok(r.plan.computeUnits >= OTC_ACCRUE_AFTER_MOVE + OTC_TRADER_REFRESH + OTC_LP_REFRESH + CB_IX_CU);
  });

  it("same cycle behind the engine clock (catch-up cranks first) still lands", async () => {
    for (const catchup of [1, 2, 5]) {
      const r = await resolveCrankPlan(build(catchup), otcTargets(), meteredSim(otcCost), undefined, refreshPruneBudget(2));
      assert.equal(r.sim.err, null, `catchup=${catchup}: ${JSON.stringify(r.sim.err)}`);
      assert.equal(r.plan.cranks.filter((c) => c.kind === "refresh").length, 2);
    }
  });

  it("accrual-only plan covers the post-move accrual and the sim-to-land race", () => {
    const plan = build()([]);
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue"]);
    // Landed 2026-10-04T03:36:56Z trZu5wyB…: accrual-only at 150k, "consumed 149850 of 149850".
    assert.ok(plan.computeUnits >= OTC_ACCRUE_AFTER_MOVE + CB_IX_CU, `limit=${plan.computeUnits}`);
    assert.ok(plan.computeUnits >= OTC_ACCRUE_UPTICK_SIM + CB_IX_CU);
  });

  it("compute exhaustion is never pruned as an engine rejection: the same plan is re-simulated at the max", async () => {
    // Every crank costs 200k: any plan under the max runs out; at 1.4M it fits.
    const calls: CrankPlan[] = [];
    const r = await resolveCrankPlan(build(), otcTargets(), meteredSim(() => 200_000, calls), undefined, refreshPruneBudget(2));
    assert.equal(r.sim.err, null);
    assert.equal(r.pruned.length, 0, "no refresh was dropped for running out of compute");
    assert.equal(r.plan.cranks.filter((c) => c.kind === "refresh").length, 2);
    assert.equal(r.plan.computeUnits, MAX_TX_CU, "the plan that is sent carries the boosted limit");
    assert.deepEqual(calls.map((p) => p.computeUnits), [calls[0].computeUnits, MAX_TX_CU]);
  });

  it("a refresh that runs out even at the max is still pruned (bounded, no loop)", async () => {
    const calls: CrankPlan[] = [];
    const sim = meteredSim((c) => (c.kind === "refresh" && !c.portfolio.equals(lp) ? 2_000_000 : 100_000), calls);
    const r = await resolveCrankPlan(build(), otcTargets(), sim, undefined, refreshPruneBudget(2));
    assert.equal(r.sim.err, null);
    assert.deepEqual(r.pruned.map((p) => p.pubkey.toBase58()), [trader.toBase58()]);
    assert.deepEqual(r.plan.cranks.map((c) => c.kind), ["accrue", "refresh"]);
    assert.ok(calls.length <= 3, `sims=${calls.length}`);
  });

  it("an accrual that runs out even at the max is returned for the revert path", async () => {
    const r = await resolveCrankPlan(build(), otcTargets(), meteredSim((c) => (c.kind === "accrue" ? 2_000_000 : 1)));
    assert.deepEqual(r.sim.err, { InstructionError: [1, "ProgramFailedToComplete"] });
    assert.equal(r.plan.computeUnits, MAX_TX_CU);
    assert.equal(r.pruned.length, 0);
  });

  it("Custom(22) refreshes are still pruned exactly as before (no boost for engine verdicts)", async () => {
    const calls: CrankPlan[] = [];
    const r = await resolveCrankPlan(build(), otcTargets(), async (plan) => {
      calls.push(plan);
      const i = plan.cranks.findIndex((c) => c.kind === "refresh");
      return i >= 0 ? { err: { InstructionError: [i + 1, { Custom: 22 }] }, logs: [], marketData: null } : { err: null, logs: [], marketData: null };
    }, undefined, refreshPruneBudget(2));
    assert.equal(r.sim.err, null);
    assert.deepEqual(r.plan.cranks.map((c) => c.kind), ["accrue"]);
    assert.ok(calls.every((p) => p.computeUnits < MAX_TX_CU), "never boosted");
    assert.equal(calls.length, 3);
  });

  it("capacity: 7 refreshes fit beside the accrual at 145k each, headroom reserved; the 8th overflows", () => {
    const seven: PositionedPortfolio[] = Array.from({ length: 7 }, () => ({ pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false }));
    const plan = build()(seven);
    assert.equal(plan.overflow.length, 0);
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 7);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
    const eight = [...seven, { pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false }];
    const p8 = build()(eight);
    assert.equal(p8.overflow.length, 1, "the 8th goes to a follow-up tx rather than eating the headroom");
    assert.ok(ACCRUAL_TX_CU_HEADROOM > 0);
  });
});

/**
 * Earn-drain fix E1 (wrapper #523 / engine #275, #175 source reclassification):
 * a refresh that fully nets a leg's loss now also books the netted support into
 * the loss domain. Measured on the live swordcat replay: crank max +10.9k CU.
 * Worst refresh = OTC trader 153k (positioned-refresh.ts notes) + 11k; worst
 * accrual = Jimothy 162.6k. The planner must cover a full pack of these without
 * a boost (a boost costs an extra simulation; at the 1.4M cap a worse cycle
 * would prune a refresh and leave the market loss-stale).
 */
const E1_ACCRUE_WORST = 163_000;
const E1_REFRESH_WORST = 153_000 + 11_000;
const E1_LIQUIDATE = 200_000;
const many = (n: number): PositionedPortfolio[] =>
  Array.from({ length: n }, () => ({ pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false }));
const e1Cost = (c: PlannedCrank): number =>
  c.kind === "accrue" ? E1_ACCRUE_WORST : c.kind === "refresh" ? E1_REFRESH_WORST : c.kind === "catchup" ? 27_500 : E1_LIQUIDATE;

describe("REFRESH_CRANK_CU after the E1 Earn-drain fix (+11k per fully-netted refresh)", () => {
  it("is 145k: 7 refreshes per accrual tx and per follow-up tx", () => {
    assert.equal(REFRESH_CRANK_CU, 145_000);
    assert.equal(Math.floor((MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM - ACCRUE_CRANK_CU) / REFRESH_CRANK_CU), 7);
    assert.equal(REFRESHES_PER_OVERFLOW_TX, 7);
  });

  it("every plan size 1..7 carries a limit that covers the E1 worst case (accrual + n worst refreshes)", () => {
    for (let n = 1; n <= 7; n++) {
      const plan = build()(many(n));
      assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, n);
      assert.ok(
        plan.computeUnits >= E1_ACCRUE_WORST + n * E1_REFRESH_WORST + CB_IX_CU,
        `n=${n}: limit ${plan.computeUnits} < worst ${E1_ACCRUE_WORST + n * E1_REFRESH_WORST + CB_IX_CU}`,
      );
      assert.ok(plan.computeUnits <= MAX_TX_CU);
    }
  });

  it("a full pack at E1 worst costs lands on the FIRST simulation: no boost, nothing pruned", async () => {
    const calls: CrankPlan[] = [];
    const targets = many(9);
    const r = await resolveCrankPlan(build(), targets, meteredSim(e1Cost, calls), undefined, refreshPruneBudget(targets.length));
    assert.equal(r.sim.err, null, `reverted: ${JSON.stringify(r.sim.err)}`);
    assert.equal(r.plan.cranks.filter((c) => c.kind === "refresh").length, 7);
    assert.equal(r.plan.overflow.length, 2, "the rest go to a follow-up tx");
    assert.equal(r.pruned.length, 0);
    assert.equal(calls.length, 1, "fits the planned budget without a boost");
    assert.ok(r.plan.computeUnits < MAX_TX_CU);
  });

  it("the old 130k x 8 packing could not hold the E1 worst case even at the 1.4M re-sim", () => {
    const oldPacked = Math.floor((MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM - ACCRUE_CRANK_CU) / 130_000);
    assert.equal(oldPacked, 8);
    assert.ok(E1_ACCRUE_WORST + oldPacked * E1_REFRESH_WORST + CB_IX_CU > MAX_TX_CU);
    assert.ok(E1_ACCRUE_WORST + 7 * E1_REFRESH_WORST + CB_IX_CU <= ACCRUE_CRANK_CU + 7 * REFRESH_CRANK_CU + ACCRUAL_TX_CU_HEADROOM);
  });

  it("a full follow-up chunk at E1 worst costs plus one liquidation fits its own limit", async () => {
    for (const c of chunkOverflowTargets(many(15))) {
      const plan = planRefreshTx({ owner, market, targets: c, liquidateTargets: [c[0].pubkey] });
      assert.equal(plan.cranks.filter((k) => k.kind === "liquidate").length, 1);
      assert.ok(plan.computeUnits <= MAX_TX_CU);
      const sim = await meteredSim(e1Cost)(plan);
      assert.equal(sim.err, null, `chunk of ${c.length}: ${JSON.stringify(sim.err)}`);
    }
    assert.ok(REFRESHES_PER_OVERFLOW_TX * E1_REFRESH_WORST + E1_LIQUIDATE + CB_IX_CU <= MAX_TX_CU);
    assert.ok(LIQUIDATE_CRANK_CU >= E1_LIQUIDATE);
  });
});

describe("isComputeExhaustion", () => {
  it("meter exhaustion and ComputationalBudgetExceeded: yes", () => {
    assert.equal(isComputeExhaustion({ InstructionError: [1, "ProgramFailedToComplete"] }, ["Program W failed: exceeded CUs meter at BPF instruction"]), true);
    assert.equal(isComputeExhaustion({ InstructionError: [3, "ComputationalBudgetExceeded"] }, []), true);
    assert.equal(isComputeExhaustion({ InstructionError: [1, "ProgramFailedToComplete"] }, null), true);
  });
  it("engine verdicts, panics with logs, and non-instruction errors: no", () => {
    assert.equal(isComputeExhaustion({ InstructionError: [1, { Custom: 22 }] }, []), false);
    assert.equal(isComputeExhaustion({ InstructionError: [1, "ProgramFailedToComplete"] }, ["Program log: panicked at src/v16.rs:1:1"]), false);
    assert.equal(isComputeExhaustion("BlockhashNotFound", []), false);
    assert.equal(isComputeExhaustion(null, []), false);
  });
});
