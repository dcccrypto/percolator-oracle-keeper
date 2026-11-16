/**
 * cross-cluster/v22/refund-plan.ts
 *
 * D6 (memo v22-decisions-deep-2026-10-29): a capped, human-approved, DRY-RUN-ONLY refund PLAN for creators of
 * NEVER-CONNECTED markets (policy: ledger "v22 market lifecycle", 2026-10-25, decision C + rent refund).
 *
 * WHAT THIS IS: a pure function from an offline JSON file (the keeper's never-connected classification, see
 * lifecycle-classify.ts / LifecycleEngine.healthFields) to a plan document with a content hash. A human reads the plan, fills
 * in the approval block, and `verify` checks that the approved file still matches its hash.
 *
 * WHAT THIS IS NOT: it never moves value. This file holds no key material, builds no instruction, opens no network connection and
 * reads no environment. The only I/O is reading the input files and writing the plan file the operator named. A test greps this
 * source and the script entry for the APIs that would change that; keep it true. Paying a plan is a separate, human-gated step
 * that does not exist in this repo.
 *
 * RECIPIENT. The keeper's classification names the market but not who paid for it: nothing in `MarketLifecycle` or the registry
 * row carries the creator. The refund is owed to the wallet that paid the slab rent, which on a wizard launch is the market
 * creator (the InitMarket payer, who is also the stake admin; plan section 5). The input therefore must carry an explicit
 * `creator` per market (field on the row, or a top-level `creators` map market -> wallet), supplied from the creator lookup
 * (on-chain by-creator scan / app launch record). A row with no creator is refused: the tool never guesses a payee.
 *
 * AMOUNTS. Policy: ~0.03 SOL slab (~0.10 SOL multi-asset) + ~0.006 SOL stake pool/vault/LP-mint rent, the part not recoverable on
 * chain (FC-B5). The guard account (~0.032 SOL) is deliberately NOT refunded here: the policy text names slab + stake rent only,
 * and the memo lists the guard as an extra with no close op (S3 / D21 is a v2.3 close op). Adding it is a policy change.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const LAMPORTS_PER_SOL = 1_000_000_000;
/** ~0.03 SOL: single-asset slab rent (policy figure, rounded). */
export const SLAB_RENT_SINGLE_LAMPORTS = 30_000_000;
/** ~0.10 SOL: multi-asset slab rent (policy figure). */
export const SLAB_RENT_MULTI_LAMPORTS = 100_000_000;
/** ~0.006 SOL: stake pool + vault + LP mint rent (policy figure). */
export const STAKE_RENT_LAMPORTS = 6_000_000;
/**
 * Per-market cap: 0.11 SOL = the largest legitimate sum (multi-asset slab 0.10 + stake 0.006 = 0.106) rounded up to the next
 * 0.01. It sits well below slab + stake + guard (0.138), so a row that tries to smuggle the guard in, or any inflated rent, is
 * over cap.
 */
export const MAX_PER_MARKET_LAMPORTS = 110_000_000;
/**
 * Per-batch cap: 1 SOL. A weekly batch of never-connected markets is expected to be a handful (a failed launch is ~$5-16);
 * 1 SOL covers ~9 multi-asset or ~27 single-asset markets, while a funding wallet that "holds a capped amount" stays small. A
 * larger batch is a signal to stop and look (a classifier fault, or markets gamed to look never-connected), not to pay more.
 */
export const MAX_PER_BATCH_LAMPORTS = 1_000_000_000;

export const NEVER_CONNECTED_REASONS = ["no-registry-row", "not-oracle-authority", "no-accepted-push"] as const;
export type NeverConnectedReasonName = (typeof NEVER_CONNECTED_REASONS)[number];

export class RefundRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundRefusal";
  }
}

export interface RefundMarketRow {
  market: string;
  creator: string;
  components: { slabRentLamports: number; stakeRentLamports: number };
  totalLamports: number;
  multiAsset: boolean;
  /** Human-readable justification. */
  reason: string;
  /** The classifier facts the reason rests on. */
  evidence: { neverConnected: NeverConnectedReasonName; registered: boolean | null; ageSlots: string | null };
}

export interface RefundApproval {
  approver: string | null;
  /** ISO date (YYYY-MM-DD or full ISO timestamp). */
  date: string | null;
  planHash: string | null;
}

export interface RefundPlan {
  version: 1;
  kind: "never-connected-rent-refund-plan";
  status: "UNAPPROVED" | "APPROVED";
  generatedAt: string;
  policy: string;
  caps: { perMarketLamports: number; perBatchLamports: number };
  markets: RefundMarketRow[];
  totals: { marketCount: number; lamports: number; sol: string; duplicatesDropped: number };
  /** sha256 over the canonical JSON of every field except status, approval and planHash. */
  planHash: string;
  approval: RefundApproval;
}

export interface BuildOptions {
  now?: () => Date;
  /** Lower-only overrides of the hard caps. */
  perMarketCapLamports?: number;
  batchCapLamports?: number;
  /** Earlier plans / refunded-market lists; any market in them refuses the batch. */
  prior?: unknown[];
}

const POLICY = "Treasury refund of sunk slab + stake rent to creators of NEVER-CONNECTED markets (ledger 2026-10-25, decision C; memo D6). Guard rent not included. DRY-RUN PLAN ONLY: nothing is sent by this tool.";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** True when `s` is base58 that decodes to exactly 32 bytes (a Solana public key). No library needed. */
export function isPubkey(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const ch of s) {
    const d = B58.indexOf(ch);
    if (d < 0) return false;
    n = n * 58n + BigInt(d);
  }
  let lead = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    lead++;
  }
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  return lead + bytes === 32;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lamportsField(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new RefundRefusal(`${what}: must be a non-negative integer lamport amount, got ${JSON.stringify(v)}`);
  return v;
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function hashBody(p: RefundPlan): string {
  const { status: _s, approval: _a, planHash: _h, ...body } = p;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

const sol = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, "").replace(/\.$/, ".0");

// ── input normalisation ─────────────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  market: unknown;
  creator: unknown;
  neverConnected: unknown;
  registered: unknown;
  ageSlots: unknown;
  multiAsset: unknown;
  slabRentLamports: unknown;
  stakeRentLamports: unknown;
}

function candidates(input: unknown): Candidate[] {
  if (!isRecord(input)) throw new RefundRefusal("input must be a JSON object with a `markets` array or map");
  const creators = isRecord(input.creators) ? input.creators : {};
  const m = input.markets;
  const mk = (market: unknown, r: Record<string, unknown>): Candidate => ({
    market,
    creator: r.creator ?? (typeof market === "string" ? creators[market] : undefined),
    neverConnected: r.neverConnected ?? r.reason,
    registered: r.registered,
    ageSlots: r.ageSlots,
    multiAsset: r.multiAsset,
    slabRentLamports: r.slabRentLamports,
    stakeRentLamports: r.stakeRentLamports,
  });
  if (Array.isArray(m)) return m.map((r) => (isRecord(r) ? mk(r.market, r) : mk(undefined, {})));
  if (isRecord(m)) {
    // The keeper /health `v22.lifecycle.markets` map: a dump of every non-healthy market. Keep only the never-connected ones.
    return Object.entries(m).filter(([, r]) => isRecord(r) && r.neverConnected !== null && r.neverConnected !== undefined).map(([k, r]) => mk(k, r as Record<string, unknown>));
  }
  throw new RefundRefusal("input `markets` must be an array or a map");
}

function priorMarkets(prior: unknown[]): Set<string> {
  const s = new Set<string>();
  for (const p of prior) {
    const list: unknown = Array.isArray(p) ? p : isRecord(p) ? (p.markets ?? p.refunded) : undefined;
    if (!Array.isArray(list)) throw new RefundRefusal("prior batch file is not a plan, a `refunded` list or an array of markets");
    for (const e of list) {
      const a = typeof e === "string" ? e : isRecord(e) && typeof e.market === "string" ? e.market : null;
      if (a === null) throw new RefundRefusal("prior batch file has an entry with no market address");
      s.add(a);
    }
  }
  return s;
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function buildRefundPlan(input: unknown, opts: BuildOptions = {}): RefundPlan {
  const now = opts.now ?? ((): Date => new Date());
  const perMarketCap = opts.perMarketCapLamports ?? MAX_PER_MARKET_LAMPORTS;
  const batchCap = opts.batchCapLamports ?? MAX_PER_BATCH_LAMPORTS;
  if (!Number.isSafeInteger(perMarketCap) || perMarketCap < 0 || perMarketCap > MAX_PER_MARKET_LAMPORTS) throw new RefundRefusal(`per-market cap ${perMarketCap} must be an integer in [0, ${MAX_PER_MARKET_LAMPORTS}]: caps can be lowered, never raised`);
  if (!Number.isSafeInteger(batchCap) || batchCap < 0 || batchCap > MAX_PER_BATCH_LAMPORTS) throw new RefundRefusal(`per-batch cap ${batchCap} must be an integer in [0, ${MAX_PER_BATCH_LAMPORTS}]: caps can be lowered, never raised`);

  const already = priorMarkets(opts.prior ?? []);
  const rows = new Map<string, RefundMarketRow>();
  let dupes = 0;

  for (const c of candidates(input)) {
    if (!isPubkey(c.market)) throw new RefundRefusal(`market ${JSON.stringify(c.market)}: not a valid address`);
    const market = c.market;
    if (!(NEVER_CONNECTED_REASONS as readonly unknown[]).includes(c.neverConnected)) throw new RefundRefusal(`${market}: not classified never-connected (got ${JSON.stringify(c.neverConnected)}); only never-connected markets are eligible`);
    const reason = c.neverConnected as NeverConnectedReasonName;
    if (c.creator === undefined || c.creator === null) throw new RefundRefusal(`${market}: no creator wallet in the input (the refund payee is never guessed)`);
    if (!isPubkey(c.creator)) throw new RefundRefusal(`${market}: creator ${JSON.stringify(c.creator)} is not a valid address`);
    if (already.has(market)) throw new RefundRefusal(`${market}: already refunded in a prior batch`);

    const multiAsset = c.multiAsset === true;
    const slab = lamportsField(c.slabRentLamports, `${market} slabRentLamports`) ?? (multiAsset ? SLAB_RENT_MULTI_LAMPORTS : SLAB_RENT_SINGLE_LAMPORTS);
    const stake = lamportsField(c.stakeRentLamports, `${market} stakeRentLamports`) ?? STAKE_RENT_LAMPORTS;
    const total = slab + stake;
    if (total > perMarketCap) throw new RefundRefusal(`${market}: ${total} lamports exceeds the per-market cap ${perMarketCap}; refusing the batch (nothing is truncated)`);

    const prev = rows.get(market);
    if (prev) {
      if (prev.creator !== c.creator) throw new RefundRefusal(`${market}: conflicting creator wallets (${prev.creator} vs ${c.creator})`);
      if (prev.totalLamports !== total) throw new RefundRefusal(`${market}: repeated with conflicting amounts`);
      dupes++;
      continue;
    }
    rows.set(market, {
      market,
      creator: c.creator,
      components: { slabRentLamports: slab, stakeRentLamports: stake },
      totalLamports: total,
      multiAsset,
      reason: `never-connected (${reason}): no price push path for this market; creator owed the sunk slab + stake rent`,
      evidence: { neverConnected: reason, registered: typeof c.registered === "boolean" ? c.registered : null, ageSlots: typeof c.ageSlots === "string" || typeof c.ageSlots === "number" ? String(c.ageSlots) : null },
    });
  }

  if (rows.size === 0) throw new RefundRefusal("no eligible markets in the input: nothing to plan");
  const markets = [...rows.values()].sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : 0));
  const lamports = markets.reduce((s, r) => s + r.totalLamports, 0);
  if (lamports > batchCap) throw new RefundRefusal(`batch total ${lamports} lamports (${sol(lamports)} SOL) exceeds the per-batch cap ${batchCap}; refusing the batch (nothing is truncated)`);

  const plan: RefundPlan = {
    version: 1,
    kind: "never-connected-rent-refund-plan",
    status: "UNAPPROVED",
    generatedAt: now().toISOString(),
    policy: POLICY,
    caps: { perMarketLamports: perMarketCap, perBatchLamports: batchCap },
    markets,
    totals: { marketCount: markets.length, lamports, sol: sol(lamports), duplicatesDropped: dupes },
    planHash: "",
    approval: { approver: null, date: null, planHash: null },
  };
  plan.planHash = hashBody(plan);
  return plan;
}

// ── verify ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  computedHash: string;
}

export function verifyRefundPlan(plan: RefundPlan): VerifyResult {
  const problems: string[] = [];
  let computedHash = "";
  try {
    computedHash = hashBody(plan);
  } catch {
    return { ok: false, problems: ["plan is not a readable plan document"], computedHash };
  }
  if (plan.kind !== "never-connected-rent-refund-plan" || plan.version !== 1) problems.push("not a version-1 never-connected refund plan");
  if (plan.status !== "APPROVED") problems.push(`status is ${JSON.stringify(plan.status)}, not APPROVED`);
  if (plan.planHash !== computedHash) problems.push("planHash does not match the plan contents (the plan was edited)");
  const a = plan.approval;
  if (!a || typeof a.approver !== "string" || a.approver.trim() === "") problems.push("approval.approver is empty");
  if (!a || typeof a.date !== "string" || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(a.date) || Number.isNaN(Date.parse(a.date))) problems.push("approval.date is not an ISO date");
  if (!a || a.planHash !== computedHash) problems.push("approval.planHash does not match the plan contents");
  // Independent re-check of the caps and totals, so a plan whose hash was recomputed by hand still cannot pass over cap.
  const perMarket = plan.caps?.perMarketLamports;
  const perBatch = plan.caps?.perBatchLamports;
  if (!(Number.isSafeInteger(perMarket) && perMarket <= MAX_PER_MARKET_LAMPORTS)) problems.push("per-market cap missing or above the hard cap");
  if (!(Number.isSafeInteger(perBatch) && perBatch <= MAX_PER_BATCH_LAMPORTS)) problems.push("per-batch cap missing or above the hard cap");
  let sum = 0;
  const seen = new Set<string>();
  for (const m of plan.markets ?? []) {
    sum += m.totalLamports;
    if (m.totalLamports !== m.components.slabRentLamports + m.components.stakeRentLamports) problems.push(`${m.market}: total is not the sum of its components`);
    if (m.totalLamports > MAX_PER_MARKET_LAMPORTS || m.totalLamports > (perMarket ?? 0)) problems.push(`${m.market}: over the per-market cap`);
    if (!isPubkey(m.creator) || !isPubkey(m.market)) problems.push(`${m.market}: invalid address`);
    if (seen.has(m.market)) problems.push(`${m.market}: duplicate market`);
    seen.add(m.market);
  }
  if (sum !== plan.totals?.lamports) problems.push("totals.lamports is not the sum of the markets");
  if (sum > MAX_PER_BATCH_LAMPORTS || sum > (perBatch ?? 0)) problems.push("batch total is over the per-batch cap");
  return { ok: problems.length === 0, problems, computedHash };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderPlanTable(plan: RefundPlan): string {
  const head = ["market", "creator (refund recipient)", "slab", "stake", "total (SOL)", "reason"];
  const rows = plan.markets.map((m) => [m.market, m.creator, sol(m.components.slabRentLamports), sol(m.components.stakeRentLamports), sol(m.totalLamports), m.evidence.neverConnected]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd();
  return [
    `NEVER-CONNECTED RENT REFUND PLAN  status=${plan.status}  (DRY RUN: nothing is sent by this tool)`,
    line(head),
    line(w.map((n) => "-".repeat(n))),
    ...rows.map(line),
    line(w.map((n) => "-".repeat(n))),
    `TOTAL  ${plan.totals.marketCount} markets  ${plan.totals.lamports} lamports  ${plan.totals.sol} SOL   caps: ${sol(plan.caps.perMarketLamports)} SOL/market, ${sol(plan.caps.perBatchLamports)} SOL/batch`,
    `planHash  ${plan.planHash}`,
    plan.status === "UNAPPROVED" ? "To approve: a human reviews this plan, then sets status=APPROVED and fills approval.{approver,date,planHash}; run `verify`." : "",
  ].filter((l) => l !== "").join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `usage:
  refund-plan plan   --input <classification.json> [--prior <file>]... [--out <plan.json>] [--per-market-cap-lamports N] [--batch-cap-lamports N]
  refund-plan verify --plan <approved-plan.json>
exit codes: 0 ok, 1 refused / verification failed, 2 usage`;

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string[]> } | null {
  const [cmd, ...rest] = argv;
  if (!cmd) return null;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!k || !k.startsWith("--") || v === undefined) return null;
    flags.set(k, [...(flags.get(k) ?? []), v]);
  }
  return { cmd, flags };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new RefundRefusal(`cannot read ${path} as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function intFlag(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new RefundRefusal(`${v} is not a lamport integer`);
  return Number(v);
}

export function runCli(argv: string[], io: CliIo, now?: () => Date): number {
  const a = parseArgs(argv);
  if (!a || (a.cmd !== "plan" && a.cmd !== "verify")) {
    io.err(USAGE);
    return 2;
  }
  const one = (k: string): string | undefined => a.flags.get(k)?.[0];
  try {
    if (a.cmd === "plan") {
      const input = one("--input");
      if (!input) {
        io.err(USAGE);
        return 2;
      }
      const plan = buildRefundPlan(readJson(input), {
        ...(now ? { now } : {}),
        prior: (a.flags.get("--prior") ?? []).map(readJson),
        ...(one("--per-market-cap-lamports") !== undefined ? { perMarketCapLamports: intFlag(one("--per-market-cap-lamports"))! } : {}),
        ...(one("--batch-cap-lamports") !== undefined ? { batchCapLamports: intFlag(one("--batch-cap-lamports"))! } : {}),
      });
      const out = one("--out");
      if (out) writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
      else io.out(JSON.stringify(plan, null, 2));
      io.out(renderPlanTable(plan));
      return 0;
    }
    const path = one("--plan");
    if (!path) {
      io.err(USAGE);
      return 2;
    }
    const r = verifyRefundPlan(readJson(path) as RefundPlan);
    if (r.ok) {
      io.out(`OK: approved plan matches its hash ${r.computedHash}`);
      return 0;
    }
    io.err(`NOT VERIFIED:\n- ${r.problems.join("\n- ")}`);
    return 1;
  } catch (e) {
    if (e instanceof RefundRefusal) {
      io.err(`REFUSED: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
