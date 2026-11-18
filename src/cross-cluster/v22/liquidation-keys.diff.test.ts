/** Differential: markLiquidationCandidates / fitLiquidations vs the pre-optimisation code (33eda56) copied here, 10k random inputs. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { LIQUIDATE_CRANK_CU, V22_LEG_COST } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { LIQ_TX_HEADROOM_CU, LIQ_TX_MAX_CU, atOrBelowMaintenance, fitLiquidations, liqExtraWeight, marginOf, markLiquidationCandidates } from "./liquidation.ts";
import type { FitInput, FitResult, FlaggedAccount, MarginParams, StageAConfig } from "./liquidation.ts";

function oldMark(cs: ReadonlyArray<PositionedPortfolio>, cfg: StageAConfig | null) {
  const candidates = new Map<string, PositionedPortfolio>();
  if (!cfg) return { marked: [...cs], candidates };
  const marked = cs.map((p) => {
    if (p.isLp || !p.risk) return p;
    if (!atOrBelowMaintenance(marginOf(p.risk, cfg.params), cfg.padBps)) return p;
    const m = { ...p, liqWeight: liqExtraWeight(p) };
    candidates.set(p.pubkey.toBase58(), m);
    return m;
  });
  return { marked, candidates };
}

function rngOf(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}
const params: MarginParams = {
  mmrBps: 500n,
  minNonzeroMmReq: 1n,
  assets: new Map([[0, { priceE6: 1_000_000n, rawTargetE6: 990_000n, aLong: 1n << 64n, aShort: 1n << 64n }]]),
};

describe("liquidation candidate keys: identical to old code", () => {
  it("10k randomized inputs", () => {
    const oldFitReal = (i: FitInput): FitResult => {
      const cap = (i.maxCu ?? LIQ_TX_MAX_CU) - LIQ_TX_HEADROOM_CU;
      const order = i.flagged
        .map((f) => ({ f, k: f.portfolio.pubkey.toBase58() }))
        .sort((a, b) => (a.f.ratioBps < b.f.ratioBps ? -1 : a.f.ratioBps > b.f.ratioBps ? 1 : a.k < b.k ? -1 : 1))
        .map((e) => e.f);
      const chosen: FlaggedAccount[] = [];
      const deferred: FitResult["deferred"] = [];
      let cu = i.baseCu;
      for (const f of order) {
        const add = V22_LEG_COST.liquidateCu(f.portfolio, LIQUIDATE_CRANK_CU) + (i.extraCuPerLiquidation ?? 0);
        if (chosen.length >= i.maxPerTx) deferred.push({ account: f, why: "max-per-tx" });
        else if (cu + add > cap) deferred.push({ account: f, why: "compute" });
        else {
          chosen.push(f);
          cu += add;
        }
      }
      return { chosen, deferred };
    };
    const rng = rngOf(20261118);
    const pool: Uint8Array[] = Array.from({ length: 40 }, () => Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256)));
    for (let iter = 0; iter < 10_000; iter++) {
      const n = Math.floor(rng() * (iter % 50 === 0 ? 120 : 12));
      const ps: PositionedPortfolio[] = Array.from({ length: n }, () => {
        // draw from a small pool so duplicate pubkeys (equal keys) occur too
        const pk = new PublicKey(pool[Math.floor(rng() * pool.length)]);
        const hasRisk = rng() > 0.1;
        return {
          pubkey: pk,
          longLegs: 1 + Math.floor(rng() * 3),
          shortLegs: Math.floor(rng() * 2),
          isLp: rng() < 0.1,
          activeLegs: rng() < 0.5 ? undefined : 1 + Math.floor(rng() * 4),
          risk: hasRisk
            ? { equity: BigInt(Math.floor(rng() * 120_000) - 10_000), legs: [{ assetIndex: 0, side: Math.floor(rng() * 2), basis: BigInt(1 + Math.floor(rng() * 2_000_000)), aBasis: 1n << 64n }] }
            : undefined,
        };
      });
      const cfg: StageAConfig | null = rng() < 0.05 ? null : { params, padBps: Math.floor(rng() * 300) };
      const a = markLiquidationCandidates(ps, cfg);
      const b = oldMark(ps, cfg);
      assert.deepEqual(a.marked, b.marked);
      assert.deepEqual([...a.candidates.entries()], [...b.candidates.entries()]);

      const flagged: FlaggedAccount[] = [...a.candidates.values()].map((p) => ({ portfolio: p, ratioBps: BigInt(Math.floor(rng() * 4)) }));
      const fi: FitInput = {
        flagged,
        baseCu: Math.floor(rng() * 400_000),
        maxPerTx: 1 + Math.floor(rng() * 6),
        maxCu: rng() < 0.5 ? undefined : 300_000 + Math.floor(rng() * 1_500_000),
        extraCuPerLiquidation: rng() < 0.5 ? undefined : Math.floor(rng() * 50_000),
      };
      // also: flagged straight from the inputs, with duplicate pubkeys, fresh same-bytes objects (cache miss) and ties
      const rawFlagged: FlaggedAccount[] = ps.map((p) => ({ portfolio: rng() < 0.5 ? { ...p, pubkey: new PublicKey(p.pubkey.toBytes()) } : p, ratioBps: BigInt(Math.floor(rng() * 3)) }));
      for (const input of [fi, { ...fi, flagged: rawFlagged }]) {
        const x = fitLiquidations(input);
        const y = oldFitReal(input);
        assert.equal(x.chosen.length, y.chosen.length);
        x.chosen.forEach((c, j) => assert.equal(c, y.chosen[j]));
        assert.equal(x.deferred.length, y.deferred.length);
        x.deferred.forEach((d, j) => {
          assert.equal(d.account, y.deferred[j].account);
          assert.equal(d.why, y.deferred[j].why);
        });
      }
      const fa = fitLiquidations(fi);
      const fb = oldFitReal(fi);
      assert.equal(fa.chosen.length, fb.chosen.length);
      fa.chosen.forEach((c, j) => assert.equal(c, fb.chosen[j]));
      assert.equal(fa.deferred.length, fb.deferred.length);
      fa.deferred.forEach((d, j) => {
        assert.equal(d.account, fb.deferred[j].account);
        assert.equal(d.why, fb.deferred[j].why);
      });
    }
  });
});
