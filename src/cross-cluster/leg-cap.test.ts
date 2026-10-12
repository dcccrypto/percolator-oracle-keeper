/**
 * v2.2 position cap 4: leg-aware sizing of every planner (positioned-refresh.ts), the settle-pairing weights, the
 * single-instruction jobs' limits, and the layout / tag guards for the release candidate (engine bfa3d037, wrapper c6ee0b6e).
 *
 * Numbers in the assertions are the RC's own (ledger v22-combination-2026-10-08.md, cu-per-tag-fold-final.txt,
 * layout-v22.json), typed here as LITERALS on purpose so a change to the model's constants cannot pass by moving both sides.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  G9_FEED_ALLOWLIST_CAP_V22,
  IX_TAG_V22,
  LAYOUT_V22,
  LAYOUT_V21,
  WRAPPER_BATCH_MAX_LEGS,
  decodeG9FeedAllowlistV22,
} from "@percolatorct/sdk";
import {
  LIQUIDATE_CRANK_CU,
  MAX_TX_CU,
  REFRESH_CRANK_CU,
  REFRESHES_PER_OVERFLOW_TX,
  V22_LEG_COST,
  V22_POSITION_CAP,
  V22_SOLO_MIN_LEGS,
  chunkOverflowTargets,
  legCostModelFor,
  planCrankTx,
  planRefreshTx,
  selectPositionedPortfolios,
  soloTxComputeUnits,
} from "./positioned-refresh.ts";
import type { PositionedPortfolio } from "./positioned-refresh.ts";
import { DEFAULT_SWEEP_CONFIG, planSweepTx } from "./positioned-sweep.ts";
import { layoutById, marketAccountLen, detectLayout } from "./market-layout.ts";
import { SOLO_WEIGHT, legAwareTxUnits, planSettleRound, portfolioWeight } from "./v22/settle-pairing.ts";
import { analysePortfolios } from "./v22/positioned.ts";
import { execCtx, fakeExecConn, key, portfolioBytes, v22Ctx, v22MarketBytes } from "./v22/test-helpers.ts";
import { runSettleRound, DEFAULT_SWEEP_ROUND_CONFIG, resetPairingStats } from "./v22/sweep.ts";
import { freshRentState, settleRentOnce } from "./v22/rent.ts";
import { freshDustState, sweepDustOnce } from "./v22/dust.ts";
import { buildSettleHoldingRentIxV22 } from "@percolatorct/sdk";
import type { V22Positioned } from "./v22/positioned.ts";
import { refreshOverflow } from "./recovery-cranker.ts";

const OWNER = key(1);
const MARKET = key(2);
const LP = key(3);
const pfL = (n: number, legs: number, o: { lp?: boolean; activeLegs?: number } = {}): PositionedPortfolio => ({
  pubkey: key(100 + n),
  longLegs: legs,
  shortLegs: 0,
  isLp: o.lp === true,
  ...(o.activeLegs !== undefined ? { activeLegs: o.activeLegs } : {}),
  lossWeight: BigInt(n),
});
const snap = (p: { cranks: Array<{ kind: string; portfolio: PublicKey; ix: { data: Buffer; keys: unknown[] } }>; overflow: PositionedPortfolio[]; computeUnits: number }) => ({
  cranks: p.cranks.map((c) => [c.kind, c.portfolio.toBase58(), Buffer.from(c.ix.data).toString("hex"), c.ix.keys.length]),
  overflow: p.overflow.map((o) => o.pubkey.toBase58()),
  computeUnits: p.computeUnits,
});

describe("the model's numbers are the RC's measurements", () => {
  it("cap 4, solo from 3 legs; the SDK's batch cap = min(11, cap) pins the cap", () => {
    assert.equal(V22_POSITION_CAP, 4);
    assert.equal(WRAPPER_BATCH_MAX_LEGS, Math.min(11, V22_POSITION_CAP), "SDK WRAPPER_BATCH_MAX_LEGS moved: the position cap moved with it");
    assert.equal(V22_SOLO_MIN_LEGS, 3);
  });

  it("typical refresh 145k / 175k / 210k / 245k for 1..4 legs (3 + legs, 35k each; 1 leg keeps the v2.1 figure)", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => V22_LEG_COST.refreshCu(pfL(1, n), REFRESH_CRANK_CU)), [145_000, 175_000, 210_000, 245_000]);
    // the sweep's own single-leg base (114k) is kept for one leg, raised only by the leg count
    assert.deepEqual([1, 2, 4].map((n) => V22_LEG_COST.refreshCu(pfL(1, n), 114_000)), [114_000, 175_000, 245_000]);
  });

  it("worst settle at the cap is the measured 1,013,864 (liens + ADL + the real #287 hook); 5 and 6 legs clamp under 1.4M only by the planner, not here", () => {
    assert.equal(V22_LEG_COST.worstRefreshCu(pfL(1, 4)), 1_013_864);
    assert.equal(V22_LEG_COST.worstRefreshCu(pfL(1, 3)), 1_013_864 - 176_000);
    assert.ok(V22_LEG_COST.worstRefreshCu(pfL(1, 1)) >= V22_LEG_COST.refreshCu(pfL(1, 1), REFRESH_CRANK_CU));
    assert.ok(V22_LEG_COST.worstRefreshCu(pfL(1, 4)) < 1_260_000, "the 10% headroom line of the RC's gate");
  });

  it("liquidation crank: 250k at one leg (unchanged), the measured worst 728,649 (rounded up to 729k) at the cap, monotone between", () => {
    const l = [1, 2, 3, 4].map((n) => V22_LEG_COST.liquidateCu(pfL(1, n), LIQUIDATE_CRANK_CU));
    assert.equal(l[0], 250_000);
    assert.equal(l[3], 729_000);
    assert.ok(l[3] >= 728_649);
    assert.ok(l[0] < l[1] && l[1] < l[2] && l[2] < l[3]);
  });

  it("a 4-leg refresh AND its liquidation fit one transaction typically (245k + 729k = 974k), the worst refresh alone does not leave room for it", () => {
    const p = pfL(1, 4);
    assert.ok(V22_LEG_COST.refreshCu(p, REFRESH_CRANK_CU) + V22_LEG_COST.liquidateCu(p, LIQUIDATE_CRANK_CU) <= MAX_TX_CU);
    assert.ok(V22_LEG_COST.worstRefreshCu(p) + V22_LEG_COST.liquidateCu(p, LIQUIDATE_CRANK_CU) > MAX_TX_CU);
  });

  it("legs are ALL active legs of the account, never fewer than the legs on the asset", () => {
    assert.equal(V22_LEG_COST.legs({ longLegs: 1, shortLegs: 0, activeLegs: 4 }), 4);
    assert.equal(V22_LEG_COST.legs({ longLegs: 2, shortLegs: 1 }), 3, "hand-built entries without activeLegs use the on-asset count");
    assert.equal(V22_LEG_COST.legs({ longLegs: 3, shortLegs: 0, activeLegs: 1 }), 3);
  });
});

describe("the layout selects the model: v2.1 and unknown layouts get none", () => {
  it("v2.2 rows yes; v2.1-legacy, v2.1-drift, null, undefined no", () => {
    assert.equal(legCostModelFor(layoutById("v2.2-b")), V22_LEG_COST);
    assert.equal(legCostModelFor(layoutById("v2.2-drift")), V22_LEG_COST);
    assert.equal(legCostModelFor(layoutById("v2.1-legacy")), undefined);
    assert.equal(legCostModelFor(layoutById("v2.1-drift")), undefined);
    assert.equal(legCostModelFor(null), undefined);
    assert.equal(legCostModelFor(undefined), undefined);
  });
});

describe("planCrankTx / planRefreshTx / chunkOverflowTargets", () => {
  const base = { owner: OWNER, market: MARKET, lpPortfolio: LP, catchup: 0 };

  it("PARITY: without a model a 4-leg target is sized as one leg (the v2.1 arithmetic); with a model single-leg plans are identical to it", () => {
    const four = [pfL(1, 4, { activeLegs: 4 })];
    const old = planCrankTx({ ...base, refreshTargets: four });
    assert.equal(old.overflow.length, 0, "no model: legacy sizing packs it beside the accrual");
    assert.equal(old.computeUnits, 200_000 + 145_000 + 100_000);
    const singles = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => pfL(n, 1));
    assert.deepEqual(snap(planCrankTx({ ...base, refreshTargets: singles, cost: V22_LEG_COST })), snap(planCrankTx({ ...base, refreshTargets: singles })));
    assert.deepEqual(snap(planRefreshTx({ owner: OWNER, market: MARKET, targets: singles.slice(0, 7), liquidateTargets: [singles[2].pubkey], cost: V22_LEG_COST })), snap(planRefreshTx({ owner: OWNER, market: MARKET, targets: singles.slice(0, 7), liquidateTargets: [singles[2].pubkey] })));
    assert.deepEqual(chunkOverflowTargets(singles, undefined, V22_LEG_COST).map((g) => g.length), chunkOverflowTargets(singles).map((g) => g.length));
    assert.equal(chunkOverflowTargets(singles, undefined, V22_LEG_COST)[0].length, REFRESHES_PER_OVERFLOW_TX);
    assert.equal(REFRESHES_PER_OVERFLOW_TX, 7);
  });

  it("a 4-leg account is never packed beside the accrual: it goes to overflow; the single-leg accounts still pack (7 beside the accrual, as before)", () => {
    const targets = [pfL(1, 4, { activeLegs: 4 }), pfL(2, 1), pfL(3, 1)];
    const plan = planCrankTx({ ...base, refreshTargets: targets, cost: V22_LEG_COST });
    assert.deepEqual(plan.overflow.map((p) => p.pubkey.toBase58()), [targets[0].pubkey.toBase58()]);
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 2);
    assert.equal(plan.computeUnits, 200_000 + 2 * 145_000 + 100_000);
  });

  it("NEGATIVE CONTROL: the same 4-leg target WITHOUT the model is packed (this is the shape that would run out of compute at 1.01M)", () => {
    const plan = planCrankTx({ ...base, refreshTargets: [pfL(1, 4, { activeLegs: 4 }), pfL(2, 1)] });
    assert.equal(plan.overflow.length, 0);
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 2);
  });

  it("a 2-leg account packs by 175k; a mixed set fills to the cap by CU, not by count", () => {
    const targets = [...[1, 2, 3, 4, 5].map((n) => pfL(n, 2)), pfL(9, 1)];
    const plan = planCrankTx({ ...base, refreshTargets: targets, cost: V22_LEG_COST });
    // 200k accrue + 5 x 175k = 1,075k; + 145k = 1,220k <= pack cap 1,300k; all six fit
    assert.equal(plan.overflow.length, 0);
    assert.equal(plan.computeUnits, 200_000 + 5 * 175_000 + 145_000 + 100_000);
    const more = planCrankTx({ ...base, refreshTargets: [...targets, pfL(10, 2), pfL(11, 2)], cost: V22_LEG_COST });
    assert.ok(more.overflow.length >= 1);
    assert.ok(more.computeUnits <= MAX_TX_CU);
  });

  it("a heavy LP (3+ legs) makes the accrual itself the big crank: its worst settle is reserved, little else is packed beside it", () => {
    const lp = pfL(0, 4, { lp: true, activeLegs: 4 });
    const plan = planCrankTx({ ...base, refreshTargets: [pfL(1, 1), pfL(2, 1), pfL(3, 1)], cost: V22_LEG_COST, lp });
    // 1,013,864 accrue + 145k = 1,158,864; a second 145k (1,303,864) would pass the 1.3M pack cap
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 1);
    assert.equal(plan.overflow.length, 2);
    assert.equal(plan.computeUnits, 1_013_864 + 145_000 + 100_000);
    const lone = planCrankTx({ ...base, refreshTargets: [], cost: V22_LEG_COST, lp });
    assert.equal(lone.computeUnits, 1_013_864 + 100_000);
  });

  it("chunkOverflowTargets: a solo account is a group of its own, in order; the others pack by CU around it", () => {
    const a = pfL(1, 1), b = pfL(2, 1), solo = pfL(3, 4, { activeLegs: 4 }), c = pfL(4, 1), solo2 = pfL(5, 3, { activeLegs: 3 });
    const groups = chunkOverflowTargets([a, b, solo, c, solo2], undefined, V22_LEG_COST);
    assert.deepEqual(groups.map((g) => g.map((p) => p.pubkey.toBase58())), [[a, b], [solo], [c], [solo2]].map((g) => g.map((p) => p.pubkey.toBase58())));
    assert.equal(chunkOverflowTargets([], undefined, V22_LEG_COST).length, 0);
    // every target appears exactly once
    const flat = groups.flat().map((p) => p.pubkey.toBase58()).sort();
    assert.deepEqual(flat, [a, b, solo, c, solo2].map((p) => p.pubkey.toBase58()).sort());
  });

  it("chunkOverflowTargets: 2-leg accounts pack 5 per group (5 x 175k + a 410k liquidation <= 1.4M), 6 do not", () => {
    const g = chunkOverflowTargets([1, 2, 3, 4, 5, 6, 7].map((n) => pfL(n, 2)), undefined, V22_LEG_COST);
    assert.deepEqual(g.map((x) => x.length), [5, 2]);
  });

  it("planRefreshTx: the solo chunk's limit absorbs the WORST settle (+200k), refresh and the liquidation are both in when the typical sum fits", () => {
    const solo = pfL(1, 4, { activeLegs: 4 });
    const plan = planRefreshTx({ owner: OWNER, market: MARKET, targets: [solo], liquidateTargets: [solo.pubkey], cost: V22_LEG_COST });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["refresh", "liquidate"]);
    assert.equal(plan.computeUnits, 1_013_864 + 200_000);
    const noLiq = planRefreshTx({ owner: OWNER, market: MARKET, targets: [solo], cost: V22_LEG_COST });
    assert.equal(noLiq.computeUnits, 1_013_864 + 200_000);
    // without the model the same chunk would be limited at 145k + 200k
    assert.equal(planRefreshTx({ owner: OWNER, market: MARKET, targets: [solo] }).computeUnits, 145_000 + 200_000);
  });

  it("soloTxComputeUnits: 200k accrual + 1,013,864 + 100k headroom = 1,313,864 for a 4-leg account, never above 1.4M even at 6 legs", () => {
    assert.equal(soloTxComputeUnits(V22_LEG_COST, pfL(1, 4), { accrueCu: 200_000 }), 1_313_864);
    assert.equal(soloTxComputeUnits(V22_LEG_COST, pfL(1, 6), { accrueCu: 200_000 }), MAX_TX_CU);
  });
});

describe("planSweepTx (drift-layout sweep)", () => {
  const cfg = DEFAULT_SWEEP_CONFIG;
  const args = { owner: OWNER, market: MARKET, lpPortfolio: LP, cfg };

  it("PARITY: no model = the same plan as before (k single-leg refreshes, 114k each); a model changes nothing for single legs", () => {
    const t = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => pfL(n, 1));
    const old = planSweepTx({ ...args, targets: t });
    assert.deepEqual(snap({ ...old, overflow: old.deferred }), snap({ ...planSweepTx({ ...args, targets: t, cost: V22_LEG_COST }), overflow: planSweepTx({ ...args, targets: t, cost: V22_LEG_COST }).deferred }));
    assert.equal(old.cranks.filter((c) => c.kind === "refresh").length, 10);
  });

  it("a solo account in the batch is planned ALONE: [accrual, it], every other target deferred, limit = accrual + worst + headroom", () => {
    const solo = pfL(7, 4, { activeLegs: 4 });
    const t = [pfL(1, 1), pfL(2, 1), solo, pfL(3, 1)];
    const plan = planSweepTx({ ...args, targets: t, cost: V22_LEG_COST });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue", "refresh"]);
    assert.ok(plan.cranks[1].portfolio.equals(solo.pubkey));
    assert.equal(plan.deferred.length, 3);
    assert.equal(plan.computeUnits, 200_000 + 1_013_864 + cfg.headroomCu);
    assert.ok(plan.computeUnits <= MAX_TX_CU);
    // NEGATIVE CONTROL: without the model the 4-leg account is just one more 114k refresh in a 10-wide tx
    const old = planSweepTx({ ...args, targets: t });
    assert.equal(old.cranks.filter((c) => c.kind === "refresh").length, 4);
  });

  it("refresh-only follow-up (accrue false): the solo account alone, limit = worst + headroom; with its liquidation the typical sum is used", () => {
    const solo = pfL(7, 4, { activeLegs: 4 });
    const plan = planSweepTx({ ...args, targets: [solo], accrue: false, liquidateTargets: [solo.pubkey], cost: V22_LEG_COST });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["refresh", "liquidate"]);
    assert.equal(plan.computeUnits, 1_013_864 + cfg.headroomCu);
  });

  it("2-leg accounts: 175k each instead of 114k, so 6 (not 10) beside the accrual", () => {
    const t = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pfL(n, 2));
    const plan = planSweepTx({ ...args, targets: t, cost: V22_LEG_COST });
    assert.equal(plan.cranks.filter((c) => c.kind === "refresh").length, 6);
    assert.equal(plan.deferred.length, 2);
  });
});

describe("settle-pairing weights and rounds with 3+ leg accounts", () => {
  const cps = (n: number, legs = 1) => Array.from({ length: n }, (_, i) => pfL(i + 1, legs));

  it("weights: 3 + legs up to 2 legs, SOLO from 3; activeLegs (other assets) counts", () => {
    assert.deepEqual([1, 2].map((n) => portfolioWeight(pfL(1, n))), [4, 5]);
    assert.equal(portfolioWeight(pfL(1, 3)), SOLO_WEIGHT);
    assert.equal(portfolioWeight(pfL(1, 4)), SOLO_WEIGHT);
    assert.equal(portfolioWeight({ longLegs: 1, shortLegs: 0, activeLegs: 4 }), SOLO_WEIGHT, "one leg on this asset, four in the account");
    assert.equal(portfolioWeight({ longLegs: 1, shortLegs: 0 }), 4, "NEGATIVE CONTROL: without activeLegs the account looks like one leg");
  });

  it("a solo counterparty never shares a tx with another account: it rides alone behind its accrue crank (counterparty form)", () => {
    const solo = pfL(50, 4, { activeLegs: 4 });
    const plan = planSettleRound({ mode: "prefer", lp: LP, counterparties: [...cps(3), solo] });
    const holder = plan.txs.find((t) => t.accrueTarget?.equals(solo.pubkey) || t.refresh.some((r) => r.pubkey.equals(solo.pubkey)));
    assert.ok(holder, "the solo account is in a tx");
    assert.equal((holder!.accrue === "counterparty" ? 1 : 0) + holder!.refresh.filter((r) => !r.pubkey.equals(solo.pubkey)).length, holder!.accrue === "counterparty" ? 1 : 0, "no other refresh beside it");
    assert.equal(holder!.settlesLp, false);
    assert.equal(plan.paired, true);
    assert.equal(plan.unvisited.length, 0);
    assert.equal(plan.lpTxIndex, plan.txs.length - 1, "the LP stays last");
  });

  it("with a flat anchor: [anchor accrue, refresh solo] alone (the oversize rule needs a positive cap)", () => {
    const solo = pfL(50, 4, { activeLegs: 4 });
    const anchor = key(777);
    const plan = planSettleRound({ mode: "prefer", lp: LP, counterparties: [...cps(3), solo], anchor });
    const holder = plan.txs.find((t) => t.refresh.some((r) => r.pubkey.equals(solo.pubkey)))!;
    assert.equal(holder.accrue, "anchor");
    assert.equal(holder.refresh.length, 1);
    assert.equal(plan.unvisited.length, 0);
  });

  it("several solo accounts: one tx each; every counterparty is covered exactly once", () => {
    const s1 = pfL(50, 4, { activeLegs: 4 }), s2 = pfL(51, 3, { activeLegs: 3 });
    const c = [...cps(5), s1, s2];
    const plan = planSettleRound({ mode: "prefer", lp: LP, counterparties: c });
    const covered = [...plan.txs.flatMap((t) => (t.accrue === "counterparty" && t.accrueTarget ? [t.accrueTarget.toBase58()] : [])), ...plan.txs.flatMap((t) => t.refresh.map((r) => r.pubkey.toBase58()))];
    assert.deepEqual([...new Set(covered)].sort(), c.map((p) => p.pubkey.toBase58()).sort());
    assert.equal(covered.length, c.length, "no one twice");
    for (const s of [s1, s2]) {
      const t = plan.txs.find((x) => x.accrueTarget?.equals(s.pubkey) || x.refresh.some((r) => r.pubkey.equals(s.pubkey)))!;
      assert.ok(t.refresh.filter((r) => !r.pubkey.equals(s.pubkey)).length === 0);
    }
  });

  it("a SOLO LP: its tx carries no counterparty; they all go first", () => {
    const plan = planSettleRound({ mode: "prefer", lp: LP, lpWeight: portfolioWeight(pfL(0, 4, { activeLegs: 4 })), counterparties: cps(4) });
    const last = plan.txs[plan.txs.length - 1];
    assert.equal(last.settlesLp, true);
    assert.equal(last.refresh.length, 0);
    assert.equal(plan.unvisited.length, 0);
    assert.equal(plan.paired, true);
    assert.ok(plan.txs.length >= 2);
  });

  it("NEGATIVE CONTROL: the pre-cap weights (3 + legs for any leg count) would put a 4-leg account beside 3 others in one 32-weight tx", () => {
    const oldWeight = (p: { longLegs: number; shortLegs: number }) => 3 + p.longLegs + p.shortLegs;
    assert.ok(oldWeight(pfL(1, 4)) * 1 + oldWeight(pfL(2, 1)) * 3 <= 32);
  });
});

describe("single-instruction jobs (rent 106, dust 118) get a limit that fits a solo account's settle", () => {
  it("600k base for 1-2 legs; 1,213,864 for 4 legs; never above 1.4M", () => {
    assert.equal(legAwareTxUnits(pfL(1, 1), 600_000), 600_000);
    assert.equal(legAwareTxUnits(pfL(1, 2), 600_000), 600_000);
    assert.equal(legAwareTxUnits(pfL(1, 4), 600_000), 1_213_864);
    assert.equal(legAwareTxUnits(pfL(1, 6), 600_000), MAX_TX_CU);
  });
});

describe("activeLegs is read from the account (every asset), by both position scans", () => {
  const owner = key(9);
  const fourLegs = portfolioBytes({
    owner,
    legs: [
      { side: 0, basis: 1_000_000n, assetIndex: 0 },
      { side: 1, basis: 2_000_000n, assetIndex: 1 },
      { side: 0, basis: 3_000_000n, assetIndex: 2 },
      { side: 1, basis: 4_000_000n, assetIndex: 3 },
    ],
  });
  it("analysePortfolios (v2.2 loop): 1 leg on asset 0, 4 in the account", () => {
    const r = analysePortfolios([{ pubkey: key(10), data: fourLegs }], { lpPortfolio: null, portfolioLen: LAYOUT_V22.portfolio.accountLen });
    assert.equal(r.all.length, 1);
    assert.deepEqual([r.all[0].longLegs, r.all[0].shortLegs, r.all[0].activeLegs], [1, 0, 4]);
    assert.equal(portfolioWeight(r.all[0]), SOLO_WEIGHT);
    assert.equal(V22_LEG_COST.isSolo(r.all[0]), true);
  });
  it("selectPositionedPortfolios (legacy cranker): the same", () => {
    const r = selectPositionedPortfolios([{ pubkey: key(10), data: fourLegs }]);
    assert.deepEqual([r[0].longLegs, r[0].shortLegs, r[0].activeLegs], [1, 0, 4]);
  });
  it("a one-leg account has activeLegs 1 (not solo)", () => {
    const one = portfolioBytes({ owner, legs: [{ side: 0, basis: 1n }] });
    const r = analysePortfolios([{ pubkey: key(11), data: one }], { lpPortfolio: null, portfolioLen: LAYOUT_V22.portfolio.accountLen });
    assert.equal(r.all[0].activeLegs, 1);
    assert.equal(V22_LEG_COST.isSolo(r.all[0]), false);
  });
});

describe("layout 2,661 and the new accounts / tags, all through the SDK", () => {
  const B = layoutById("v2.2-b");
  it("market lengths by capacity are the RC's: 4,059 / 6,720 / 9,381 / 12,042 / 14,703 (literals from layout-v22.json), each detected as v2.2-b", () => {
    const expected = [4_059, 6_720, 9_381, 12_042, 14_703];
    expected.forEach((len, i) => {
      assert.equal(marketAccountLen(B, i + 1), len);
      const d = detectLayout(v22MarketBytes({ slots: i + 1 }));
      assert.ok(d.known && d.layout.id === "v2.2-b", `${len} B`);
    });
  });
  it("the slot length is the SDK's: row = LAYOUT_V22 = 2,661; v2.1 stays 2,325", () => {
    assert.equal(B.slotStride, 2_661);
    assert.equal(LAYOUT_V22.assetSlotStride, 2_661);
    assert.equal(LAYOUT_V21.assetSlotStride, 2_325);
    assert.equal(LAYOUT_V22.engineSlotLen, 1_637);
  });
  it("no non-test source file types the slot length as a literal in code (comments excepted)", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*.*$/, "");
            if (/\b(2_?661|2_?629|1_?637)\b/.test(code)) hits.push(`${p}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });
  it("G9 allowlist: 2,064 B body (2,080 B account) is the SDK's; its decoder reads a record built to that layout; the keeper has no reader of its own", () => {
    assert.equal(LAYOUT_V22.accounts.g9FeedAllowlistBody, 2_064);
    assert.equal(LAYOUT_V22.accounts.headerLen + LAYOUT_V22.accounts.g9FeedAllowlistBody, 2_080);
    assert.equal(G9_FEED_ALLOWLIST_CAP_V22, 16);
    const b = Buffer.alloc(2_080);
    b.writeBigUInt64LE(5_784_119_745_589_622_272n, 0);
    b.writeUInt16LE(19, 8);
    b[10] = 15; // ACCOUNT_KIND.G9FeedAllowlist
    const feed = key(40), owner = key(41);
    b[16] = 1; // count
    b[17] = 1; // version
    Buffer.from(feed.toBytes()).copy(b, 16 + 16);
    Buffer.from(owner.toBytes()).copy(b, 16 + 16 + 16 * 32);
    const a = decodeG9FeedAllowlistV22(new Uint8Array(b));
    assert.equal(a.count, 1);
    assert.ok(a.keys[0].equals(feed) && a.owners[0].equals(owner));
    assert.throws(() => decodeG9FeedAllowlistV22(new Uint8Array(2_079)));
  });
  it("tags 120 / 121 / 122 are governance / metadata: the keeper sends none of 74, 120, 121, 122 (a new send site must add the 7th account / handle the timelock first)", () => {
    assert.deepEqual([IX_TAG_V22.ProposeG9FeedAllowlist, IX_TAG_V22.CommitG9FeedAllowlist, IX_TAG_V22.InitLpShareMetadata], [120, 121, 122]);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          const src = readFileSync(p, "utf8");
          for (const name of ["buildCreateLpVault", "encodeCreateLpVault", "ProposeG9FeedAllowlist", "CommitG9FeedAllowlist", "InitLpShareMetadata", "IX_TAG.CreateLpVault"]) {
            if (src.split("\n").some((l) => l.includes(name) && !/^\s*(\/\/|\*|\/\*)/.test(l))) hits.push(`${p}: ${name}`);
          }
        }
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });
});

describe("the jobs that send one instruction request the leg-aware limit (through the real call sites)", () => {
  const positionedOf = (cps: PositionedPortfolio[]): V22Positioned => ({ all: cps, counterparties: cps, lp: null, minLegAbs: new Map(cps.map((p) => [p.pubkey.toBase58(), 5n])), flatAnchor: null, anchorOverrideRejected: null, lpData: null, undecodable: 0 });
  const solo = pfL(1, 1, { activeLegs: 4 });
  const light = pfL(2, 1);

  it("rent 106 (settleRentOnce): 1,213,864 for a 4-leg account, 600,000 for a one-leg one", async () => {
    const ctx = v22Ctx({ rent: true });
    const f = fakeExecConn();
    await settleRentOnce(execCtx(f.conn), ctx, positionedOf([solo, light]), freshRentState(), { cadenceSlots: 9000, pairingActive: true });
    const byKey = new Map(f.sims.map((s, i) => [s.keys[0].find((k) => k === solo.pubkey.toBase58() || k === light.pubkey.toBase58()), f.simUnits[i]]));
    assert.equal(byKey.get(solo.pubkey.toBase58()), 1_213_864);
    assert.equal(byKey.get(light.pubkey.toBase58()), 600_000);
  });

  it("dust 118 (sweepDustOnce): the same", async () => {
    const ctx = v22Ctx({ band: true });
    const f = fakeExecConn();
    await sweepDustOnce(execCtx(f.conn), ctx, positionedOf([solo, light]), freshDustState());
    const byKey = new Map(f.sims.map((s, i) => [s.keys[0].find((k) => k === solo.pubkey.toBase58() || k === light.pubkey.toBase58()), f.simUnits[i]]));
    assert.equal(byKey.get(solo.pubkey.toBase58()), 1_213_864);
    assert.equal(byKey.get(light.pubkey.toBase58()), 600_000);
  });

  it("the in-round rent settle of a round (runSettleRound): the 106 of a solo account carries the raised limit, and the round's own txs stay at 1.4M", async () => {
    resetPairingStats();
    const ctx = v22Ctx({ rent: true });
    const f = fakeExecConn();
    const d = { exec: execCtx(f.conn), getSlot: async () => 1004, hold: () => {}, release: () => {} };
    await runSettleRound(d, { market: MARKET, label: "T" }, { lp: LP, counterparties: [light, solo], nowSlot: 100, rent: { due: new Set([solo.pubkey.toBase58()]), build: (p) => buildSettleHoldingRentIxV22(ctx.sdk, d.exec.keeper.publicKey, p.pubkey, 0, 5000n, []) } }, DEFAULT_SWEEP_ROUND_CONFIG);
    const i106 = f.sims.findIndex((s) => s.tags.length === 1 && s.tags[0] === 106);
    assert.ok(i106 >= 0, "a 106 was simulated");
    assert.equal(f.simUnits[i106], 1_213_864);
    f.sims.forEach((s, i) => { if (!s.tags.includes(106)) assert.equal(f.simUnits[i], 1_400_000); });
    // the solo account's refresh is alone in its transaction (no other counterparty beside it)
    const soloTx = f.sent.find((t) => t.keys.some((ks) => ks.includes(solo.pubkey.toBase58())) && !t.tags.includes(106))!;
    assert.ok(soloTx, "the round sent a tx for the solo account");
    assert.ok(!soloTx.keys.some((ks) => ks.includes(light.pubkey.toBase58())), "the light account is not in the solo account's tx");
  });
});

describe("refreshOverflow (the cranker's follow-up path) uses the model it is given", () => {
  const run = async (cost: typeof V22_LEG_COST | undefined) => {
    const plans: Array<{ kinds: string[]; units: number }> = [];
    await refreshOverflow({
      owner: OWNER,
      market: MARKET,
      overflow: [pfL(1, 1), pfL(2, 1, { activeLegs: 4 }), pfL(3, 1)],
      ...(cost ? { cost } : {}),
      simulate: async (p) => {
        plans.push({ kinds: p.cranks.map((c) => c.kind), units: p.computeUnits });
        return { err: null, logs: [], marketData: null } as never;
      },
      send: async () => "sig",
      waitLanded: async () => "landed",
    });
    return plans;
  };
  it("with the v2.2 model: [light], [solo alone at 1,213,864], [light]; without it: one tx of three refreshes (v2.1, unchanged)", async () => {
    const withModel = await run(V22_LEG_COST);
    assert.deepEqual(withModel.map((p) => p.kinds), [["refresh"], ["refresh"], ["refresh"]]);
    assert.deepEqual(withModel.map((p) => p.units), [145_000 + 200_000, 1_213_864, 145_000 + 200_000]);
    const without = await run(undefined);
    assert.deepEqual(without.map((p) => p.kinds), [["refresh", "refresh", "refresh"]]);
    assert.equal(without[0].units, 3 * 145_000 + 200_000);
  });
});
