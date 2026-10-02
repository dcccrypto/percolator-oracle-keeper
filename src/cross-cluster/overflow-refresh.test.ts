/**
 * Overflow refreshes (2026-10-02 Percolator outage): a market with more
 * positioned portfolios than one accrual transaction can refresh must still get
 * every one refreshed each cohort, via follow-up transactions that land before
 * the market's next price push.
 *
 * Fixtures: real devnet bytes of the Percolator relaunch market 9EPm8nB8
 * (stored 8L/4S) and its 12 positioned portfolios, captured 2026-10-02 while it
 * was locked for opens. The engine is modelled only as far as the cranker
 * depends on it:
 *   - an observation crank (accrual) re-stales the whole positioned cohort
 *     (kernel_mark_kf_stale_cohorts: stale_account_count_<side> = stored_pos_count_<side>);
 *   - a no-observation refresh clears one stale portfolio, and returns
 *     Custom(22) if that portfolio is not stale or if a price push landed
 *     since the accrual (reject_incomplete_asset_health_observation_view).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/overflow-refresh.test.ts
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  LIQUIDATE_CRANK_CU,
  MAX_TX_CU,
  REFRESHES_PER_OVERFLOW_TX,
  chunkOverflowTargets,
  decodeMarketRefreshState,
  planCrankTx,
  planRefreshTx,
  selectPositionedPortfolios,
  staleCountOffsets,
} from "./positioned-refresh.ts";
import type { CrankPlan, PositionedPortfolio } from "./positioned-refresh.ts";
import {
  LOSS_STALE_ALERT_CYCLES,
  crankOneMarket,
  crankSample,
  endedLossStale,
  freshCrankMarketState,
  refreshOverflow,
} from "./recovery-cranker.ts";
import type { SimOutcome } from "./recovery-cranker.ts";
import {
  MAX_PUSH_HOLD_MS,
  getCrankRefreshHealth,
  holdPushes,
  isPushHeld,
  releasePushes,
  resetRefreshCoordination,
} from "./refresh-coordination.ts";
import { DEFAULT_THRESHOLDS, evaluateCrankHealth, freshStreaks } from "./alerting.ts";
import { crankHealthFields } from "./keeper-loop.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const MARKET = new PublicKey("9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
const LP = new PublicKey("F9YYtzdytRapfTdT4xjeHdMxnUxp1ess1ZJKbxSB7yP9");
const KEEPER = Keypair.generate();

interface IndexEntry { pubkey: string; fixture: string; longLegs: number; shortLegs: number; isLp: boolean }
const INDEX: IndexEntry[] = JSON.parse(
  readFileSync(join(here, "__fixtures__", "percolator-positioned-index.json"), "utf8"),
) as IndexEntry[];
const portfolioAccounts = () => INDEX.map((e) => ({ pubkey: new PublicKey(e.pubkey), data: fx(e.fixture) }));

afterEach(() => resetRefreshCoordination());

describe("fixture sanity (Percolator 9EPm8nB8, 2026-10-02)", () => {
  it("12 positioned portfolios account for the market's stored 8L/4S", () => {
    const s = decodeMarketRefreshState(fx("percolator-market-v18-relaunch"));
    assert.equal(s.storedPosLong, 8n);
    assert.equal(s.storedPosShort, 4n);
    const set = selectPositionedPortfolios(portfolioAccounts());
    assert.equal(set.length, 12);
    assert.equal(set.filter((p) => p.isLp).length, 1);
    assert.equal(set.reduce((n, p) => n + p.longLegs, 0), 8);
    assert.equal(set.reduce((n, p) => n + p.shortLegs, 0), 4);
  });
});

describe("chunking the overflow", () => {
  const owner = PublicKey.unique();
  const many = (n: number): PositionedPortfolio[] =>
    Array.from({ length: n }, () => ({ pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false }));

  it("12 positioned: the accrual tx refreshes what fits, the rest overflow; together exactly the 12", () => {
    const set = selectPositionedPortfolios(portfolioAccounts());
    const plan = planCrankTx({ owner, market: MARKET, lpPortfolio: LP, catchup: 0, refreshTargets: set });
    const inTx = plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58());
    const over = plan.overflow.map((p) => p.pubkey.toBase58());
    assert.ok(over.length > 0, "the outage condition: 12 do not fit one transaction");
    assert.deepEqual([...inTx, ...over].sort(), set.map((p) => p.pubkey.toBase58()).sort());
    assert.equal(new Set([...inTx, ...over]).size, 12);
  });

  it("every overflow target lands in exactly one chunk, in order; each chunk fits the CU cap and the packet", () => {
    for (const n of [1, 3, REFRESHES_PER_OVERFLOW_TX, REFRESHES_PER_OVERFLOW_TX + 1, 25]) {
      const targets = many(n);
      const chunks = chunkOverflowTargets(targets);
      assert.deepEqual(chunks.flat().map((p) => p.pubkey.toBase58()), targets.map((p) => p.pubkey.toBase58()));
      assert.equal(chunks.length, Math.ceil(n / REFRESHES_PER_OVERFLOW_TX));
      for (const c of chunks) {
        // Worst case: one liquidation in the chunk.
        const plan = planRefreshTx({ owner, market: MARKET, targets: c, liquidateTargets: [c[0].pubkey] });
        assert.ok(plan.cranks.every((k) => k.kind === "refresh" || k.kind === "liquidate"));
        assert.equal(plan.cranks.filter((k) => k.kind === "liquidate").length, 1);
        assert.ok(plan.computeUnits <= MAX_TX_CU);
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits }));
        for (const k of plan.cranks) tx.add(k.ix);
        tx.feePayer = owner;
        tx.recentBlockhash = PublicKey.unique().toBase58();
        assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232);
      }
    }
    assert.ok(REFRESHES_PER_OVERFLOW_TX * 130_000 + LIQUIDATE_CRANK_CU <= MAX_TX_CU);
  });

  it("follow-up refreshes carry no observation (they must not accrue/re-stale)", () => {
    const plan = planRefreshTx({ owner, market: MARKET, targets: many(3) });
    for (const c of plan.cranks) assert.equal(c.ix.data[9], 0, "zero observation hints");
  });
});

describe("refreshOverflow", () => {
  const owner = PublicKey.unique();
  const targets = (n: number): PositionedPortfolio[] =>
    Array.from({ length: n }, () => ({ pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false }));
  const ok: SimOutcome = { err: null, logs: [], marketData: null };

  it("sends one tx per chunk and counts landed refreshes", async () => {
    const sent: CrankPlan[] = [];
    const r = await refreshOverflow({
      owner, market: MARKET, overflow: targets(10),
      simulate: async () => ok,
      send: async (p) => { sent.push(p); return `sig${sent.length}`; },
      waitLanded: async () => "landed",
    });
    assert.equal(r.error, null);
    assert.equal(r.refreshed, 10);
    assert.equal(sent.length, chunkOverflowTargets(targets(10)).length);
  });

  it("mark moved since the accrual (every refresh Custom(22)): nothing sent, error reported for next cycle", async () => {
    let sends = 0;
    const r = await refreshOverflow({
      owner, market: MARKET, overflow: targets(3),
      simulate: async (p) => {
        const i = p.cranks.findIndex((c) => c.kind === "refresh");
        return i >= 0 ? { err: { InstructionError: [i + 1, { Custom: 22 }] }, logs: [], marketData: null } : ok;
      },
      send: async () => { sends++; return "x"; },
      waitLanded: async () => "landed",
    });
    assert.equal(sends, 0);
    assert.equal(r.refreshed, 0);
    assert.notEqual(r.error, null);
  });

  it("a follow-up that does not land is an error, not a success", async () => {
    const r = await refreshOverflow({
      owner, market: MARKET, overflow: targets(2),
      simulate: async () => ok,
      send: async () => "sig",
      waitLanded: async () => "timeout",
    });
    assert.equal(r.refreshed, 0);
    assert.match(r.error ?? "", /timeout/);
  });

  it("a send failure is reported, never thrown", async () => {
    const r = await refreshOverflow({
      owner, market: MARKET, overflow: targets(2),
      simulate: async () => ok,
      send: async () => { throw new Error("429 Too Many Requests"); },
      waitLanded: async () => "landed",
    });
    assert.match(r.error ?? "", /send failed/);
  });
});

// ── End-to-end through crankOneMarket against a modelled engine ─────────────

function wrapperIxs(msg: { staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] }) {
  return msg.compiledInstructions.map((ix) => ({
    program: msg.staticAccountKeys[ix.programIdIndex],
    keys: ix.accountKeyIndexes.map((k) => msg.staticAccountKeys[k]),
    data: ix.data,
  }));
}

/** Fake devnet: the market's stale cohort + push events, enough to exercise the cranker. */
function modelChain(opts: { pushAfterAccrualLands?: boolean } = {}) {
  const base = fx("percolator-market-v18-relaunch");
  const legs = new Map(INDEX.map((e) => [e.pubkey, e]));
  const all = INDEX.map((e) => e.pubkey);
  let stale = new Set<string>(all); // previous cohort never fully refreshed (the outage)
  let markMoved = false;
  // Engine clock current (no catch-up cranks): read slots just past the fixture's slot_last.
  let slot = Number(decodeMarketRefreshState(base).slotLast) + 2;
  let sigN = 0;
  const landed = new Set<string>();
  const sends: { kinds: string[]; heldAtSend: boolean }[] = [];
  const marketBytes = (st: Set<string>): Buffer => {
    const b = Buffer.from(base);
    const o = staleCountOffsets();
    let l = 0n;
    let s = 0n;
    for (const pk of st) {
      l += BigInt(legs.get(pk)!.longLegs);
      s += BigInt(legs.get(pk)!.shortLegs);
    }
    b.writeBigUInt64LE(l, o.long);
    b.writeBigUInt64LE(s, o.short);
    return b;
  };
  /** Apply instructions to a copy of the state; returns the error (if any) and the new state. */
  const apply = (ixs: ReturnType<typeof wrapperIxs>) => {
    let st = new Set(stale);
    let moved = markMoved;
    for (let i = 0; i < ixs.length; i++) {
      const ix = ixs[i];
      if (ix.program.equals(ComputeBudgetProgram.programId)) continue;
      const pf = ix.keys[2].toBase58();
      if (ix.data[9] > 0) {
        st = new Set(all); // accrual: whole cohort stale
        moved = false;
        continue;
      }
      if (moved || !st.has(pf)) return { err: { InstructionError: [i, { Custom: 22 }] }, st: stale, moved: markMoved };
      st.delete(pf);
    }
    return { err: null, st, moved };
  };
  const conn = {
    async getAccountInfoAndContext() { slot += 3; return { context: { slot }, value: { data: marketBytes(stale), owner: PublicKey.default, lamports: 1, executable: false } }; },
    async getAccountInfo() { return { data: marketBytes(stale), owner: PublicKey.default, lamports: 1, executable: false }; },
    async getLatestBlockhash() { return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }; },
    async getProgramAccounts() { return portfolioAccounts().map((a) => ({ pubkey: a.pubkey, account: { data: a.data } })); },
    async simulateTransaction(vtx: VersionedTransaction, cfg: { accounts?: { addresses: string[] } }) {
      const r = apply(wrapperIxs(vtx.message as never));
      const addrs = cfg.accounts?.addresses ?? [];
      const accounts = addrs.map((a) => {
        if (a === MARKET.toBase58()) return { data: [marketBytes(r.err ? stale : r.st).toString("base64"), "base64"] };
        const e = INDEX.find((x) => x.pubkey === a);
        return e ? { data: [fx(e.fixture).toString("base64"), "base64"] } : null;
      });
      return { context: { slot }, value: { err: r.err, logs: [], accounts } };
    },
    async sendRawTransaction(raw: Buffer) {
      const tx = Transaction.from(raw);
      const msg = tx.compileMessage();
      const ixs = wrapperIxs(msg as never);
      const r = apply(ixs);
      const kinds = ixs.filter((x) => !x.program.equals(ComputeBudgetProgram.programId)).map((x) => (x.data[9] > 0 ? "obs" : "refresh"));
      sends.push({ kinds, heldAtSend: isPushHeld(MARKET.toBase58()) });
      const sig = `sig${++sigN}`;
      if (!r.err) {
        stale = r.st;
        markMoved = r.moved;
        landed.add(sig);
        // Negative control: a price push lands right after the accrual tx.
        if (opts.pushAfterAccrualLands && kinds.includes("obs")) markMoved = true;
      }
      return sig;
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map((s) => (landed.has(s) ? { err: null, confirmationStatus: "processed" } : null)) };
    },
  };
  return { conn, sends, staleNow: () => stale.size, pushNow: () => { markMoved = true; } };
}

const ENTRY = { marketAddress: MARKET.toBase58(), label: "Percolator/USDC", lpPortfolio: LP.toBase58() };

describe("crankOneMarket with 12 positioned portfolios (modelled engine)", () => {
  it("accrual tx + follow-up refreshes: every positioned portfolio refreshed, market ends not loss-stale", async () => {
    const chain = modelChain();
    const st = freshCrankMarketState();
    await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
    assert.equal(chain.staleNow(), 0, "stale_account_count must be 0 after the cycle");
    assert.ok(chain.sends.length >= 2, "accrual tx plus at least one follow-up");
    assert.equal(chain.sends[0].kinds[0], "obs");
    assert.ok(chain.sends.slice(1).every((s) => s.kinds.every((k) => k === "refresh")), "follow-ups never accrue");
    assert.ok(chain.sends.every((s) => s.heldAtSend), "pushes held from before the accrual until the follow-ups land");
    assert.equal(isPushHeld(MARKET.toBase58()), false, "hold released once they landed");
    const h = getCrankRefreshHealth(MARKET.toBase58());
    assert.ok(h);
    assert.equal(h.positioned, 12);
    assert.ok(h.overflow > 0);
    assert.equal(h.overflowRefreshed, h.overflow);
    assert.equal(h.overflowError, null);
    assert.equal(h.postStaleLong, 0);
    assert.equal(h.postStaleShort, 0);
    assert.equal(h.lossStaleCycles, 0);
    assert.equal(h.status, "ok");
    assert.equal(st.obs?.lossStaleCycles, 0);
    // Steady state: the next cycles accrue again and refresh everyone again.
    for (let i = 0; i < 3; i++) {
      await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
      assert.equal(chain.staleNow(), 0);
    }
    assert.equal(getCrankRefreshHealth(MARKET.toBase58())?.status, "ok");
  });

  it("negative control: the accrual tx alone (pre-fix behaviour) leaves the overflow stale", () => {
    const set = selectPositionedPortfolios(portfolioAccounts());
    const plan = planCrankTx({ owner: KEEPER.publicKey, market: MARKET, lpPortfolio: LP, catchup: 0, refreshTargets: set });
    const refreshed = new Set(plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58()));
    const left = set.filter((p) => !refreshed.has(p.pubkey.toBase58()));
    assert.ok(left.length > 0);
    assert.equal(endedLossStale({ staleLong: 0, staleShort: 0 }, {
      staleLong: BigInt(left.reduce((n, p) => n + p.longLegs, 0)),
      staleShort: BigInt(left.reduce((n, p) => n + p.shortLegs, 0)),
    }), true);
  });

  it("negative control: a push landing after the accrual voids the follow-ups; the market goes non-ok after N cycles and alerts", async () => {
    const chain = modelChain({ pushAfterAccrualLands: true });
    const st = freshCrankMarketState();
    for (let i = 1; i <= LOSS_STALE_ALERT_CYCLES; i++) {
      await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
      assert.ok(chain.staleNow() > 0, "overflow portfolios still stale");
      const h = getCrankRefreshHealth(MARKET.toBase58())!;
      assert.equal(h.lossStaleCycles, i);
      assert.notEqual(h.overflowError, null);
      assert.equal(h.status, i >= LOSS_STALE_ALERT_CYCLES ? "loss-stale" : "ok");
      const fields = crankHealthFields(h);
      assert.equal(fields.lossStale, 1);
      assert.equal(fields.crankStatus, h.status);
    }
    assert.equal(isPushHeld(MARKET.toBase58()), false, "a failed cycle still releases the hold");
    const sample = crankSample("Percolator/USDC", MARKET.toBase58(), st);
    assert.ok(sample);
    const ev = evaluateCrankHealth(sample, freshStreaks(), DEFAULT_THRESHOLDS);
    assert.ok(ev.active.some((a) => a.kind === "loss-stale" && a.severity === "critical"));
  });

  it("recovers: once pushes stop landing in the window, the next cycle clears it and resets the streak", async () => {
    const bad = modelChain({ pushAfterAccrualLands: true });
    const st = freshCrankMarketState();
    await crankOneMarket(bad.conn as never, KEEPER, ENTRY, st, false);
    assert.equal(getCrankRefreshHealth(MARKET.toBase58())?.lossStaleCycles, 1);
    const good = modelChain();
    st.lastCrankSlot = null; // a different (fresh) model chain restarts its slot numbering
    await crankOneMarket(good.conn as never, KEEPER, ENTRY, st, false);
    assert.equal(good.staleNow(), 0);
    assert.equal(getCrankRefreshHealth(MARKET.toBase58())?.lossStaleCycles, 0);
  });
});

describe("loss-stale alert threshold", () => {
  const sample = (lossStaleCycles: number) => ({
    label: "M", market: "m", chainSlot: 10n, engineSlot: 10n, crankOk: true, crankReverted: false,
    totalOk: 1, totalReverts: 0, consecutiveReverts: 0, lastRevertCode: null,
    lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0, adl: null,
    staleLong: 2, staleShort: 0, positioned: 12, overflow: 3, overflowRefreshed: 0, lossStaleCycles,
  });
  it("fires at ALERT_LOSS_STALE_CYCLES, not before", () => {
    const t = DEFAULT_THRESHOLDS;
    assert.equal(evaluateCrankHealth(sample(t.lossStaleCycles - 1), freshStreaks(), t).active.some((a) => a.kind === "loss-stale"), false);
    assert.equal(evaluateCrankHealth(sample(t.lossStaleCycles), freshStreaks(), t).active.some((a) => a.kind === "loss-stale"), true);
  });
});

describe("push holds", () => {
  it("hold, release, expiry, and the hard cap", () => {
    const m = "M1";
    holdPushes(m, 5_000, 1_000);
    assert.equal(isPushHeld(m, 1_001), true);
    assert.equal(isPushHeld(m, 6_000), false, "expired");
    holdPushes(m, 5_000, 1_000);
    releasePushes(m);
    assert.equal(isPushHeld(m, 1_001), false);
    holdPushes(m, 10 * 60_000, 0);
    assert.equal(isPushHeld(m, MAX_PUSH_HOLD_MS - 1), true);
    assert.equal(isPushHeld(m, MAX_PUSH_HOLD_MS), false, "never longer than MAX_PUSH_HOLD_MS");
  });
});
