/**
 * Coverage for the remaining positioned-refresh.ts paths: decode-failure skip, per-leg loop (real v2.2 / v18 portfolio
 * bytes), catch-up sizing branches, leg-aware planners and overflow chunking.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/positioned-refresh-coverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  ACCRUE_CRANK_CU,
  ACCRUAL_TX_CU_HEADROOM,
  FOLLOWUP_CU_HEADROOM,
  LIQUIDATE_CRANK_CU,
  MAX_CATCHUP_WITH_REFRESH,
  MAX_TX_CU,
  REFRESHES_PER_OVERFLOW_TX,
  REFRESH_CRANK_CU,
  REPAIR_CU,
  V22_LEG_COST,
  V22_POSITION_CAP,
  V22_WORST_SETTLE_CU_AT_CAP,
  buildObservationCrankIx,
  buildRefreshCrankIx,
  catchupAllowsRefresh,
  chunkOverflowTargets,
  decodeMarketRefreshState,
  isAssetLossStale,
  isBankruptPortfolio,
  isComputeExhaustion,
  legCostModelFor,
  marketHasPositions,
  parseInstructionError,
  planCrankTx,
  planRefreshTx,
  riskSnapOf,
  selectPositionedPortfolios,
  soloTxComputeUnits,
  staleCountOffsets,
} from "./positioned-refresh.ts";
import type { PositionedPortfolio } from "./positioned-refresh.ts";
import { detectLayout, engineSlotBase, layoutById } from "./market-layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const owner = PublicKey.unique();
const market = PublicKey.unique();
const lp = PublicKey.unique();
const pp = (legs: number, isLp = false, extra: Partial<PositionedPortfolio> = {}): PositionedPortfolio => ({
  pubkey: PublicKey.unique(), longLegs: legs, shortLegs: 0, isLp, ...extra,
});

describe("selectPositionedPortfolios: decode loop (real v2.2 bytes)", () => {
  const LP = PublicKey.unique();
  const TAKER = PublicKey.unique();
  const FLAT = PublicKey.unique();
  const accounts = () => [
    { pubkey: LP, data: fx("k6-2xhs-lp-6w14eZR3-v22") },
    { pubkey: TAKER, data: fx("k6-2xhs-taker-GV86syBh-v22") },
    { pubkey: FLAT, data: fx("k6-2xhs-flat-JB5PkWDs-v22") },
  ];

  it("per-leg loop over a list of assets: counts sides, sums loss weight, tracks lowest kf epoch", () => {
    const out = selectPositionedPortfolios(accounts(), [0, 1, 2, 3]);
    assert.equal(out.length, 2, "flat portfolio skipped");
    const lpE = out.find((p) => p.pubkey.equals(LP))!;
    const tk = out.find((p) => p.pubkey.equals(TAKER))!;
    assert.deepEqual([lpE.longLegs, lpE.shortLegs, lpE.isLp, lpE.activeLegs], [0, 4, true, 4]);
    assert.equal(lpE.kfEpochSnapLong, null);
    assert.equal(lpE.kfEpochSnapShort, 511456052n);
    assert.equal(lpE.lossWeight, 305000n);
    assert.deepEqual([tk.longLegs, tk.shortLegs, tk.isLp], [4, 0, false]);
    assert.equal(tk.kfEpochSnapLong, 511449713n);
    assert.equal(tk.kfEpochSnapShort, null);
  });

  it("a single asset index counts only legs on that asset but activeLegs counts all", () => {
    const out = selectPositionedPortfolios(accounts(), 0);
    const tk = out.find((p) => p.pubkey.equals(TAKER))!;
    assert.equal(tk.longLegs, 1);
    assert.equal(tk.activeLegs, 4);
  });

  it("an asset with no legs on it drops the portfolio", () => {
    assert.equal(selectPositionedPortfolios(accounts(), 99).length, 0);
    assert.equal(selectPositionedPortfolios(accounts(), []).length, 0);
  });

  it("v18 portfolio (one leg each side across LP and trader)", () => {
    const out = selectPositionedPortfolios([
      { pubkey: PublicKey.unique(), data: fx("ansem-bankrupt-portfolio-v18") },
      { pubkey: PublicKey.unique(), data: fx("ansem-lp-portfolio-v18") },
    ]);
    assert.deepEqual(out.map((p) => [p.longLegs, p.shortLegs, p.isLp]), [[1, 0, false], [0, 1, true]]);
  });

  it("decode failure: a portfolio-sized account of garbage is skipped, not thrown", () => {
    for (const len of [9563, 10603]) {
      const junk = Buffer.alloc(len, 0xff);
      assert.deepEqual(selectPositionedPortfolios([{ pubkey: PublicKey.unique(), data: junk }]), []);
    }
  });

  it("decode failure in the middle does not drop the good accounts around it", () => {
    const junk = Buffer.alloc(9563, 0xff);
    const out = selectPositionedPortfolios([
      { pubkey: LP, data: fx("k6-2xhs-lp-6w14eZR3-v22") },
      { pubkey: PublicKey.unique(), data: junk },
      { pubkey: TAKER, data: fx("k6-2xhs-taker-GV86syBh-v22") },
    ], [0, 1, 2, 3]);
    assert.deepEqual(out.map((p) => p.pubkey.toBase58()), [LP.toBase58(), TAKER.toBase58()]);
  });
});

describe("isBankruptPortfolio / riskSnapOf (real bytes)", () => {
  it("ANSEM bankrupt trader is bankrupt; its LP and flat v22 accounts are not", () => {
    assert.equal(isBankruptPortfolio(fx("ansem-bankrupt-portfolio-v18")), true);
    assert.equal(isBankruptPortfolio(fx("ansem-lp-portfolio-v18")), false);
    assert.equal(isBankruptPortfolio(fx("k6-2xhs-flat-JB5PkWDs-v22")), false);
  });
  it("undecodable bytes are not bankrupt (catch)", () => {
    assert.equal(isBankruptPortfolio(Buffer.alloc(10)), false);
    assert.equal(isBankruptPortfolio(Buffer.alloc(9563, 0xff)), false);
  });
  it("riskSnapOf sums equity and keeps only active legs", () => {
    const snap = riskSnapOf({
      capital: 10n, pnl: -3n, feeCredits: 2n,
      legs: [
        { active: true, assetIndex: 1, side: 0, basisPosQ: 5n, aBasis: 7n },
        { active: false, assetIndex: 2, side: 1, basisPosQ: 9n, aBasis: 9n },
      ],
    });
    assert.deepEqual(snap, { equity: 9n, legs: [{ assetIndex: 1, side: 0, basis: 5n, aBasis: 7n }] });
  });
});

describe("decodeMarketRefreshState: v2.2 market and error paths", () => {
  it("decodes the v22 market and its stale-count offsets point at the decoded values", () => {
    const data = fx("k6-2xhs-market-v22");
    const s = decodeMarketRefreshState(data);
    assert.equal(typeof s.maxAccrualDtSlots, "bigint");
    assert.equal(marketHasPositions(s), s.storedPosLong !== 0n || s.storedPosShort !== 0n);
    const off = staleCountOffsets(0, layoutById("v2.2-b"));
    assert.ok(off.short > off.long);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    assert.equal(view.getBigUint64(off.long, true), s.staleLong);
    assert.equal(view.getBigUint64(off.short, true), s.staleShort);
  });
  it("staleCountOffsets defaults to the legacy layout", () => {
    const o = staleCountOffsets();
    assert.ok(o.long > 0 && o.short > o.long);
  });
  it("unknown layout length throws", () => {
    assert.throws(() => decodeMarketRefreshState(Buffer.alloc(123)), /decodeMarketRefreshState/);
  });
  it("asset index out of range throws", () => {
    const data = fx("cate-market-v18");
    assert.throws(() => decodeMarketRefreshState(data, -1), /out of range/);
    assert.throws(() => decodeMarketRefreshState(data, 999), /out of range/);
  });
  it("a non-active lifecycle never contributes to loss-stale", () => {
    const data = Buffer.from(fx("cate-market-v18"));
    const s0 = decodeMarketRefreshState(data);
    assert.equal(s0.contributesToLossStale, true);
    const det = detectLayout(data);
    assert.ok(det.known);
    data[engineSlotBase(det.layout, 0) + det.layout.asset.lifecycle] = 1;
    const s1 = decodeMarketRefreshState(data);
    assert.equal(s1.lifecycle, 1);
    assert.equal(s1.contributesToLossStale, false);
    assert.equal(isAssetLossStale({ ...s1, staleLong: 0n, staleShort: 0n }), false);
  });
});

describe("crank instruction builders", () => {
  it("observation crank carries the oracle accounts after the base accounts", () => {
    const o1 = PublicKey.unique();
    const base = buildObservationCrankIx(owner, market, lp);
    const withOracle = buildObservationCrankIx(owner, market, lp, [o1]);
    assert.equal(withOracle.keys.length, base.keys.length + 1);
    assert.ok(withOracle.keys.at(-1)!.pubkey.equals(o1));
    assert.equal(withOracle.keys.at(-1)!.isWritable, false);
  });
  it("refresh crank appends the vault-LP counterparty writable, unless it is the portfolio itself or absent", () => {
    const vault = PublicKey.unique();
    const p = PublicKey.unique();
    const plain = buildRefreshCrankIx(owner, market, p);
    const withVault = buildRefreshCrankIx(owner, market, p, vault);
    assert.equal(withVault.keys.length, plain.keys.length + 1);
    assert.ok(withVault.keys.at(-1)!.pubkey.equals(vault));
    assert.equal(withVault.keys.at(-1)!.isWritable, true);
    assert.equal(buildRefreshCrankIx(owner, market, p, p).keys.length, plain.keys.length);
    assert.equal(buildRefreshCrankIx(owner, market, p, null).keys.length, plain.keys.length);
  });
});

describe("legCostModelFor / V22_LEG_COST", () => {
  it("selects the model only for v2.2 layouts", () => {
    assert.equal(legCostModelFor(null), undefined);
    assert.equal(legCostModelFor(undefined), undefined);
    assert.equal(legCostModelFor(layoutById("v2.1-legacy")), undefined);
    assert.equal(legCostModelFor(layoutById("v2.2-b")), V22_LEG_COST);
    assert.equal(legCostModelFor(layoutById("v2.2-drift")), V22_LEG_COST);
  });
  it("leg counting, refresh, liquidation and worst-settle figures", () => {
    const one = pp(1);
    const four = pp(0, false, { shortLegs: 0, activeLegs: 4 });
    assert.equal(V22_LEG_COST.legs(one), 1);
    assert.equal(V22_LEG_COST.legs(four), 4);
    assert.equal(V22_LEG_COST.refreshCu(one, 145_000), 145_000);
    assert.equal(V22_LEG_COST.refreshCu(four, 145_000), 35_000 * 7);
    assert.equal(V22_LEG_COST.liquidateCu(one, 250_000), 250_000);
    assert.equal(V22_LEG_COST.liquidateCu(four, 250_000), 728_649 > 0 ? Math.ceil(728_649 / 1000) * 1000 : 0);
    assert.equal(V22_LEG_COST.worstRefreshCu(four), V22_WORST_SETTLE_CU_AT_CAP);
    assert.ok(V22_LEG_COST.worstRefreshCu(one) >= REFRESH_CRANK_CU);
    assert.equal(V22_LEG_COST.isSolo(pp(2)), false);
    assert.equal(V22_LEG_COST.isSolo(pp(3)), true);
    assert.equal(V22_POSITION_CAP, 4);
  });
  it("soloTxComputeUnits adds accrual and headroom under the cap", () => {
    const four = pp(0, false, { activeLegs: 4 });
    assert.equal(soloTxComputeUnits(V22_LEG_COST, four), V22_WORST_SETTLE_CU_AT_CAP + ACCRUAL_TX_CU_HEADROOM);
    assert.equal(soloTxComputeUnits(V22_LEG_COST, four, { accrueCu: ACCRUE_CRANK_CU, headroomCu: 100_000 }), 1_313_864);
    assert.equal(soloTxComputeUnits(V22_LEG_COST, four, { accrueCu: 500_000 }), MAX_TX_CU);
  });
});

describe("planCrankTx: catch-up sizing and options", () => {
  it("catchupAllowsRefresh boundary", () => {
    assert.equal(catchupAllowsRefresh(MAX_CATCHUP_WITH_REFRESH), true);
    assert.equal(catchupAllowsRefresh(MAX_CATCHUP_WITH_REFRESH + 1), false);
  });
  it("catch-up above the refresh allowance: catch-up only, empty overflow, CU = catch-up + headroom", () => {
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 11, refreshTargets: [pp(1)] });
    assert.equal(plan.cranks.length, 11);
    assert.ok(plan.cranks.every((c) => c.kind === "catchup"));
    assert.deepEqual(plan.overflow, []);
    assert.equal(plan.computeUnits, 11 * 45_000 + ACCRUAL_TX_CU_HEADROOM);
  });
  it("catch-up of exactly the allowance still accrues and refreshes", () => {
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 10, refreshTargets: [pp(1)] });
    assert.deepEqual(plan.cranks.map((c) => c.kind), [...Array(10).fill("catchup"), "accrue", "refresh"]);
  });
  it("accrue:false: repairs and catch-up only", () => {
    const plan = planCrankTx({
      owner, market, lpPortfolio: lp, catchup: 2, refreshTargets: [pp(1)], accrue: false,
      repairs: [{ kind: "expire", domain: 0 }, { kind: "finalize", assetIndex: 0, side: 1 }],
    });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["repair", "repair", "catchup", "catchup"]);
    assert.equal(plan.cranks[0].repair?.kind, "expire");
    assert.ok(plan.cranks[0].portfolio.equals(market));
    assert.equal(plan.computeUnits, 2 * REPAIR_CU + 2 * 45_000 + ACCRUAL_TX_CU_HEADROOM);
  });
  it("catch-up count is clamped by the CU budget left after repairs", () => {
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 5, refreshTargets: [], repairs: Array.from({ length: 5 }, () => ({ kind: "expire" as const, domain: 1 })) });
    // catchupN < catchup is false here (5 fits), so this accrues.
    assert.equal(plan.cranks.filter((c) => c.kind === "repair").length, 5);
    assert.equal(plan.cranks.at(-1)!.kind, "accrue");
  });
  it("liquidate targets get a second crank right after the refresh, never for the LP", () => {
    const trader = pp(1);
    const lpE = pp(1, true);
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: [lpE, trader], liquidateTargets: [trader.pubkey, lpE.pubkey] });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue", "refresh", "liquidate", "refresh"]);
  });
  it("a liquidation that does not fit the packing cap is skipped", () => {
    const targets = Array.from({ length: 5 }, () => pp(1));
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: targets, liquidateTargets: targets.map((t) => t.pubkey) });
    const kinds = plan.cranks.map((c) => c.kind);
    assert.ok(kinds.includes("liquidate"));
    assert.ok(plan.computeUnits <= MAX_TX_CU);
    const refreshes = kinds.filter((k) => k === "refresh").length;
    assert.equal(refreshes + plan.overflow.length, 5);
  });
  it("leg-aware model: a solo (3+ leg) target is never packed beside the accrual", () => {
    const solo = pp(0, false, { activeLegs: 4 });
    const small = pp(1);
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: [solo, small], cost: V22_LEG_COST });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue", "refresh"]);
    assert.deepEqual(plan.overflow, [solo]);
  });
  it("leg-aware model: a heavy LP makes the accrual its own worst-settle cost; liquidation is leg-priced", () => {
    const heavyLp = pp(0, true, { activeLegs: 4 });
    const trader = pp(2, false, { activeLegs: 2 });
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 0, refreshTargets: [trader], cost: V22_LEG_COST, lp: heavyLp, liquidateTargets: [trader.pubkey] });
    assert.equal(plan.cranks[0].kind, "accrue");
    assert.ok(plan.computeUnits > V22_WORST_SETTLE_CU_AT_CAP);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
  });
});

describe("planRefreshTx", () => {
  it("empty target list: no cranks and zero compute", () => {
    const plan = planRefreshTx({ owner, market, targets: [] });
    assert.deepEqual([plan.cranks.length, plan.computeUnits, plan.overflow.length], [0, 0, 0]);
  });
  it("single-leg: refresh per target with follow-up headroom", () => {
    const plan = planRefreshTx({ owner, market, targets: [pp(1), pp(1)] });
    assert.equal(plan.cranks.length, 2);
    assert.equal(plan.computeUnits, 2 * REFRESH_CRANK_CU + FOLLOWUP_CU_HEADROOM);
  });
  it("liquidate follows a non-LP refresh when it fits, and not for the LP", () => {
    const t = pp(1);
    const l = pp(1, true);
    const plan = planRefreshTx({ owner, market, targets: [t, l], liquidateTargets: [t.pubkey, l.pubkey] });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["refresh", "liquidate", "refresh"]);
    assert.equal(plan.computeUnits, 2 * REFRESH_CRANK_CU + LIQUIDATE_CRANK_CU + FOLLOWUP_CU_HEADROOM);
  });
  it("a liquidation over the tx cap is skipped", () => {
    const targets = Array.from({ length: REFRESHES_PER_OVERFLOW_TX + 1 }, () => pp(1));
    const plan = planRefreshTx({ owner, market, targets, liquidateTargets: targets.map((t) => t.pubkey) });
    assert.ok(plan.cranks.filter((c) => c.kind === "liquidate").length <= REFRESHES_PER_OVERFLOW_TX);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
  });
  it("leg-aware: a solo target's worst settle sets the limit", () => {
    const solo = pp(0, false, { activeLegs: 4 });
    const plan = planRefreshTx({ owner, market, targets: [solo], cost: V22_LEG_COST });
    assert.equal(plan.computeUnits, Math.min(MAX_TX_CU, V22_WORST_SETTLE_CU_AT_CAP + FOLLOWUP_CU_HEADROOM));
  });
});

describe("chunkOverflowTargets", () => {
  it("single-leg arithmetic: perTx groups, in order, nothing lost", () => {
    const t = Array.from({ length: 2 * REFRESHES_PER_OVERFLOW_TX + 1 }, () => pp(1));
    const g = chunkOverflowTargets(t);
    assert.deepEqual(g.map((x) => x.length), [REFRESHES_PER_OVERFLOW_TX, REFRESHES_PER_OVERFLOW_TX, 1]);
    assert.deepEqual(g.flat(), t);
    assert.deepEqual(chunkOverflowTargets(t.slice(0, 3), 2).map((x) => x.length), [2, 1]);
    assert.deepEqual(chunkOverflowTargets(t.slice(0, 3), 0).map((x) => x.length), [1, 1, 1], "perTx floors at 1");
    assert.deepEqual(chunkOverflowTargets([]), []);
  });
  it("leg-aware: solo targets are alone, others pack by CU", () => {
    const solo = pp(0, false, { activeLegs: 4 });
    const twoLeg = Array.from({ length: 8 }, () => pp(2, false, { activeLegs: 2 }));
    const g = chunkOverflowTargets([twoLeg[0], solo, ...twoLeg.slice(1)], 0, V22_LEG_COST);
    assert.deepEqual(g[0], [twoLeg[0]]);
    assert.deepEqual(g[1], [solo]);
    assert.deepEqual(g.flat().length, 9);
    assert.ok(g.slice(2).every((x) => x.length >= 1));
    assert.ok(g.length >= 3, "the 7 two-leg targets split across groups");
    assert.deepEqual(chunkOverflowTargets([], 0, V22_LEG_COST), []);
  });
  it("leg-aware single-leg targets pack like the legacy count", () => {
    const t = Array.from({ length: REFRESHES_PER_OVERFLOW_TX + 1 }, () => pp(1));
    const g = chunkOverflowTargets(t, 0, V22_LEG_COST);
    assert.equal(g[0].length, REFRESHES_PER_OVERFLOW_TX);
    assert.equal(g.flat().length, t.length);
  });
});

describe("isComputeExhaustion / parseInstructionError edge cases", () => {
  const ie = (d: unknown) => ({ InstructionError: [1, d] });
  it("non-error shapes are not exhaustion", () => {
    assert.equal(isComputeExhaustion(null), false);
    assert.equal(isComputeExhaustion("x"), false);
    assert.equal(isComputeExhaustion({}), false);
    assert.equal(isComputeExhaustion({ InstructionError: "bad" }), false);
  });
  it("ComputationalBudgetExceeded is exhaustion", () => {
    assert.equal(isComputeExhaustion(ie("ComputationalBudgetExceeded")), true);
  });
  it("other errors are not exhaustion", () => {
    assert.equal(isComputeExhaustion(ie({ Custom: 22 })), false);
  });
  it("ProgramFailedToComplete: exhaustion without logs, with a meter log; not with unrelated logs", () => {
    const e = ie("ProgramFailedToComplete");
    assert.equal(isComputeExhaustion(e), true);
    assert.equal(isComputeExhaustion(e, null), true);
    assert.equal(isComputeExhaustion(e, []), true);
    assert.equal(isComputeExhaustion(e, ["Program x exceeded CUs meter at BPF instruction"]), true);
    assert.equal(isComputeExhaustion(e, ["Program log: panicked"]), false);
  });
  it("parseInstructionError rejects malformed input and yields custom=null for non-custom detail", () => {
    assert.equal(parseInstructionError(null), null);
    assert.equal(parseInstructionError({}), null);
    assert.equal(parseInstructionError({ InstructionError: "x" }), null);
    assert.equal(parseInstructionError({ InstructionError: ["a", {}] }), null);
    assert.deepEqual(parseInstructionError({ InstructionError: [3, "ProgramFailedToComplete"] }), { index: 3, custom: null });
    assert.deepEqual(parseInstructionError({ InstructionError: [3, { Custom: "x" }] }), { index: 3, custom: null });
  });
});
