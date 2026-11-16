/** Differential: optimised selectSweepBatch vs the original full-sort implementation on random inputs. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { freshSweepCursor, isStaleAtRead, markVisited, selectSweepBatch } from "./positioned-sweep.ts";
import type { SideEpochs, SweepCursor } from "./positioned-sweep.ts";
import type { PositionedPortfolio } from "./positioned-refresh.ts";

/** Verbatim original (ed00e3c). */
function refSelect(positioned: ReadonlyArray<PositionedPortfolio>, cursor: SweepCursor, k: number, exclude: ReadonlySet<string>, epochs: SideEpochs | null): PositionedPortfolio[] {
  if (k <= 0) return [];
  const candidates = positioned.map((p) => ({ p, key: p.pubkey.toBase58() })).filter((x) => !exclude.has(x.key));
  if (candidates.length === 0) return [];
  const last = (key: string) => cursor.visits.get(key) ?? -1;
  const rank = (xs: typeof candidates) =>
    xs.map((x) => ({ ...x, stale: isStaleAtRead(x.p, epochs), w: x.p.lossWeight ?? 0n })).sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? -1 : 1;
      if (a.w !== b.w) return a.w > b.w ? -1 : 1;
      const va = last(a.key);
      const vb = last(b.key);
      if (va !== vb) return va - vb;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  let due = candidates.filter((x) => last(x.key) < cursor.roundStart);
  if (due.length === 0) {
    cursor.roundStart = cursor.seq + 1;
    cursor.roundPending = false;
    due = candidates;
  }
  const picked = rank(due).slice(0, k);
  if (picked.length < k) {
    const inBatch = new Set(picked.map((x) => x.key));
    const next = rank(candidates.filter((x) => !inBatch.has(x.key))).slice(0, k - picked.length);
    if (next.length > 0) cursor.roundPending = true;
    picked.push(...next);
  }
  return picked.map((x) => x.p).sort((a, b) => Number(a.isLp) - Number(b.isLp));
}

let seed = 12345;
const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };

describe("selectSweepBatch differential", () => {
  it("matches the original on randomised inputs (0 mismatches)", () => {
    let mismatches = 0, batches = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = rnd(40);
      const pool = Array.from({ length: n }, (_, i) => new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i : j === 30 ? 7 : 1))));
      const mk = (): PositionedPortfolio[] =>
        (pool.map((pubkey) => ({
          pubkey, longLegs: 1, shortLegs: 0, isLp: rnd(8) === 0,
          lossWeight: rnd(4) === 0 ? undefined : BigInt(rnd(5)),
          kfEpochSnapLong: rnd(3) === 0 ? undefined : rnd(5) === 0 ? null : BigInt(rnd(3)),
          kfEpochSnapShort: rnd(3) === 0 ? undefined : rnd(5) === 0 ? null : BigInt(rnd(3)),
        })) as PositionedPortfolio[]).concat(rnd(5) === 0 && n > 0 ? [{ pubkey: pool[0], longLegs: 1, shortLegs: 0, isLp: false, lossWeight: 2n } as PositionedPortfolio] : []);
      const pos = mk();
      const epochs: SideEpochs | null = rnd(4) === 0 ? null : { long: BigInt(rnd(3)), short: BigInt(rnd(3)) };
      const a = freshSweepCursor(), b = freshSweepCursor();
      for (let step = 0; step < 12; step++) {
        const k = rnd(12) - 1;
        const exclude = new Set(pos.filter(() => rnd(6) === 0).map((p) => p.pubkey.toBase58()));
        const x = refSelect(pos, a, k, exclude, epochs);
        const y = selectSweepBatch(pos, b, k, exclude, epochs);
        batches++;
        if (x.length !== y.length || x.some((p, i) => p !== y[i]) || a.roundStart !== b.roundStart || a.roundPending !== b.roundPending) mismatches++;
        if (rnd(4) !== 0) { markVisited(a, x.map((p) => p.pubkey)); markVisited(b, y.map((p) => p.pubkey)); }
      }
    }
    assert.ok(batches > 1000);
    assert.equal(mismatches, 0);
  });
});
