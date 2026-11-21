/**
 * Differential test: the indexed addMarket / removeMarket / reconcileMarkets must
 * produce byte-identical registry JSON to the original linear-scan versions.
 */
import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addMarket, removeMarket, type Registry, type MarketEntry } from "./registry.ts";
import { reconcileMarkets } from "./register-poll.ts";

afterEach(() => mock.restoreAll());

// --- reference (pre-change) implementations ---
function refAdd(registry: Registry, entry: Omit<MarketEntry, "registeredAt">, now: number) {
  const idx = registry.markets.findIndex((m) => m.marketAddress === entry.marketAddress);
  const full: MarketEntry = { ...entry, registeredAt: now };
  if (idx >= 0) registry.markets[idx] = full;
  else registry.markets.push(full);
  return full;
}
function refRemove(registry: Registry, a: string) {
  const before = registry.markets.length;
  registry.markets = registry.markets.filter((m) => m.marketAddress !== a);
  return registry.markets.length < before;
}
function refReconcile(
  registry: Pick<Registry, "markets">,
  desired: readonly MarketEntry[],
  absences: Map<string, number>,
  threshold: number,
) {
  const d = new Map(desired.map((m) => [m.marketAddress, m]));
  const added: string[] = [], removed: string[] = [], updated: string[] = [];
  for (const [addr, entry] of d) {
    absences.delete(addr);
    const idx = registry.markets.findIndex((m) => m.marketAddress === addr);
    if (idx === -1) {
      registry.markets.push(entry);
      added.push(addr);
    } else if (registry.markets[idx].poolAddress !== entry.poolAddress ||
      registry.markets[idx].dexType !== entry.dexType ||
      registry.markets[idx].symbol !== entry.symbol ||
      registry.markets[idx].collateral !== entry.collateral) {
      registry.markets[idx] = entry;
      updated.push(addr);
    }
  }
  for (const local of [...registry.markets]) {
    if (d.has(local.marketAddress)) continue;
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

let seed = 12345;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const row = (i: number, v = 0): any => ({
  label: `L${i}`,
  marketAddress: `M${i}`,
  poolAddress: `P${i}-${v}`,
  dexType: "raydium-clmm",
});

describe("registry add/remove index is output-identical", () => {
  it("5,000 random add/remove ops give identical registry JSON", () => {
    let t = 1000;
    mock.method(Date, "now", () => t);
    const a: Registry = { version: 1, markets: [] } as any;
    const b: Registry = { version: 1, markets: [] } as any;
    for (let op = 0; op < 5000; op++) {
      t++;
      const i = rnd(300);
      if (rnd(4) === 0) {
        assert.equal(removeMarket(a, `M${i}`), refRemove(b, `M${i}`));
      } else {
        const e = row(i, rnd(5));
        assert.deepEqual(addMarket(a, e), refAdd(b, e, t));
      }
      if (op % 250 === 0) assert.equal(JSON.stringify(a), JSON.stringify(b));
    }
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("survives in-place edits to the array between adds", () => {
    let t = 1;
    mock.method(Date, "now", () => t);
    const a: Registry = { version: 1, markets: [] } as any;
    const b: Registry = { version: 1, markets: [] } as any;
    for (let i = 0; i < 20; i++) {
      t = i + 1;
      addMarket(a, row(i));
      refAdd(b, row(i), t);
    }
    t = 100;
    // external edits: direct push, splice, and duplicate address
    for (const r of [a, b]) {
      r.markets.push({ ...row(50), registeredAt: 9 });
      r.markets.splice(3, 1);
      r.markets.splice(0, 0, { ...row(7), registeredAt: 9 });
    }
    for (let i = 0; i < 80; i++) {
      t = 200 + i;
      const e = row(rnd(60), 1);
      addMarket(a, e);
      refAdd(b, e, t);
    }
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("reconcileMarkets matches the reference over random cycles (incl. duplicates)", () => {
    for (const threshold of [1, 2, 3]) {
      const a = { markets: [] as MarketEntry[] };
      const b = { markets: [] as MarketEntry[] };
      for (let i = 0; i < 40; i++) {
        a.markets.push({ ...row(i % 35), registeredAt: 1 });
        b.markets.push({ ...row(i % 35), registeredAt: 1 });
      }
      const absA = new Map<string, number>();
      const absB = new Map<string, number>();
      for (let cycle = 0; cycle < 60; cycle++) {
        const desired: MarketEntry[] = [];
        for (let k = 0; k < 40; k++) {
          if (rnd(3) > 0) desired.push({ ...row(rnd(70), rnd(2)), registeredAt: 1 });
        }
        const ra = reconcileMarkets(a, desired, absA, threshold);
        const rb = refReconcile(b, desired, absB, threshold);
        assert.deepEqual(ra, rb);
        assert.equal(JSON.stringify(a), JSON.stringify(b));
        assert.deepEqual([...absA], [...absB]);
      }
    }
  });
});
