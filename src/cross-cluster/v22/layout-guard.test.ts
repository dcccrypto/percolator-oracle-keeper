import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_V21, LAYOUT_V22, LAYOUTS_BY_VERSION } from "@percolatorct/sdk";
import type { LayoutTable } from "@percolatorct/sdk";
import { detectLayout, layoutById, marketAccountLen, rowAgreesWithSdk, SDK_PORTFOLIO_LENS, v22VariantBRow } from "../market-layout.ts";
import { layoutGuardSnapshot, resetLayoutGuardMetrics } from "../layout-guard-metrics.ts";
import { layoutHealthFor } from "../recovery-cranker.ts";
import { analysePortfolios } from "./positioned.ts";
import { buildV22MarketCtx } from "./market.ts";
import { v22MarketBytes, key } from "./test-helpers.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";

beforeEach(() => resetLayoutGuardMetrics());
const B = layoutById("v2.2-b");

describe("VERSION-keyed layout guard", () => {
  it("variant B: every geometry number comes from the SDK LAYOUT_V22 (slot 2,629, leg 217, portfolio 10,603, group 806, VERSION 19)", () => {
    assert.deepEqual([B.wrapperVersion, B.slotStride, B.portfolioLegLen, B.portfolioAccountLen, B.headerLen, B.groupOff], [19, 2629, 217, 10603, 806, 592]);
    assert.deepEqual([B.slotStride, B.portfolioAccountLen, B.portfolioLegLen, B.headerLen], [LAYOUT_V22.assetSlotStride, LAYOUT_V22.portfolio.accountLen, LAYOUT_V22.portfolio.legStride, LAYOUT_V22.marketGroupLen]);
    assert.equal(rowAgreesWithSdk(B), null);
    assert.equal(rowAgreesWithSdk(layoutById("v2.1-legacy")), null);
    assert.equal(rowAgreesWithSdk(layoutById("v2.1-drift")), null);
    assert.deepEqual([...SDK_PORTFOLIO_LENS].sort((a, b) => a - b), [9563, 10603]);
  });

  it("a VERSION 19 account of the variant-B length detects as v2.2-b (not stage A), for 1..14 slots", () => {
    for (const n of [1, 2, 14]) {
      const d = detectLayout(v22MarketBytes({ slots: n }));
      assert.ok(d.known);
      if (d.known) assert.equal(d.layout.id, "v2.2-b");
      assert.equal(marketAccountLen(B, n), v22MarketBytes({ slots: n }).length);
    }
  });

  it("unknown VERSION is a LOUD error: known=false, counted by code and VERSION, logged once, never a fallback", () => {
    const d = detectLayout(v22MarketBytes({ version: 20 }));
    assert.equal(d.known, false);
    if (!d.known) assert.match(d.reason, /sdk-guard: UNKNOWN_VERSION/);
    const s = layoutGuardSnapshot();
    assert.equal(s.refusals, 1);
    assert.equal(s.byCode.UNKNOWN_VERSION, 1);
    assert.equal(s.byVersion["20"], 1);
    detectLayout(v22MarketBytes({ version: 20 }));
    assert.equal(layoutGuardSnapshot().refusals, 2);
  });

  it("NEGATIVE CONTROL: a variant-B-sized account stamped VERSION 18 is NOT decoded with v2.1 offsets (unknown), nor with v2.2 ones", () => {
    const d = detectLayout(v22MarketBytes({ version: 18 }));
    assert.equal(d.known, false);
    assert.equal(layoutGuardSnapshot().byCode.NO_ROW_FOR_LENGTH, 1);
  });

  it("a known VERSION with a length that matches no row is refused (NO_ROW_FOR_LENGTH)", () => {
    const b = Buffer.from(v22MarketBytes());
    const d = detectLayout(new Uint8Array(Buffer.concat([b, Buffer.alloc(7)])));
    assert.equal(d.known, false);
    assert.equal(layoutGuardSnapshot().byCode.NO_ROW_FOR_LENGTH, 1);
  });

  it("a keeper row that disagrees with the pinned SDK table is refused (ROW_DISAGREES_WITH_SDK), via an SDK that moved", () => {
    const moved: LayoutTable = { ...LAYOUT_V22, assetSlotStride: LAYOUT_V22.assetSlotStride + 8 };
    const registry = new Map<number, LayoutTable>([[18, LAYOUT_V21], [19, moved]]);
    assert.match(rowAgreesWithSdk(B, registry) ?? "", /slotStride keeper 2629 != SDK 2637/);
    // a row rebuilt from the moved table carries the new stride, i.e. the table is the single source
    assert.equal(v22VariantBRow(moved).slotStride, 2637);
    assert.match(rowAgreesWithSdk(layoutById("v2.1-legacy"), new Map([[18, { ...LAYOUT_V21, marketGroupLen: 760 }]])) ?? "", /headerLen/);
    assert.match(rowAgreesWithSdk(B, new Map()) ?? "", /no layout for VERSION 19/);
    assert.ok(LAYOUTS_BY_VERSION.has(19));
  });

  it("layout health: variant B is supported (SDK reads 10,603 B at VERSION 19); stage A (10,091 B) is unsupported and says why", () => {
    const ok = layoutHealthFor(detectLayout(v22MarketBytes()), null);
    assert.equal(ok.kind, "ok");
    assert.equal(ok.id, "v2.2-b");
    const stageA = layoutById("v2.2-drift");
    const len = marketAccountLen(stageA, 1);
    const b = Buffer.alloc(len);
    b.writeUInt16LE(19, 8);
    b.writeUInt32LE(1, stageA.groupOff + stageA.header.maxMarketSlots);
    const h = layoutHealthFor(detectLayout(new Uint8Array(b)), null);
    assert.equal(h.kind, "unsupported");
    assert.match(h.problem ?? "", /10091-byte portfolios.*10603/);
  });

  it("the v2.2 loader runs the SDK's FULL guard: bad magic and wrong kind are refused loudly and counted", () => {
    const bad = Buffer.from(v22MarketBytes());
    bad.writeBigUInt64LE(0n, 0);
    const r = buildV22MarketCtx({ marketAddress: key(900).toBase58(), label: "x", programId: WRAPPER_PROGRAM_ID, data: new Uint8Array(bad), readSlot: 1, registryData: null, vaultLpStateData: null });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "layout-unknown");
    assert.equal(layoutGuardSnapshot().byCode.BAD_MAGIC, 1);
    const wrongKind = Buffer.from(v22MarketBytes());
    wrongKind[10] = 2;
    const k = buildV22MarketCtx({ marketAddress: key(900).toBase58(), label: "x", programId: WRAPPER_PROGRAM_ID, data: new Uint8Array(wrongKind), readSlot: 1, registryData: null, vaultLpStateData: null });
    assert.equal(k.ok, false);
    assert.equal(layoutGuardSnapshot().byCode.WRONG_KIND, 1);
  });

  it("a v2.1 market is not-v22 (the legacy cranker owns it) and costs no guard refusal", () => {
    const l = layoutById("v2.1-legacy");
    const b = Buffer.alloc(marketAccountLen(l, 1));
    b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
    b.writeUInt16LE(18, 8);
    b[10] = 1;
    b.writeUInt32LE(1, l.groupOff + l.header.maxMarketSlots);
    const r = buildV22MarketCtx({ marketAddress: key(900).toBase58(), label: "x", programId: WRAPPER_PROGRAM_ID, data: new Uint8Array(b), readSlot: 1, registryData: null, vaultLpStateData: null });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not-v22");
    assert.equal(layoutGuardSnapshot().refusals, 0);
  });

  it("portfolios: only SDK-parsable lengths are read; an undecodable account of the right length is counted, never guessed", () => {
    const ok = analysePortfolios([{ pubkey: key(1), data: new Uint8Array(10603) }, { pubkey: key(2), data: new Uint8Array(10091) }, { pubkey: key(3), data: new Uint8Array(9563) }], { lpPortfolio: null, portfolioLen: 10603 });
    assert.equal(ok.all.length, 0);
    assert.equal(ok.undecodable, 1, "the zeroed 10,603 B account fails the SDK guard; the other lengths are not this market's");
  });
});
