/**
 * R3-M1 (a): every open portfolio is TOUCHED each cycle on a market with the P2b program features.
 *
 * The cranker refreshes every positioned portfolio each cycle (the accrual tx packs 7, the rest go
 * out as follow-up txs, `chunkOverflowTargets`). The only heuristic that could still drop a
 * refresh is the simulation PRUNE BUDGET in `resolveCrankPlan`: after `maxPrunes` engine
 * rejections it drops every remaining refresh, stale or not. It was capped at 16
 * (`MAX_REFRESH_PRUNE_BUDGET`), so a market with more than 16 positioned portfolios could skip a
 * stale one. On a P2b program the budget now scales with the set (no cap); today's programs keep
 * the cap exactly.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { planCrankTx, chunkOverflowTargets } from "./positioned-refresh.ts";
import type { CrankPlan, PositionedPortfolio } from "./positioned-refresh.ts";
import { MAX_REFRESH_PRUNE_BUDGET, MAX_REFRESH_PRUNES, refreshPruneBudget, resolveCrankPlan } from "./recovery-cranker.ts";
import type { SimOutcome } from "./recovery-cranker.ts";
import { DEFAULT_P2B_GATE_CONFIG, P2bFeatureGate, setP2bGate } from "./p2b-feature.ts";

const OWNER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const LP = Keypair.generate().publicKey;

afterEach(() => setP2bGate(null));

const set = (n: number): PositionedPortfolio[] =>
  Array.from({ length: n }, () => ({ pubkey: Keypair.generate().publicKey, longLegs: 1, shortLegs: 0, isLp: false }));

const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan => planCrankTx({ owner: OWNER, market: MARKET, lpPortfolio: LP, catchup: 0, refreshTargets: t });

/** The engine model: a refresh of a NON-stale portfolio is rejected with Custom(22) (NoAction). */
function simFor(stale: ReadonlySet<string>) {
  return async (p: CrankPlan): Promise<SimOutcome> => {
    const i = p.cranks.findIndex((c) => c.kind === "refresh" && !stale.has(c.portfolio.toBase58()));
    return i >= 0 ? { err: { InstructionError: [i + 1, { Custom: 22 }] }, logs: [], marketData: null } : { err: null, logs: [], marketData: null };
  };
}

const keptKeys = (r: Awaited<ReturnType<typeof resolveCrankPlan>>): string[] => [
  ...r.plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58()),
  ...r.plan.overflow.map((p) => p.pubkey.toBase58()),
];

describe("refreshPruneBudget", () => {
  it("today's programs (gate off): min(16, max(3, targets)) exactly as before", () => {
    assert.equal(refreshPruneBudget(2), MAX_REFRESH_PRUNES);
    assert.equal(refreshPruneBudget(12), 12);
    assert.equal(refreshPruneBudget(16), 16);
    assert.equal(refreshPruneBudget(17), MAX_REFRESH_PRUNE_BUDGET);
    assert.equal(refreshPruneBudget(40), MAX_REFRESH_PRUNE_BUDGET);
  });
  it("P2b program (gate on): one prune per target, no cap", () => {
    setP2bGate(new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported"));
    assert.equal(refreshPruneBudget(2), MAX_REFRESH_PRUNES);
    assert.equal(refreshPruneBudget(17), 17);
    assert.equal(refreshPruneBudget(40), 40);
    assert.equal(refreshPruneBudget(500), 500);
  });
  it("an explicit opt overrides the gate either way", () => {
    assert.equal(refreshPruneBudget(40, { uncapped: true }), 40);
    assert.equal(refreshPruneBudget(40, { uncapped: false }), MAX_REFRESH_PRUNE_BUDGET);
  });
});

describe("no open portfolio is skipped by the prune budget on a P2b market", () => {
  it("40 positioned, only the LAST stale: the capped (today's) budget DROPS it; the P2b budget keeps it", async () => {
    const s = set(40);
    const staleKey = s[39].pubkey.toBase58();
    const sim = simFor(new Set([staleKey]));
    // negative control = today's behaviour: the cap of 16 gives up first
    const capped = await resolveCrankPlan(build, s, sim, undefined, refreshPruneBudget(40, { uncapped: false }));
    assert.equal(keptKeys(capped).includes(staleKey), false, "the stale portfolio is dropped by the cap (documented gap)");
    assert.ok(capped.pruned.some((p) => p.code === null), "dropped for budget (code null), not an engine verdict");
    // P2b
    const scaled = await resolveCrankPlan(build, s, sim, undefined, refreshPruneBudget(40, { uncapped: true }));
    assert.equal(keptKeys(scaled).includes(staleKey), true);
    assert.equal(scaled.pruned.some((p) => p.code === null), false, "nothing dropped without an engine rejection");
  });

  it("property: for N in 1..64 and several stale subsets, every stale portfolio is kept and nothing is dropped for budget", async () => {
    const stalePatterns: Array<(i: number, n: number) => boolean> = [
      (i, n) => i === n - 1, // last only
      (i) => i === 0, // first only
      (i) => i % 3 === 0,
      (i, n) => i >= n - 2,
    ];
    for (let n = 1; n <= 64; n++) {
      for (const pat of stalePatterns) {
        const s = set(n);
        const stale = new Set(s.filter((_, i) => pat(i, n)).map((p) => p.pubkey.toBase58()));
        const r = await resolveCrankPlan(build, s, simFor(stale), undefined, refreshPruneBudget(n, { uncapped: true }));
        const kept = new Set(keptKeys(r));
        for (const k of stale) assert.ok(kept.has(k), `N=${n}: a stale portfolio was skipped`);
        assert.equal(r.pruned.some((p) => p.code === null), false, `N=${n}: dropped for budget`);
        // every target is either in the plan (refresh or overflow) or was rejected by the ENGINE (code != null)
        const accounted = new Set([...kept, ...r.pruned.map((p) => p.pubkey.toBase58())]);
        for (const t of s) assert.ok(accounted.has(t.pubkey.toBase58()), `N=${n}: a target vanished`);
      }
    }
  });

  it("the plan itself never loses a target: refresh + overflow == targets, and overflow chunks cover the overflow exactly once", () => {
    for (const n of [1, 7, 8, 9, 15, 16, 17, 40, 100]) {
      const s = set(n);
      const plan = build(s);
      const inTx = plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58());
      assert.equal(inTx.length + plan.overflow.length, n, `N=${n}`);
      const chunks = chunkOverflowTargets(plan.overflow);
      const flat = chunks.flat().map((p) => p.pubkey.toBase58());
      assert.deepEqual(flat, plan.overflow.map((p) => p.pubkey.toBase58()), `N=${n}: chunks cover the overflow once, in order`);
      assert.equal(new Set([...inTx, ...flat]).size, n, `N=${n}: no duplicates, none missing`);
    }
  });

  it("the budget bounds the simulations: at most (targets + 2) per resolve", async () => {
    const s = set(40);
    let sims = 0;
    const inner = simFor(new Set([s[39].pubkey.toBase58()]));
    const r = await resolveCrankPlan(build, s, async (p) => { sims++; return inner(p); }, undefined, refreshPruneBudget(40, { uncapped: true }));
    assert.ok(sims <= 40 + 2, `sims=${sims}`);
    assert.equal(keptKeys(r).length > 0, true);
  });

});
