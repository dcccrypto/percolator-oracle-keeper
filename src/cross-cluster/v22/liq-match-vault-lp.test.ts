/**
 * bigtest-2026-11-05 F2 (KEEPER_V22_LIQUIDATE_MATCH_VAULT_LP): the bound vault LP rides as the LAST account on the refresh and the
 * liquidation crank of every flagged account, so a wrapper with feat/v22-wrap-liq-adl-latch matches a clean liquidation against
 * the vault LP instead of ADL-scaling its side (reference: percolator-prog tests/p3_vault_lp.rs `f2_tag5_*`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { buildRefreshCrankIx } from "../positioned-refresh.ts";
import { buildSweepTxSlots } from "./sweep.ts";
import { vaultLpCounterpartyFor } from "./loop.ts";
import { V22_FLAG_DEFAULTS, describeV22Flags, v22FlagsFromEnv } from "./flags.ts";
import { key } from "./test-helpers.ts";

const LP = key(500);
const MARKET = key(900);
const owner = Keypair.generate().publicKey;
const p = (n: number): PositionedPortfolio => ({ pubkey: key(n), longLegs: 1, shortLegs: 0, isLp: false });
const a = p(1), t = p(2), c = p(3);
const last = (ix: { keys: { pubkey: { toBase58(): string }; isWritable: boolean; isSigner: boolean }[] }) => ix.keys[ix.keys.length - 1];

describe("bigtest F2: vault-LP counterparty on the liquidation cranks", () => {
  it("flag defaults OFF, parses, and shows in the banner", () => {
    assert.equal(V22_FLAG_DEFAULTS.liquidateMatchVaultLp, false);
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on" }).liquidateMatchVaultLp, false);
    const f = v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIQUIDATE_MATCH_VAULT_LP: "on" });
    assert.equal(f.liquidateMatchVaultLp, true);
    assert.equal(describeV22Flags(f).liquidateMatchVaultLp, true);
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIQUIDATE_MATCH_VAULT_LP: "maybe" }));
  });

  it("buildRefreshCrankIx: no counterparty = today's 3 accounts; with one it is appended LAST, writable; never on the LP itself", () => {
    const plain = buildRefreshCrankIx(owner, MARKET, t.pubkey);
    assert.equal(plain.keys.length, 3);
    const withLp = buildRefreshCrankIx(owner, MARKET, t.pubkey, LP);
    assert.equal(withLp.keys.length, 4);
    assert.deepEqual(last(withLp), { pubkey: LP, isSigner: false, isWritable: true });
    assert.deepEqual(withLp.data, plain.data);
    assert.equal(buildRefreshCrankIx(owner, MARKET, LP, LP).keys.length, 3, "the LP's own crank is unchanged");
  });

  it("buildSweepTxSlots: only the flagged account's refresh + liq cranks carry the LP; the accrue and other refreshes are unchanged", () => {
    const base = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c], liquidate: new Set([t.pubkey.toBase58()]) });
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c], liquidate: new Set([t.pubkey.toBase58()]), vaultLpCounterparty: LP });
    assert.deepEqual(s.map((x) => x.kind), base.map((x) => x.kind));
    const lens = s.map((x) => x.ix.keys.length);
    const baseLens = base.map((x) => x.ix.keys.length);
    // [accrue LP, refresh a, refresh t, liq t, refresh c]
    assert.deepEqual(lens, [baseLens[0], baseLens[1], baseLens[2] + 1, baseLens[3] + 1, baseLens[4]]);
    assert.ok(last(s[2].ix).pubkey.toBase58() === LP.toBase58() && last(s[3].ix).pubkey.toBase58() === LP.toBase58());
    s.forEach((x, i) => assert.deepEqual(x.ix.data, base[i].ix.data, "instruction data unchanged"));
  });

  it("buildSweepTxSlots: with no liquidation set the counterparty changes nothing (the plain tx is today's, byte for byte)", () => {
    const base = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c] });
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c], vaultLpCounterparty: LP });
    assert.deepEqual(s.map((x) => x.ix.keys.map((k) => k.pubkey.toBase58())), base.map((x) => x.ix.keys.map((k) => k.pubkey.toBase58())));
  });

  it("counterparty form: the liq crank after the accrue-target observation carries the LP, the observation crank does not", () => {
    const base = buildSweepTxSlots(owner, MARKET, { accrue: "counterparty", accrueTarget: t.pubkey, refresh: [a], liquidate: new Set([t.pubkey.toBase58()]) });
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "counterparty", accrueTarget: t.pubkey, refresh: [a], liquidate: new Set([t.pubkey.toBase58()]), vaultLpCounterparty: LP });
    assert.equal(s[0].ix.keys.length, base[0].ix.keys.length, "observation crank unchanged");
    assert.equal(s[1].kind, "liq");
    assert.equal(s[1].ix.keys.length, base[1].ix.keys.length + 1);
  });

  it("vaultLpCounterpartyFor: flag AND registry bound AND vault_lp_state LP == the round's LP", () => {
    assert.equal(vaultLpCounterpartyFor(false, true, LP, LP), null);
    assert.equal(vaultLpCounterpartyFor(true, false, LP, LP), null);
    assert.equal(vaultLpCounterpartyFor(true, true, null, LP), null);
    assert.equal(vaultLpCounterpartyFor(true, true, LP, key(501)), null, "an LP that is not the round's LP is never sent");
    assert.equal(vaultLpCounterpartyFor(true, true, LP, LP)?.toBase58(), LP.toBase58());
  });
});

describe("bigtest F2: compute reserve for a matched liquidation", () => {
  it("fitLiquidations reserves MATCH_VAULT_LP_EXTRA_CU per liquidation only when asked", async () => {
    const { fitLiquidations, MATCH_VAULT_LP_EXTRA_CU } = await import("./liquidation.ts");
    assert.ok(MATCH_VAULT_LP_EXTRA_CU >= 129_145, "covers the measured +129,145 CU");
    const flagged = [1, 2, 3, 4].map((n) => ({ portfolio: p(10 + n), ratioBps: BigInt(n), margin: {} as never }));
    const plain = fitLiquidations({ flagged, baseCu: 300_000, maxPerTx: 4 });
    const matched = fitLiquidations({ flagged, baseCu: 300_000, maxPerTx: 4, extraCuPerLiquidation: MATCH_VAULT_LP_EXTRA_CU });
    assert.ok(matched.chosen.length < plain.chosen.length, `${matched.chosen.length} < ${plain.chosen.length}`);
    assert.ok(matched.deferred.every((d) => d.why === "compute"));
  });
});
