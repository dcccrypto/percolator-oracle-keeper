import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRefundPlan,
  verifyRefundPlan,
  renderPlanTable,
  runCli,
  isPubkey,
  canonicalJson,
  RefundRefusal,
  SLAB_RENT_SINGLE_LAMPORTS,
  SLAB_RENT_MULTI_LAMPORTS,
  STAKE_RENT_LAMPORTS,
  MAX_PER_MARKET_LAMPORTS,
  MAX_PER_BATCH_LAMPORTS,
  type RefundPlan,
} from "./refund-plan.ts";

const C1 = "2iMPctKhzWuiAL9pSe6m2tezEsMPHgxHyD4ayBFuF948";
const C2 = "36LMUPAeyB3YB9bm6adeAzEanAGY3HnPe2ecbzSGHder";
const MK = ["HPrBtBY2gVS3iGcJYwijb67GHj2mjPnggCCCh9u1Fsnq", "GhpAVyeGxVahavueyssThRUnPHjNFXaJoxsQH7o54MYQ", "8ooNARShZb8vYkEeCQZ6dQQ96hD2Qh6a4iPLanTXWQr8", "G2tRpqhgKhUPawABrg6ivVZPgy4bUW5gbLq79frr8rHJ"];
const now = () => new Date("2026-11-16T00:00:00.000Z");
const e = (n: number, over: Record<string, unknown> = {}) => ({ market: MK[n]!, creator: C1, neverConnected: "no-registry-row", ...over });
const refusal = (re: RegExp) => (x: unknown): boolean => x instanceof RefundRefusal && re.test(x.message);
const build = (input: unknown, opts = {}) => buildRefundPlan(input, { now, ...opts });

test("isPubkey: rejects non-strings, bad lengths, bad alphabet and wrong decoded size", () => {
  assert.equal(isPubkey(C1), true);
  assert.equal(isPubkey(42), false);
  assert.equal(isPubkey("short"), false);
  assert.equal(isPubkey(C1 + "x".repeat(10)), false);
  assert.equal(isPubkey("0" + C1.slice(1)), false); // '0' not in base58
  assert.equal(isPubkey("1".repeat(32)), true); // 32 leading zero bytes
  assert.equal(isPubkey("1".repeat(33)), false); // 33 bytes
  assert.equal(isPubkey("z".repeat(44)), false); // decodes past 32 bytes
});

test("canonicalJson sorts keys and recurses arrays", () => {
  assert.equal(canonicalJson({ b: [1, { z: 1, a: 2 }], a: null }), '{"a":null,"b":[1,{"a":2,"z":1}]}');
});

test("input shape: non-object, bad markets type, and non-record array rows are refused", () => {
  assert.throws(() => build(null), refusal(/must be a JSON object/));
  assert.throws(() => build([]), refusal(/must be a JSON object/));
  assert.throws(() => build({ markets: 5 }), refusal(/array or a map/));
  assert.throws(() => build({ markets: ["junk"] }), refusal(/undefined: not a valid address/));
  assert.throws(() => build({ markets: [] }), refusal(/nothing to plan/));
});

test("map input from /health keeps only never-connected rows and takes creator from the creators map", () => {
  const p = build({
    creators: { [MK[0]!]: C2 },
    markets: {
      [MK[0]!]: { neverConnected: "no-accepted-push", multiAsset: true, registered: true, ageSlots: 123 },
      [MK[1]!]: { neverConnected: null },
      [MK[2]!]: { reason: undefined },
      [MK[3]!]: "not-a-record",
    },
  });
  assert.equal(p.markets.length, 1);
  const m = p.markets[0]!;
  assert.equal(m.market, MK[0]);
  assert.equal(m.creator, C2);
  assert.equal(m.multiAsset, true);
  assert.equal(m.totalLamports, SLAB_RENT_MULTI_LAMPORTS + STAKE_RENT_LAMPORTS);
  assert.deepEqual(m.evidence, { neverConnected: "no-accepted-push", registered: true, ageSlots: "123" });
});

test("evidence: non-boolean registered and non-string/number ageSlots become null; string ageSlots kept", () => {
  const a = build({ markets: [e(0, { registered: "yes", ageSlots: {} })] }).markets[0]!;
  assert.deepEqual(a.evidence, { neverConnected: "no-registry-row", registered: null, ageSlots: null });
  const b = build({ markets: [e(0, { registered: false, ageSlots: "99999999999" })] }).markets[0]!;
  assert.deepEqual(b.evidence, { neverConnected: "no-registry-row", registered: false, ageSlots: "99999999999" });
});

test("row-level refusals: invalid market, wrong classification, missing/invalid creator", () => {
  assert.throws(() => build({ markets: [e(0, { market: "nope" })] }), refusal(/not a valid address/));
  assert.throws(() => build({ markets: [e(0, { neverConnected: "connected" })] }), refusal(/not classified never-connected/));
  assert.throws(() => build({ markets: [e(0, { neverConnected: undefined })] }), refusal(/not classified never-connected/));
  assert.throws(() => build({ markets: [e(0, { creator: undefined })] }), refusal(/no creator wallet/));
  assert.throws(() => build({ markets: [e(0, { creator: null })] }), refusal(/no creator wallet/));
  assert.throws(() => build({ markets: [e(0, { creator: "bad" })] }), refusal(/creator "bad" is not a valid address/));
});

test("lamportsField: negative, fractional, string and unsafe amounts are refused; explicit amounts are used", () => {
  for (const bad of [-1, 1.5, "30000000", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => build({ markets: [e(0, { slabRentLamports: bad })] }), refusal(/slabRentLamports: must be a non-negative integer/));
    assert.throws(() => build({ markets: [e(0, { stakeRentLamports: bad })] }), refusal(/stakeRentLamports: must be a non-negative integer/));
  }
  const m = build({ markets: [e(0, { slabRentLamports: 1_000, stakeRentLamports: 0 })] }).markets[0]!;
  assert.deepEqual(m.components, { slabRentLamports: 1_000, stakeRentLamports: 0 });
  assert.equal(m.totalLamports, 1_000);
});

test("per-market cap boundary: exactly at the cap passes, one lamport over refuses", () => {
  const at = build({ markets: [e(0, { slabRentLamports: MAX_PER_MARKET_LAMPORTS - STAKE_RENT_LAMPORTS })] }).markets[0]!;
  assert.equal(at.totalLamports, MAX_PER_MARKET_LAMPORTS);
  assert.throws(() => build({ markets: [e(0, { slabRentLamports: MAX_PER_MARKET_LAMPORTS - STAKE_RENT_LAMPORTS + 1 })] }), refusal(new RegExp(`${MAX_PER_MARKET_LAMPORTS + 1} lamports exceeds the per-market cap ${MAX_PER_MARKET_LAMPORTS}`)));
});

test("cap overrides: lowering works and is recorded; raising, negative and fractional are refused", () => {
  const p = build({ markets: [e(0)] }, { perMarketCapLamports: 40_000_000, batchCapLamports: 50_000_000 });
  assert.deepEqual(p.caps, { perMarketLamports: 40_000_000, perBatchLamports: 50_000_000 });
  assert.throws(() => build({ markets: [e(0)] }, { perMarketCapLamports: MAX_PER_MARKET_LAMPORTS + 1 }), refusal(/per-market cap .* caps can be lowered, never raised/));
  assert.throws(() => build({ markets: [e(0)] }, { perMarketCapLamports: -1 }), refusal(/per-market cap/));
  assert.throws(() => build({ markets: [e(0)] }, { perMarketCapLamports: 1.5 }), refusal(/per-market cap/));
  assert.throws(() => build({ markets: [e(0)] }, { batchCapLamports: MAX_PER_BATCH_LAMPORTS + 1 }), refusal(/per-batch cap .* never raised/));
  assert.throws(() => build({ markets: [e(0)] }, { batchCapLamports: -5 }), refusal(/per-batch cap/));
  // a lowered per-market cap now rejects a default single-asset row (36_000_000 > 35_999_999)
  assert.throws(() => build({ markets: [e(0)] }, { perMarketCapLamports: SLAB_RENT_SINGLE_LAMPORTS + STAKE_RENT_LAMPORTS - 1 }), refusal(/36000000 lamports exceeds the per-market cap 35999999/));
});

test("batch cap: total over the cap refuses with the exact total, at-cap passes", () => {
  const two = { markets: [e(0), e(1)] }; // 2 x 36_000_000
  assert.throws(() => build(two, { batchCapLamports: 71_999_999 }), refusal(/batch total 72000000 lamports \(0\.072 SOL\) exceeds the per-batch cap 71999999/));
  const p = build(two, { batchCapLamports: 72_000_000 });
  assert.equal(p.totals.lamports, 72_000_000);
  assert.equal(p.totals.sol, "0.072");
});

test("duplicates: identical repeats are dropped and counted; conflicting creator or amount refuses", () => {
  const p = build({ markets: [e(0), e(0), e(0)] });
  assert.equal(p.markets.length, 1);
  assert.equal(p.totals.duplicatesDropped, 2);
  assert.equal(p.totals.lamports, SLAB_RENT_SINGLE_LAMPORTS + STAKE_RENT_LAMPORTS);
  assert.throws(() => build({ markets: [e(0), e(0, { creator: C2 })] }), refusal(/conflicting creator wallets/));
  assert.throws(() => build({ markets: [e(0), e(0, { multiAsset: true })] }), refusal(/repeated with conflicting amounts/));
});

test("rows are sorted by market address regardless of input order", () => {
  const p = build({ markets: [e(1), e(0), e(2)] });
  const got = p.markets.map((m) => m.market);
  assert.deepEqual(got, [...got].sort());
});

test("prior batches: plan, refunded list, array of strings and array of objects all block a repeat", () => {
  const first = build({ markets: [e(0)] });
  assert.throws(() => build({ markets: [e(0)] }, { prior: [first] }), refusal(/already refunded in a prior batch/));
  assert.throws(() => build({ markets: [e(0)] }, { prior: [{ refunded: [MK[0]] }] }), refusal(/already refunded/));
  assert.throws(() => build({ markets: [e(0)] }, { prior: [[MK[0]]] }), refusal(/already refunded/));
  assert.throws(() => build({ markets: [e(0)] }, { prior: [[{ market: MK[0] }]] }), refusal(/already refunded/));
  // unrelated prior does not block
  assert.equal(build({ markets: [e(1)] }, { prior: [first] }).markets[0]!.market, MK[1]);
});

test("prior batches: malformed files are refused rather than ignored", () => {
  assert.throws(() => build({ markets: [e(0)] }, { prior: ["str"] }), refusal(/not a plan, a `refunded` list or an array/));
  assert.throws(() => build({ markets: [e(0)] }, { prior: [{}] }), refusal(/not a plan/));
  assert.throws(() => build({ markets: [e(0)] }, { prior: [[42]] }), refusal(/entry with no market address/));
  assert.throws(() => build({ markets: [e(0)] }, { prior: [[{ market: 7 }]] }), refusal(/entry with no market address/));
});

function approved(over: Partial<RefundPlan> = {}): RefundPlan {
  const p = build({ markets: [e(0), e(1)] });
  return { ...p, status: "APPROVED", approval: { approver: "khubair", date: "2026-11-16", planHash: p.planHash }, ...over };
}

test("verify: a correctly approved plan is ok with no problems", () => {
  const r = verifyRefundPlan(approved());
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("verify: unapproved status, empty approver, bad date and wrong approval hash are each reported", () => {
  const p = build({ markets: [e(0)] });
  const r = verifyRefundPlan(p);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('status is "UNAPPROVED", not APPROVED'));
  assert.ok(r.problems.includes("approval.approver is empty"));
  assert.ok(r.problems.includes("approval.date is not an ISO date"));
  assert.ok(r.problems.includes("approval.planHash does not match the plan contents"));
  const ok = approved();
  assert.ok(verifyRefundPlan({ ...ok, approval: { ...ok.approval, approver: "  " } }).problems.includes("approval.approver is empty"));
  assert.ok(verifyRefundPlan({ ...ok, approval: { ...ok.approval, date: "2026-13-99" } }).problems.includes("approval.date is not an ISO date"));
  assert.ok(verifyRefundPlan({ ...ok, approval: { ...ok.approval, date: "yesterday" } }).problems.includes("approval.date is not an ISO date"));
  assert.equal(verifyRefundPlan({ ...ok, approval: { ...ok.approval, date: "2026-11-16T10:00:00Z" } }).ok, true);
  assert.ok(verifyRefundPlan({ ...ok, approval: undefined as never }).problems.includes("approval.planHash does not match the plan contents"));
});

test("verify: wrong kind/version and edited contents are reported", () => {
  const ok = approved();
  assert.ok(verifyRefundPlan({ ...ok, version: 2 as never }).problems.includes("not a version-1 never-connected refund plan"));
  assert.ok(verifyRefundPlan({ ...ok, kind: "other" as never }).problems.includes("not a version-1 never-connected refund plan"));
  const edited = { ...ok, markets: [{ ...ok.markets[0]!, creator: C2 }, ok.markets[1]!] };
  assert.ok(verifyRefundPlan(edited).problems.includes("planHash does not match the plan contents (the plan was edited)"));
});

test("verify: a hand-rehashed plan over cap, with bad totals, duplicates and bad addresses is still refused", () => {
  const base = build({ markets: [e(0), e(1)] });
  const bad: RefundPlan = {
    ...base,
    caps: { perMarketLamports: MAX_PER_MARKET_LAMPORTS + 1, perBatchLamports: MAX_PER_BATCH_LAMPORTS + 1 },
    totals: { ...base.totals, lamports: 1 },
    markets: [
      { ...base.markets[0]!, totalLamports: MAX_PER_MARKET_LAMPORTS + 1 },
      { ...base.markets[0]!, creator: "bad" },
    ],
  };
  const { problems } = verifyRefundPlan(bad);
  const m0 = base.markets[0]!.market;
  assert.ok(problems.includes("per-market cap missing or above the hard cap"));
  assert.ok(problems.includes("per-batch cap missing or above the hard cap"));
  assert.ok(problems.includes(`${m0}: total is not the sum of its components`));
  assert.ok(problems.includes(`${m0}: over the per-market cap`));
  assert.ok(problems.includes(`${m0}: invalid address`));
  assert.ok(problems.includes(`${m0}: duplicate market`));
  assert.ok(problems.includes("totals.lamports is not the sum of the markets"));
  // batch total over a (valid, lowered) per-batch cap
  assert.ok(verifyRefundPlan({ ...base, caps: { perMarketLamports: 40_000_000, perBatchLamports: 71_999_999 } }).problems.includes("batch total is over the per-batch cap"));
  assert.ok(!verifyRefundPlan({ ...base, caps: { perMarketLamports: 40_000_000, perBatchLamports: 72_000_000 } }).problems.includes("batch total is over the per-batch cap"));
});

test("verify: missing caps and markets do not throw and are reported", () => {
  const ok = approved();
  const r = verifyRefundPlan({ ...ok, caps: undefined as never, markets: undefined as never, totals: undefined as never });
  assert.ok(r.problems.includes("per-market cap missing or above the hard cap"));
  assert.ok(r.problems.includes("per-batch cap missing or above the hard cap"));
  assert.ok(r.problems.includes("totals.lamports is not the sum of the markets"));
});

test("verify: a non-plan value that cannot be hashed is reported as unreadable", () => {
  const r = verifyRefundPlan(null as never);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["plan is not a readable plan document"]);
  assert.equal(r.computedHash, "");
});

test("renderPlanTable: approved plan omits the approve hint; unapproved includes it; SOL formatting is exact", () => {
  const p = build({ markets: [e(0, { slabRentLamports: 100_000_000, stakeRentLamports: 6_000_000 })] });
  const un = renderPlanTable(p);
  assert.match(un, /status=UNAPPROVED/);
  assert.match(un, /To approve:/);
  assert.match(un, / 0\.1 +0\.006 +0\.106 +no-registry-row/);
  assert.match(un, /TOTAL {2}1 markets {2}106000000 lamports {2}0\.106 SOL {3}caps: 0\.11 SOL\/market, 1\.0 SOL\/batch/);
  const ap = renderPlanTable({ ...p, status: "APPROVED" });
  assert.doesNotMatch(ap, /To approve:/);
  assert.match(ap, new RegExp(`planHash {2}${p.planHash}`));
});

function cli(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, now);
  return { code, out, err };
}

test("cli: usage errors return 2", () => {
  for (const argv of [[], ["bogus"], ["plan", "--input"], ["plan", "input"], ["plan"], ["verify"]]) {
    const r = cli(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err[0]!, /^usage:/);
  }
});

test("cli plan: stdout path prints JSON then table; --out writes file; cap and prior flags are applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-"));
  const inp = join(dir, "in.json");
  writeFileSync(inp, JSON.stringify({ markets: [e(0), e(1)] }));
  const r = cli(["plan", "--input", inp]);
  assert.equal(r.code, 0);
  assert.equal(r.out.length, 2);
  assert.equal((JSON.parse(r.out[0]!) as RefundPlan).totals.lamports, 72_000_000);
  assert.equal((JSON.parse(r.out[0]!) as RefundPlan).generatedAt, "2026-11-16T00:00:00.000Z");

  const outFile = join(dir, "plan.json");
  const w = cli(["plan", "--input", inp, "--out", outFile, "--per-market-cap-lamports", "40000000", "--batch-cap-lamports", "80000000"]);
  assert.equal(w.code, 0);
  assert.equal(w.out.length, 1);
  const written = JSON.parse(readFileSync(outFile, "utf8")) as RefundPlan;
  assert.deepEqual(written.caps, { perMarketLamports: 40_000_000, perBatchLamports: 80_000_000 });

  const over = cli(["plan", "--input", inp, "--batch-cap-lamports", "71999999"]);
  assert.equal(over.code, 1);
  assert.match(over.err[0]!, /^REFUSED: batch total 72000000 lamports/);

  const prior = cli(["plan", "--input", inp, "--prior", outFile]);
  assert.equal(prior.code, 1);
  assert.match(prior.err[0]!, /already refunded in a prior batch/);
});

test("cli plan: unreadable input and non-integer cap flags are refused with exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-"));
  const missing = cli(["plan", "--input", join(dir, "nope.json")]);
  assert.equal(missing.code, 1);
  assert.match(missing.err[0]!, /^REFUSED: cannot read .*nope\.json as JSON/);
  const inp = join(dir, "in.json");
  writeFileSync(inp, JSON.stringify({ markets: [e(0)] }));
  const bad = cli(["plan", "--input", inp, "--per-market-cap-lamports", "1.5"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err[0]!, /REFUSED: 1\.5 is not a lamport integer/);
});

test("cli verify: ok prints the hash; failure lists each problem; unreadable plan is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-"));
  const good = approved();
  const gp = join(dir, "good.json");
  writeFileSync(gp, JSON.stringify(good));
  const ok = cli(["verify", "--plan", gp]);
  assert.equal(ok.code, 0);
  assert.equal(ok.out[0], `OK: approved plan matches its hash ${good.planHash}`);

  const bp = join(dir, "bad.json");
  writeFileSync(bp, JSON.stringify(build({ markets: [e(0)] })));
  const bad = cli(["verify", "--plan", bp]);
  assert.equal(bad.code, 1);
  assert.match(bad.err[0]!, /^NOT VERIFIED:\n- status is "UNAPPROVED", not APPROVED\n- /);

  const np = join(dir, "notjson.json");
  writeFileSync(np, "{oops");
  const un = cli(["verify", "--plan", np]);
  assert.equal(un.code, 1);
  assert.match(un.err[0]!, /^REFUSED: cannot read/);
});

test("cli: a non-RefundRefusal error is rethrown, not swallowed", () => {
  const inp = join(mkdtempSync(join(tmpdir(), "rp-")), "in.json");
  writeFileSync(inp, JSON.stringify({ markets: [e(0)] }));
  assert.throws(() => runCli(["plan", "--input", inp], { out: () => { throw new TypeError("boom"); }, err: () => {} }, now), TypeError);
});

test("verify: negative or non-integer row amounts cannot offset an over-cap batch (rehashed, approved plan)", () => {
  const base = build({ markets: [e(0), e(1), e(2)] });
  const row = (i: number, slab: number, stake: number) => ({ ...base.markets[i]!, components: { slabRentLamports: slab, stakeRentLamports: stake }, totalLamports: slab + stake });
  const body = { ...base, caps: { perMarketLamports: 110_000_000, perBatchLamports: 100_000_000 }, markets: [row(0, 104_000_000, 6_000_000), row(1, 104_000_000, 6_000_000), row(2, -120_000_000, 0)], totals: { ...base.totals, lamports: 100_000_000 } };
  const p0 = { ...body, status: "APPROVED" as const, approval: { approver: "x", date: "2026-11-16", planHash: "" } };
  const hash = verifyRefundPlan(p0).computedHash;
  const plan: RefundPlan = { ...p0, planHash: hash, approval: { ...p0.approval, planHash: hash } };
  const r = verifyRefundPlan(plan);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes(`${base.markets[2]!.market}: amounts must be non-negative integer lamports`));
});

test("verify: fractional and unsafe-integer row amounts are rejected with the same reason", () => {
  const base = build({ markets: [e(0)] });
  for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
    const row = { ...base.markets[0]!, components: { slabRentLamports: bad, stakeRentLamports: 0 }, totalLamports: bad };
    const p0 = { ...base, markets: [row], status: "APPROVED" as const, approval: { approver: "x", date: "2026-11-16", planHash: "" } };
    const hash = verifyRefundPlan(p0).computedHash;
    const r = verifyRefundPlan({ ...p0, planHash: hash, approval: { ...p0.approval, planHash: hash } });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes(`${base.markets[0]!.market}: amounts must be non-negative integer lamports`), String(bad));
  }
});
