/**
 * K-BUG-V22MARKETREGDOMAIN: the loader must not default the registry domain to 0 when a registry
 * account exists but the SDK cannot parse it (truncated / wrong VERSION / wrong kind / bad magic).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_KIND, WRAPPER_ACCOUNT_MAGIC, deriveLpBackingLedger } from "@percolatorct/sdk";
import { buildV22MarketCtx } from "./market.ts";
import { buildBondCrankFeesIx, bondFeeSkipReason } from "./fee-bond.ts";
import { v22MarketBytes, key } from "./test-helpers.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";

/** A real, SDK-parsable 176 B LpVaultRegistry: header (magic, VERSION 19, kind 5) + domain u16 @ 16+132 + flags. */
function realRegistry(o: { domain: number; version?: number; kind?: number; len?: number; bound?: boolean; ext?: boolean; bond?: boolean }): Uint8Array {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(WRAPPER_ACCOUNT_MAGIC, 0);
  b.writeUInt16LE(o.version ?? 19, 8);
  b[10] = o.kind ?? ACCOUNT_KIND.LpVaultRegistry;
  b.writeUInt16LE(o.domain, 16 + 132);
  b[160] = o.bound === false ? 0 : 1;
  b[161] = o.ext === false ? 0 : 1;
  b[162] = o.bond === false ? 0 : 1;
  return new Uint8Array(b.subarray(0, o.len ?? 176));
}

function load(registryData: Uint8Array | null) {
  return buildV22MarketCtx({
    marketAddress: key(900).toBase58(),
    label: "T",
    programId: WRAPPER_PROGRAM_ID,
    data: v22MarketBytes({}),
    readSlot: 5000,
    registryData,
    vaultLpStateData: null,
    lpHint: key(901),
  });
}

describe("v2.2 market loader: registry domain", () => {
  for (const domain of [0, 1, 2]) {
    it(`a readable registry in domain ${domain} loads with that domain`, () => {
      const r = load(realRegistry({ domain }));
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.ctx.registryDomain, domain);
        assert.equal(r.ctx.bound, true);
        assert.equal(r.ctx.bond, true);
      }
    });
  }

  it("domain 2 registry: the bond tag-78 targets the domain-2 ledger", () => {
    const r = load(realRegistry({ domain: 2 }));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(bondFeeSkipReason(r.ctx), null);
    const ix = buildBondCrankFeesIx(r.ctx, key(902));
    const [l2] = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, r.ctx.market, 2);
    assert.ok(ix.keys.some((k) => k.pubkey.equals(l2)));
  });

  const bad: Array<[string, Uint8Array]> = [
    ["truncated (100 B)", realRegistry({ domain: 2, len: 100 })],
    ["truncated just before the flags region (175 B)", realRegistry({ domain: 1, len: 175 })],
    ["wrong VERSION (18)", realRegistry({ domain: 2, version: 18 })],
    ["wrong kind (Market)", realRegistry({ domain: 2, kind: ACCOUNT_KIND.Market })],
  ];
  for (const [name, bytes] of bad) {
    it(`unparsable registry (${name}) is reported unreadable, not loaded as domain 0`, () => {
      const r = load(bytes);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "unreadable");
    });
  }

  it("no registry account at all still loads (unbound, domain 0)", () => {
    const r = load(null);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual([r.ctx.registryDomain, r.ctx.bound, r.ctx.bond], [0, false, false]);
  });
});
