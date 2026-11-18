import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRefundPlan,
  verifyRefundPlan,
  renderPlanTable,
  runCli,
  RefundRefusal,
  SLAB_RENT_SINGLE_LAMPORTS,
  SLAB_RENT_MULTI_LAMPORTS,
  STAKE_RENT_LAMPORTS,
  MAX_PER_MARKET_LAMPORTS,
  MAX_PER_BATCH_LAMPORTS,
  type RefundPlan,
} from "./refund-plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const C1 = "2iMPctKhzWuiAL9pSe6m2tezEsMPHgxHyD4ayBFuF948";
const C2 = "36LMUPAeyB3YB9bm6adeAzEanAGY3HnPe2ecbzSGHder";
const MARKETS = ["HPrBtBY2gVS3iGcJYwijb67GHj2mjPnggCCCh9u1Fsnq", "GhpAVyeGxVahavueyssThRUnPHjNFXaJoxsQH7o54MYQ", "GEvNksQpnpfqdygoQzqNNgssUi6duL4oYv3ux7MvVvE", "8ooNARShZb8vYkEeCQZ6dQQ96hD2Qh6a4iPLanTXWQr8", "G2tRpqhgKhUPawABrg6ivVZPgy4bUW5gbLq79frr8rHJ"];
const M = (n: number): string => MARKETS[n]!;
const now = () => new Date("2026-10-29T00:00:00.000Z");
const entry = (n: number, over: Record<string, unknown> = {}) => ({ market: M(n), creator: C1, neverConnected: "no-registry-row", ...over });

test("single-asset market: slab + stake rent, evidence carried, totals", () => {
  const p = buildRefundPlan({ markets: [entry(0)] }, { now });
  assert.equal(p.status, "UNAPPROVED");
  assert.equal(p.markets.length, 1);
  const m = p.markets[0]!;
  assert.equal(m.creator, C1);
  assert.equal(m.components.slabRentLamports, SLAB_RENT_SINGLE_LAMPORTS);
  assert.equal(m.components.stakeRentLamports, STAKE_RENT_LAMPORTS);
  assert.equal(m.totalLamports, SLAB_RENT_SINGLE_LAMPORTS + STAKE_RENT_LAMPORTS);
  assert.match(m.reason, /no-registry-row/);
  assert.equal(p.totals.marketCount, 1);
  assert.equal(p.totals.lamports, m.totalLamports);
  assert.deepEqual(p.approval, { approver: null, date: null, planHash: null });
  assert.match(p.planHash, /^[0-9a-f]{64}$/);
});

test("multi-asset uses the larger slab rent and stays under the per-market cap", () => {
  const p = buildRefundPlan({ markets: [entry(0, { multiAsset: true })] }, { now });
  assert.equal(p.markets[0]!.components.slabRentLamports, SLAB_RENT_MULTI_LAMPORTS);
  assert.ok(p.markets[0]!.totalLamports <= MAX_PER_MARKET_LAMPORTS);
});

test("default caps are derived from policy amounts", () => {
  assert.ok(MAX_PER_MARKET_LAMPORTS >= SLAB_RENT_MULTI_LAMPORTS + STAKE_RENT_LAMPORTS);
  assert.ok(MAX_PER_MARKET_LAMPORTS < SLAB_RENT_MULTI_LAMPORTS + STAKE_RENT_LAMPORTS + 32_000_000, "the guard rent is not covered");
  assert.ok(MAX_PER_BATCH_LAMPORTS <= 1_000_000_000);
});

test("per-market cap: an over-cap component refuses the batch, never truncates", () => {
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: 500_000_000 })] }, { now }), (e: unknown) => e instanceof RefundRefusal && /per-market cap/.test(e.message));
});

test("per-batch cap: refuses when the sum is over, accepts exactly at the cap", () => {
  const per = SLAB_RENT_SINGLE_LAMPORTS + STAKE_RENT_LAMPORTS;
  const three = { markets: [entry(0), entry(1), entry(2)] };
  assert.throws(() => buildRefundPlan(three, { now, batchCapLamports: per * 3 - 1 }), (e: unknown) => e instanceof RefundRefusal && /per-batch cap/.test(e.message));
  const p = buildRefundPlan(three, { now, batchCapLamports: per * 3 });
  assert.equal(p.totals.lamports, per * 3);
});

test("caps can only be lowered, never raised above the hard defaults", () => {
  assert.throws(() => buildRefundPlan({ markets: [entry(0)] }, { now, batchCapLamports: MAX_PER_BATCH_LAMPORTS + 1 }), RefundRefusal);
  assert.throws(() => buildRefundPlan({ markets: [entry(0)] }, { now, perMarketCapLamports: MAX_PER_MARKET_LAMPORTS + 1 }), RefundRefusal);
});

test("dedupe: an identical repeated market is counted once; conflicting creators refuse", () => {
  const p = buildRefundPlan({ markets: [entry(0), entry(0)] }, { now });
  assert.equal(p.markets.length, 1);
  assert.equal(p.totals.duplicatesDropped, 1);
  assert.throws(() => buildRefundPlan({ markets: [entry(0), entry(0, { creator: C2 })] }, { now }), (e: unknown) => e instanceof RefundRefusal && /conflicting creator/.test(e.message));
});

test("prior batch: a market already refunded refuses the whole batch", () => {
  const prior = buildRefundPlan({ markets: [entry(0)] }, { now });
  assert.throws(() => buildRefundPlan({ markets: [entry(0), entry(1)] }, { now, prior: [prior] }), (e: unknown) => e instanceof RefundRefusal && /already refunded/.test(e.message));
  assert.doesNotThrow(() => buildRefundPlan({ markets: [entry(1)] }, { now, prior: [prior] }));
});

test("only never-connected markets are eligible; bad creator / bad market / empty refuse", () => {
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { neverConnected: null })] }, { now }), (e: unknown) => e instanceof RefundRefusal && /not classified never-connected/.test(e.message));
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { neverConnected: "healthy" })] }, { now }), RefundRefusal);
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { creator: undefined })] }, { now }), (e: unknown) => e instanceof RefundRefusal && /creator/.test(e.message));
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { creator: "not-a-key" })] }, { now }), RefundRefusal);
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: -1 })] }, { now }), RefundRefusal);
  assert.throws(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: 1.5 })] }, { now }), RefundRefusal);
  assert.throws(() => buildRefundPlan({ markets: [] }, { now }), RefundRefusal);
});

test("accepts the keeper health lifecycle shape (markets map) with a creators side map", () => {
  const input = {
    markets: { [M(0)]: { neverConnected: "not-oracle-authority", registered: true, classes: ["never-connected"] }, [M(1)]: { neverConnected: null, classes: ["dead-price-warn"] } },
    creators: { [M(0)]: C1 },
  };
  const p = buildRefundPlan(input, { now });
  assert.equal(p.markets.length, 1, "non-never-connected rows of the health map are skipped, not refused");
  assert.equal(p.markets[0]!.creator, C1);
  assert.match(p.markets[0]!.reason, /not-oracle-authority/);
});

function approved(p: RefundPlan): RefundPlan {
  return { ...p, status: "APPROVED", approval: { approver: "khubair", date: "2026-10-30", planHash: p.planHash } };
}

test("verify: unapproved fails; approved with matching hash passes", () => {
  const p = buildRefundPlan({ markets: [entry(0)] }, { now });
  assert.equal(verifyRefundPlan(p).ok, false);
  assert.equal(verifyRefundPlan(approved(p)).ok, true);
});

test("verify: any content edit after approval is caught", () => {
  const a = approved(buildRefundPlan({ markets: [entry(0)] }, { now }));
  const swapped = structuredClone(a); swapped.markets[0]!.creator = C2;
  assert.equal(verifyRefundPlan(swapped).ok, false);
  const bumped = structuredClone(a); bumped.markets[0]!.totalLamports += 1; bumped.totals.lamports += 1;
  assert.equal(verifyRefundPlan(bumped).ok, false);
  const wrongHash = structuredClone(a); wrongHash.approval.planHash = "0".repeat(64);
  assert.equal(verifyRefundPlan(wrongHash).ok, false);
  const noApprover = structuredClone(a); noApprover.approval.approver = "";
  assert.equal(verifyRefundPlan(noApprover).ok, false);
  const badDate = structuredClone(a); badDate.approval.date = "soon";
  assert.equal(verifyRefundPlan(badDate).ok, false);
});

test("verify: approval fields do not change the hash (so a human can fill them)", () => {
  const p = buildRefundPlan({ markets: [entry(0)] }, { now });
  assert.equal(verifyRefundPlan(approved(p)).computedHash, p.planHash);
});

test("verify: an approved plan that is over the caps is rejected even with a matching hash", () => {
  const p = buildRefundPlan({ markets: [entry(0)] }, { now });
  assert.equal(verifyRefundPlan({ ...approved(p), caps: { ...p.caps, perBatchLamports: 1 } }).ok, false);
});

test("table lists creator, market, components, total and the batch totals", () => {
  const t = renderPlanTable(buildRefundPlan({ markets: [entry(0), entry(1, { multiAsset: true })] }, { now }));
  assert.match(t, new RegExp(M(0)));
  assert.match(t, new RegExp(C1));
  assert.match(t, /TOTAL/);
  assert.match(t, /UNAPPROVED/);
});

function tmp(name: string, v: unknown): string {
  const d = mkd();
  const f = join(d, name); writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v)); return f;
}
let dir: string | null = null;
function mkd(): string { return (dir ??= mkdtempSync(join(tmpdir(), "refund-plan-"))); }

test("CLI: plan writes JSON and exits 0; over-cap exits non-zero and writes nothing", () => {
  const out: string[] = []; const err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  const inp = tmp("in.json", { markets: [entry(0)] });
  const o = join(mkd(), "plan.json");
  assert.equal(runCli(["plan", "--input", inp, "--out", o], io, now), 0);
  const written = JSON.parse(readFileSync(o, "utf8")) as RefundPlan;
  assert.equal(written.status, "UNAPPROVED");
  assert.equal(runCli(["verify", "--plan", o], io, now), 1);
  const o2 = join(mkd(), "plan2.json");
  const over = tmp("over.json", { markets: [entry(0, { stakeRentLamports: 900_000_000 })] });
  assert.equal(runCli(["plan", "--input", over, "--out", o2], io, now), 1);
  assert.throws(() => readFileSync(o2), "no plan file on refusal");
  assert.equal(runCli(["nonsense"], io, now), 2);
  assert.equal(runCli(["plan"], io, now), 2);
  const ap = tmp("approved.json", approved(written));
  assert.equal(runCli(["verify", "--plan", ap], io, now), 0);
});

test("CLI: a missing input file is a clean refusal, not a throw", () => {
  const io = { out: () => {}, err: () => {} };
  assert.equal(runCli(["plan", "--input", join(mkd(), "nope.json")], io, now), 1);
});

test("DRY-RUN GUARD: the tool sources contain no signing, key, tx-building, sending or network APIs", () => {
  const files = [join(here, "refund-plan.ts"), join(here, "../../../scripts/refund-plan.ts")];
  const forbidden: RegExp[] = [
    /sendTransaction/i, /sendRawTransaction/i, /sendAndConfirm/i, /signTransaction/i, /signAllTransactions/i, /\.sign\(/, /partialSign/,
    /Keypair/, /secretKey/i, /fromSecretKey/, /fromSeed/, /\bTransaction\b/, /VersionedTransaction/, /TransactionMessage/, /SystemProgram/, /\btransfer/i,
    /new\s+Connection/, /\bConnection\b/, /requestAirdrop/, /@solana\//, /@percolatorct\//, /\bfetch\s*\(/, /node:https?/, /from\s+["']https?["']/, /node:net/, /child_process/, /\bspawn/, /\bexec(Sync)?\b/,
    /process\.env/, /id\.json/, /\.config\/solana/, /\bWebSocket\b/, /rpc/i,
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const re of forbidden) assert.doesNotMatch(src, re, `${f} must not match ${re}`);
  }
});

// ── branch coverage: malformed / partial data, caps, priors, verify, render, CLI ─────────────────────────────────────
import { isPubkey, canonicalJson } from "./refund-plan.ts";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const refuses = (fn: () => unknown, re: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof RefundRefusal && re.test(e.message));
};
const approve = (p: RefundPlan): RefundPlan => ({ ...p, status: "APPROVED", approval: { approver: "ops", date: "2026-10-30", planHash: p.planHash } });
const good = (): RefundPlan => buildRefundPlan({ markets: [entry(0), entry(1, { multiAsset: true })] }, { now });

test("isPubkey: rejects non-strings, bad length, bad alphabet, wrong decoded size, accepts leading-1 keys", () => {
  assert.equal(isPubkey(42), false);
  assert.equal(isPubkey("short"), false);
  assert.equal(isPubkey("1".repeat(45)), false);
  assert.equal(isPubkey("0".repeat(40)), false); // '0' not in base58
  assert.equal(isPubkey("z".repeat(44)), false); // decodes to > 32 bytes
  assert.equal(isPubkey("1".repeat(32)), true); // 32 zero bytes (system program)
  assert.equal(isPubkey(C1), true);
});

test("canonicalJson sorts keys and handles arrays/primitives", () => {
  assert.equal(canonicalJson({ b: [1, { z: 1, a: null }], a: "x" }), '{"a":"x","b":[1,{"a":null,"z":1}]}');
});

test("input shape: non-object, bad markets type, row that is not a record", () => {
  refuses(() => buildRefundPlan(null), /JSON object/);
  refuses(() => buildRefundPlan([]), /JSON object/);
  refuses(() => buildRefundPlan({ markets: 5 }), /array or a map/);
  refuses(() => buildRefundPlan({ markets: ["x"] }), /not a valid address/);
});

test("map input keeps only never-connected rows and takes creator from the creators map", () => {
  const p = buildRefundPlan(
    { creators: { [M(0)]: C2 }, markets: { [M(0)]: { neverConnected: "no-accepted-push" }, [M(1)]: { neverConnected: null }, [M(2)]: { neverConnected: undefined }, [M(3)]: "junk" } },
    { now },
  );
  assert.equal(p.markets.length, 1);
  assert.equal(p.markets[0]!.creator, C2);
  assert.equal(p.markets[0]!.evidence.neverConnected, "no-accepted-push");
});

test("array row: non-record market refused; creators map ignored when not a record; reason fallback field used", () => {
  refuses(() => buildRefundPlan({ markets: [null] }), /not a valid address/);
  refuses(() => buildRefundPlan({ creators: [C1], markets: [{ market: M(0), neverConnected: "no-registry-row" }] }), /no creator wallet/);
  const p = buildRefundPlan({ markets: [{ market: M(0), creator: C1, reason: "no-registry-row" }] }, { now });
  assert.equal(p.markets[0]!.evidence.neverConnected, "no-registry-row");
});

test("refusals: unclassified, null creator, invalid creator, non-numeric/negative/fractional amounts", () => {
  refuses(() => buildRefundPlan({ markets: [entry(0, { neverConnected: "healthy" })] }), /not classified never-connected/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { creator: null })] }), /no creator wallet/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { creator: "nope" })] }), /creator "nope" is not a valid/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: "5" })] }), /slabRentLamports: must be a non-negative integer/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: -1 })] }), /non-negative integer/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { stakeRentLamports: 1.5 })] }), /stakeRentLamports/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { stakeRentLamports: Number.MAX_SAFE_INTEGER + 1 })] }), /stakeRentLamports/);
});

test("amount edges: zero amounts allowed; exactly-at-cap passes; one over refuses", () => {
  const z = buildRefundPlan({ markets: [entry(0, { slabRentLamports: 0, stakeRentLamports: 0 })] }, { now });
  assert.equal(z.markets[0]!.totalLamports, 0);
  assert.equal(z.totals.sol, "0.0");
  const at = buildRefundPlan({ markets: [entry(0, { slabRentLamports: MAX_PER_MARKET_LAMPORTS - 1, stakeRentLamports: 1 })] }, { now });
  assert.equal(at.markets[0]!.totalLamports, MAX_PER_MARKET_LAMPORTS);
  refuses(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: MAX_PER_MARKET_LAMPORTS, stakeRentLamports: 1 })] }), /exceeds the per-market cap/);
  refuses(() => buildRefundPlan({ markets: [entry(0, { slabRentLamports: Number.MAX_SAFE_INTEGER })] }), /exceeds the per-market cap/);
});

test("evidence: registered boolean and ageSlots string/number carried, other types become null", () => {
  const p = buildRefundPlan({ markets: [entry(0, { registered: false, ageSlots: "123" }), entry(1, { registered: "yes", ageSlots: 77 }), entry(2, { ageSlots: {} })] }, { now });
  const by = Object.fromEntries(p.markets.map((m) => [m.market, m.evidence]));
  assert.deepEqual(by[M(0)], { neverConnected: "no-registry-row", registered: false, ageSlots: "123" });
  assert.deepEqual(by[M(1)], { neverConnected: "no-registry-row", registered: null, ageSlots: "77" });
  assert.deepEqual(by[M(2)], { neverConnected: "no-registry-row", registered: null, ageSlots: null });
});

test("duplicates: identical repeat dropped and counted; conflicting creator or amount refuses", () => {
  const p = buildRefundPlan({ markets: [entry(0), entry(0), entry(0)] }, { now });
  assert.equal(p.markets.length, 1);
  assert.equal(p.totals.duplicatesDropped, 2);
  refuses(() => buildRefundPlan({ markets: [entry(0), entry(0, { creator: C2 })] }), /conflicting creator wallets/);
  refuses(() => buildRefundPlan({ markets: [entry(0), entry(0, { multiAsset: true })] }), /repeated with conflicting amounts/);
});

test("same creator owning several markets is fine; plan is sorted by market address", () => {
  const p = buildRefundPlan({ markets: [entry(2), entry(0), entry(1)] }, { now });
  assert.deepEqual(p.markets.map((m) => m.market), [M(0), M(1), M(2)].sort());
  assert.ok(p.markets.every((m) => m.creator === C1));
});

test("cap options: lower-only and integer-only; batch cap enforced with nothing truncated", () => {
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { perMarketCapLamports: MAX_PER_MARKET_LAMPORTS + 1 }), /never raised/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { perMarketCapLamports: -1 }), /never raised/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { perMarketCapLamports: 1.5 }), /never raised/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { batchCapLamports: MAX_PER_BATCH_LAMPORTS + 1 }), /never raised/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { batchCapLamports: -5 }), /never raised/);
  refuses(() => buildRefundPlan({ markets: [entry(0), entry(1)] }, { batchCapLamports: 2 * 36_000_000 - 1 }), /per-batch cap/);
  const ok = buildRefundPlan({ markets: [entry(0), entry(1)] }, { batchCapLamports: 2 * 36_000_000, now });
  assert.equal(ok.caps.perBatchLamports, 72_000_000);
  assert.equal(ok.totals.lamports, 72_000_000);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { perMarketCapLamports: 35_999_999 }), /per-market cap/);
});

test("empty / no eligible markets refused", () => {
  refuses(() => buildRefundPlan({ markets: [] }), /nothing to plan/);
  refuses(() => buildRefundPlan({ markets: { [M(0)]: { neverConnected: null } } }), /nothing to plan/);
});

test("prior: plan object, refunded list, bare array of strings/objects all block; malformed priors refuse", () => {
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [{ markets: [{ market: M(0) }] }] }), /already refunded/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [{ refunded: [M(0)] }] }), /already refunded/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [[M(0)]] }), /already refunded/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [[{ market: M(0) }]] }), /already refunded/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: ["str"] }), /not a plan/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [{}] }), /not a plan/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [[5]] }), /no market address/);
  refuses(() => buildRefundPlan({ markets: [entry(0)] }, { prior: [[{ market: 5 }]] }), /no market address/);
  const p = buildRefundPlan({ markets: [entry(0)] }, { prior: [[M(1)], { refunded: [] }], now });
  assert.equal(p.markets.length, 1);
});

test("default clock is used when none supplied", () => {
  const p = buildRefundPlan({ markets: [entry(0)] });
  assert.ok(Math.abs(Date.parse(p.generatedAt) - Date.now()) < 60_000);
});

test("verify: good approved plan passes; hash is stable", () => {
  const p = approve(good());
  const r = verifyRefundPlan(p);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.computedHash, p.planHash);
});

test("verify: unreadable doc, wrong kind/version, unapproved, edited, bad approval fields", () => {
  const bad = verifyRefundPlan(null as unknown as RefundPlan);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, ["plan is not a readable plan document"]);
  const p = good();
  assert.match(verifyRefundPlan(p).problems.join("|"), /status is "UNAPPROVED"/);
  assert.match(verifyRefundPlan({ ...approve(p), kind: "x" } as unknown as RefundPlan).problems.join("|"), /not a version-1/);
  assert.match(verifyRefundPlan({ ...approve(p), version: 2 } as unknown as RefundPlan).problems.join("|"), /not a version-1/);
  const ap = approve(p);
  assert.match(verifyRefundPlan({ ...ap, approval: { approver: "  ", date: "2026-10-30", planHash: p.planHash } }).problems.join("|"), /approver is empty/);
  assert.match(verifyRefundPlan({ ...ap, approval: { approver: "a", date: "30/10/2026", planHash: p.planHash } }).problems.join("|"), /not an ISO date/);
  assert.match(verifyRefundPlan({ ...ap, approval: { approver: "a", date: "2026-13-45", planHash: p.planHash } }).problems.join("|"), /not an ISO date/);
  assert.equal(verifyRefundPlan({ ...ap, approval: { approver: "a", date: "2026-10-30T10:00:00.000Z", planHash: p.planHash } }).ok, true);
  assert.match(verifyRefundPlan({ ...ap, approval: { approver: "a", date: "2026-10-30", planHash: "0".repeat(64) } }).problems.join("|"), /approval.planHash does not match/);
  const noApproval = verifyRefundPlan({ ...ap, approval: undefined } as unknown as RefundPlan);
  assert.match(noApproval.problems.join("|"), /approver is empty/);
  assert.match(noApproval.problems.join("|"), /not an ISO date/);
  assert.match(noApproval.problems.join("|"), /approval.planHash does not match/);
  const edited = { ...ap, markets: [{ ...ap.markets[0]!, reason: "tampered" }, ap.markets[1]!] };
  assert.match(verifyRefundPlan(edited).problems.join("|"), /planHash does not match the plan contents/);
});

test("verify: re-checks caps and totals even when the hash is recomputed by hand", () => {
  const rehash = (p: RefundPlan): RefundPlan => {
    const { status: _s, approval: _a, planHash: _h, ...body } = p;
    const h = createHash("sha256").update(canonicalJson(body)).digest("hex");
    return { ...p, planHash: h, approval: { ...p.approval, planHash: h } };
  };
  const ap = approve(good());
  const probs = (p: RefundPlan): string => verifyRefundPlan(rehash(p)).problems.join("|");
  assert.equal(verifyRefundPlan(rehash(ap)).ok, true);
  assert.match(probs({ ...ap, caps: { ...ap.caps, perMarketLamports: MAX_PER_MARKET_LAMPORTS + 1 } }), /per-market cap missing or above/);
  assert.match(probs({ ...ap, caps: { ...ap.caps, perBatchLamports: MAX_PER_BATCH_LAMPORTS + 1 } }), /per-batch cap missing or above/);
  assert.match(probs({ ...ap, caps: undefined } as unknown as RefundPlan), /per-market cap missing/);
  const m0 = ap.markets[0]!;
  assert.match(probs({ ...ap, markets: [{ ...m0, totalLamports: m0.totalLamports + 1 }, ap.markets[1]!] }), /total is not the sum of its components/);
  const over = { ...m0, components: { slabRentLamports: MAX_PER_MARKET_LAMPORTS + 1, stakeRentLamports: 0 }, totalLamports: MAX_PER_MARKET_LAMPORTS + 1 };
  assert.match(probs({ ...ap, markets: [over] }), /over the per-market cap/);
  assert.match(probs({ ...ap, markets: [{ ...m0, creator: "bad" }, ap.markets[1]!] }), /invalid address/);
  assert.match(probs({ ...ap, markets: [{ ...m0, market: "bad" }, ap.markets[1]!] }), /invalid address/);
  assert.match(probs({ ...ap, markets: [m0, m0] }), /duplicate market/);
  assert.match(probs({ ...ap, totals: { ...ap.totals, lamports: 1 } }), /totals.lamports is not the sum/);
  assert.match(probs({ ...ap, totals: undefined } as unknown as RefundPlan), /totals.lamports is not the sum/);
  assert.match(probs({ ...ap, caps: { perMarketLamports: 110_000_000, perBatchLamports: 1 } }), /batch total is over the per-batch cap/);
});

test("renderPlanTable: unapproved shows approval hint; approved omits it; alignment and totals", () => {
  const p = good();
  const t = renderPlanTable(p);
  assert.match(t, /status=UNAPPROVED/);
  assert.match(t, /To approve:/);
  assert.match(t, new RegExp(`planHash  ${p.planHash}`));
  assert.match(t, /TOTAL  2 markets  142000000 lamports  0.142 SOL   caps: 0.11 SOL\/market, 1.0 SOL\/batch/);
  assert.ok(t.split("\n").every((l) => l === l.trimEnd()));
  const t2 = renderPlanTable(approve(p));
  assert.match(t2, /status=APPROVED/);
  assert.doesNotMatch(t2, /To approve:/);
});

test("CLI: usage errors exit 2 and write nothing", () => {
  const cap = () => { const o: string[] = [], e: string[] = []; return { o, e, io: { out: (s: string) => void o.push(s), err: (s: string) => void e.push(s) } }; };
  for (const argv of [[], ["bogus"], ["plan", "--input"], ["plan", "input"], ["plan"], ["verify"], ["plan", "--input", "a", "stray"]]) {
    const c = cap();
    assert.equal(runCli(argv, c.io, now), 2, JSON.stringify(argv));
    assert.match(c.e.join("\n"), /usage:/);
    assert.deepEqual(c.o, []);
  }
});

test("CLI plan/verify end to end: --out writes file, flags parsed, refusals exit 1, no stdout JSON when --out", () => {
  const d = mkdtempSync(join(tmpdir(), "refund-cov-"));
  const input = join(d, "in.json");
  const out = join(d, "plan.json");
  writeFileSync(input, JSON.stringify({ markets: [entry(0), entry(1)] }));
  const o: string[] = [], e: string[] = [];
  const io = { out: (s: string) => void o.push(s), err: (s: string) => void e.push(s) };
  assert.equal(runCli(["plan", "--input", input, "--out", out, "--per-market-cap-lamports", "50000000", "--batch-cap-lamports", "100000000"], io, now), 0);
  assert.equal(o.length, 1); // table only
  const plan = JSON.parse(readFileSync(out, "utf8")) as RefundPlan;
  assert.deepEqual(plan.caps, { perMarketLamports: 50_000_000, perBatchLamports: 100_000_000 });
  assert.equal(plan.generatedAt, "2026-10-29T00:00:00.000Z");
  // without --out: JSON then table on stdout, plan not written elsewhere
  o.length = 0;
  assert.equal(runCli(["plan", "--input", input], io, now), 0);
  assert.equal(o.length, 2);
  assert.equal((JSON.parse(o[0]!) as RefundPlan).kind, "never-connected-rent-refund-plan");
  // real clock when `now` omitted
  o.length = 0;
  assert.equal(runCli(["plan", "--input", input], io), 0);
  // prior file blocks, as does bad int flag and missing file / bad JSON
  const prior = join(d, "prior.json");
  writeFileSync(prior, JSON.stringify({ refunded: [M(0)] }));
  e.length = 0;
  assert.equal(runCli(["plan", "--input", input, "--prior", prior, "--out", join(d, "nope.json")], io, now), 1);
  assert.match(e[0]!, /^REFUSED: .*already refunded/);
  assert.equal(existsSync(join(d, "nope.json")), false);
  e.length = 0;
  assert.equal(runCli(["plan", "--input", input, "--batch-cap-lamports", "12x"], io, now), 1);
  assert.match(e[0]!, /not a lamport integer/);
  e.length = 0;
  assert.equal(runCli(["plan", "--input", join(d, "missing.json")], io, now), 1);
  assert.match(e[0]!, /cannot read .* as JSON/);
  const junk = join(d, "junk.json");
  writeFileSync(junk, "{not json");
  e.length = 0;
  assert.equal(runCli(["verify", "--plan", junk], io, now), 1);
  assert.match(e[0]!, /cannot read/);
  // verify: unapproved fails, approved passes
  e.length = 0;
  assert.equal(runCli(["verify", "--plan", out], io, now), 1);
  assert.match(e[0]!, /^NOT VERIFIED:\n- /);
  const apPath = join(d, "approved.json");
  writeFileSync(apPath, JSON.stringify(approve(plan)));
  o.length = 0;
  assert.equal(runCli(["verify", "--plan", apPath], io, now), 0);
  assert.equal(o[0], `OK: approved plan matches its hash ${plan.planHash}`);
});

test("CLI rethrows non-refusal errors", () => {
  const d = mkdtempSync(join(tmpdir(), "refund-cov-"));
  const p = join(d, "p.json");
  writeFileSync(p, "null"); // verify(null): verifyRefundPlan reports "not readable" itself, so the CLI returns 1 via NOT VERIFIED
  const io = { out: () => {}, err: () => {} };
  assert.equal(runCli(["verify", "--plan", p], io), 1);
  const boom = { out: () => { throw new Error("sink broke"); }, err: () => {} };
  const input = join(d, "i.json");
  writeFileSync(input, JSON.stringify({ markets: [entry(0)] }));
  assert.throws(() => runCli(["plan", "--input", input], boom, now), /sink broke/);
});
