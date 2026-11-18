import test from "node:test";
import assert from "node:assert/strict";
import { reconcileMarkets } from "./register-poll.js";
import type { MarketEntry } from "./registry.js";

/** Verbatim pre-optimisation reconcileMarkets (findIndex per desired, filter per removal). */
function reconcileOld(
  registry: { markets: MarketEntry[] },
  desired: readonly MarketEntry[],
  absences: Map<string, number>,
  threshold: number,
) {
  const desiredByAddr = new Map(desired.map((m) => [m.marketAddress, m]));
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  const differs = (a: MarketEntry, b: MarketEntry) =>
    a.poolAddress !== b.poolAddress || a.dexType !== b.dexType || a.symbol !== b.symbol || a.collateral !== b.collateral;
  for (const [addr, entry] of desiredByAddr) {
    absences.delete(addr);
    const idx = registry.markets.findIndex((m) => m.marketAddress === addr);
    if (idx === -1) {
      registry.markets.push(entry);
      added.push(addr);
    } else if (differs(registry.markets[idx], entry)) {
      registry.markets[idx] = entry;
      updated.push(addr);
    }
  }
  for (const local of [...registry.markets]) {
    if (desiredByAddr.has(local.marketAddress)) continue;
    const n = (absences.get(local.marketAddress) ?? 0) + 1;
    absences.set(local.marketAddress, n);
    if (n >= threshold) {
      registry.markets = registry.markets.filter((m) => m.marketAddress !== local.marketAddress);
      absences.delete(local.marketAddress);
      removed.push(local.marketAddress);
    }
  }
  return { added, removed, updated };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test("reconcileMarkets matches the old implementation on 5000 random states", () => {
  const r = rng(20261118);
  const int = (n: number) => Math.floor(r() * n);
  const entry = (a: number): MarketEntry =>
    ({
      label: `l${int(1000)}`,
      marketAddress: `a${a}`,
      poolAddress: `p${int(3)}`,
      dexType: int(2) ? "raydium-clmm" : "orca-whirlpool",
      symbol: int(2) ? "S" : undefined,
    }) as unknown as MarketEntry;
  let mismatches = 0;
  for (let t = 0; t < 5000; t++) {
    const space = 1 + int(12);
    const local = Array.from({ length: int(15) }, () => entry(int(space))); // duplicates possible
    const desired = Array.from({ length: int(15) }, () => entry(int(space)));
    const absences = new Map<string, number>();
    for (let a = 0; a < space; a++) if (r() < 0.4) absences.set(`a${a}`, int(4));
    const threshold = 1 + int(4);
    const o = { markets: local.map((e) => ({ ...e })) };
    const n = { markets: local.map((e) => ({ ...e })) };
    const oa = new Map(absences);
    const na = new Map(absences);
    const ro = reconcileOld(o, desired, oa, threshold);
    const rn = reconcileMarkets(n, desired, na, threshold);
    try {
      assert.deepEqual(n.markets, o.markets);
      assert.deepEqual(rn, ro);
      assert.deepEqual([...na], [...oa]); // entries and insertion order
    } catch {
      mismatches++;
    }
  }
  assert.equal(mismatches, 0);
});
