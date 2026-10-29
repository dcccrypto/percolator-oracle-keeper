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
