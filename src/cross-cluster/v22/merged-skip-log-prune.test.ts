/**
 * mergedSkipLog is module-level and keyed by market: a market that leaves the registry must be forgotten
 * (same class as the auth-mark-pusher prune fixes), and a backwards clock must not mute the line forever.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/v22/merged-skip-log-prune.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { logMergedSkip, mergedSkipLogSize, pruneMergedSkipLog, resetMergedSkipLog, MERGED_SKIP_LOG_MS } from "./sweep.ts";

const mk = () => {
  const lines: string[] = [];
  return { lines, deps: { exec: { log: (l: string) => lines.push(l) } } as never };
};

describe("mergedSkipLog prune", () => {
  beforeEach(() => resetMergedSkipLog());

  it("grows per market, and pruning to the live set drops churned markets", () => {
    const { deps } = mk();
    for (let i = 0; i < 1000; i++) logMergedSkip(deps, `m${i}`, "x", "why", 1);
    assert.equal(mergedSkipLogSize(), 1000);
    pruneMergedSkipLog(new Set(["m1", "m2"]));
    assert.equal(mergedSkipLogSize(), 2);
  });

  it("a kept market keeps its throttle", () => {
    const { deps, lines } = mk();
    logMergedSkip(deps, "m1", "x", "why", 1000);
    pruneMergedSkipLog(new Set(["m1"]));
    logMergedSkip(deps, "m1", "x", "why", 1001);
    assert.equal(lines.length, 1);
  });

  it("a clock that went backwards does not suppress the line indefinitely", () => {
    const { deps, lines } = mk();
    logMergedSkip(deps, "m1", "x", "why", 10_000_000);
    logMergedSkip(deps, "m1", "x", "why", 5_000); // clock stepped back hours
    assert.equal(lines.length, 2);
    logMergedSkip(deps, "m1", "x", "why", 5_000 + MERGED_SKIP_LOG_MS - 1);
    assert.equal(lines.length, 2);
  });
});
