/**
 * lev-guard-math.ts differential tests.
 *
 *  - cpmmDumpBps vs the program's `lev_guard_v22::cpmm_dump_bps` (percolator-prog feat/v22-rc23-2026-10-22 src/lev_guard_v22.rs): the vector file
 *    `fixtures/lev-guard-math/cpmm-vectors.txt` ("r q expected" per line) was produced by running that function verbatim (generator: gen-cpmm.rs,
 *    `rustc -O gen-cpmm.rs && ./gen-cpmm`). 24k rows: 144 edge pairs (0, 1, u64::MAX, r+q overflow of u64) plus xorshift-random.
 *  - holderTerms / piDefault vs the sim `ops/sims/v22lev/levmodel.py` (generator: gen-terms.py), 1e-12 tolerance (1 ULP pow noise).
 *  - filter, tie-break and per-owner split rules with crafted accounts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cpmmDumpBps, holderTerms, piDefault, S_DEFAULT, filterHolders, largestHolder, holderAttemptOrder, totalsByOwner, knownExcludedOwners,
  clampBps, buildReport, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, INCINERATOR,
  type Holder, type HolderKind, type TokenAccountView, type OwnerView, type FilterInput,
} from "./lev-guard-math.ts";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lev-guard-math");

describe("cpmmDumpBps vs Rust cpmm_dump_bps", () => {
  it("matches every vector (>= 20k incl. edges)", () => {
    const rows = fs.readFileSync(join(FX, "cpmm-vectors.txt"), "utf8").trim().split("\n");
    assert.ok(rows.length >= 20_000);
    let mismatches = 0;
    for (const line of rows) {
      const [r, q, e] = line.split(" ");
      if (cpmmDumpBps(BigInt(r), BigInt(q)) !== Number(e)) mismatches++;
    }
    assert.equal(mismatches, 0);
  });
  it("edges", () => {
    const U = (1n << 64n) - 1n;
    assert.equal(cpmmDumpBps(0n, 0n), 0);
    assert.equal(cpmmDumpBps(5n, 0n), 0);
    assert.equal(cpmmDumpBps(0n, 5n), 10_000);
    assert.equal(cpmmDumpBps(U, U), 7500);
    assert.equal(cpmmDumpBps(1n, U), 10_000);
  });
  it("non-positive inputs are treated as zero", () => {
    assert.equal(cpmmDumpBps(10n, -1n), 0);
    assert.equal(cpmmDumpBps(-1n, 10n), 10_000);
  });
});

interface TermCase { h: Array<{ kind: HolderKind; frac: number; s?: number; pi?: number; individual?: boolean }>; x: number; age: number; un: boolean; J: number; m: number; H: number; pis: Record<string, number> }

const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

describe("holderTerms / piDefault vs levmodel.py", () => {
  const cases = JSON.parse(fs.readFileSync(join(FX, "holder-terms.json"), "utf8")) as TermCase[];
  it("J, m_ind, H and pi defaults are equal within 1e-12", () => {
    assert.ok(cases.length >= 800);
    for (const c of cases) {
      const got = holderTerms(c.h as Holder[], c.x, c.age, c.un);
      // JS Math.pow vs C libm pow differ by <= 1 ULP on `** 2`; the report rounds to bps (ceil(x - 1e-9)), so 1e-12 is far below any effect.
      near(got.J, c.J);
      near(got.mInd, c.m);
      near(got.H, c.H);
      for (const k of Object.keys(S_DEFAULT) as HolderKind[]) assert.equal(piDefault(k, c.age, c.un), c.pis[k]);
    }
  });
  it("unknown kind falls to the 0.0005 default", () => {
    assert.equal(piDefault("zzz" as HolderKind, 1), 0.0005);
  });
});

const BASE = "BaseMint1111111111111111111111111111111111";
const acct = (address: string, owner: string, amount: bigint, o: Partial<TokenAccountView> = {}): TokenAccountView =>
  ({ address, programOwner: TOKEN_PROGRAM, mint: BASE, owner, amount, state: 1, ...o });
const wallet: OwnerView = { onCurve: true, accountOwner: SYSTEM_PROGRAM };
const input = (owners: Record<string, OwnerView>, extra: Partial<FilterInput> = {}): FilterInput => ({
  baseMint: BASE, poolVaults: new Set(["vault"]), excludedOwners: knownExcludedOwners(["poolauth"]), owners: new Map(Object.entries(owners)), ...extra,
});

describe("filterHolders", () => {
  it("applies each drop reason in order", () => {
    const f = input({ w: wallet, pda: { onCurve: false, accountOwner: null }, prog: { onCurve: true, accountOwner: "Prog" }, nullw: { onCurve: true, accountOwner: null } });
    const r = filterHolders([
      acct("vault", "w", 1n),
      acct("a1", "w", 1n, { programOwner: "Other" }),
      acct("a2", "w", 1n, { mint: "X" }),
      acct("a3", "w", 1n, { state: 0 }),
      acct("a3b", "w", 1n, { state: 2 }),
      acct("a4", "w", 0n),
      acct("a5", INCINERATOR, 1n),
      acct("a5b", "poolauth", 1n),
      acct("a6", "ghost", 1n),
      acct("a7", "prog", 1n),
      acct("a8", "pda", 1n),
      acct("ok", "w", 5n),
      acct("ok22", "nullw", 7n, { programOwner: TOKEN_2022_PROGRAM }),
    ], f);
    assert.deepEqual(Object.fromEntries(r.dropped.map((d) => [d.address, d.reason])), {
      vault: "pool-vault", a1: "not-a-token-account", a2: "wrong-mint", a3: "not-initialized", a3b: "not-initialized", a4: "empty",
      a5: "excluded-owner", a5b: "excluded-owner", a6: "owner-unknown", a7: "owner-program-owned", a8: "owner-off-curve",
    });
    assert.deepEqual(r.kept.map((k) => k.address), ["ok", "ok22"]);
  });
  it("known excluded owners", () => {
    const s = knownExcludedOwners([]);
    for (const a of [SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, INCINERATOR]) assert.ok(s.has(a));
  });
});

describe("largestHolder / holderAttemptOrder / totalsByOwner", () => {
  const c = (address: string, owner: string, amount: bigint) => ({ address, owner, amount });
  it("largest wins; ties go to the lower address; empty is null", () => {
    assert.equal(largestHolder([]), null);
    assert.equal(largestHolder([c("b", "o1", 5n), c("a", "o2", 5n), c("c", "o3", 4n)])?.address, "a");
    assert.equal(largestHolder([c("a", "o1", 5n), c("b", "o2", 5n)])?.address, "a");
    assert.equal(largestHolder([c("a", "o1", 4n), c("b", "o2", 9n)])?.address, "b");
  });
  it("attempt order: amount desc, tie by address asc, input untouched", () => {
    const k = [c("d", "o", 1n), c("b", "o", 5n), c("a", "o", 5n), c("c", "o", 9n)];
    assert.deepEqual(holderAttemptOrder(k).map((x) => x.address), ["c", "a", "b", "d"]);
    assert.deepEqual(k.map((x) => x.address), ["d", "b", "a", "c"]);
  });
  it("owner split: FULL balance summed across accounts", () => {
    const t = totalsByOwner([c("a1", "o1", 3n), c("a2", "o2", 4n), c("a3", "o1", 5n)]);
    assert.deepEqual(t, [{ owner: "o1", total: 8n }, { owner: "o2", total: 4n }]);
  });
});

describe("clampBps / buildReport", () => {
  it("clamps, rounds up, rejects non-finite", () => {
    assert.equal(clampBps(NaN), null);
    assert.equal(clampBps(Infinity), null);
    assert.equal(clampBps(-5), 0);
    assert.equal(clampBps(20_000), 10_000);
    assert.equal(clampBps(12.2), 13);
    assert.equal(clampBps(12.0000000001), 12);
  });
  it("report from a split owner uses the summed balance", () => {
    const split = buildReport({ reserve: 1000n, supply: 10_000n, ownerTotals: totalsByOwner([{ address: "a", owner: "o", amount: 500n }, { address: "b", owner: "o", amount: 500n }]), ageDays: 10 });
    const whole = buildReport({ reserve: 1000n, supply: 10_000n, ownerTotals: [{ owner: "o", total: 1000n }], ageDays: 10 });
    assert.deepEqual(split, whole);
    assert.equal(split?.mIndBps, cpmmDumpBps(1000n, 1000n));
    assert.equal(split?.lCapX100, 0);
    assert.equal(split?.nMultBps, 10_000);
  });
  it("null on bad supply / reserve / non-finite", () => {
    assert.equal(buildReport({ reserve: 1n, supply: 0n, ownerTotals: [], ageDays: 1 }), null);
    assert.equal(buildReport({ reserve: -1n, supply: 1n, ownerTotals: [], ageDays: 1 }), null);
    assert.equal(buildReport({ reserve: 0n, supply: 1n, ownerTotals: [{ owner: "o", total: 0n }], ageDays: 1 }), null); // 0/0 -> NaN
  });
  it("empty holders: zero report", () => {
    assert.deepEqual(buildReport({ reserve: 5n, supply: 100n, ownerTotals: [], ageDays: 1 }), { jDumpBps: 0, mIndBps: 0, lCapX100: 0, nMultBps: 10_000 });
  });
});
