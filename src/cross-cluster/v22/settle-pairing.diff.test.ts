/**
 * Differential test: the optimised planSettleRound must produce plans deep-equal to the pre-optimisation planner
 * (copied verbatim below as planSettleRoundOld) over 2,000 random inputs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { V22_LEG_COST } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { portfolioWeight, planSettleRound, FLAT_ANCHOR_WEIGHT, DEFAULT_WEIGHT_BUDGET, DEFAULT_MAX_TXS_PER_ROUND } from "./settle-pairing.ts";
import type { PlanInput, PlannedTx, RoundPlan } from "./settle-pairing.ts";

function heaviestFirstOld(xs: ReadonlyArray<PositionedPortfolio>): PositionedPortfolio[] {
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
function takeUpToOld(list: PositionedPortfolio[], cap: number): { taken: PositionedPortfolio[]; rest: PositionedPortfolio[] } {
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

const sumWOld = (xs: ReadonlyArray<PositionedPortfolio>): number => xs.reduce((n, p) => n + portfolioWeight(p), 0);

/**
 * Plan one round. Pure. `counterparties` is the whole positioned set of the asset minus the LP (the caller passes
 * every counterparty, not just the stale ones: a non-stale refresh is pruned by simulation later, but the pairing
 * rule is about the SET).
 */
export function planSettleRoundOld(i: PlanInput): RoundPlan {
  const W = i.weightBudget ?? DEFAULT_WEIGHT_BUDGET;
  const maxTxs = i.maxTxsPerRound ?? DEFAULT_MAX_TXS_PER_ROUND;
  const lpW = i.lpWeight ?? 3;
  const C = heaviestFirstOld(i.counterparties);
  const notes: string[] = [];
  const base = { mode: i.mode, needsPushHold: false, notes };

  const lpTx = (index: number, refresh: PositionedPortfolio[]): PlannedTx => ({
    index,
    accrue: "lp",
    accrueTarget: i.lp,
    refresh,
    settlesLp: true,
    weight: lpW + sumWOld(refresh),
  });

  // ── mode off, or a round that fits one tx: the shapes coincide for the single-tx case.
  if (C.length === 0 || sumWOld(C) + lpW <= W) {
    const tx = lpTx(0, C);
    return { ...base, txs: [tx], lpTxIndex: 0, paired: true, unvisited: [], unpairedLpSettle: false, lpDeferred: false, phases: [[0]] };
  }

  if (i.mode === "off") {
    // Legacy #147 shape: LP crank in every tx, chunks of counterparties.
    const txs: PlannedTx[] = [];
    let rest = C;
    while (rest.length > 0 && txs.length < maxTxs) {
      const { taken, rest: r } = takeUpToOld(rest, W - lpW);
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
  while (sumWOld(remaining) > W - lpW && cpTxs.length < maxTxs - 1) {
    let taken: PositionedPortfolio[];
    let rest: PositionedPortfolio[];
    if (i.anchor) {
      ({ taken, rest } = takeUpToOld(remaining, W - anchorW));
      if (taken.length === 0) break;
      cpTxs.push({ index: cpTxs.length, accrue: "anchor", accrueTarget: i.anchor, refresh: taken, settlesLp: false, weight: anchorW + sumWOld(taken) });
    } else {
      // accrue through the first counterparty (its settle IS the accrue crank): it costs its own weight once.
      ({ taken, rest } = takeUpToOld(remaining, W));
      if (taken.length === 0) break;
      const [first, ...others] = taken;
      cpTxs.push({ index: cpTxs.length, accrue: "counterparty", accrueTarget: first.pubkey, refresh: others, settlesLp: false, weight: sumWOld(taken) });
    }
    remaining = rest;
  }
  const lpCap = W - lpW;
  const { taken: lpTaken, rest: unvisited } = takeUpToOld(remaining, lpCap);
  const lastIdx = cpTxs.length;

  if (unvisited.length > 0) {
    // The round cannot complete inside maxTxs.
    if (i.mode === "strict") {
      notes.push(`strict: ${unvisited.length} counterparties do not fit ${maxTxs} txs; the LP is NOT settled this round`);
      // The remaining counterparties that fit still go out so the sweep keeps moving; the LP waits.
      const txs = [...cpTxs];
      if (lpTaken.length > 0) {
        const [first, ...others] = lpTaken;
        txs.push({ index: txs.length, accrue: i.anchor ? "anchor" : "counterparty", accrueTarget: i.anchor ?? first.pubkey, refresh: i.anchor ? lpTaken : others, settlesLp: false, weight: sumWOld(lpTaken) + anchorW });
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


function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("planSettleRound is identical to the legacy planner over 2,000 random inputs", () => {
  const rng = makeRng(20261117);
  const modes = ["off", "prefer", "strict"] as const;
  let multiTx = 0;
  for (let t = 0; t < 2000; t++) {
    const n = Math.floor(rng() * (t % 10 === 0 ? 400 : 60));
    // A small key pool forces weight / loss-weight / key ties and duplicate pubkeys (and shared object refs).
    const pool = Array.from({ length: 1 + Math.floor(rng() * 8) }, () => new PublicKey(Uint8Array.from({ length: 32 }, () => (rng() < 0.2 ? 0 : Math.floor(rng() * 256)))));
    const cps: PositionedPortfolio[] = [];
    for (let i = 0; i < n; i++) {
      if (cps.length > 0 && rng() < 0.05) {
        cps.push(cps[Math.floor(rng() * cps.length)]);
        continue;
      }
      const long = Math.floor(rng() * 4);
      const short = Math.floor(rng() * 3);
      const p: PositionedPortfolio = {
        pubkey: rng() < 0.3 ? pool[Math.floor(rng() * pool.length)] : new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256))),
        longLegs: long,
        shortLegs: short,
        isLp: false,
      };
      if (rng() < 0.6) p.activeLegs = Math.floor(rng() * 6);
      if (rng() < 0.6) p.lossWeight = BigInt(Math.floor(rng() * 4)) * 1_000n;
      if (rng() < 0.1) p.liqWeight = Math.floor(rng() * 8);
      cps.push(p);
    }
    const input: PlanInput = {
      mode: modes[Math.floor(rng() * 3)],
      lp: new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256))),
      lpWeight: rng() < 0.2 ? undefined : Math.floor(rng() * 40),
      counterparties: cps,
      anchor: rng() < 0.4 ? new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256))) : rng() < 0.5 ? null : undefined,
      weightBudget: rng() < 0.3 ? undefined : 1 + Math.floor(rng() * 80),
      maxTxsPerRound: rng() < 0.3 ? undefined : 1 + Math.floor(rng() * 20),
    };
    const a = planSettleRound(input);
    const b = planSettleRoundOld(input);
    assert.deepStrictEqual(a, b, `mismatch at case ${t}`);
    if (b.txs.length > 1) multiTx++;
  }
  assert.ok(multiTx > 500, `only ${multiTx} multi-tx cases exercised`);
});
