/**
 * Market layout table (market-layout.ts): table-driven detection for every row,
 * a v2.2-length account decoded at the table's offsets, and the fail-loud
 * behaviour on an unknown stride / unsupported portfolio layout (error log,
 * counter, /health fields, alert, and NO legacy refresh-everything fallback).
 *
 * Security second pass K1: the previous detection only knew 1350 + n*2485 and
 * 1350 + n*2325, so every v2.2 market was "unknown" and silently took the old
 * accrue-and-refresh-everything cycle.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/market-layout.test.ts
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import {
  ABS_MAX_MARKET_SLOTS,
  ABS_WRAPPER_VERSION,
  KF_DRIFT_FIELDS,
  MARKET_LAYOUTS,
  assetSlotsOff,
  detectLayout,
  engineSlotBase,
  knownStrides,
  layoutById,
  marketAccountLen,
} from "./market-layout.ts";
import type { MarketLayout } from "./market-layout.ts";
import { decodeMarketRefreshState, staleCountOffsets } from "./positioned-refresh.ts";
import {
  POS_SCALE,
  SOCIAL_WEIGHT_SCALE,
  decodeSweepMarketState,
  detectMarketLayout,
  evaluateCoverage,
  sweepFieldOffsets,
} from "./positioned-sweep.ts";
import { crankOneMarket, crankSample, freshCrankMarketState, layoutHealthFor, sweepContextFor } from "./recovery-cranker.ts";
import { DEFAULT_SWEEP_CONFIG } from "./positioned-sweep.ts";
import { getCrankRefreshHealth, getLayoutProblemCounts, resetRefreshCoordination } from "./refresh-coordination.ts";
import { DEFAULT_THRESHOLDS, crankHealthRecord, evaluateCrankHealth, freshStreaks } from "./alerting.ts";
import { crankHealthFields, layoutProblemFields } from "./keeper-loop.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

afterEach(() => resetRefreshCoordination());

function emptyMarket(l: MarketLayout, slots = 1): Buffer {
  const b = Buffer.alloc(marketAccountLen(l, slots));
  b.writeUInt16LE(l.wrapperVersion, ABS_WRAPPER_VERSION);
  b.writeUInt32LE(slots, ABS_MAX_MARKET_SLOTS);
  return b;
}
function putU128(b: Buffer, off: number, v: bigint): void {
  b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
  b.writeBigUInt64LE(v >> 64n, off + 8);
}

describe("layout table", () => {
  it("has the four rows, internally consistent", () => {
    assert.deepEqual(MARKET_LAYOUTS.map((l) => l.id), ["v2.1-legacy", "v2.1-drift", "v2.2-drift", "v2.2-b"]);
    for (const l of MARKET_LAYOUTS) {
      assert.equal(l.slotStride, l.wrapperLen + l.engineSlotLen, l.id);
      // max_market_slots sits at the same absolute offset everywhere (detection reads it first)
      assert.equal(l.groupOff + l.header.maxMarketSlots, ABS_MAX_MARKET_SLOTS, l.id);
      assert.ok(l.header.currentSlot + 8 <= l.headerLen, l.id);
      if (l.slot.driftLong !== null && l.slot.driftShort !== null) {
        assert.equal(l.slot.driftShort, l.slot.driftLong + KF_DRIFT_FIELDS.len, l.id);
        // the drift tail is the END of the engine slot
        // (variant B appends #282's 32 B slot tail AFTER the drift tail)
        assert.equal(l.slot.driftShort + KF_DRIFT_FIELDS.len + (l.id === "v2.2-b" ? 64 : 0), l.engineSlotLen, l.id);
      } else {
        assert.equal(l.slot.driftLong, null);
        assert.equal(l.slot.driftShort, null);
      }
    }
    assert.equal(ABS_MAX_MARKET_SLOTS, 626);
  });

  it("pins the numbers of each row (the table is the single place to update)", () => {
    const leg = layoutById("v2.1-legacy");
    const d21 = layoutById("v2.1-drift");
    const d22 = layoutById("v2.2-drift");
    assert.deepEqual([assetSlotsOff(leg), leg.slotStride, leg.portfolioAccountLen], [1350, 2325, 9563]);
    assert.deepEqual([assetSlotsOff(d21), d21.slotStride, engineSlotBase(d21, 0), d21.slot.driftLong], [1350, 2485, 2374, 1301]);
    assert.equal(d21.provisional, false);
    // v2.2: offset_of! probe of engine release/v22-engine @ ee05b125 (Wave B + drift tail)
    assert.deepEqual(
      [d22.headerLen, assetSlotsOff(d22), d22.engineSlotLen, d22.slotStride, engineSlotBase(d22, 0)],
      [806, 1398, 1573, 2597, 2422],
    );
    assert.deepEqual([d22.portfolioAccountLen, d22.portfolioLegLen], [10091, 185]);
    assert.deepEqual(
      [d22.groupOff + d22.header.insurance, d22.groupOff + d22.header.sourceInsuranceReservedTotal, d22.groupOff + d22.header.currentSlot],
      [941, 1085, 1253],
    );
    assert.deepEqual([d22.slot.insBudgetLong, d22.slot.barrierShort, d22.slot.insReservationLong, d22.slot.driftLong, d22.slot.driftShort], [627, 699, 1269, 1413, 1493]);
    // v2.2 = v2.1-drift slot + 112 (AssetStateV16 band/rent words) and header + 48 (V16Config)
    assert.equal(d22.slotStride, d21.slotStride + 112);
    assert.equal(d22.headerLen, d21.headerLen + 48);
    assert.equal(d22.provisional, true);
    assert.equal(d22.v21Decoders, false);
    assert.equal(marketAccountLen(d22, 1), 3995);
  });

  for (const l of MARKET_LAYOUTS) {
    for (const slots of [1, 2, 14]) {
      it(`detects ${l.id} with ${slots} slot(s) from the account length`, () => {
        const det = detectLayout(emptyMarket(l, slots));
        assert.equal(det.known, true);
        if (det.known) {
          assert.equal(det.layout.id, l.id);
          assert.equal(det.slots, slots);
        }
        assert.equal(detectMarketLayout(emptyMarket(l, slots)), l.slot.driftLong === null ? "legacy" : "drift");
      });
    }
  }

  it("real devnet markets are v2.1-legacy", () => {
    for (const name of ["cate-market-v18", "jup-market-v18", "percolator-market-v18-relaunch"]) {
      const det = detectLayout(fixture(name));
      assert.equal(det.known && det.layout.id, "v2.1-legacy", name);
    }
  });

  it("unknown: any other length, a zero slot count, or a short account (with the reason)", () => {
    const d22 = layoutById("v2.2-drift");
    // Wave B WITHOUT the drift tail (stride 2437, VERSION 19): not a row, so not guessed
    const waveBOnly = Buffer.alloc(assetSlotsOff(d22) + (d22.slotStride - 160));
    waveBOnly.writeUInt16LE(19, ABS_WRAPPER_VERSION);
    waveBOnly.writeUInt32LE(1, ABS_MAX_MARKET_SLOTS);
    const det = detectLayout(waveBOnly);
    assert.equal(det.known, false);
    if (!det.known) {
      assert.equal(det.accountLen, 3835);
      assert.equal(det.version, 19);
      assert.match(det.reason, /matches no known layout/);
      for (const l of MARKET_LAYOUTS) assert.ok(det.reason.includes(String(l.slotStride)), `names stride ${l.slotStride}`);
    }
    const plusOne = Buffer.alloc(marketAccountLen(d22, 1) + 1);
    plusOne.writeUInt16LE(19, ABS_WRAPPER_VERSION);
    plusOne.writeUInt32LE(1, ABS_MAX_MARKET_SLOTS);
    assert.equal(detectLayout(plusOne).known, false);
    const wrongCount = emptyMarket(d22, 2);
    wrongCount.writeUInt32LE(3, ABS_MAX_MARKET_SLOTS);
    assert.equal(detectLayout(wrongCount).known, false);
    const zero = emptyMarket(d22, 1);
    zero.writeUInt32LE(0, ABS_MAX_MARKET_SLOTS);
    assert.equal(detectLayout(zero).known, false);
    assert.equal(detectLayout(Buffer.alloc(64)).known, false);
    assert.match(knownStrides(), /1350\+n\*2325.*1350\+n\*2485.*1398\+n\*2597/);
  });

  it("length collision: 3835 bytes is BOTH v2.1-drift (1350+2485) and Wave-B-without-drift (1398+2437); the VERSION decides", () => {
    const d21 = layoutById("v2.1-drift");
    assert.equal(marketAccountLen(d21, 1), 1398 + 2437);
    const asV21 = emptyMarket(d21, 1); // VERSION 18
    const det = detectLayout(asV21);
    assert.equal(det.known && det.layout.id, "v2.1-drift");
    const asV22 = Buffer.from(asV21);
    asV22.writeUInt16LE(19, ABS_WRAPPER_VERSION);
    assert.equal(detectLayout(asV22).known, false, "a VERSION 19 account of that length is not decoded with v2.1 offsets");
    assert.equal(decodeSweepMarketState(asV22), null);
    // and a v2.2-length account that still says VERSION 18 is not a v2.2 market either
    const wrongVersion = emptyMarket(layoutById("v2.2-drift"), 1);
    wrongVersion.writeUInt16LE(18, ABS_WRAPPER_VERSION);
    assert.equal(detectLayout(wrongVersion).known, false);
  });
});

describe("v2.2-drift account decoded at the table's offsets", () => {
  const d22 = layoutById("v2.2-drift");
  const W = SOCIAL_WEIGHT_SCALE * POS_SCALE;
  const build = (): Buffer => {
    const b = emptyMarket(d22, 1);
    const g = d22.groupOff;
    const e = engineSlotBase(d22, 0);
    b.writeBigUInt64LE(500n, g + d22.header.maxAccrualDtSlots);
    putU128(b, g + d22.header.insurance, 1_000n);
    putU128(b, g + d22.header.sourceInsuranceReservedTotal, 100n);
    b.writeBigUInt64LE(9_000n, g + d22.header.currentSlot);
    b[g + d22.header.lossStaleActive] = 1;
    b[e + d22.asset.lifecycle] = 2;
    b.writeBigUInt64LE(9_000n, e + d22.asset.slotLast);
    b.writeBigUInt64LE(77n, e + d22.asset.kfEpochLong);
    b.writeBigUInt64LE(78n, e + d22.asset.kfEpochShort);
    b.writeBigUInt64LE(6n, e + d22.asset.storedPosLong);
    b.writeBigUInt64LE(5n, e + d22.asset.storedPosShort);
    b.writeBigUInt64LE(3n, e + d22.asset.staleLong);
    b.writeBigUInt64LE(2n, e + d22.asset.staleShort);
    putU128(b, e + d22.slot.insBudgetLong, 800n);
    putU128(b, e + d22.slot.insBudgetShort, 700n);
    putU128(b, e + d22.slot.insSpentLong, 100n);
    b.writeBigUInt64LE(0n, e + d22.slot.barrierLong);
    putU128(b, e + d22.slot.insReservationShort, 0n);
    const dl = e + d22.slot.driftLong!;
    b.writeBigUInt64LE(70n, dl + KF_DRIFT_FIELDS.genEpoch);
    b.writeBigUInt64LE(1n, dl + KF_DRIFT_FIELDS.laggardCount);
    putU128(b, dl + KF_DRIFT_FIELDS.driftGen, 10n);
    putU128(b, dl + KF_DRIFT_FIELDS.driftPrior, 4n);
    putU128(b, dl + KF_DRIFT_FIELDS.staleWeight, 3n * W);
    putU128(b, dl + KF_DRIFT_FIELDS.laggardWeight, 1n * W);
    const ds = e + d22.slot.driftShort!;
    b.writeBigUInt64LE(71n, ds + KF_DRIFT_FIELDS.genEpoch);
    putU128(b, ds + KF_DRIFT_FIELDS.driftGen, 7n);
    putU128(b, ds + KF_DRIFT_FIELDS.staleWeight, 2n * W);
    return b;
  };

  it("the drift tail, stale counts and insurance are read from the v2.2 offsets", () => {
    const s = decodeSweepMarketState(build());
    assert.ok(s);
    assert.equal(s.layoutId, "v2.2-drift");
    assert.deepEqual([s.staleLong, s.staleShort, s.kfEpochLong, s.kfEpochShort], [3n, 2n, 77n, 78n]);
    assert.deepEqual([s.currentSlot, s.slotLast, s.insurance, s.sourceInsuranceReservedTotal], [9_000n, 9_000n, 1_000n, 100n]);
    assert.deepEqual([s.insuranceBudgetLong, s.insuranceBudgetShort, s.insuranceSpentLong], [800n, 700n, 100n]);
    assert.deepEqual(s.driftLong, { genEpoch: 70n, laggardCount: 1n, driftGen: 10n, driftPrior: 4n, staleWeight: 3n * W, laggardWeight: W });
    assert.equal(s.driftShort.driftGen, 7n);
    const c = evaluateCoverage(s);
    // long: 3*10 + 1*4 + 2*3 = 40 vs short domain min(900, 700) = 700; short: 2*7 + 2*2 = 18 vs long domain 700
    assert.deepEqual([c.boundLong, c.boundShort, c.availableShortDomain, c.availableLongDomain], [40n, 18n, 700n, 700n]);
    assert.equal(c.covered, true);
    assert.equal(c.relaxedEligible, true);
  });

  it("the refresh decoder reads the v2.2 header and asset state", () => {
    const r = decodeMarketRefreshState(build());
    assert.deepEqual(
      [r.maxAccrualDtSlots, r.currentSlot, r.slotLast, r.storedPosLong, r.storedPosShort, r.staleLong, r.staleShort, r.lossStaleActive],
      [500n, 9_000n, 9_000n, 6n, 5n, 3n, 2n, true],
    );
    assert.deepEqual(staleCountOffsets(0, d22), { long: engineSlotBase(d22, 0) + 337, short: engineSlotBase(d22, 0) + 345 });
  });

  it("the v2.1 offsets on the same bytes read something else (a guessed layout would be wrong)", () => {
    const b = build();
    const v21 = sweepFieldOffsets(0, layoutById("v2.1-drift"));
    const v22 = sweepFieldOffsets(0, d22);
    assert.notEqual(v21.staleLong, v22.staleLong);
    assert.notEqual(b.readBigUInt64LE(v21.staleLong), 3n);
    assert.notEqual(b.readBigUInt64LE(v21.currentSlot), 9_000n);
  });

  it("negative control (K1): the OLD detection called a v2.2 account unknown and silently fell back to legacy", () => {
    // the detection this PR shipped before the table: only 1350 + n*2485 and 1350 + n*2325
    const oldDetect = (data: Uint8Array): "drift" | "legacy" | "unknown" => {
      const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(626, true);
      if (n === 0) return "unknown";
      if (data.length === 1350 + n * 2485) return "drift";
      if (data.length === 1350 + n * 2325) return "legacy";
      return "unknown";
    };
    const b = build();
    assert.equal(oldDetect(b), "unknown"); // -> old sweepContextFor returned null -> refresh-everything cycle, no log
    const det = detectLayout(b);
    assert.equal(det.known && det.layout.id, "v2.2-drift");
    assert.ok(sweepContextFor(b, [], { sweepCursor: { visits: new Map(), roundStart: 0, seq: 0, roundPending: false } }, DEFAULT_SWEEP_CONFIG, true));
  });
});

// ── Fail loudly in the cranker ────────────────────────────────────────────────

const KEEPER = Keypair.generate();
const MARKET = PublicKey.unique();
const LP = PublicKey.unique();
const ENTRY = { marketAddress: MARKET.toBase58(), label: "V22/USDC", lpPortfolio: LP.toBase58() };

function fakeConn(data: Buffer) {
  let slot = 10_000;
  const sends: string[][] = [];
  let programAccountCalls = 0;
  const kinds = (raw: Buffer): string[] => {
    const msg = Transaction.from(raw).compileMessage();
    return msg.compiledInstructions
      .filter((ix) => !msg.staticAccountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId))
      .map((ix) => (ix.data[9] > 0 ? "obs" : "refresh"));
  };
  const conn = {
    async getAccountInfoAndContext() {
      slot += 3;
      return { context: { slot }, value: { data, owner: PublicKey.default, lamports: 1, executable: false } };
    },
    async getAccountInfo() {
      return { data, owner: PublicKey.default, lamports: 1, executable: false };
    },
    async getLatestBlockhash() {
      return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 };
    },
    async getProgramAccounts() {
      programAccountCalls++;
      return [];
    },
    async simulateTransaction() {
      return { context: { slot }, value: { err: null, logs: [], accounts: [{ data: [data.toString("base64"), "base64"] }] } };
    },
    async sendRawTransaction(raw: Buffer) {
      sends.push(kinds(raw));
      return `sig${sends.length}`;
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map(() => ({ err: null, confirmationStatus: "processed" })) };
    },
  };
  return { conn, sends, programAccountCalls: () => programAccountCalls };
}

function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  return fn()
    .then((result) => ({ result, errors }))
    .finally(() => {
      console.error = orig;
    });
}

describe("unknown stride: fail loudly, no legacy fallback", () => {
  const unknownMarket = (): Buffer => {
    // a real-looking account with an unknown stride and "positions" where a legacy read would find them
    const b = Buffer.alloc(1398 + 2437);
    b.writeUInt16LE(19, ABS_WRAPPER_VERSION); // Wave B without the drift tail
    b.writeUInt32LE(1, ABS_MAX_MARKET_SLOTS);
    const legacy = layoutById("v2.1-legacy");
    b.writeBigUInt64LE(4n, engineSlotBase(legacy, 0) + legacy.asset.storedPosLong);
    b.writeBigUInt64LE(4n, engineSlotBase(legacy, 0) + legacy.asset.staleLong);
    return b;
  };

  it("decoders refuse it (no offsets guessed)", () => {
    const b = unknownMarket();
    assert.equal(decodeSweepMarketState(b), null);
    assert.throws(() => decodeMarketRefreshState(b), /unknown market layout.*length 3835.*2325.*2485.*2597/);
  });

  it("crankOneMarket: error log (market, length, known strides), counter, unhealthy, alert; accrual only", async () => {
    const chain = fakeConn(unknownMarket());
    const st = freshCrankMarketState();
    const { errors } = await captureErrors(() => crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false));
    // error-level log naming the market, the account length and the known strides
    const line = errors.find((e) => e.includes("[cranker][LAYOUT]"));
    assert.ok(line, "an error-level layout line");
    assert.ok(line.includes("V22/USDC") && line.includes(MARKET.toBase58()));
    assert.ok(line.includes("3835"));
    for (const l of MARKET_LAYOUTS) assert.ok(line.includes(`n*${l.slotStride}`));
    assert.match(line, /No legacy fallback/);
    // metric
    assert.deepEqual(getLayoutProblemCounts(), { unknown: 1, unsupported: 0 });
    // NO legacy refresh-everything: no portfolio discovery, no refresh instruction, just the accrual crank
    assert.equal(chain.programAccountCalls(), 0);
    assert.deepEqual(chain.sends, [["obs"]]);
    // unhealthy in /health
    const h = getCrankRefreshHealth(MARKET.toBase58());
    assert.ok(h);
    assert.equal(h.status, "layout-unknown");
    const f = crankHealthFields(h);
    assert.equal(f.crankStatus, "layout-unknown");
    assert.equal(f.marketLayout, "unknown");
    assert.equal(f.marketLayoutUnknown, true);
    assert.match(String(f.marketLayoutProblem), /matches no known layout/);
    const lpf = layoutProblemFields(["V22/USDC"]);
    // the VERSION-keyed guard's refusal counters ride along (by reason and by on-chain VERSION)
    const { layoutGuard, ...rest } = lpf as Record<string, unknown>;
    assert.deepEqual(rest, { layoutProblemMarkets: ["V22/USDC"], sweepLayoutUnknown: 1, sweepLayoutUnsupported: 0 });
    assert.ok((layoutGuard as { refusals: number }).refusals >= 1);
    assert.equal((layoutGuard as { lastCode: string }).lastCode, "NO_ROW_FOR_LENGTH");
    // alert through the existing crank alert path, and the [health] line
    const sample = crankSample("V22/USDC", MARKET.toBase58(), st);
    assert.ok(sample?.layout);
    const ev = evaluateCrankHealth(sample, freshStreaks(), DEFAULT_THRESHOLDS);
    const alert = ev.active.find((a) => a.kind === "market-layout");
    assert.ok(alert);
    assert.equal(alert.severity, "critical");
    assert.match(alert.message, /UNKNOWN/);
    const rec = crankHealthRecord(sample);
    assert.equal(rec.lay, "unknown");
    assert.equal(rec.layErr, 1);
  });

  it("the error is repeated periodically, the counter counts every read", async () => {
    const chain = fakeConn(unknownMarket());
    const st = freshCrankMarketState();
    const { errors } = await captureErrors(async () => {
      for (let i = 0; i < 31; i++) await crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false);
    });
    assert.equal(errors.filter((e) => e.includes("[cranker][LAYOUT]")).length, 2); // read 1 and read 31
    assert.equal(getLayoutProblemCounts().unknown, 31);
    assert.ok(chain.sends.every((k) => k.length === 1 && k[0] === "obs"));
  });
});

describe("v2.2 portfolios vs the SDK parser (gap reported, not hand-rolled)", () => {
  const d22 = layoutById("v2.2-drift");
  const v22Market = (): Buffer => {
    const b = emptyMarket(d22, 1);
    const e = engineSlotBase(d22, 0);
    b.writeBigUInt64LE(500n, d22.groupOff + d22.header.maxAccrualDtSlots);
    b.writeBigUInt64LE(10_002n, d22.groupOff + d22.header.currentSlot);
    b.writeBigUInt64LE(10_002n, e + d22.asset.slotLast);
    b[e + d22.asset.lifecycle] = 2;
    b.writeBigUInt64LE(9n, e + d22.asset.storedPosLong);
    b.writeBigUInt64LE(9n, e + d22.asset.storedPosShort);
    return b;
  };

  it("the SDK parser is VERSION-keyed: 9563 B at VERSION 18, 10603 B at VERSION 19; stage A (10091 B) is unsupported", () => {
    assert.equal(V17_PORTFOLIO_ACCOUNT_LEN, 9563);
    const det = detectLayout(v22Market());
    const h = layoutHealthFor(det, { storedPosLong: 9n, storedPosShort: 9n });
    assert.equal(h.kind, "unsupported");
    assert.equal(h.id, "v2.2-drift");
    assert.equal(h.provisional, true);
    assert.match(h.problem ?? "", /10091-byte portfolios \(leg 185 B\).*parsePortfolioV17.*10603/);
    // once the SDK parser handles the v2.2 portfolio the same market is fully supported
    assert.equal(layoutHealthFor(det, null, 10091).kind, "ok");
    // and the v2.1 layouts are supported by today's SDK
    for (const id of ["v2.1-legacy", "v2.1-drift"] as const) {
      assert.equal(layoutHealthFor(detectLayout(emptyMarket(layoutById(id))), null).kind, "ok", id);
    }
  });

  it("crankOneMarket on a v2.2 market: loud, unhealthy, accrual only, no portfolio parsing attempted", async () => {
    const chain = fakeConn(v22Market());
    const st = freshCrankMarketState();
    const { errors } = await captureErrors(() => crankOneMarket(chain.conn as never, KEEPER, ENTRY, st, false));
    const line = errors.find((e) => e.includes("[cranker][LAYOUT]"));
    assert.ok(line);
    assert.match(line, /v2\.2-drift.*10091.*parsePortfolioV17/);
    assert.deepEqual(getLayoutProblemCounts(), { unknown: 0, unsupported: 1 });
    assert.equal(chain.programAccountCalls(), 0);
    assert.deepEqual(chain.sends, [["obs"]]);
    const h = getCrankRefreshHealth(MARKET.toBase58());
    assert.equal(h?.status, "layout-unsupported");
    assert.equal(h?.layout?.hasPositions, true);
    assert.equal(crankHealthFields(h).marketLayout, "v2.2-drift");
    assert.equal(crankHealthFields(h).marketLayoutUnknown, false);
    const sample = crankSample("V22/USDC", MARKET.toBase58(), st);
    assert.ok(sample);
    // the engine clock was read from the v2.2 header, not a v2.1 guess
    assert.equal(sample.engineSlot, 10_002n);
    const alert = evaluateCrankHealth(sample, freshStreaks(), DEFAULT_THRESHOLDS).active.find((a) => a.kind === "market-layout");
    assert.equal(alert?.severity, "critical");
  });

  it("a v2.2 market with no position is still reported, at warn", () => {
    const det = detectLayout(emptyMarket(d22, 1));
    const layout = layoutHealthFor(det, { storedPosLong: 0n, storedPosShort: 0n });
    const ev = evaluateCrankHealth(
      {
        label: "X", market: "m", chainSlot: 10n, engineSlot: 10n, crankOk: true, crankReverted: false, totalOk: 1, totalReverts: 0,
        consecutiveReverts: 0, lastRevertCode: null, lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0, layout,
      },
      freshStreaks(),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(ev.active.find((a) => a.kind === "market-layout")?.severity, "warn");
  });
});

describe("recognised layouts stay healthy", () => {
  it("no layout problem ever seen: /health top level gains no key", () => {
    assert.deepEqual(layoutProblemFields([]), {});
  });

  it("v2.1-legacy and v2.1-drift carry their layout id and no problem", () => {
    for (const id of ["v2.1-legacy", "v2.1-drift"] as const) {
      const h = layoutHealthFor(detectLayout(emptyMarket(layoutById(id))), { storedPosLong: 1n, storedPosShort: 0n });
      assert.deepEqual([h.id, h.problem, h.kind], [id, null, "ok"]);
    }
  });
});
