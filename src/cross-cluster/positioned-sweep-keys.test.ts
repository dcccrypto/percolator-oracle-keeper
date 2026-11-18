/**
 * Differential test: the cursor functions with cached base58 keys must match the
 * original per-call `toBase58()` implementation (copied below) on random rounds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { freshSweepCursor, markVisited, pruneVisits, refreshPositionedFrom, selectSweepBatch } from "./positioned-sweep.ts";
import type { SweepCursor, SideEpochs } from "./positioned-sweep.ts";
import type { PositionedPortfolio } from "./positioned-refresh.ts";
import { isStaleAtRead } from "./positioned-sweep.ts";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Reference base58 (same string as toBase58()), memoised by raw bytes only so the 10k-round test is fast
// on a loaded machine; the new code under test uses its own per-PublicKey cache.
const refB58Memo = new Map<string, string>();
function refB58(pk: PublicKey): string {
  const h = Buffer.from(pk.toBytes()).toString("hex");
  let v = refB58Memo.get(h);
  if (v === undefined) {
    v = pk.toBase58();
    refB58Memo.set(h, v);
  }
  return v;
}

// ── reference (pre-change) implementation ──
function refSelect(
  positioned: ReadonlyArray<PositionedPortfolio>,
  cursor: SweepCursor,
  k: number,
  exclude: ReadonlySet<string>,
  epochs: SideEpochs | null,
): PositionedPortfolio[] {
  if (k <= 0) return [];
  const candidates = positioned.map((p) => ({ p, key: refB58(p.pubkey) })).filter((x) => !exclude.has(x.key));
  if (candidates.length === 0) return [];
  const last = (key: string) => cursor.visits.get(key) ?? -1;
  const rank = (xs: typeof candidates) =>
    xs
      .map((x) => ({ ...x, stale: isStaleAtRead(x.p, epochs), w: x.p.lossWeight ?? 0n }))
      .sort((a, b) => {
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
function refMark(cursor: SweepCursor, pubkeys: ReadonlyArray<PublicKey>): void {
  if (pubkeys.length === 0) return;
  const seq = ++cursor.seq;
  for (const pk of pubkeys) cursor.visits.set(refB58(pk), seq);
  if (cursor.roundPending) {
    cursor.roundStart = seq + 1;
    cursor.roundPending = false;
  }
}
function refPrune(cursor: SweepCursor, positioned: ReadonlyArray<PositionedPortfolio>): void {
  const live = new Set(positioned.map((p) => refB58(p.pubkey)));
  for (const k of [...cursor.visits.keys()]) if (!live.has(k)) cursor.visits.delete(k);
}
function refRefresh(positioned: PositionedPortfolio[], fresh: ReadonlyArray<PositionedPortfolio>): void {
  const byKey = new Map(fresh.map((p) => [refB58(p.pubkey), p]));
  for (let i = 0; i < positioned.length; i++) {
    const f = byKey.get(refB58(positioned[i].pubkey));
    if (f) positioned[i] = f;
  }
}

function mk(rng: () => number, pk?: PublicKey): PositionedPortfolio {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(rng() * 256);
  const r = rng();
  return {
    pubkey: pk ?? new PublicKey(b),
    longLegs: 1,
    shortLegs: 0,
    isLp: rng() < 0.1,
    lossWeight: r < 0.2 ? undefined : BigInt(Math.floor(rng() * 4)),
    kfEpochSnapLong: rng() < 0.3 ? undefined : rng() < 0.2 ? null : BigInt(Math.floor(rng() * 3)),
    kfEpochSnapShort: rng() < 0.5 ? undefined : null,
  } as PositionedPortfolio;
}

test("cursor functions: 10k random rounds, new vs reference, identical order and cursor state", () => {
  const rng = makeRng(20261118);
  let pool: PositionedPortfolio[] = Array.from({ length: 40 }, () => mk(rng));
  const a = freshSweepCursor();
  const b = freshSweepCursor();
  let mismatches = 0;
  for (let round = 0; round < 10_000; round++) {
    // Churn the positioned set.
    if (rng() < 0.15 && pool.length > 3) pool.splice(Math.floor(rng() * pool.length), 1);
    if (rng() < 0.2) pool.push(mk(rng));
    const k = Math.floor(rng() * 9) - 1; // -1..7, includes k<=0
    const epochs: SideEpochs | null = rng() < 0.2 ? null : { long: BigInt(Math.floor(rng() * 3)), short: BigInt(Math.floor(rng() * 3)) };
    const exclude = new Set<string>();
    for (const p of pool) if (rng() < 0.1) exclude.add(refB58(p.pubkey));
    const pa = selectSweepBatch(pool, a, k, exclude, epochs);
    const pb = refSelect(pool, b, k, exclude, epochs);
    if (pa.length !== pb.length || pa.some((p, i) => p !== pb[i])) mismatches++;
    const landed = pa.filter(() => rng() < 0.8).map((p) => p.pubkey);
    markVisited(a, landed);
    refMark(b, landed);
    if (rng() < 0.3) {
      pruneVisits(a, pool);
      refPrune(b, pool);
    }
    if (rng() < 0.3 && pool.length > 0) {
      // Fresh entries: new PublicKey objects with equal bytes, plus an unknown one.
      const fresh = pool.filter(() => rng() < 0.3).map((p) => mk(rng, new PublicKey(p.pubkey.toBytes())));
      fresh.push(mk(rng));
      const pool2 = pool.slice();
      refreshPositionedFrom(pool, fresh);
      refRefresh(pool2, fresh);
      if (pool.some((p, i) => p !== pool2[i])) mismatches++;
    }
    if (a.roundStart !== b.roundStart || a.seq !== b.seq || a.roundPending !== b.roundPending) mismatches++;
    if (JSON.stringify([...a.visits]) !== JSON.stringify([...b.visits])) mismatches++;
  }
  assert.equal(mismatches, 0);
});
