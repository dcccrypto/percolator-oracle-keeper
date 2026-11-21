/**
 * Pins measured behaviour of the mark-smoother under a backwards clock step, a
 * stale peek, and pool removal. Every case runs the optimised smoother and the
 * frozen reference (mark-smoother.reference.ts) side by side with explicit
 * nowMs, and asserts they agree.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/mark-smoother.clock.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMarkSmoother } from "./mark-smoother.ts";
import { createMarkSmootherRef } from "./mark-smoother.reference.ts";

const CYCLE = 7_000;
const T0 = 10_000_000;

/** Warm a pool with 40 cycles, then step the clock back by `backMs` and count withheld pushes. */
function withheldAfterStepBack(mk: typeof createMarkSmoother, backMs: number) {
  const s = mk({});
  let t = T0;
  for (let i = 0; i < 40; i++, t += CYCLE) s.smooth("P", 100n, t);
  assert.equal(s.smooth("P", 100n, t), 100n, "published before the step");
  let tb = t - backMs;
  let withheld = 0;
  let firstSpan = 0;
  for (let i = 0; i < 200; i++, tb += CYCLE) {
    const r = s.smooth("P", 100n, tb);
    if (i === 0) firstSpan = s.status("P").spanMs;
    if (r !== null) break;
    withheld++;
  }
  return { withheld, firstSpan };
}

describe("mark-smoother: backwards clock step (lead 1)", () => {
  it("60 s step back withholds 5 cycles (35 s), span stays positive", () => {
    for (const mk of [createMarkSmoother, createMarkSmootherRef]) {
      const r = withheldAfterStepBack(mk, 60_000);
      assert.equal(r.withheld, 5);
      assert.equal(r.withheld * CYCLE, 35_000);
      assert.ok(r.firstSpan > 0);
    }
  });
  it("200 s step back drives the span negative and withholds 25 cycles (175 s)", () => {
    for (const mk of [createMarkSmoother, createMarkSmootherRef]) {
      const r = withheldAfterStepBack(mk, 200_000);
      assert.ok(r.firstSpan < 0);
      assert.equal(r.withheld, 25);
    }
  });
  it("any step >= ~300 s is bounded by the 64-sample cap at 63 cycles (441 s)", () => {
    for (const back of [300_000, 3_600_000]) {
      for (const mk of [createMarkSmoother, createMarkSmootherRef]) {
        assert.equal(withheldAfterStepBack(mk, back).withheld, 63);
      }
    }
  });
});

describe("mark-smoother: peek age (lead 3)", () => {
  it("peek ignores age (matches the reference); keeper-loop always calls smooth first, which evicts", () => {
    for (const mk of [createMarkSmoother, createMarkSmootherRef]) {
      const s = mk({});
      for (let i = 0; i < 5; i++) s.smooth("Q", 100n, T0 + i * CYCLE);
      // Ten minutes of silence, no smooth(): peek still returns the old median.
      assert.equal(s.peek("Q"), 100n);
      // Any smooth() at the later time evicts the old samples first, so peek goes null.
      assert.equal(s.smooth("Q", 200n, T0 + 600_000), null);
      assert.equal(s.peek("Q"), null);
    }
  });
});

describe("mark-smoother: windows map (lead 2)", () => {
  it("a pool with no further pushes keeps its window until reset()", () => {
    const s = createMarkSmoother({});
    for (let i = 0; i < 5; i++) s.smooth("gone", 100n, T0 + i * CYCLE);
    s.smooth("live", 100n, T0 + 3_600_000);
    assert.equal(s.status("gone").samples, 5);
    s.reset();
    assert.equal(s.status("gone").samples, 0);
  });
});
