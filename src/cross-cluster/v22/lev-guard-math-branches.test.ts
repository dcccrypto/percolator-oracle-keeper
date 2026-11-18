/**
 * Branch coverage for lev-guard-math.ts: piDefault age/kind arms, holderTerms defaults and exclusions, cpmmDumpBps / clampBps /
 * buildReport edges (zero, negative, u64 max, rounding at exact boundaries). Pure maths, no RPC.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BPS_MAX,
  S_DEFAULT,
  buildReport,
  clampBps,
  cpmmDumpBps,
  filterHolders,
  holderAttemptOrder,
  holderTerms,
  knownExcludedOwners,
  largestHolder,
  piDefault,
  totalsByOwner,
  TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  type HolderKind,
} from "./lev-guard-math.ts";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

describe("piDefault: every kind and age arm, exact boundaries", () => {
  for (const k of ["dev", "insider", "bundle"] as HolderKind[]) {
    it(`${k}`, () => {
      assert.equal(piDefault(k, 0), 0.01);
      assert.equal(piDefault(k, 6.999), 0.01);
      assert.equal(piDefault(k, 7), 0.002);
      assert.equal(piDefault(k, 29.999), 0.002);
      assert.equal(piDefault(k, 30), 0.0005);
      assert.equal(piDefault(k, -1), 0.01);
    });
  }
  it("sniper", () => {
    assert.equal(piDefault("sniper", 0.999), 0.01);
    assert.equal(piDefault("sniper", 1), 0.002);
    assert.equal(piDefault("sniper", 6.999), 0.002);
    assert.equal(piDefault("sniper", 7), 0.0005);
  });
  it("early", () => {
    assert.equal(piDefault("early", 6.999), 0.005);
    assert.equal(piDefault("early", 7), 0.0005);
  });
  it("flat kinds", () => {
    assert.equal(piDefault("whale", 0), 0.0005);
    assert.equal(piDefault("treasury", 0), 0.0002);
    assert.equal(piDefault("top10", 0), 0.0001);
    assert.equal(piDefault("cex", 0), 0.0001);
  });
  it("unlock window", () => {
    assert.equal(piDefault("unlock", 0), 0.0);
    assert.equal(piDefault("unlock", 0, false), 0.0);
    assert.equal(piDefault("unlock", 0, true), 0.02);
  });
  it("unknown kind falls to the 0.0005 default", () => {
    assert.equal(piDefault("zzz" as HolderKind, 0), 0.0005);
  });
});

describe("holderTerms: defaults, overrides, individual exclusions", () => {
  it("empty list is all zero", () => {
    assert.deepEqual(holderTerms([], 0.5, 1), { J: 0, mInd: 0, H: 0 });
  });
  it("s and pi default from the kind tables; explicit values override", () => {
    const d = holderTerms([{ kind: "sniper", frac: 0.1 }], 0.2, 0);
    const m = 1 - (0.2 / (0.2 + S_DEFAULT.sniper * 0.1)) ** 2;
    assert.equal(d.J, 0.5 * m); // sniper age 0: pi 0.01 / P_TGT 0.02 = 0.5
    const o = holderTerms([{ kind: "sniper", frac: 0.1, s: 1, pi: 0.5 }], 0.2, 0);
    const m1 = 1 - (0.2 / 0.3) ** 2;
    assert.ok(Math.abs(o.J - m1) < 1e-12); // w capped at 1
    assert.ok(Math.abs(o.H - 0.5 * m1) < 1e-12);
  });
  it("top10 and early never size m_ind; individual:false never does either", () => {
    for (const kind of ["top10", "early"] as HolderKind[]) assert.equal(holderTerms([{ kind, frac: 0.3 }], 0.1, 0).mInd, 0);
    assert.equal(holderTerms([{ kind: "whale", frac: 0.3, individual: false }], 0.1, 0).mInd, 0);
    const r = holderTerms([{ kind: "whale", frac: 0.3, individual: true }], 0.1, 0);
    assert.ok(r.mInd > 0);
  });
  it("m_ind uses the full balance (s = 1) while J uses s", () => {
    const r = holderTerms([{ kind: "cex", frac: 0.2, pi: 0.02 }], 0.2, 0);
    assert.ok(r.mInd > r.J);
  });
  it("inUnlock flows through to the unlock kind's pi", () => {
    assert.equal(holderTerms([{ kind: "unlock", frac: 0.2 }], 0.2, 0, false).J, 0);
    assert.ok(holderTerms([{ kind: "unlock", frac: 0.2 }], 0.2, 0, true).J > 0);
  });
  it("xFrac 0 -> m = 1", () => {
    assert.equal(holderTerms([{ kind: "dev", frac: 0.1, pi: 0.02 }], 0, 0).J, 1);
  });
});

describe("cpmmDumpBps edges", () => {
  it("q <= 0 is 0 (checked before r), r <= 0 is 100 %", () => {
    assert.equal(cpmmDumpBps(0n, 0n), 0);
    assert.equal(cpmmDumpBps(5n, -1n), 0);
    assert.equal(cpmmDumpBps(-5n, 0n), 0);
    assert.equal(cpmmDumpBps(0n, 1n), BPS_MAX);
    assert.equal(cpmmDumpBps(-1n, 1n), BPS_MAX);
  });
  it("u64 max reserve and quantity", () => {
    assert.equal(cpmmDumpBps(U64_MAX, 1n), 1); // ratio floors to 999999999, so kept = 9999: rounded up, never 0
    assert.equal(cpmmDumpBps(1n, U64_MAX), BPS_MAX);
    assert.equal(cpmmDumpBps(U64_MAX, U64_MAX), 7500);
  });
  it("rounding is UP: r == q keeps 25 %, one unit of drift rounds the dump up", () => {
    assert.equal(cpmmDumpBps(1000n, 1000n), 7500);
    // ratio = floor(3e9/4) exact; r=1,q=2: ratio = 333333333, kept = floor(1.111e17/1e14)=1111 -> 8889
    assert.equal(cpmmDumpBps(1n, 2n), 8889);
    // never below the real-valued dump
    for (const [r, q] of [[1n, 3n], [7n, 11n], [999n, 1n], [123456789n, 987654321n]] as Array<[bigint, bigint]>) {
      const exact = 1 - (Number(r) / Number(r + q)) ** 2;
      assert.ok(cpmmDumpBps(r, q) >= Math.floor(exact * BPS_MAX));
      assert.ok(cpmmDumpBps(r, q) <= BPS_MAX);
    }
  });
});

describe("clampBps edges", () => {
  it("non-finite -> null", () => {
    assert.equal(clampBps(NaN), null);
    assert.equal(clampBps(Infinity), null);
    assert.equal(clampBps(-Infinity), null);
  });
  it("clamps to [0, 10000] and rounds up with a 1e-9 tolerance", () => {
    assert.equal(clampBps(-5), 0);
    assert.equal(clampBps(-0.5), 0);
    assert.equal(clampBps(0), 0);
    assert.equal(clampBps(1e-10), 0);
    assert.equal(clampBps(1e-8), 1);
    assert.equal(clampBps(0.5), 1);
    assert.equal(clampBps(1234.0000000001), 1234);
    assert.equal(clampBps(1234.001), 1235);
    assert.equal(clampBps(10_000), 10_000);
    assert.equal(clampBps(10_000.5), 10_000);
    assert.equal(clampBps(1e30), 10_000);
  });
});

describe("buildReport edges", () => {
  const owners = [{ owner: "a", total: 100n }, { owner: "b", total: 300n }];
  it("non-positive supply or negative reserve -> null", () => {
    assert.equal(buildReport({ reserve: 1n, supply: 0n, ownerTotals: owners, ageDays: 1 }), null);
    assert.equal(buildReport({ reserve: 1n, supply: -1n, ownerTotals: owners, ageDays: 1 }), null);
    assert.equal(buildReport({ reserve: -1n, supply: 10n, ownerTotals: owners, ageDays: 1 }), null);
  });
  it("no holders -> all-zero report, no cap, no multiplier", () => {
    assert.deepEqual(buildReport({ reserve: 100n, supply: 1000n, ownerTotals: [], ageDays: 1 }), { jDumpBps: 0, mIndBps: 0, lCapX100: 0, nMultBps: 10_000 });
  });
  it("reserve 0 -> m_ind 100 %", () => {
    const r = buildReport({ reserve: 0n, supply: 1000n, ownerTotals: owners, ageDays: 1 })!;
    assert.equal(r.mIndBps, BPS_MAX);
    assert.equal(r.jDumpBps, 250); // whale pi 0.0005 -> w 0.025 * m 1 = 250 bps
  });
  it("m_ind is the largest owner's integer CPMM dump", () => {
    const r = buildReport({ reserve: 1000n, supply: 10_000n, ownerTotals: owners, ageDays: 1 })!;
    assert.equal(r.mIndBps, cpmmDumpBps(1000n, 300n));
  });
  it("u64-max reserve/supply: finite, clamped", () => {
    const r = buildReport({ reserve: U64_MAX, supply: U64_MAX, ownerTotals: [{ owner: "a", total: U64_MAX }], ageDays: 0 })!;
    assert.ok(r.jDumpBps >= 0 && r.jDumpBps <= BPS_MAX);
    assert.equal(r.mIndBps, 7500);
  });
  it("a non-finite J (xFrac overflow to Infinity) -> null", () => {
    // Number(huge) / Number(1n) overflows only past 1.8e308; build it from a giant bigint.
    const huge = 10n ** 400n;
    assert.equal(buildReport({ reserve: huge, supply: 1n, ownerTotals: [{ owner: "a", total: 1n }], ageDays: 1 }), null);
  });
});

describe("filter / ordering helpers: remaining arms", () => {
  const base = { address: "A", programOwner: TOKEN_PROGRAM, mint: "M", owner: "O", amount: 1n, state: 1 };
  const f = (owners: Map<string, { onCurve: boolean; accountOwner: string | null }>) => ({ baseMint: "M", poolVaults: new Set<string>(), excludedOwners: knownExcludedOwners([]), owners });
  it("owner with no account (null) and on curve is kept; off-curve dropped; unknown dropped", () => {
    assert.equal(filterHolders([base], f(new Map([["O", { onCurve: true, accountOwner: null }]]))).kept.length, 1);
    assert.equal(filterHolders([base], f(new Map([["O", { onCurve: true, accountOwner: SYSTEM_PROGRAM }]]))).kept.length, 1);
    assert.equal(filterHolders([base], f(new Map([["O", { onCurve: false, accountOwner: null }]]))).dropped[0].reason, "owner-off-curve");
    assert.equal(filterHolders([base], f(new Map())).dropped[0].reason, "owner-unknown");
  });
  it("largestHolder / holderAttemptOrder / totalsByOwner ties and empties", () => {
    assert.equal(largestHolder([]), null);
    const a = { address: "a", owner: "o", amount: 5n };
    const b = { address: "b", owner: "o", amount: 5n };
    const c = { address: "c", owner: "p", amount: 9n };
    assert.equal(largestHolder([b, a])!.address, "a");
    assert.equal(largestHolder([a, b])!.address, "a");
    assert.equal(largestHolder([a, c])!.address, "c");
    assert.deepEqual(holderAttemptOrder([b, a, c]).map((x) => x.address), ["c", "a", "b"]);
    assert.deepEqual(holderAttemptOrder([a, b, c]).map((x) => x.address), ["c", "a", "b"]);
    assert.deepEqual(totalsByOwner([a, b, c]), [{ owner: "o", total: 10n }, { owner: "p", total: 9n }]);
  });
});
