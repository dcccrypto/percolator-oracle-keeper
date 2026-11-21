import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshRentState, markRentSettled, planRentSettles } from "./rent.ts";
import { key, pf, v22Ctx } from "./test-helpers.ts";
import type { V22Positioned } from "./positioned.ts";

function positioned(cps: ReturnType<typeof pf>[], lp = pf(901, 2, { lp: true })): V22Positioned {
  return { all: [lp, ...cps], counterparties: cps, lp, minLegAbs: new Map(), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 };
}

describe("rent state growth", () => {
  it("closed portfolios are pruned: cycling N portfolios keeps state bounded by the live set", () => {
    const ctx = v22Ctx({ rent: true });
    const st = freshRentState();
    const N = 200;
    for (let i = 1; i <= N; i++) {
      const p = positioned([pf(i)]);
      const plan = planRentSettles(ctx, p, st, 9000, true, 4);
      markRentSettled(st, ctx, plan.due.map((d) => d.portfolio));
      // portfolio i closes next iteration
    }
    assert.ok(st.last.size <= 2, `rent state leaked: ${st.last.size} entries for 1 live portfolio`);
  });
  it("a live portfolio keeps its cadence entry across plans; another market's entries are untouched", () => {
    const ctx = v22Ctx({ rent: true });
    const st = freshRentState();
    const p = positioned([pf(1)]);
    markRentSettled(st, ctx, [key(1).toBase58()]);
    st.last.set("OTHERMARKET|x", 1n);
    assert.equal(planRentSettles(ctx, p, st, 9000, true, 4).due.length, 0);
    assert.ok(st.last.has(`${ctx.marketAddress}|${key(1).toBase58()}`));
    assert.ok(st.last.has("OTHERMARKET|x"));
  });
});
