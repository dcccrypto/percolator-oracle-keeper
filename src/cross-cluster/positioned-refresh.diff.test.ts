/** Differential: planCrankTx / planRefreshTx vs the frozen pre-optimisation copy, 2,000 random inputs. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as nu from "./positioned-refresh.js";
import * as old from "./positioned-refresh.legacy-ref.js";

let seed = 0x9e3779b9;
const rnd = (): number => {
  seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const int = (n: number): number => Math.floor(rnd() * n);
const pk = (): PublicKey => new PublicKey(Uint8Array.from({ length: 32 }, () => int(256)));

const snap = (c: nu.CrankPlan) => ({
  computeUnits: c.computeUnits,
  overflow: c.overflow.map((p) => p.pubkey.toBase58()),
  cranks: c.cranks.map((k) => ({
    kind: k.kind,
    portfolio: k.portfolio.toBase58(),
    ix: k.ix.keys.map((m) => `${m.pubkey.toBase58()}${+m.isSigner}${+m.isWritable}`).join(",") + "|" + Buffer.from(k.ix.data).toString("hex"),
  })),
});

describe("positioned-refresh plan: differential vs legacy copy", () => {
  it("2,000 random planCrankTx + planRefreshTx inputs are identical", () => {
    const owner = Keypair.generate().publicKey;
    for (let iter = 0; iter < 2000; iter++) {
      const market = pk();
      const lpPortfolio = pk();
      const n = int(40);
      const targets: nu.PositionedPortfolio[] = [];
      for (let i = 0; i < n; i++) {
        const legs = int(5);
        targets.push({
          pubkey: pk(), longLegs: int(3), shortLegs: int(3), isLp: rnd() < 0.15,
          ...(rnd() < 0.7 ? { activeLegs: legs } : {}),
        });
      }
      const liq: PublicKey[] = [];
      for (const t of targets) if (rnd() < 0.4) liq.push(t.pubkey, t.pubkey.equals(t.pubkey) && rnd() < 0.3 ? t.pubkey : pk());
      const cost = rnd() < 0.5 ? nu.V22_LEG_COST : undefined;
      const lp = rnd() < 0.5 ? targets.find((t) => t.isLp) ?? null : null;
      const params = {
        owner, market, lpPortfolio, catchup: int(14), refreshTargets: targets,
        ...(rnd() < 0.8 ? { liquidateTargets: liq } : {}), ...(cost ? { cost } : {}), lp,
        ...(rnd() < 0.15 ? { accrue: false } : {}),
      };
      assert.deepEqual(snap(nu.planCrankTx(params)), snap(old.planCrankTx(params as never) as nu.CrankPlan), `planCrankTx iter ${iter}`);
      const rp = { owner, market, targets, ...(rnd() < 0.8 ? { liquidateTargets: liq } : {}), ...(cost ? { cost } : {}) };
      assert.deepEqual(snap(nu.planRefreshTx(rp)), snap(old.planRefreshTx(rp as never) as nu.CrankPlan), `planRefreshTx iter ${iter}`);
    }
  });
});
