/**
 * market-layout.ts refusal / unknown-layout paths, exercised on real slab-shaped byte buffers
 * (length + header VERSION + max_market_slots built from the real table rows) and the real SDK
 * registry. No module under test is mocked.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/market-layout-refusals.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LAYOUTS_BY_VERSION, LAYOUT_V22 } from "@percolatorct/sdk";
import type { LayoutTable } from "@percolatorct/sdk";
import {
  ABS_MAX_MARKET_SLOTS,
  ABS_WRAPPER_VERSION,
  KF_DRIFT_FIELDS,
  MARKET_LAYOUTS,
  SDK_PORTFOLIO_LENS,
  describeUnknownLayout,
  detectLayout,
  layoutById,
  marketAccountLen,
  rowAgreesWithSdk,
  v22VariantBRow,
} from "./market-layout.ts";
import type { MarketLayout } from "./market-layout.ts";
import { layoutGuardSnapshot, resetLayoutGuardMetrics } from "./layout-guard-metrics.ts";

function slab(l: MarketLayout, slots = 1): Buffer {
  const b = Buffer.alloc(marketAccountLen(l, slots));
  b.writeUInt16LE(l.wrapperVersion, ABS_WRAPPER_VERSION);
  b.writeUInt32LE(slots, ABS_MAX_MARKET_SLOTS);
  return b;
}

let origError: typeof console.error;
beforeEach(() => {
  resetLayoutGuardMetrics();
  origError = console.error;
  console.error = () => {};
});
afterEach(() => {
  console.error = origError;
  resetLayoutGuardMetrics();
});

describe("detectLayout refusals", () => {
  it("UNKNOWN_VERSION: a VERSION the SDK registry lacks is refused even when the length matches a row", () => {
    const l = layoutById("v2.2-b");
    const det = detectLayout(slab(l), new Map());
    assert.equal(det.known, false);
    if (!det.known) {
      assert.equal(det.version, l.wrapperVersion);
      assert.equal(det.slots, 1);
    }
    const snap = layoutGuardSnapshot();
    assert.equal(snap.lastCode, "UNKNOWN_VERSION");
    assert.equal(snap.byCode.UNKNOWN_VERSION, 1);
    assert.equal(snap.byVersion[String(l.wrapperVersion)], 1);
  });

  it("UNKNOWN_VERSION reason names the sdk guard, not 'ambiguous', when exactly one row matches", () => {
    const l = layoutById("v2.2-b");
    const det = detectLayout(slab(l), new Map());
    assert.equal(det.known, false);
    if (!det.known) {
      assert.match(det.reason, /\[sdk-guard: UNKNOWN_VERSION\]/);
      assert.doesNotMatch(det.reason, /ambiguous/);
    }
  });

  it("UNKNOWN_VERSION: an unregistered header VERSION (e.g. 4242) is refused on the real registry", () => {
    const b = slab(layoutById("v2.1-drift"));
    b.writeUInt16LE(4242, ABS_WRAPPER_VERSION);
    const det = detectLayout(b);
    assert.equal(det.known, false);
    assert.equal(layoutGuardSnapshot().lastCode, "UNKNOWN_VERSION");
    assert.equal(layoutGuardSnapshot().lastVersion, 4242);
  });

  it("NO_ROW_FOR_LENGTH: known VERSION, wrong length has no guard suffix and counts the refusal", () => {
    const l = layoutById("v2.1-legacy");
    const b = Buffer.concat([slab(l), Buffer.alloc(1)]);
    const det = detectLayout(b);
    assert.equal(det.known, false);
    if (!det.known) assert.doesNotMatch(det.reason, /sdk-guard/);
    assert.equal(layoutGuardSnapshot().lastCode, "NO_ROW_FOR_LENGTH");
  });

  it("ROW_DISAGREES_WITH_SDK: a matched row whose geometry differs from the SDK table is refused", () => {
    const l = layoutById("v2.1-legacy");
    const real = LAYOUTS_BY_VERSION.get(l.wrapperVersion) as LayoutTable;
    const skewed = new Map(LAYOUTS_BY_VERSION);
    skewed.set(l.wrapperVersion, { ...real, marketGroupOff: real.marketGroupOff + 8 } as LayoutTable);
    const det = detectLayout(slab(l), skewed);
    assert.equal(det.known, false);
    if (!det.known) {
      assert.match(det.reason, /v2\.1-legacy disagrees with the pinned SDK table.*groupOff keeper 592 != SDK 600.*refusing to decode/);
      assert.equal(det.slots, 1);
      assert.equal(det.version, l.wrapperVersion);
    }
    assert.equal(layoutGuardSnapshot().lastCode, "ROW_DISAGREES_WITH_SDK");
  });

  it("AMBIGUOUS_ROW: two rows with the same VERSION and stride are refused, never first-match", () => {
    const base = layoutById("v2.1-drift");
    const dup: MarketLayout = { ...base, id: "v2.1-legacy" };
    const rows = MARKET_LAYOUTS as MarketLayout[];
    rows.push(dup);
    try {
      const det = detectLayout(slab(base));
      assert.equal(det.known, false);
      if (!det.known) assert.match(det.reason, /is ambiguous between v2\.1-drift \/ v2\.1-legacy/);
      assert.equal(layoutGuardSnapshot().lastCode, "AMBIGUOUS_ROW");
    } finally {
      rows.pop();
    }
    assert.equal(detectLayout(slab(base)).known, true);
  });

  it("a short account and max_market_slots == 0 return a reason without touching the guard counters", () => {
    const short = detectLayout(Buffer.alloc(ABS_MAX_MARKET_SLOTS + 3));
    assert.equal(short.known, false);
    if (!short.known) {
      assert.equal(short.slots, null);
      assert.equal(short.version, null);
      assert.match(short.reason, /too short/);
    }
    const exact = detectLayout(Buffer.alloc(ABS_MAX_MARKET_SLOTS + 4)); // zero slots, VERSION 0
    assert.equal(exact.known, false);
    if (!exact.known) {
      assert.equal(exact.slots, 0);
      assert.match(exact.reason, /max_market_slots is 0/);
    }
    assert.equal(layoutGuardSnapshot().refusals, 0);
  });

  it("detects on a Buffer view with a non-zero byteOffset (pooled slab)", () => {
    const l = layoutById("v2.2-b");
    const inner = slab(l, 2);
    const pooled = Buffer.alloc(inner.length + 16);
    inner.copy(pooled, 16);
    const det = detectLayout(pooled.subarray(16));
    assert.equal(det.known && det.layout.id, "v2.2-b");
    assert.equal(det.known && det.slots, 2);
  });
});

describe("describeUnknownLayout", () => {
  it("prefixes the reason for logs / alerts", () => {
    const det = detectLayout(Buffer.alloc(8));
    assert.equal(det.known, false);
    if (!det.known) assert.equal(describeUnknownLayout(det), `unknown market layout: ${det.reason}`);
  });
});

describe("rowAgreesWithSdk", () => {
  it("every shipped row agrees with the pinned SDK", () => {
    for (const l of MARKET_LAYOUTS) assert.equal(rowAgreesWithSdk(l), null, l.id);
  });

  it("an SDK registry with no table for the row's VERSION is reported", () => {
    const l = layoutById("v2.2-drift");
    assert.equal(rowAgreesWithSdk(l, new Map()), `SDK has no layout for VERSION ${l.wrapperVersion}`);
  });

  it("the variant-B row also compares stride, portfolio length and leg size, and joins every diff", () => {
    const l = layoutById("v2.2-b");
    const t = LAYOUTS_BY_VERSION.get(l.wrapperVersion) as LayoutTable;
    const sdk = new Map([
      [
        l.wrapperVersion,
        {
          ...t,
          marketGroupOff: t.marketGroupOff + 1,
          marketGroupLen: t.marketGroupLen + 1,
          wrapperSlotLen: t.wrapperSlotLen + 1,
          assetSlotStride: t.assetSlotStride + 1,
          portfolio: { ...t.portfolio, accountLen: t.portfolio.accountLen + 1, legStride: t.portfolio.legStride + 1 },
        } as LayoutTable,
      ],
    ]);
    const msg = rowAgreesWithSdk(l, sdk) as string;
    for (const n of ["groupOff", "headerLen", "wrapperLen", "slotStride", "portfolioAccountLen", "portfolioLegLen"]) {
      assert.ok(msg.includes(`${n} keeper`), n);
    }
    assert.equal(msg.split("; ").length, 6);
  });

  it("a non-variant-B row skips the stride / portfolio comparison", () => {
    const l = layoutById("v2.2-drift");
    const t = LAYOUTS_BY_VERSION.get(l.wrapperVersion) as LayoutTable;
    const sdk = new Map([[l.wrapperVersion, { ...t, assetSlotStride: 1, portfolio: { ...t.portfolio, accountLen: 1, legStride: 1 } } as LayoutTable]]);
    assert.equal(rowAgreesWithSdk(l, sdk), null);
  });
});

describe("v22VariantBRow / table helpers", () => {
  it("derives geometry from the SDK table and reflects provisional status", () => {
    const row = v22VariantBRow(LAYOUT_V22);
    assert.equal(row.provisional, LAYOUT_V22.status === "PROVISIONAL");
    assert.equal(row.groupOff, LAYOUT_V22.marketGroupOff);
    assert.equal(row.slotStride, LAYOUT_V22.assetSlotStride);
    assert.match(row.source, /^SDK LAYOUT_V22 /);
    const prov = v22VariantBRow({ ...LAYOUT_V22, status: "PROVISIONAL" } as LayoutTable);
    assert.equal(prov.provisional, true);
    const fin = v22VariantBRow({ ...LAYOUT_V22, status: "FINAL" } as unknown as LayoutTable);
    assert.equal(fin.provisional, false);
  });

  it("layoutById throws on an id with no row", () => {
    assert.throws(() => layoutById("v9.9" as never), /no market layout "v9\.9"/);
  });

  it("KF_DRIFT_FIELDS offsets are contiguous within one 80-byte block", () => {
    assert.deepEqual(
      [KF_DRIFT_FIELDS.genEpoch, KF_DRIFT_FIELDS.laggardCount, KF_DRIFT_FIELDS.driftGen, KF_DRIFT_FIELDS.driftPrior, KF_DRIFT_FIELDS.staleWeight, KF_DRIFT_FIELDS.laggardWeight],
      [0, 8, 16, 32, 48, 64],
    );
    assert.equal(KF_DRIFT_FIELDS.laggardWeight + 16, KF_DRIFT_FIELDS.len);
  });

  it("SDK_PORTFOLIO_LENS holds exactly the portfolio lengths of the SDK registry", () => {
    assert.deepEqual([...SDK_PORTFOLIO_LENS].sort(), [...new Set([...LAYOUTS_BY_VERSION.values()].map((t) => t.portfolio.accountLen))].sort());
    assert.ok(SDK_PORTFOLIO_LENS.has(9563));
  });
});
