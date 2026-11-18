import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PublicKey } from "@solana/web3.js";
import { V22_LEG_COST } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { PairingMode } from "./flags.ts";
import { DEFAULT_MAX_TXS_PER_ROUND, DEFAULT_WEIGHT_BUDGET, FLAT_ANCHOR_WEIGHT, planSettleRound, portfolioWeight } from "./settle-pairing.ts";
import type { PlanInput, PlannedTx, RoundPlan } from "./settle-pairing.ts";
import { key } from "./test-helpers.ts";

/** Differential test: planSettleRound must return a RoundPlan deep-equal to the pre-optimisation implementation (frozen below). */

// ── frozen legacy implementation (verbatim from fc9594a / ed00e3c) ──
const V = V22_LEG_COST; void V; void DEFAULT_MAX_TXS_PER_ROUND; void FLAT_ANCHOR_WEIGHT; void DEFAULT_WEIGHT_BUDGET;
function legacyHeaviestFirst(xs: ReadonlyArray<PositionedPortfolio>): PositionedPortfolio[] {
  // Decorate once: base58-encoding a key inside the comparator ran O(n log n) times and dominated the tick.
  const d = xs.map((p) => ({ p, w: portfolioWeight(p), l: p.lossWeight ?? 0n, k: p.pubkey.toBase58() }));
  d.sort((a, b) => {
    if (a.w !== b.w) return b.w - a.w;
    if (a.l !== b.l) return a.l > b.l ? -1 : 1;
    return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
  });
  return d.map((e) => e.p);
}

/**
 * Greedy pack, in the given order, into a tx with `cap` weight units for refreshes. Skips nothing that fits. A SOLO
 * portfolio (heavier than any budget) is taken ALONE when it is the first thing taken and `cap` is positive (the tx
 * has an accrue crank of its own beside it, never a second account): `cap <= 0` means the tx's other occupant
 * (a heavy LP) already uses the whole budget, so nothing rides.
 */
function legacyTakeUpTo(list: PositionedPortfolio[], cap: number): { taken: PositionedPortfolio[]; rest: PositionedPortfolio[] } {
  const taken: PositionedPortfolio[] = [];
  const rest: PositionedPortfolio[] = [];
  let used = 0;
  for (const p of list) {
    const w = portfolioWeight(p);
    if (used + w <= cap) {
      taken.push(p);
      used += w;
    } else if (taken.length === 0 && cap > 0 && V22_LEG_COST.isSolo(p)) {
      taken.push(p);
      used = Number.POSITIVE_INFINITY;
    } else rest.push(p);
  }
  return { taken, rest };
}

const legacySumW = (xs: ReadonlyArray<PositionedPortfolio>): number => xs.reduce((n, p) => n + portfolioWeight(p), 0);

/**
 * Plan one round. Pure. `counterparties` is the whole positioned set of the asset minus the LP (the caller passes
 * every counterparty, not just the stale ones: a non-stale refresh is pruned by simulation later, but the pairing
 * rule is about the SET).
 */
function legacyPlanSettleRound(i: PlanInput): RoundPlan {
  const W = i.weightBudget ?? DEFAULT_WEIGHT_BUDGET;
  const maxTxs = i.maxTxsPerRound ?? DEFAULT_MAX_TXS_PER_ROUND;
  const lpW = i.lpWeight ?? 3;
  const C = legacyHeaviestFirst(i.counterparties);
  const notes: string[] = [];
  const base = { mode: i.mode, needsPushHold: false, notes };

  const lpTx = (index: number, refresh: PositionedPortfolio[]): PlannedTx => ({
    index,
    accrue: "lp",
    accrueTarget: i.lp,
    refresh,
    settlesLp: true,
    weight: lpW + legacySumW(refresh),
  });

  // ── mode off, or a round that fits one tx: the shapes coincide for the single-tx case.
  if (C.length === 0 || legacySumW(C) + lpW <= W) {
    const tx = lpTx(0, C);
    return { ...base, txs: [tx], lpTxIndex: 0, paired: true, unvisited: [], unpairedLpSettle: false, lpDeferred: false, phases: [[0]] };
  }

  if (i.mode === "off") {
    // Legacy #147 shape: LP crank in every tx, chunks of counterparties.
    const txs: PlannedTx[] = [];
    let rest = C;
    while (rest.length > 0 && txs.length < maxTxs) {
      const { taken, rest: r } = legacyTakeUpTo(rest, W - lpW);
      if (taken.length === 0) break;
      txs.push(lpTx(txs.length, taken));
      rest = r;
    }
    notes.push("pairing off: the LP is settled in every tx (legacy #147 shape)");
    return { ...base, txs, lpTxIndex: txs.length > 0 ? txs.length - 1 : null, paired: false, unvisited: rest, unpairedLpSettle: true, lpDeferred: false, phases: [txs.map((t) => t.index)] };
  }

  // ── multi-tx paired round: counterparty txs first (accrue NOT on the LP), the LP tx last.
  const anchorW = i.anchor ? FLAT_ANCHOR_WEIGHT : 0;
  const cpTxs: PlannedTx[] = [];
  let remaining = C;
  // Phase 1: fill txs from the heaviest until what is left fits the LP tx's capacity.
  while (legacySumW(remaining) > W - lpW && cpTxs.length < maxTxs - 1) {
    let taken: PositionedPortfolio[];
    let rest: PositionedPortfolio[];
    if (i.anchor) {
      ({ taken, rest } = legacyTakeUpTo(remaining, W - anchorW));
      if (taken.length === 0) break;
      cpTxs.push({ index: cpTxs.length, accrue: "anchor", accrueTarget: i.anchor, refresh: taken, settlesLp: false, weight: anchorW + legacySumW(taken) });
    } else {
      // accrue through the first counterparty (its settle IS the accrue crank): it costs its own weight once.
      ({ taken, rest } = legacyTakeUpTo(remaining, W));
      if (taken.length === 0) break;
      const [first, ...others] = taken;
      cpTxs.push({ index: cpTxs.length, accrue: "counterparty", accrueTarget: first.pubkey, refresh: others, settlesLp: false, weight: legacySumW(taken) });
    }
    remaining = rest;
  }
  const lpCap = W - lpW;
  const { taken: lpTaken, rest: unvisited } = legacyTakeUpTo(remaining, lpCap);
  const lastIdx = cpTxs.length;

  if (unvisited.length > 0) {
    // The round cannot complete inside maxTxs.
    if (i.mode === "strict") {
      notes.push(`strict: ${unvisited.length} counterparties do not fit ${maxTxs} txs; the LP is NOT settled this round`);
      // The remaining counterparties that fit still go out so the sweep keeps moving; the LP waits.
      const txs = [...cpTxs];
      if (lpTaken.length > 0) {
        const [first, ...others] = lpTaken;
        txs.push({ index: txs.length, accrue: i.anchor ? "anchor" : "counterparty", accrueTarget: i.anchor ?? first.pubkey, refresh: i.anchor ? lpTaken : others, settlesLp: false, weight: legacySumW(lpTaken) + anchorW });
      }
      return { ...base, needsPushHold: false, txs, lpTxIndex: null, paired: false, unvisited, unpairedLpSettle: false, lpDeferred: true, phases: [txs.map((t) => t.index)] };
    }
    notes.push(`prefer: ${unvisited.length} counterparties do not fit ${maxTxs} txs; the LP settles with them unvisited (counted)`);
    const txs = [...cpTxs, lpTx(lastIdx, lpTaken)];
    return { ...base, needsPushHold: cpTxs.length > 0, txs, lpTxIndex: lastIdx, paired: false, unvisited, unpairedLpSettle: true, lpDeferred: false, phases: [cpTxs.map((t) => t.index), [lastIdx]] };
  }

  const txs = [...cpTxs, lpTx(lastIdx, lpTaken)];
  notes.push(`paired: ${cpTxs.length} counterparty tx(s) then the LP tx (last); accrue via ${i.anchor ? "a flat anchor" : "the first counterparty of each tx"}`);
  return { ...base, needsPushHold: true, txs, lpTxIndex: lastIdx, paired: true, unvisited: [], unpairedLpSettle: false, lpDeferred: false, phases: cpTxs.length > 0 ? [cpTxs.map((t) => t.index), [lastIdx]] : [[lastIdx]] };
}

let seed = 0x1234abcd;
const rnd = (): number => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const int = (n: number): number => Math.floor(rnd() * n);

function randomInput(): PlanInput {
  const n = int(4) === 0 ? int(5) : int(60);
  const poolKeys = 1 + int(40); // few distinct keys per list is not possible (unique), so ties come from weight/lossWeight
  void poolKeys;
  const counterparties: PositionedPortfolio[] = [];
  const lossChoices = [undefined, 0n, 1n, 5n];
  for (let i = 0; i < n; i++) {
    const p: PositionedPortfolio = {
      pubkey: key(1 + int(100_000)),
      longLegs: int(3),
      shortLegs: int(3),
      isLp: false,
      lossWeight: rnd() < 0.5 ? lossChoices[int(lossChoices.length)] : BigInt(int(1000)),
    };
    if (rnd() < 0.15) p.activeLegs = int(6);
    if (rnd() < 0.1) p.liqWeight = int(8);
    counterparties.push(p);
  }
  const modes: PairingMode[] = ["off", "prefer", "strict"];
  const lpKey: PublicKey = key(999_999);
  return {
    mode: modes[int(3)],
    lp: lpKey,
    lpWeight: rnd() < 0.5 ? undefined : 3 + int(40),
    counterparties,
    anchor: rnd() < 0.4 ? key(888_888) : rnd() < 0.5 ? null : undefined,
    weightBudget: rnd() < 0.5 ? undefined : 4 + int(60),
    maxTxsPerRound: rnd() < 0.4 ? undefined : 1 + int(30),
  };
}

describe("planSettleRound differential vs the pre-optimisation planner", () => {
  it("identical RoundPlan (deep equal incl. notes and order) on 12,000 random inputs", () => {
    const seenShapes = new Set<string>();
    for (let t = 0; t < 12_000; t++) {
      const input = randomInput();
      const got = planSettleRound(input);
      const want = legacyPlanSettleRound(input);
      assert.deepStrictEqual(got, want, `case ${t} mode=${input.mode}`);
      seenShapes.add(`${input.mode}:${got.paired}:${got.unpairedLpSettle}:${got.lpDeferred}:${got.txs.length > 1}`);
    }
    assert.ok(seenShapes.size >= 8, `inputs must cover the plan shapes (saw ${seenShapes.size})`);
  });

  it("does not mutate its input", () => {
    const input = randomInput();
    const before = input.counterparties.map((p) => p.pubkey.toBase58());
    planSettleRound(input);
    assert.deepEqual(input.counterparties.map((p) => p.pubkey.toBase58()), before);
  });
});
