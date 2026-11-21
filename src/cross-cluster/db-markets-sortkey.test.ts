/**
 * Differential: the decorate-sort-undecorate capMarketRows must match the previous
 * parse-in-comparator implementation (kept verbatim below) on kept, capped and warnings.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { capMarketRows, type DbMarketRow, type KeeperMarketCaps } from "./db-markets.ts";

// Date.parse is pure; memoise it so 1000 sets run fast (the old comparator parses O(n log n) times).
const realParse = Date.parse;
const parseMemo = new Map<string, number>();
function memoParse(v: string): number {
  let t = parseMemo.get(v);
  if (t === undefined) parseMemo.set(v, (t = realParse(v)));
  return t;
}

function oldOrder(rows: readonly DbMarketRow[]): DbMarketRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const tb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    const da = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
    const db = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    if (da !== db) return da < db ? -1 : 1;
    return a.slab_address < b.slab_address ? -1 : a.slab_address > b.slab_address ? 1 : 0;
  });
}

function oldCap(rows: readonly DbMarketRow[], caps: KeeperMarketCaps, isPriceable: (r: DbMarketRow) => boolean) {
  const kept: DbMarketRow[] = [];
  const capped: DbMarketRow[] = [];
  const perDeployer = new Map<string, number>();
  let total = 0;
  for (const r of oldOrder(rows)) {
    if (!isPriceable(r)) {
      kept.push(r);
      continue;
    }
    const who = r.deployer ?? "";
    const n = perDeployer.get(who) ?? 0;
    if (total >= caps.maxTotal || n >= caps.maxPerDeployer) {
      capped.push(r);
      continue;
    }
    perDeployer.set(who, n + 1);
    total++;
    kept.push(r);
  }
  return { kept, capped };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

describe("capMarketRows sort-key differential", () => {
  it("matches the old implementation over 1000 random row sets", () => {
    Date.parse = memoParse;
    const warn = mock.method(console, "warn", () => {});
    const dates = [null, undefined, "", "garbage", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z", "2026-02-01", "2025-12-31T23:59:59Z"];
    for (let iter = 0; iter < 1000; iter++) {
      const r = rng(iter + 1);
      const n = Math.floor(r() * 14);
      const rows: DbMarketRow[] = Array.from({ length: n }, (_, i) => ({
        slab_address: `s${iter}_${Math.floor(r() * 15)}`, // collisions exercise the tiebreak/stability
        dex_pool_address: `p${i}`,
        symbol: null,
        mint_address: `m${i}`,
        mainnet_ca: null,
        deployer: r() < 0.1 ? null : `d${Math.floor(r() * 4)}`,
        created_at:
          r() < 0.5
            ? dates[Math.floor(r() * dates.length)]
            : new Date(1_700_000_000_000 + Math.floor(r() * 5) * 86_400_000).toISOString(),
      }));
      const caps = { maxTotal: 1 + Math.floor(r() * 12), maxPerDeployer: 1 + Math.floor(r() * 5) };
      const pr = (x: DbMarketRow) => x.mint_address.charCodeAt(1) % 5 !== 0;
      const want = oldCap(rows, caps, pr);
      const got = capMarketRows(rows, caps, pr);
      assert.equal(got.kept.length, want.kept.length);
      got.kept.forEach((x, i) => assert.equal(x, want.kept[i]));
      assert.equal(got.capped.length, want.capped.length);
      got.capped.forEach((x, i) => assert.equal(x, want.capped[i]));
    }
    warn.mock.restore();
    Date.parse = realParse;
  });
});
