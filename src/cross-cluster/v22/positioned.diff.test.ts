/**
 * Differential test: optimised analysePortfolios / parseAccrueAnchors vs the frozen pre-optimisation copy
 * (positioned.reference.ts) over 10,000 random portfolios (incl. LP, keeper-flat anchors, matcher, override hits and
 * misses, wrong-length and undecodable accounts, duplicate keys). Results must deep-equal, Map contents included.
 *
 * Run: node --import tsx/esm --test src/cross-cluster/v22/positioned.diff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { analysePortfolios, parseAccrueAnchors } from "./positioned.ts";
import { analysePortfoliosRef, parseAccrueAnchorsRef } from "./positioned.reference.ts";
import { key, portfolioBytes } from "./test-helpers.ts";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const LEN = portfolioBytes({ owner: key(1) }).length;

function randKey(rng: () => number): PublicKey {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(rng() * 256);
  return new PublicKey(b);
}

describe("analysePortfolios == frozen reference", () => {
  it("10,000 random portfolios, 100 calls x 100 accounts", () => {
    const rng = makeRng(0xc0ffee);
    const keeper = key(200);
    const owners = [keeper, key(1), key(2), key(3)];
    // A pool of distinct byte patterns (parsing, not generation, is the slow part); keys are random per account.
    const pool: Uint8Array[] = [];
    for (let i = 0; i < 160; i++) {
      const n = Math.floor(rng() * 17); // 0..16 legs (0 = flat)
      const legs = Array.from({ length: n }, () => ({
        side: (rng() < 0.5 ? 0 : 1) as 0 | 1,
        basis: BigInt(Math.floor(rng() * 1e9)) * (rng() < 0.5 ? -1n : 1n),
        assetIndex: Math.floor(rng() * 4),
      }));
      pool.push(portfolioBytes({ owner: owners[Math.floor(rng() * owners.length)], capital: BigInt(Math.floor(rng() * 1e6)), pnl: BigInt(Math.floor(rng() * 1e6)) - 5n * 10n ** 5n, legs, matcher: rng() < 0.15 }));
    }
    let total = 0;
    let withMin = 0;
    let rejected = 0;
    for (let call = 0; call < 100; call++) {
      const accts: Array<{ pubkey: PublicKey; data: Uint8Array }> = [];
      for (let i = 0; i < 100; i++) {
        const r = rng();
        const pubkey = accts.length > 0 && rng() < 0.03 ? accts[Math.floor(rng() * accts.length)].pubkey : randKey(rng); // duplicate keys
        const data = r < 0.03 ? new Uint8Array(LEN - 1) : r < 0.06 ? new Uint8Array(LEN).fill(7) : pool[Math.floor(rng() * pool.length)];
        accts.push({ pubkey, data });
      }
      const pick = () => accts[Math.floor(rng() * accts.length)].pubkey;
      const mode = call % 4;
      const opts = {
        lpPortfolio: rng() < 0.8 ? pick() : rng() < 0.5 ? null : randKey(rng),
        portfolioLen: LEN,
        keeperOwner: rng() < 0.85 ? keeper : null,
        anchorOverride: mode === 0 ? null : mode === 1 ? pick() : mode === 2 ? randKey(rng) : pick(),
        ...(rng() < 0.5 ? { assetIndices: [0, 2] } : { assetIndex: Math.floor(rng() * 3) }),
      };
      const a = analysePortfolios(accts, opts);
      const b = analysePortfoliosRef(accts, opts);
      assert.deepEqual(a, b);
      assert.deepEqual([...a.minLegAbs.entries()], [...b.minLegAbs.entries()], "minLegAbs insertion order + contents");
      assert.equal(a.anchorOverrideRejected, b.anchorOverrideRejected);
      assert.equal(a.flatAnchor?.toBase58() ?? null, b.flatAnchor?.toBase58() ?? null);
      total += accts.length;
      withMin += a.minLegAbs.size;
      if (a.anchorOverrideRejected) rejected++;
    }
    assert.equal(total, 10_000);
    assert.ok(withMin > 500, `exercised minLegAbs (${withMin})`);
    assert.ok(rejected > 5, `exercised the override-rejected messages (${rejected})`);
  });
});

describe("parseAccrueAnchors == frozen reference", () => {
  it("random env lists, repeated calls (memo hit) and mutation isolation", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 300; i++) {
      const parts: string[] = [];
      const n = Math.floor(rng() * 6);
      for (let j = 0; j < n; j++) {
        const r = rng();
        parts.push(r < 0.1 ? "junk" : r < 0.2 ? `${randKey(rng).toBase58()}:` : r < 0.3 ? `${randKey(rng).toBase58()}:notakey` : ` ${randKey(rng).toBase58()} : ${randKey(rng).toBase58()} `.replace(/ : /, ":"));
      }
      const raw = i % 17 === 0 ? undefined : parts.join(",");
      const ref = parseAccrueAnchorsRef(raw);
      for (let k = 0; k < 3; k++) {
        const got = parseAccrueAnchors(raw);
        assert.deepEqual([...got.entries()].map(([m, a]) => [m, a.toBase58()]), [...ref.entries()].map(([m, a]) => [m, a.toBase58()]));
        got.set("x", key(1)); // a caller mutating its copy must not poison the memo
        got.clear();
      }
    }
  });
});
