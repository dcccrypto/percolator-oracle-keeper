import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildV22MarketCtx, crankOracleAccounts, loadV22Market, lpVaultRegistryBondFlag, readBand, REGISTRY_BOND_FLAG_OFF } from "./market.ts";
import { layoutById } from "../market-layout.ts";
import { layoutGuardSnapshot, resetLayoutGuardMetrics } from "../layout-guard-metrics.ts";
import { registryBytes, v22MarketBytes, vaultLpStateBytes, key } from "./test-helpers.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";

beforeEach(() => resetLayoutGuardMetrics());
const market = key(910);
const base = (over: Partial<Parameters<typeof buildV22MarketCtx>[0]> = {}) =>
  buildV22MarketCtx({ marketAddress: market.toBase58(), label: "T", programId: WRAPPER_PROGRAM_ID, data: v22MarketBytes(), readSlot: 5000, registryData: null, vaultLpStateData: null, ...over });

describe("buildV22MarketCtx guards", () => {
  it("bad magic and wrong kind are refused as layout-unknown and counted", () => {
    const bad = Buffer.from(v22MarketBytes());
    bad[0] ^= 0xff;
    const r = base({ data: new Uint8Array(bad) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "layout-unknown");
    assert.equal(layoutGuardSnapshot().byCode.BAD_MAGIC, 1);
    const wk = Buffer.from(v22MarketBytes());
    wk[10] = 2;
    const r2 = base({ data: new Uint8Array(wk) });
    assert.equal(r2.ok, false);
    assert.equal(layoutGuardSnapshot().byCode.WRONG_KIND, 1);
  });

  it("unknown VERSION falls through to detectLayout and is layout-unknown", () => {
    const r = base({ data: v22MarketBytes({ version: 20 }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "layout-unknown");
  });

  it("a too-short buffer is layout-unknown", () => {
    const r = base({ data: new Uint8Array(4) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "layout-unknown");
  });

  it("a non-variant-B layout is refused (not-v22 for v2.1, layout-unsupported for stage A)", async () => {
    const ml = await import("../market-layout.ts");
    const v21 = layoutById("v2.1-legacy");
    const d21 = new Uint8Array(ml.marketAccountLen(v21, 1));
    const r = base({ data: d21 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason === "layout-unknown" || r.reason === "not-v22");
    const drift = layoutById("v2.2-drift");
    const dd = Buffer.alloc(ml.marketAccountLen(drift, 1));
    dd.writeBigUInt64LE(Buffer.from(v22MarketBytes()).readBigUInt64LE(0), 0);
    dd.writeUInt16LE(19, 8);
    dd[10] = 1;
    const r2 = base({ data: new Uint8Array(dd) });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.ok(["layout-unsupported", "layout-unknown"].includes(r2.reason));
  });

  it("a market that fails the refresh read is unreadable", () => {
    const b = Buffer.from(v22MarketBytes());
    b.writeUInt32LE(0xffffffff, layoutById("v2.2-b").groupOff + layoutById("v2.2-b").header.maxMarketSlots);
    const r = base({ data: new Uint8Array(b) });
    assert.equal(r.ok, false);
  });
});

describe("buildV22MarketCtx registry / vault / pin", () => {
  it("an invalid bound byte reads as unbound; a short registry reads all flags false", () => {
    const reg = Buffer.from(registryBytes({ ext: true, bond: true }));
    reg[160] = 2;
    const r = base({ registryData: new Uint8Array(reg) });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual([r.ctx.bound, r.ctx.ext, r.ctx.bond], [false, true, true]);
    const s = base({ registryData: new Uint8Array(20) });
    assert.ok(s.ok);
    if (s.ok) assert.deepEqual([s.ctx.bound, s.ctx.ext, s.ctx.bond, s.ctx.registryDomain], [false, false, false, 0]);
  });

  it("lpVaultRegistryBondFlag: length guard and only 1 counts", () => {
    assert.equal(lpVaultRegistryBondFlag(new Uint8Array(REGISTRY_BOND_FLAG_OFF)), false);
    const b = new Uint8Array(REGISTRY_BOND_FLAG_OFF + 1);
    assert.equal(lpVaultRegistryBondFlag(b), false);
    b[REGISTRY_BOND_FLAG_OFF] = 1;
    assert.equal(lpVaultRegistryBondFlag(b), true);
    b[REGISTRY_BOND_FLAG_OFF] = 2;
    assert.equal(lpVaultRegistryBondFlag(b), false);
  });

  it("a decodable vault_lp_state wins over the hint and carries the outstanding draw", () => {
    const lp = key(920);
    const r = base({ vaultLpStateData: vaultLpStateBytes(lp, 77n), lpHint: key(921) });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.ctx.lpPortfolio?.toBase58(), lp.toBase58());
      assert.equal(r.ctx.seniorDrawOutstandingAtoms, 77n);
      assert.equal(r.ctx.sdk.lpPortfolio?.toBase58(), lp.toBase58());
    }
  });

  it("an undecodable vault_lp_state falls back to the hint (0 outstanding); no hint leaves lpPortfolio null", () => {
    const hint = key(922);
    const r = base({ vaultLpStateData: new Uint8Array(10), lpHint: hint });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.ctx.lpPortfolio?.toBase58(), hint.toBase58());
      assert.equal(r.ctx.seniorDrawOutstandingAtoms, 0n);
    }
    const n = base({ vaultLpStateData: new Uint8Array(10) });
    assert.ok(n.ok);
    if (n.ok) {
      assert.equal(n.ctx.lpPortfolio, null);
      assert.equal("lpPortfolio" in n.ctx.sdk, false);
    }
  });

  it("pin duration is read-slot based: pinned and past => delta; unpinned or not yet past => 0", () => {
    const a = base({ data: v22MarketBytes({ band: true, pinSince: 4000n, currentSlot: 5000n }) });
    assert.ok(a.ok);
    if (a.ok) assert.equal(a.ctx.pinDurationSlots, 1000n);
    const b = base({ data: v22MarketBytes({ band: true, currentSlot: 5000n }) });
    assert.ok(b.ok);
    if (b.ok) assert.equal(b.ctx.pinDurationSlots, 0n);
    const c = base({ data: v22MarketBytes({ band: true, pinSince: 6000n, currentSlot: 5000n }) });
    assert.ok(c.ok);
    if (c.ok) assert.equal(c.ctx.pinDurationSlots, 0n);
  });

  it("readBand reads the band/rent words", () => {
    const d = v22MarketBytes({ band: true, rent: true, pinSince: 42n });
    const s = readBand(d, layoutById("v2.2-b"), 0, 99n);
    assert.equal(s.bandBps, 130n);
    assert.equal(s.rentMaxE9PerSlot, 5000n);
    assert.equal(s.pinSinceSlot, 42n);
  });

  it("crankOracleAccounts: Hybrid carries the legs (a copy), AUTH_MARK none", () => {
    const f = key(930);
    const h = base({ data: v22MarketBytes({ oracleMode: 1, legs: 1, legFeeds: [f] }) });
    assert.ok(h.ok);
    if (h.ok) {
      const out = crankOracleAccounts(h.ctx);
      assert.deepEqual(out.map((k) => k.toBase58()), [f.toBase58()]);
      assert.notEqual(out, h.ctx.oracleLegFeeds);
    }
    assert.deepEqual(crankOracleAccounts({ oracleMode: 0, oracleLegFeeds: [f] }), []);
  });
});

describe("loadV22Market", () => {
  const entry = { marketAddress: market.toBase58(), label: "T" };
  const acct = (data: Uint8Array) => ({ data: Buffer.from(data) });
  const conn = (value: unknown[], slot = 123) => ({ getMultipleAccountsInfoAndContext: async () => ({ context: { slot }, value }) }) as never;

  it("loads market + registry + vault_lp_state at the context slot", async () => {
    const lp = key(940);
    const r = await loadV22Market(conn([acct(v22MarketBytes()), acct(registryBytes({ bound: true })), acct(vaultLpStateBytes(lp, 5n))]), entry, WRAPPER_PROGRAM_ID);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.ctx.readSlot, 123);
      assert.equal(r.ctx.bound, true);
      assert.equal(r.ctx.seniorDrawOutstandingAtoms, 5n);
    }
  });

  it("missing registry / vault state load as null; a valid lpPortfolio hint is used", async () => {
    const hint = key(941);
    const r = await loadV22Market(conn([acct(v22MarketBytes()), null, null]), { ...entry, lpPortfolio: hint.toBase58() }, WRAPPER_PROGRAM_ID);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.ctx.registryData, null);
      assert.equal(r.ctx.lpPortfolio?.toBase58(), hint.toBase58());
    }
  });

  it("an invalid lpPortfolio hint is dropped, not thrown", async () => {
    const r = await loadV22Market(conn([acct(v22MarketBytes()), null, null]), { ...entry, lpPortfolio: "not-a-key" }, WRAPPER_PROGRAM_ID);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.ctx.lpPortfolio, null);
  });

  it("a missing market account is unreadable", async () => {
    const r = await loadV22Market(conn([null, null, null]), entry, WRAPPER_PROGRAM_ID);
    assert.deepEqual(r.ok ? null : [r.reason, r.detail], ["unreadable", "market account not found"]);
  });

  it("an RPC error (Error or non-Error) never throws: unreadable with the message", async () => {
    const e1 = await loadV22Market({ getMultipleAccountsInfoAndContext: async () => { throw new Error("rpc down"); } } as never, entry, WRAPPER_PROGRAM_ID);
    assert.deepEqual(e1.ok ? null : [e1.reason, e1.detail], ["unreadable", "rpc down"]);
    const e2 = await loadV22Market({ getMultipleAccountsInfoAndContext: async () => { throw "boom"; } } as never, entry, WRAPPER_PROGRAM_ID);
    assert.deepEqual(e2.ok ? null : [e2.reason, e2.detail], ["unreadable", "boom"]);
    const e3 = await loadV22Market(conn([]), { marketAddress: "bad", label: "x" }, WRAPPER_PROGRAM_ID);
    assert.equal(e3.ok, false);
  });
});

