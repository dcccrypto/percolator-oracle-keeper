/**
 * The per-cycle refresh/catch-up plan (planCrankTx + chunkOverflowTargets + planRefreshTx) is byte-identical for a
 * fixed seed. GOLDEN was captured from the code BEFORE the encode/base58 caching perf change, so this fails if the
 * order, kinds, accounts, instruction bytes, overflow or CU of any plan changes.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/positioned-refresh-plan-equality.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { planCrankTx, planRefreshTx, chunkOverflowTargets, V22_LEG_COST } from "./positioned-refresh.ts";
import type { PositionedPortfolio } from "./positioned-refresh.ts";

const GOLDEN = "e6a4d6d96575cef5fab84fc3b5f982ddd22b49fd126247836b8472267ed96fd6";

function run(): string {
  let s = 0x9e3779b9;
  const rnd = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  const mkKey = (): PublicKey => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = Math.floor(rnd() * 256);
    return new PublicKey(b);
  };
  const h = createHash("sha256");
  const owner = mkKey();
  for (let m = 0; m < 12; m++) {
    const market = mkKey();
    const targets: PositionedPortfolio[] = [];
    for (let i = 0; i < 40; i++) {
      targets.push({ pubkey: mkKey(), longLegs: rnd() < 0.5 ? 1 : 0, shortLegs: rnd() < 0.5 ? 1 : 0, isLp: i % 17 === 0, activeLegs: 1 + Math.floor(rnd() * 4) });
    }
    const liq = targets.filter(() => rnd() < 0.15).map((t) => t.pubkey);
    const lp = targets[0]!;
    const cost = m % 2 === 0 ? V22_LEG_COST : undefined;
    const catchup = [0, 1, 3, 12, 50][m % 5]!;
    const plans = [planCrankTx({ owner, market, lpPortfolio: lp.pubkey, catchup, refreshTargets: targets, liquidateTargets: liq, cost, lp })];
    if (m === 5) plans.push(planCrankTx({ owner, market, lpPortfolio: lp.pubkey, catchup: 2, refreshTargets: targets, accrue: false }));
    for (const g of chunkOverflowTargets(plans[0]!.overflow, undefined, cost)) plans.push(planRefreshTx({ owner, market, targets: g, liquidateTargets: liq, cost }));
    for (const p of plans) {
      h.update(`CU${p.computeUnits}|OV${p.overflow.map((o) => o.pubkey.toBase58()).join(",")}|`);
      for (const c of p.cranks) {
        h.update(`${c.kind}:${c.portfolio.toBase58()}:${c.ix.programId.toBase58()}:`);
        for (const k of c.ix.keys) h.update(`${k.pubkey.toBase58()}${k.isSigner ? "s" : ""}${k.isWritable ? "w" : ""},`);
        h.update(Buffer.from(c.ix.data));
        h.update(";");
      }
      h.update("\n");
    }
  }
  return h.digest("hex");
}

describe("positioned-refresh plan equality", () => {
  it("plan (order and contents) is byte-equal to the pre-optimisation golden", () => {
    assert.equal(run(), GOLDEN);
  });
  it("is deterministic across calls (no shared mutable ix data between plans)", () => {
    assert.equal(run(), run());
  });
});
