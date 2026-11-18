/**
 * Differential test: planSettleRound (running weight totals, early-exit pack) against a frozen copy of the previous
 * implementation (settle-pairing.frozen.ts, byte-identical to 12b4d5a). The full RoundPlan JSON must match on
 * every seeded random input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { planSettleRound } from "./settle-pairing.ts";
import { planSettleRound as frozenPlan } from "./settle-pairing.frozen.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";

function rngOf(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ser = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof PublicKey ? x.toBase58() : x));

const MODES = ["off", "strict", "prefer"] as const;

describe("planSettleRound differential vs frozen copy", () => {
  it("5,000+ seeded random inputs produce identical RoundPlan JSON", () => {
    const N = 6000;
    let mismatches = 0;
    let multi = 0;
    for (let t = 0; t < N; t++) {
      const rng = rngOf(0xc0ffee + t * 7919);
      const n = rng() < 0.1 ? 0 : Math.floor(rng() * (rng() < 0.7 ? 60 : 300));
      const soloRate = [0, 0, 0.02, 0.15][Math.floor(rng() * 4)];
      const dupeKeys = rng() < 0.2; // duplicate pubkeys / tied weights exercise the comparator tail
      const cps: PositionedPortfolio[] = Array.from({ length: n }, (_, i) => {
        const id = dupeKeys ? Math.floor(rng() * 20) : i + 1;
        const b = new Uint8Array(32);
        b[0] = id & 0xff;
        b[1] = (id >> 8) & 0xff;
        b[2] = 7;
        const r = rng();
        const legs = r < soloRate ? 3 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 2);
        const p: PositionedPortfolio = {
          pubkey: new PublicKey(b),
          longLegs: legs > 1 && rng() < 0.5 ? legs - 1 : legs,
          shortLegs: legs > 1 ? 1 : 0,
          isLp: false,
          lossWeight: rng() < 0.2 ? undefined : BigInt(Math.floor(rng() * 5)),
        };
        if (rng() < 0.3) p.activeLegs = legs + Math.floor(rng() * 2);
        if (rng() < 0.15) p.liqWeight = Math.floor(rng() * 6);
        return p;
      });
      const lpB = new Uint8Array(32).fill(250);
      const input = {
        mode: MODES[Math.floor(rng() * 3)],
        lp: new PublicKey(lpB),
        lpWeight: rng() < 0.4 ? undefined : 3 + Math.floor(rng() * (rng() < 0.1 ? 40 : 6)),
        counterparties: cps,
        anchor: rng() < 0.5 ? new PublicKey(new Uint8Array(32).fill(251)) : rng() < 0.5 ? null : undefined,
        weightBudget: rng() < 0.5 ? undefined : 1 + Math.floor(rng() * 80),
        maxTxsPerRound: rng() < 0.5 ? undefined : Math.floor(rng() * 25),
      };
      const a = ser(planSettleRound(input));
      const b = ser(frozenPlan(input));
      if (a !== b) {
        mismatches++;
        if (mismatches <= 3) console.error("MISMATCH seed", t, a.slice(0, 300), b.slice(0, 300));
      }
      if (JSON.parse(b).txs.length > 1) multi++;
    }
    assert.equal(mismatches, 0);
    assert.ok(multi > N / 4, `only ${multi} multi-tx cases`);
  });

  it("inputs are not mutated and the result does not alias a shared array between calls", () => {
    const cps: PositionedPortfolio[] = Array.from({ length: 10 }, (_, i) => ({ pubkey: new PublicKey(new Uint8Array(32).fill(i + 1)), longLegs: 1, shortLegs: 0, isLp: false }));
    const before = ser(cps);
    const lp = new PublicKey(new Uint8Array(32).fill(200));
    const a = planSettleRound({ mode: "prefer", lp, counterparties: cps });
    const b = planSettleRound({ mode: "prefer", lp, counterparties: cps });
    assert.equal(ser(cps), before);
    assert.notEqual(a.txs[0].refresh, b.txs[0].refresh);
  });
});
