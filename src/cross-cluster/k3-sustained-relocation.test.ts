/**
 * K-3 (2026-10-03, Agency Nwmb5na6): the circuit breaker must not keep the
 * published mark away from the source price indefinitely.
 *
 * What happened: Agency's PumpSwap pool repriced ~2-4x over the afternoon. The
 * trailing ±30%/hour band let the mark follow only in +30% steps, so from
 * 16:20 to 20:05 UTC the on-chain mark sat 40-160% below the pool. A lagging
 * mark can only move one way, toward the source, so a long opened against it
 * is a free option. Wallet 4VsQ2a went long at 17:35 (mark 0.004803, pool
 * ~0.0098), closed at 18:49 (mark 0.006243 = +30.0%), went long again at
 * 18:51 (pool ~0.0144) and rode the next step to 0.008115 (+30.0%) while the
 * pool FELL ~16%. The LP (3,000 seed capital) ended at 0.
 *
 * These tests drive the breaker through the same clone / split / commit path
 * runCycle uses, with an injected clock at the live 1.5 s cadence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acceptedPublishPrice,
  cloneCircuitBreakerState,
  commitPublishedBreakerState,
  parseSustainedRelocationMs,
  splitBreakerCommit,
} from "./keeper-loop.ts";
import { checkCircuitBreaker, markGap, type CircuitBreakerState } from "../circuit-breaker.ts";

const CYCLE_MS = 1_500;
const SUSTAIN_MS = 300_000;
const base = (lastPrice: number): CircuitBreakerState => ({
  symbol: "AGENCY", lastPrice, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0,
});

/** One runCycle market step. Returns the new persisted state and what (if anything) was published. */
function cycle(
  persisted: CircuitBreakerState,
  sourceUsd: number,
  now: number,
  opts: { sustainMs: number; pushLands?: boolean },
): { persisted: CircuitBreakerState; published: number | null } {
  const candidate = cloneCircuitBreakerState(persisted);
  const accepted = checkCircuitBreaker(candidate, sourceUsd, {
    maxMovePct: 10,
    confirmTrips: 3,
    sustainedRelocationMs: opts.sustainMs,
    now: () => now,
    log: () => {},
  });
  if (accepted === null) return { persisted: candidate, published: null };
  const e6 = BigInt(Math.round(sourceUsd * 1e6));
  const publish = acceptedPublishPrice(e6, Number(e6) / 1e6, accepted, persisted.lastPrice);
  const { commitNow, deferred } = splitBreakerCommit(persisted, candidate, publish.priceUsd);
  if (opts.pushLands === false) return { persisted: commitNow, published: null };
  return { persisted: commitPublishedBreakerState(commitNow, deferred, now + 400), published: publish.priceUsd };
}

/** Run `seconds` of cycles at a constant source price. */
function run(
  s: CircuitBreakerState,
  sourceUsd: number,
  startMs: number,
  seconds: number,
  sustainMs: number,
): { s: CircuitBreakerState; end: number; snaps: number } {
  let t = startMs;
  let snaps = 0;
  for (let i = 0; i < Math.floor((seconds * 1000) / CYCLE_MS); i++) {
    const before = s.lastPrice;
    s = cycle(s, sourceUsd, t, { sustainMs }).persisted;
    if (s.lastPrice === sourceUsd && before !== sourceUsd && Math.abs(sourceUsd - before) / before > 0.3) snaps++;
    t += CYCLE_MS;
  }
  return { s, end: t, snaps };
}

describe("K-3 sustained relocation — the Agency shape", () => {
  it("NEGATIVE CONTROL (sustain disabled = the live keeper): a 2x pool move still lags after a full hour", () => {
    // Steady state at 0.0048, then the pool sits at 0.0098 (2.04x).
    let { s, end } = run(base(0.0048), 0.0048, 0, 60, 0);
    ({ s, end } = run(s, 0.0098, end, 3_600, 0));
    assert.ok(s.lastPrice < 0.0098 * 0.8, `old behaviour: mark ${s.lastPrice} must still trail 0.0098 by >20% after 1h`);
    assert.ok(s.lastPrice > 0.0048, "the band does let it step up");
  });

  it("with the bound, the mark reaches the source within the sustain window and stays there", () => {
    let { s, end } = run(base(0.0048), 0.0048, 0, 60, SUSTAIN_MS);
    const before = run(s, 0.0098, end, SUSTAIN_MS / 1000 - 10, SUSTAIN_MS);
    assert.ok(before.s.lastPrice < 0.0098, "not yet: the band still applies inside the window");
    assert.ok(before.s.lastPrice <= 0.0048 * 1.3 + 1e-12, "and nothing past the band edge was published");
    const after = run(before.s, 0.0098, before.end, 30, SUSTAIN_MS);
    assert.equal(after.s.lastPrice, 0.0098, "the source price is published once the gap has lasted the window");
    assert.equal(after.s.cbGapSince, undefined, "the gap episode is closed by the landed snap");
    assert.equal(markGap(after.s, 0.0098, after.end), null);
    // and it then TRACKS: the next small move is published as-is, not clamped back to the old window
    const next = cycle(after.s, 0.0101, after.end, { sustainMs: SUSTAIN_MS });
    assert.equal(next.published, 0.0101, "window restarted at the snapped mark");
  });

  it("a new divergence after a snap needs a full window again (no free follow-through)", () => {
    let { s, end } = run(base(0.0048), 0.0048, 0, 60, SUSTAIN_MS);
    ({ s, end } = run(s, 0.0098, end, SUSTAIN_MS / 1000 + 30, SUSTAIN_MS));
    assert.equal(s.lastPrice, 0.0098);
    const r = run(s, 0.03, end, 60, SUSTAIN_MS); // 3x more, one minute later
    assert.ok(r.s.lastPrice <= 0.0098 * 1.3 + 1e-12, `mark ${r.s.lastPrice} jumped without a fresh sustained window`);
  });

  it("downward relocations are bounded the same way", () => {
    let { s, end } = run(base(0.01), 0.01, 0, 60, SUSTAIN_MS);
    ({ s, end } = run(s, 0.004, end, SUSTAIN_MS / 1000 + 30, SUSTAIN_MS));
    assert.equal(s.lastPrice, 0.004);
  });
});

describe("K-3 keeps manipulation resistance", () => {
  it("a one-cycle spike is never published, however long the alternation runs", () => {
    let s = base(100);
    let t = 0;
    for (let i = 0; i < 2_000; i++) { // 50 min
      // The normal reads differ from each other: a read IDENTICAL to the baseline does not reset
      // the trip run (#76, by design), which is a separate, pre-existing property.
      const r = cycle(s, i % 2 === 0 ? 300 : 100 + ((i % 7) + 1) / 10, t, { sustainMs: SUSTAIN_MS });
      assert.notEqual(r.published, 300, `spike published at cycle ${i}`);
      s = r.persisted;
      t += CYCLE_MS;
    }
    assert.ok(s.lastPrice < 110);
  });

  it("a manipulation that lets the source back inside the band once per window never snaps", () => {
    // Hold the pool 2x for (window - 1 cycle), let ONE check through at the mark, repeat for 40 min.
    let s = base(100);
    let t = 0;
    const holdCycles = Math.floor(SUSTAIN_MS / CYCLE_MS) - 1;
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < holdCycles; i++) {
        s = cycle(s, 200, t, { sustainMs: SUSTAIN_MS }).persisted;
        t += CYCLE_MS;
      }
      s = cycle(s, s.lastPrice, t, { sustainMs: SUSTAIN_MS }).persisted; // one honest read
      t += CYCLE_MS;
    }
    assert.ok(s.lastPrice < 200, `mark ${s.lastPrice} reached the manipulated level`);
  });

  it("a same-side read that IS published as-is ends the episode", () => {
    let s = base(100);
    s = cycle(s, 200, 0, { sustainMs: SUSTAIN_MS }).persisted; // trip 1/3: withheld
    s = cycle(s, 200, CYCLE_MS, { sustainMs: SUSTAIN_MS }).persisted; // trip 2/3: withheld
    assert.equal(s.cbGapChecks, 2);
    const honest = cycle(s, 105, 2 * CYCLE_MS, { sustainMs: SUSTAIN_MS }); // above the mark, but publishable
    assert.equal(honest.published, 105);
    assert.equal(honest.persisted.cbGapSince, undefined, "the clock restarts on any published source read");
  });

  it("a direction flip restarts the clock", () => {
    let s = base(100);
    let t = 0;
    for (let i = 0; i < 150; i++) { s = cycle(s, 200, t, { sustainMs: SUSTAIN_MS }).persisted; t += CYCLE_MS; }
    for (let i = 0; i < 150; i++) { s = cycle(s, 50, t, { sustainMs: SUSTAIN_MS }).persisted; t += CYCLE_MS; }
    assert.ok(s.lastPrice !== 50 && s.lastPrice !== 200, `snapped to ${s.lastPrice} on a flip`);
    assert.equal(s.cbGapDir, -1);
  });

  it("two checks far apart (keeper stalled) do not count as a sustained gap", () => {
    let s = base(100);
    s = cycle(s, 200, 0, { sustainMs: SUSTAIN_MS }).persisted;
    const r = cycle(s, 200, SUSTAIN_MS * 3, { sustainMs: SUSTAIN_MS });
    assert.notEqual(r.persisted.lastPrice, 200, "needs the minimum number of checks, not just elapsed time");
  });
});

describe("K-3 snap and the push pipeline", () => {
  it("a dropped snap push does not move the baseline, and the snap retries next cycle", () => {
    let { s, end } = run(base(0.0048), 0.0048, 0, 60, SUSTAIN_MS);
    ({ s, end } = run(s, 0.0098, end, SUSTAIN_MS / 1000 - 1, SUSTAIN_MS));
    // advance until the breaker WANTS to snap, but the push is dropped
    let dropped: CircuitBreakerState | null = null;
    for (let i = 0; i < 40 && !dropped; i++) {
      const candidate = cloneCircuitBreakerState(s);
      const a = checkCircuitBreaker(candidate, 0.0098, {
        maxMovePct: 10, confirmTrips: 3, sustainedRelocationMs: SUSTAIN_MS, now: () => end, log: () => {},
      });
      if (candidate.cbSnapPending && a === 0.0098) {
        dropped = cycle(s, 0.0098, end, { sustainMs: SUSTAIN_MS, pushLands: false }).persisted;
      } else {
        s = cycle(s, 0.0098, end, { sustainMs: SUSTAIN_MS }).persisted;
      }
      end += CYCLE_MS;
    }
    assert.ok(dropped, "reached a snap");
    assert.notEqual(dropped.lastPrice, 0.0098, "baseline must not advance on a dropped push");
    assert.equal(dropped.cbSnapPending, undefined, "the snap flag never persists for a push that did not land");
    assert.ok(dropped.cbGapSince !== undefined, "the gap episode stays open");
    const retry = cycle(dropped, 0.0098, end, { sustainMs: SUSTAIN_MS });
    assert.equal(retry.published, 0.0098, "next cycle snaps again");
    assert.equal(retry.persisted.lastPrice, 0.0098);
  });
});

describe("CROSS_CLUSTER_SUSTAINED_RELOCATION_MS", () => {
  it("defaults to 5 minutes, 0 disables, garbage throws", () => {
    assert.equal(parseSustainedRelocationMs(undefined), 300_000);
    assert.equal(parseSustainedRelocationMs(""), 300_000);
    assert.equal(parseSustainedRelocationMs("0"), 0);
    assert.equal(parseSustainedRelocationMs("600000"), 600_000);
    assert.throws(() => parseSustainedRelocationMs("-1"));
    assert.throws(() => parseSustainedRelocationMs("5m"));
    assert.throws(() => parseSustainedRelocationMs("1.5"));
  });
});
