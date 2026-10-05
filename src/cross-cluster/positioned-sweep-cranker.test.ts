/**
 * crankOneMarket on a drift-layout market (v21-funding-scale program): the
 * cycle becomes a round-robin sweep of k portfolios per transaction, each
 * transaction `[observation crank, refresh x k]`, paced by bound/insurance, with
 * no push hold; health carries the coverage. The legacy-layout path is covered
 * unchanged by overflow-refresh.test.ts.
 *
 * The chain is a small engine model on top of the real Percolator 9EPm8nB8
 * fixture (12 positioned portfolios), re-laid out to the drift stride:
 *   - an observation crank accrues (once per slot; a second one in the same slot
 *     returns Custom(22)), bumps the KF epoch, re-stales every positioned
 *     portfolio (funding > 0) and adds one adverse step to drift_gen;
 *   - a refresh is accepted only in an accrued slot and only for a stale
 *     portfolio (else Custom(22)); it snapshots the epoch, and once every
 *     portfolio has been refreshed since the generation began the generation
 *     rotates (drift_gen -> drift_prior);
 *   - each landed transaction moves the chain to the next slot.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/positioned-sweep-cranker.test.ts
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import {
  ASSET_SLOTS_OFF,
  DRIFT_SLOT_STRIDE,
  LEGACY_SLOT_STRIDE,
  POS_SCALE,
  SOCIAL_WEIGHT_SCALE,
  decodeSweepMarketState,
  detectMarketLayout,
  sweepFieldOffsets,
} from "./positioned-sweep.ts";
import { LOSS_STALE_ALERT_CYCLES, crankOneMarket, crankSample, freshCrankMarketState } from "./recovery-cranker.ts";
import { getCrankRefreshHealth, isPushHeld, resetRefreshCoordination } from "./refresh-coordination.ts";
import { DEFAULT_THRESHOLDS, evaluateCrankHealth, freshStreaks } from "./alerting.ts";
import { crankHealthFields } from "./keeper-loop.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const MARKET = new PublicKey("9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
const LP = new PublicKey("F9YYtzdytRapfTdT4xjeHdMxnUxp1ess1ZJKbxSB7yP9");
const KEEPER = Keypair.generate();
const ENTRY = { marketAddress: MARKET.toBase58(), label: "Percolator/USDC", lpPortfolio: LP.toBase58() };

interface IndexEntry { pubkey: string; fixture: string; longLegs: number; shortLegs: number; isLp: boolean }
const INDEX: IndexEntry[] = JSON.parse(
  readFileSync(join(here, "__fixtures__", "percolator-positioned-index.json"), "utf8"),
) as IndexEntry[];
const portfolioAccounts = () => INDEX.map((e) => ({ pubkey: new PublicKey(e.pubkey), data: fx(e.fixture) }));

afterEach(() => resetRefreshCoordination());

function wrapperIxs(msg: { staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] }) {
  return msg.compiledInstructions.map((ix) => ({
    program: msg.staticAccountKeys[ix.programIdIndex],
    keys: ix.accountKeyIndexes.map((k) => msg.staticAccountKeys[k]),
    data: ix.data,
  }));
}

/** One stale leg's loss weight: with W = SWS*POS the bound is stale * drift_gen + 2 * stale. */
const W = SOCIAL_WEIGHT_SCALE * POS_SCALE;

interface EngineModel {
  stale: Set<string>;
  snap: Map<string, bigint>;
  kfEpoch: bigint;
  genEpoch: bigint;
  driftGen: bigint;
  driftPrior: bigint;
  accruedSlot: number;
}

function driftChain(opts: { insurance: bigint }) {
  const base = fx("percolator-market-v18-relaunch");
  const all = INDEX.map((e) => e.pubkey);
  let slot = Number(decodeMarketRefreshState(base).slotLast) + 2;
  let m: EngineModel = {
    stale: new Set(all),
    snap: new Map(all.map((p) => [p, 0n])), // every leg predates the generation: laggards
    kfEpoch: 1n,
    genEpoch: 1n,
    driftGen: 1n,
    driftPrior: 1n,
    accruedSlot: slot - 1,
  };
  let sigN = 0;
  const landed = new Set<string>();
  const sends: { kinds: string[]; heldAtSend: boolean; slot: number }[] = [];

  const bytes = (s: EngineModel): Buffer => {
    const b = Buffer.alloc(ASSET_SLOTS_OFF + DRIFT_SLOT_STRIDE);
    base.copy(b, 0, 0, ASSET_SLOTS_OFF);
    base.copy(b, ASSET_SLOTS_OFF, ASSET_SLOTS_OFF, ASSET_SLOTS_OFF + LEGACY_SLOT_STRIDE);
    const o = sweepFieldOffsets(0);
    b.writeUInt32LE(1, o.maxMarketSlots);
    b.writeBigUInt64LE(BigInt(s.accruedSlot), o.currentSlot);
    b.writeBigUInt64LE(BigInt(s.accruedSlot), o.slotLast);
    b[o.lifecycle] = 2;
    b[o.modeLong] = 0;
    b[o.modeShort] = 0;
    for (const off of [o.pendingObligationLong, o.pendingObligationShort, o.pendingBarrierLong, o.pendingBarrierShort]) b.writeBigUInt64LE(0n, off);
    b.writeBigUInt64LE(BigInt(s.stale.size), o.staleLong);
    b.writeBigUInt64LE(0n, o.staleShort);
    const u128 = (off: number, v: bigint) => {
      b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
      b.writeBigUInt64LE(v >> 64n, off + 8);
    };
    u128(o.insurance, opts.insurance);
    u128(o.sourceInsuranceReservedTotal, 0n);
    for (const off of [o.insuranceBudgetLong, o.insuranceBudgetShort]) u128(off, opts.insurance);
    for (const off of [o.insuranceSpentLong, o.insuranceSpentShort, o.insuranceReservedNumLong, o.insuranceReservedNumShort]) u128(off, 0n);
    const laggards = [...s.snap.values()].filter((e) => e < s.genEpoch).length;
    b.writeBigUInt64LE(s.genEpoch, o.driftLong);
    b.writeBigUInt64LE(BigInt(laggards), o.driftLong + 8);
    u128(o.driftLong + 16, s.driftGen);
    u128(o.driftLong + 32, s.driftPrior);
    u128(o.driftLong + 48, BigInt(s.stale.size) * W);
    u128(o.driftLong + 64, BigInt(laggards) * W);
    return b;
  };

  const apply = (ixs: ReturnType<typeof wrapperIxs>, at: number): { err: unknown; next: EngineModel } => {
    const s: EngineModel = { ...m, stale: new Set(m.stale), snap: new Map(m.snap) };
    for (let i = 0; i < ixs.length; i++) {
      const ix = ixs[i];
      if (ix.program.equals(ComputeBudgetProgram.programId)) continue;
      const pf = ix.keys[2].toBase58();
      if (ix.data[9] > 0) {
        if (s.accruedSlot === at) return { err: { InstructionError: [i, { Custom: 22 }] }, next: m };
        s.accruedSlot = at;
        s.kfEpoch += 1n;
        s.stale = new Set(all); // funding > 0: every accrual re-stales the cohort
        s.driftGen += 1n;
        continue;
      }
      if (s.accruedSlot !== at || !s.stale.has(pf)) return { err: { InstructionError: [i, { Custom: 22 }] }, next: m };
      s.stale.delete(pf);
      s.snap.set(pf, s.kfEpoch);
      if ([...s.snap.values()].every((e) => e >= s.genEpoch)) {
        s.driftPrior = s.driftGen;
        s.driftGen = 0n;
        s.genEpoch = s.kfEpoch;
      }
    }
    return { err: null, next: s };
  };

  const conn = {
    async getAccountInfoAndContext() {
      slot += 3;
      return { context: { slot }, value: { data: bytes(m), owner: PublicKey.default, lamports: 1, executable: false } };
    },
    async getAccountInfo() {
      return { data: bytes(m), owner: PublicKey.default, lamports: 1, executable: false };
    },
    async getLatestBlockhash() {
      return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 };
    },
    async getProgramAccounts() {
      return portfolioAccounts().map((a) => ({ pubkey: a.pubkey, account: { data: a.data } }));
    },
    async simulateTransaction(vtx: VersionedTransaction, cfg: { accounts?: { addresses: string[] } }) {
      const r = apply(wrapperIxs(vtx.message as never), slot);
      const accounts = (cfg.accounts?.addresses ?? []).map((a) => {
        if (a === MARKET.toBase58()) return { data: [bytes(r.err ? m : r.next).toString("base64"), "base64"] };
        const e = INDEX.find((x) => x.pubkey === a);
        return e ? { data: [fx(e.fixture).toString("base64"), "base64"] } : null;
      });
      return { context: { slot }, value: { err: r.err, logs: [], accounts } };
    },
    async sendRawTransaction(raw: Buffer) {
      const ixs = wrapperIxs(Transaction.from(raw).compileMessage() as never);
      const r = apply(ixs, slot);
      const kinds = ixs.filter((x) => !x.program.equals(ComputeBudgetProgram.programId)).map((x) => (x.data[9] > 0 ? "obs" : "refresh"));
      sends.push({ kinds, heldAtSend: isPushHeld(MARKET.toBase58()), slot });
      const sig = `sig${++sigN}`;
      if (!r.err) {
        m = r.next;
        landed.add(sig);
      }
      slot += 1; // the next transaction lands in a later slot
      return sig;
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map((s) => (landed.has(s) ? { err: null, confirmationStatus: "processed" } : null)) };
    },
  };
  return { conn, sends, model: () => m, bytes: () => bytes(m) };
}

describe("drift-layout fixture conversion", () => {
  it("the converted Percolator market is drift layout and decodes", () => {
    const chain = driftChain({ insurance: 10n ** 12n });
    const b = chain.bytes();
    assert.equal(detectMarketLayout(b), "drift");
    const s = decodeSweepMarketState(b);
    assert.ok(s);
    assert.equal(s.maxMarketSlots, 1);
    assert.equal(s.staleLong, 12n);
    assert.equal(decodeMarketRefreshState(b).storedPosLong, 8n);
  });
});

describe("crankOneMarket on a drift-layout market (continuous sweep)", () => {
  it("covered: one [observation crank, refresh x 10] tx per cycle, no push hold, round robin reaches all 12 in 2 cycles", async () => {
    const chain = driftChain({ insurance: 10n ** 12n });
    const st = freshCrankMarketState();
    await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
    assert.equal(chain.sends.length, 1, "relaxed pace: the accrual tx only");
    assert.deepEqual(chain.sends[0].kinds, ["obs", ...Array(10).fill("refresh")]);
    assert.equal(chain.sends[0].heldAtSend, false, "a sweep never holds pushes");
    assert.equal(chain.model().stale.size, 2, "2 of 12 still stale: fine while covered");
    const h = getCrankRefreshHealth(MARKET.toBase58());
    assert.ok(h?.sweep);
    assert.equal(h.sweep.covered, true);
    assert.equal(h.sweep.blocksRiskIncrease, false);
    assert.equal(h.sweep.pace, "relaxed");
    assert.equal(h.sweep.staleLong, 2);
    assert.equal(h.sweep.refreshed, 10);
    assert.equal(h.positioned, 12);
    assert.equal(h.lossStaleCycles, 0);
    assert.equal(h.status, "ok");
    const f = crankHealthFields(h);
    assert.equal(f.lossStale, 0);
    assert.equal(f.sweepCovered, true);
    assert.equal(typeof f.sweepCoverageRatio, "number");
    assert.equal(st.sweepCursor.visits.size, 10);

    await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
    assert.equal(chain.sends.length, 2);
    assert.equal(st.sweepCursor.visits.size, 12, "the 2 left over were taken first in cycle 2");
    const cycle2 = new Set(chain.sends[1].kinds);
    assert.deepEqual([...cycle2], ["obs", "refresh"]);
    // every portfolio refreshed since the generation began -> it rotated: drift_gen moved to
    // drift_prior and a new generation started at the current KF epoch (the 2 portfolios this
    // cycle did not reach are now its laggards, picked first next cycle)
    const s = decodeSweepMarketState(chain.bytes());
    assert.ok(s);
    assert.equal(s.driftLong.genEpoch, chain.model().kfEpoch);
    assert.equal(s.driftLong.driftGen, 0n);
    assert.equal(s.driftLong.laggardCount, 2n);
    assert.equal(getCrankRefreshHealth(MARKET.toBase58())?.status, "ok");
  });

  it("not covered (no insurance): urgent pace sweeps everyone this cycle in 2 txs, each with its own accrual; alerts after N cycles", async () => {
    const chain = driftChain({ insurance: 0n });
    const st = freshCrankMarketState();
    for (let i = 1; i <= LOSS_STALE_ALERT_CYCLES; i++) {
      const before = chain.sends.length;
      await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
      const cycle = chain.sends.slice(before);
      assert.equal(cycle.length, 2, "ceil(12 / 10) sweep txs");
      for (const s of cycle) {
        assert.equal(s.kinds[0], "obs", "every sweep tx starts with the LP observation crank");
        assert.ok(s.kinds.slice(1).every((k) => k === "refresh"));
        assert.equal(s.heldAtSend, false);
      }
      assert.equal(cycle[0].kinds.length - 1 + cycle[1].kinds.length - 1, 12, "all 12 refreshed this cycle");
      assert.notEqual(cycle[0].slot, cycle[1].slot, "spread across slots");
      const h = getCrankRefreshHealth(MARKET.toBase58())!;
      assert.equal(h.sweep?.covered, false);
      assert.equal(h.sweep?.pace, "urgent");
      assert.equal(h.sweep?.txsSent, 2);
      assert.equal(h.sweep?.coverageRatio, null, "bound against zero insurance: infinite");
      assert.equal(h.lossStaleCycles, i);
      assert.equal(h.status, i >= LOSS_STALE_ALERT_CYCLES ? "loss-stale" : "ok");
      assert.equal(crankHealthFields(h).lossStale, 1);
    }
    const sample = crankSample("Percolator/USDC", MARKET.toBase58(), st);
    assert.ok(sample?.sweep);
    const ev = evaluateCrankHealth(sample, freshStreaks(), DEFAULT_THRESHOLDS);
    assert.ok(ev.active.some((a) => a.kind === "loss-stale"));
  });

  it("a legacy-layout account (unconverted fixture) never decodes as drift, so the sweep does not engage", async () => {
    // The legacy fixture itself, unconverted: overflow-refresh.test.ts pins that path in
    // detail; here only that the sweep does not engage on it.
    const st = freshCrankMarketState();
    assert.equal(decodeSweepMarketState(fx("percolator-market-v18-relaunch")), null);
    assert.equal(st.sweepCursor.visits.size, 0);
  });
});
