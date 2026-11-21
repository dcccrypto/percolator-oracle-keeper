import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshRentState, planRentSettles } from "./rent.ts";
import type { V22Positioned } from "./positioned.ts";
import { key, pf, v22Ctx } from "./test-helpers.ts";

function positioned(cps: ReturnType<typeof pf>[], lp = pf(901, 2, { lp: true })): V22Positioned {
  return { all: [lp, ...cps], counterparties: cps, lp, minLegAbs: new Map(), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 };
}

describe("rent plan: last-settle stamp ahead of the read slot", () => {
  const ctx = v22Ctx({ rent: true, currentSlot: 5000n, slotLast: 5000n });
  const p = positioned([pf(1), pf(2)]);
  const k = (n: number) => `${ctx.marketAddress}|${key(n).toBase58()}`;

  it("slot regression after RPC failover (stamp > read slot) is due, not skipped", () => {
    const st = freshRentState();
    st.last.set(k(1), 5400n); // stamped from a faster RPC
    const plan = planRentSettles(ctx, p, st, 9000, true, 4);
    assert.equal(plan.due.length, 2);
  });
  it("far-future stamp is due, not skipped until that slot", () => {
    const st = freshRentState();
    st.last.set(k(1), 5000n + 10_000_000n);
    assert.equal(planRentSettles(ctx, p, st, 9000, true, 4).due.some((d) => d.portfolio === key(1).toBase58()), true);
  });
  it("negative control: a recent past stamp inside the cadence stays skipped", () => {
    const st = freshRentState();
    st.last.set(k(1), 4990n);
    assert.equal(planRentSettles(ctx, p, st, 9000, true, 4).due.some((d) => d.portfolio === key(1).toBase58()), false);
  });
});
