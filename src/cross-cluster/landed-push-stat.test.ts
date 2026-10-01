/**
 * recordLandedPush: a landed push clears the sticky /health lastError.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/landed-push-stat.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordLandedPush } from "./keeper-loop.ts";

describe("recordLandedPush", () => {
  it("clears a cold-start smoother error once a push lands", () => {
    const stat = {
      totalPushes: 0,
      lastPushAt: null as number | null,
      lastSig: null as string | null,
      lastErrorMsg: "mark smoother re-priming — withholding push until minSamples" as string | null,
    };
    recordLandedPush(stat, 1_000, "sigA");
    assert.equal(stat.lastErrorMsg, null);
    assert.equal(stat.totalPushes, 1);
    assert.equal(stat.lastPushAt, 1_000);
    assert.equal(stat.lastSig, "sigA");
  });

  it("counts every landed push", () => {
    const stat = { totalPushes: 5, lastPushAt: 1, lastSig: "x" as string | null, lastErrorMsg: null as string | null };
    recordLandedPush(stat, 2, "y");
    assert.equal(stat.totalPushes, 6);
  });
});
