/**
 * P3 F-14: tag 101 moves no SPL; the junior is paid only by its own (signed)
 * tag 102 after the seniors' 77. The keeper cannot run 102, so it alerts when
 * the seniors are done but the junior has not released for N cycles.
 * Real bytes: SOLCAT market (resolved + terminal-flat by patch), SOLCAT LP-vault
 * registry (bound flag / shares patched), SOLCAT domain-0 backing ledger
 * (total_principal_atoms = 5,000,512,268 live).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveLpBackingLedger, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { ledgerTotalPrincipal, watchJuniorRelease } from "./vault-lp-junior-watch.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { FeeJobFailureTracker, runFeeJobSweep } from "./fee-jobs.ts";
import { makeJuniorWatchJob } from "./vault-lp-junior-watch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MKT = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr"); // any v18 market bytes; keys are derived from it
const JUNIOR = Keypair.generate().publicKey;
const CFG = { wrapperProgramId: WRAPPER, alertCycles: 3 };
const G = 592;

const market = (o: { resolved?: boolean; flat?: boolean } = { resolved: true, flat: true }) => {
  const b = Buffer.from(fx("sol-market-v18-fees"));
  if (o.resolved) b[G + 626] = 1;
  if (o.flat) { b.writeBigUInt64LE(0n, G + 517); b.fill(0, G + 317, G + 333); }
  return b;
};
const registry = (o: { bound?: boolean; shares?: bigint } = {}) => {
  const b = Buffer.from(fx("solcat-lp-vault-registry-v18"));
  b[160] = o.bound === false ? 0 : 1;
  const s = o.shares ?? 0n;
  b.writeBigUInt64LE(s & 0xffff_ffff_ffff_ffffn, 16 + 64); b.writeBigUInt64LE(s >> 64n, 16 + 72);
  return b;
};
const vaultState = (seniorClaim: bigint) => {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
  MKT.toBuffer().copy(b, 16); deriveLpVaultRegistry(WRAPPER, MKT)[0].toBuffer().copy(b, 48);
  Keypair.generate().publicKey.toBuffer().copy(b, 80); JUNIOR.toBuffer().copy(b, 112);
  b.writeBigUInt64LE(seniorClaim & 0xffff_ffff_ffff_ffffn, 16 + 128); b.writeBigUInt64LE(seniorClaim >> 64n, 16 + 136);
  b[16 + 214] = 1;
  return b;
};
const ledger = (principal?: bigint) => {
  const b = Buffer.from(fx("solcat-backing-ledger-d0-v18"));
  if (principal !== undefined) { b.writeBigUInt64LE(principal & 0xffff_ffff_ffff_ffffn, 80); b.writeBigUInt64LE(principal >> 64n, 88); }
  return b;
};

function conn(m: Buffer, r: Buffer, s: Buffer, l: Buffer) {
  const reg = deriveLpVaultRegistry(WRAPPER, MKT)[0].toBase58();
  const st = deriveVaultLpState(WRAPPER, MKT).toBase58();
  const led = deriveLpBackingLedger(WRAPPER, MKT, 0)[0].toBase58();
  const byKey = new Map([[MKT.toBase58(), m], [reg, r], [st, s], [led, l]]);
  return { async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map((k) => { const d = byKey.get(k.toBase58()); return d ? { data: d } : null; }); } };
}

describe("vault-LP junior-release watch (P3 F-14)", () => {
  it("real ledger bytes: total_principal_atoms @80 = 5,000,512,268 (5B deposited + 512,268 cranked fees)", () => {
    assert.equal(ledgerTotalPrincipal(new Uint8Array(fx("solcat-backing-ledger-d0-v18"))), 5_000_512_268n);
  });

  it("seniors done + principal left: skipped for N-1 cycles, then a blocked alert naming the junior and the amount", async () => {
    const streaks = new Map<string, number>();
    const c = conn(market(), registry(), vaultState(0n), ledger());
    const kinds: string[] = [];
    let last: { kind: string; alertKind?: string; reason?: string } = { kind: "" };
    for (let i = 0; i < 3; i++) { last = await watchJuniorRelease(c as never, MKT.toBase58(), CFG, streaks) as typeof last; kinds.push(last.kind); }
    assert.deepEqual(kinds, ["skipped", "skipped", "blocked"]);
    assert.equal(last.alertKind, "vault-lp-junior-release-pending");
    assert.ok(last.reason!.includes(JUNIOR.toBase58()) && last.reason!.includes("5000512268"), last.reason);
  });

  it("the fee loop turns it into a warn alert", async () => {
    const job = makeJuniorWatchJob(CFG, new Map([[MKT.toBase58(), 2]]));
    const r = await runFeeJobSweep(job, { conn: conn(market(), registry(), vaultState(0n), ledger()) as never, keeper: Keypair.generate(), dryRun: false }, [{ marketAddress: MKT.toBase58(), label: "M" }]);
    const a = new FeeJobFailureTracker().alertsFor(r);
    assert.deepEqual(a.map((x) => [x.kind, x.severity]), [["vault-lp-junior-release-pending", "warn"]]);
  });

  for (const [name, c] of [
    ["seniors NOT done (shares > 0)", () => conn(market(), registry({ shares: 1n }), vaultState(0n), ledger())],
    ["seniors NOT done (senior claim > 0)", () => conn(market(), registry(), vaultState(10n), ledger())],
    ["junior already released (principal 0)", () => conn(market(), registry(), vaultState(0n), ledger(0n))],
    ["not terminal-flat (portfolios left)", () => conn(market({ resolved: true, flat: false }), registry(), vaultState(0n), ledger())],
    ["market still Live", () => conn(market({ resolved: false, flat: true }), registry(), vaultState(0n), ledger())],
    ["unbound vault (6377376a markets)", () => conn(market(), registry({ bound: false }), vaultState(0n), ledger())],
  ] as const) {
    it(`${name}: never alerts, and the streak resets`, async () => {
      const streaks = new Map<string, number>([[MKT.toBase58(), 5]]);
      const o = await watchJuniorRelease(c() as never, MKT.toBase58(), CFG, streaks);
      assert.equal(o.kind, "nothing");
      assert.equal(streaks.has(MKT.toBase58()), false);
    });
  }
});
