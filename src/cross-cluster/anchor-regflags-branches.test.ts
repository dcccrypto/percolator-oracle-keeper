/**
 * Branch coverage for two keeper-gating helpers: registry-flags.ts (per-market registry flags) and the
 * explicit-layout path of v22/create-anchor.ts buildCreateAnchorIxs. Each test asserts the DECISION returned.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_V22 } from "@percolatorct/sdk";
import type { LayoutTable } from "@percolatorct/sdk";
import { LP_VAULT_REGISTRY_BOUND_FLAG_OFF, LP_VAULT_REGISTRY_EXT_FLAG_OFF, lpVaultRegistryBound, lpVaultRegistryExtFlag } from "./registry-flags.ts";
import { buildCreateAnchorIxs } from "./v22/create-anchor.ts";
import { key } from "./v22/test-helpers.ts";

const withByte = (off: number, b: number | null, len = off + 8) => {
  const d = new Uint8Array(len);
  if (b !== null) d[off] = b;
  return d;
};

describe("lpVaultRegistryBound", () => {
  it("offsets are 160 / 161", () => {
    assert.equal(LP_VAULT_REGISTRY_BOUND_FLAG_OFF, 160);
    assert.equal(LP_VAULT_REGISTRY_EXT_FLAG_OFF, 161);
  });
  it("a short account (flag byte out of range, incl. exactly offset length) reads unbound", () => {
    assert.equal(lpVaultRegistryBound(new Uint8Array(0)), false);
    assert.equal(lpVaultRegistryBound(new Uint8Array(160)), false);
    assert.equal(lpVaultRegistryBound(new Uint8Array(100).fill(1)), false);
  });
  it("0 => unbound, 1 => bound", () => {
    assert.equal(lpVaultRegistryBound(withByte(160, 0)), false);
    assert.equal(lpVaultRegistryBound(withByte(160, 1)), true);
    assert.equal(lpVaultRegistryBound(new Uint8Array(161)), false, "exactly offset+1 long, zero byte");
  });
  it("any other byte throws, naming the value (reported, not guessed)", () => {
    for (const b of [2, 7, 255]) assert.throws(() => lpVaultRegistryBound(withByte(160, b)), new RegExp(`flag is ${b} \\(only 0/1`));
  });
  it("the ext flag byte next door does not affect the bound decision", () => {
    const d = withByte(160, 1);
    d[161] = 9;
    assert.equal(lpVaultRegistryBound(d), true);
  });
});

describe("lpVaultRegistryExtFlag", () => {
  it("short account => false, even with garbage elsewhere", () => {
    assert.equal(lpVaultRegistryExtFlag(new Uint8Array(0)), false);
    assert.equal(lpVaultRegistryExtFlag(new Uint8Array(161).fill(1)), false);
  });
  it("only the exact byte 1 means ext exists; 0, 2 and 255 never throw and read as no ext", () => {
    assert.equal(lpVaultRegistryExtFlag(withByte(161, 1)), true);
    assert.equal(lpVaultRegistryExtFlag(withByte(161, 0)), false);
    assert.equal(lpVaultRegistryExtFlag(withByte(161, 2)), false);
    assert.equal(lpVaultRegistryExtFlag(withByte(161, 255)), false);
    assert.equal(lpVaultRegistryExtFlag(new Uint8Array(162)), false);
  });
  it("the bound flag byte does not affect the ext decision", () => {
    const d = withByte(161, 0);
    d[160] = 1;
    assert.equal(lpVaultRegistryExtFlag(d), false);
  });
});

describe("buildCreateAnchorIxs explicit layout", () => {
  const keeper = key(1), anchor = key(2), market = key(3), programId = key(4);
  const size = (ix: { data: Buffer }) => Number(ix.data.readBigUInt64LE(12));
  it("defaults to LAYOUT_V22 and honours an explicit layout's portfolio length", () => {
    const [dflt, init] = buildCreateAnchorIxs({ keeper, anchor, market, programId, lamports: 5 });
    assert.equal(size(dflt as never), LAYOUT_V22.portfolio.accountLen);
    assert.equal(init.programId.toBase58(), programId.toBase58());
    const custom = { ...LAYOUT_V22, portfolio: { ...LAYOUT_V22.portfolio, accountLen: 1234 } } as LayoutTable;
    const [c] = buildCreateAnchorIxs({ keeper, anchor, market, programId, lamports: 5, layout: custom });
    assert.equal(size(c as never), 1234);
  });
});

describe("checkMarketForAnchor unreadable market", () => {
  it("a non-layout failure while reading the market is reported as 'unreadable', not 'unsupported'", async () => {
    const { checkMarketForAnchor } = await import("./v22/create-anchor.ts");
    const boom = { length: 4, get 0(): number { throw new Error("kaboom"); } } as unknown as Uint8Array;
    assert.equal(checkMarketForAnchor({ owner: key(4), data: boom }, key(4)), "unreadable market account: kaboom");
  });
});
