import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { planSettleRound } from "./settle-pairing.ts";
import { key } from "./test-helpers.ts";

/** Pins the work the planner does (not just its output, which settle-pairing-diff.test.ts pins): weigh once, base58 only on a tie. */
function counted(n: number, legsOf: (i: number) => number) {
  const c = { b58: 0, legReads: 0 };
  const cps: PositionedPortfolio[] = Array.from({ length: n }, (_, i) => {
    const pk = key(i + 1);
    const orig = pk.toBase58.bind(pk);
    pk.toBase58 = () => {
      c.b58++;
      return orig();
    };
    const p = { pubkey: pk, shortLegs: 0, isLp: false, lossWeight: BigInt(i + 1) } as unknown as PositionedPortfolio;
    Object.defineProperty(p, "longLegs", {
      get() {
        c.legReads++;
        return legsOf(i);
      },
      enumerable: true,
    });
    return p;
  });
  return { c, cps };
}

describe("planSettleRound work", () => {
  it("never base58-encodes a key when every weight is distinct", () => {
    const { c, cps } = counted(40, (i) => 1 + (i % 40));
    planSettleRound({ mode: "prefer", lp: key(9000), counterparties: cps, weightBudget: 60 } as never);
    assert.equal(c.b58, 0);
  });

  it("encodes only keys that reach the tiebreak (equal weight AND equal lossWeight)", () => {
    const { c, cps } = counted(40, () => 2);
    planSettleRound({ mode: "prefer", lp: key(9000), counterparties: cps, weightBudget: 60 } as never);
    // equal weights but distinct lossWeight: tiebreak stops at lossWeight, no encoding
    assert.equal(c.b58, 0);
  });

  it("weighs each counterparty a bounded number of times, independent of tx count", () => {
    const n = 200;
    const { c, cps } = counted(n, () => 1);
    const plan = planSettleRound({ mode: "prefer", lp: key(9000), counterparties: cps, weightBudget: 12, maxTxsPerRound: 50 } as never);
    assert.ok(plan.txs.length > 3, "multi-tx round");
    assert.ok(c.legReads <= 4 * n, `longLegs read ${c.legReads} times for ${n} counterparties`);
  });
});
