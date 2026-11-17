/**
 * Differential test: optimised createMarkSmoother vs the frozen pre-optimisation
 * reference (mark-smoother.reference.ts). smooth/peek/status must match exactly
 * on random and adversarial sequences.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/mark-smoother.diff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMarkSmoother } from "./mark-smoother.ts";
import { createMarkSmootherRef } from "./mark-smoother.reference.ts";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Step = { pool: string; px: bigint; t: number };

function run(steps: Step[], opts: Parameters<typeof createMarkSmoother>[0], resetAt = -1): number {
  const a = createMarkSmoother(opts);
  const b = createMarkSmootherRef(opts);
  const pools = new Set(steps.map((s) => s.pool));
  let compared = 0;
  steps.forEach((s, i) => {
    if (i === resetAt) {
      a.reset();
      b.reset();
    }
    assert.equal(a.smooth(s.pool, s.px, s.t), b.smooth(s.pool, s.px, s.t), `smooth step ${i}`);
    for (const p of pools) {
      assert.equal(a.peek(p), b.peek(p), `peek ${p} step ${i}`);
      assert.deepEqual(a.status(p), b.status(p), `status ${p} step ${i}`);
    }
    compared++;
  });
  assert.deepEqual(a.status("never-seen"), b.status("never-seen"));
  assert.equal(a.peek("never-seen"), b.peek("never-seen"));
  return compared;
}

const T0 = 1_000_000;
const OPTS = [{}, { windowMs: 15_000 }, { windowMs: 30_000, minSamples: 1, minSpanMs: 0 }, { minSamples: 5 }, { windowMs: 600_000 }];

describe("mark-smoother differential vs reference", () => {
  it("random walks, random gaps, 3 pools, many option sets", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeRng(seed);
      const steps: Step[] = [];
      let t = T0;
      let px = 1_000_000n;
      for (let i = 0; i < 400; i++) {
        const r = rng();
        // mostly 3s steps, sometimes jitter, sometimes a long gap that evicts all
        t += r < 0.8 ? 3000 : r < 0.95 ? Math.floor(rng() * 10_000) : Math.floor(rng() * 400_000);
        px += BigInt(Math.floor((rng() - 0.5) * 2000));
        steps.push({ pool: `p${Math.floor(rng() * 3)}`, px, t });
      }
      for (const o of OPTS) run(steps, o, seed % 3 === 0 ? 200 : -1);
    }
  });

  it("ping-pong (balanced and 7:6 majority), odd and even counts", () => {
    for (const pattern of [[100n, 200n], [100n, 100n, 200n], [100n, 200n, 200n, 200n, 100n]]) {
      const steps: Step[] = [];
      for (let i = 0; i < 300; i++) steps.push({ pool: "p", px: pattern[i % pattern.length], t: T0 + i * 3000 });
      for (const o of OPTS) run(steps, o);
    }
  });

  it("all-equal values and heavy duplicates", () => {
    const rng = makeRng(99);
    const eq = Array.from({ length: 200 }, (_, i) => ({ pool: "p", px: 5n, t: T0 + i * 3000 }));
    const dup = Array.from({ length: 300 }, (_, i) => ({ pool: "p", px: BigInt(Math.floor(rng() * 3)), t: T0 + i * 3000 }));
    for (const o of OPTS) {
      run(eq, o);
      run(dup, o);
    }
  });

  it("monotonic up/down ramps, zero and huge prices", () => {
    const up = Array.from({ length: 200 }, (_, i) => ({ pool: "p", px: BigInt(i), t: T0 + i * 3000 }));
    const down = Array.from({ length: 200 }, (_, i) => ({ pool: "p", px: BigInt(1000 - i), t: T0 + i * 3000 }));
    const big = Array.from({ length: 200 }, (_, i) => ({ pool: "p", px: (i % 2 ? 0n : 10n ** 30n) + BigInt(i), t: T0 + i * 3000 }));
    for (const o of OPTS) for (const s of [up, down, big]) run(s, o);
  });

  it("time stepping backwards / equal timestamps / count cap overflow", () => {
    const rng = makeRng(7);
    const steps: Step[] = [];
    let t = T0 + 1_000_000;
    for (let i = 0; i < 400; i++) {
      const r = rng();
      t += r < 0.2 ? -Math.floor(rng() * 20_000) : r < 0.4 ? 0 : 1000; // dense -> hits the 64 cap
      steps.push({ pool: "p", px: BigInt(Math.floor(rng() * 50)), t });
    }
    for (const o of OPTS) run(steps, o);
  });
});
