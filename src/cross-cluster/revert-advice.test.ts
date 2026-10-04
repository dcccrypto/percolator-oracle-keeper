/**
 * The cranker's revert log must name the actual cause (#137 review nit): a
 * compute-exhausted plan is not "drifting toward deep-stale".
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/revert-advice.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { revertAdvice } from "./recovery-cranker.ts";

describe("revertAdvice", () => {
  it("compute exhaustion is a budgeting problem, never deep-stale drift", () => {
    const msg = revertAdvice(null, true);
    assert.match(msg, /ran out of compute/);
    assert.doesNotMatch(msg, /deep-stale/);
    // Even if some code is also parsed, exhaustion wins.
    assert.doesNotMatch(revertAdvice(19, true), /deep-stale/);
  });

  it("EngineStale / EngineLockActive keep the deep-stale warning", () => {
    assert.match(revertAdvice(19, false), /deep-stale/);
    assert.match(revertAdvice(21, false), /deep-stale/);
  });

  it("an unclassified revert claims neither", () => {
    const msg = revertAdvice(null, false);
    assert.doesNotMatch(msg, /deep-stale/);
    assert.doesNotMatch(msg, /ran out of compute/);
    assert.match(msg, /Unclassified/);
    assert.doesNotMatch(revertAdvice(22, false), /deep-stale/);
  });
});
