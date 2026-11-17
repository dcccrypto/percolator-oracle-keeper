/**
 * Audit pins for lp-fee-cranker's registry-domain handling (job J-20261117-K-BUG-LPFEEDOMAINFALLBACK).
 *
 * Prog rule (percolator-prog feat/v22-rc23-2026-10-22, src/v16_program.rs):
 *   - `fn sibling_domain(domain: u16) -> u16 { domain ^ 1 }`  (:22154)
 *   - registry.domain is a u16 and is NOT limited to 0/1 (domains run 0..2*max_market_slots);
 *     tag 78 checks `target_domain / 2 == registry.domain / 2`.
 *   - `read_lp_vault_registry` rejects bad header/version/zero market_group with InvalidAccountData,
 *     so a registry the SDK cannot parse is refused by the program too.
 * Verdicts: lead 2 NOT real (^1 is the program's own sibling for every u16 domain); lead 1 and
 * lead 3 NOT real as a money bug (a wrong-guess tx is refused in preflight, surfaces as a failed
 * outcome, and no share count is available on that path to skip on). These tests pin that.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { V17_EXPECTED_VERSION, deriveLpBackingLedger } from "@percolatorct/sdk";
import { crankLpFeesOnce } from "./lp-fee-cranker.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const KEEPER = Keypair.generate();

function registryBuf(opts: { shares?: bigint; domain?: number; badVersion?: boolean } = {}): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(opts.badVersion ? 9999 : V17_EXPECTED_VERSION, 8);
  b.writeUInt8(5, 10);
  const H = 16;
  const shares = opts.shares ?? 1_000_000n;
  b.writeBigUInt64LE(shares & 0xffff_ffff_ffff_ffffn, H + 64);
  b.writeBigUInt64LE(shares >> 64n, H + 72);
  b.writeUInt16LE(opts.domain ?? 2, H + 132);
  return b;
}

function conn(reg: Buffer, sendError?: Error) {
  const sent: Transaction[] = [];
  return {
    sent,
    c: {
      async getMultipleAccountsInfo() { return [{ data: reg }]; },
      async getLatestBlockhash() { return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 }; },
      async sendRawTransaction(raw: Buffer) {
        sent.push(Transaction.from(raw));
        if (sendError) throw sendError;
        return "sig";
      },
      async getBlockHeight() { return 2; },
      async getSignatureStatuses() { return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    },
  };
}

function ledgerKeys(tx: Transaction): string[] {
  const keys = tx.instructions[tx.instructions.length - 1].keys.map((k) => k.pubkey.toBase58());
  return keys;
}

describe("lp-fee-cranker domain handling vs prog sibling_domain = domain ^ 1", () => {
  for (const domain of [0, 1, 2, 3, 6, 7, 254, 255, 65534, 65535]) {
    it(`lead 2: registry domain ${domain} sends ledger(domain) and ledger(domain^1)`, async () => {
      const market = Keypair.generate().publicKey;
      const f = conn(registryBuf({ domain }));
      assert.equal(await crankLpFeesOnce(f.c as never, KEEPER, market.toBase58(), false), "cranked");
      const keys = ledgerKeys(f.sent[0]);
      const own = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, domain)[0].toBase58();
      const sib = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, domain ^ 1)[0].toBase58();
      assert.ok(keys.includes(own), "own-domain ledger present");
      assert.ok(keys.includes(sib), "sibling (domain^1) ledger present");
    });
  }

  it("lead 1: unparseable registry uses the fallback domain-0 pair; a program refusal surfaces as a failed outcome, one preflight-rejected send", async () => {
    const market = Keypair.generate().publicKey;
    const f = conn(registryBuf({ domain: 6, badVersion: true }), new Error('failed: {"InstructionError":[0,"InvalidSeeds"]}'));
    const out = await crankLpFeesOnce(f.c as never, KEEPER, market.toBase58(), false);
    assert.equal(typeof out, "object", "reported as a failure (visible), not silently skipped or cranked");
    assert.equal(f.sent.length, 1);
    const keys = ledgerKeys(f.sent[0]);
    const fb = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, 0)[0].toBase58();
    assert.ok(keys.includes(fb), "fallback guess is domain 0 (documented)");
    const real = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, 6)[0].toBase58();
    assert.ok(!keys.includes(real));
  });

  it("lead 3: zero-shares skip cannot apply on the fallback path (no share count was parsed)", async () => {
    const market = Keypair.generate().publicKey;
    const f = conn(registryBuf({ shares: 0n, badVersion: true }), new Error('failed: {"InstructionError":[0,{"Custom":38}]}'));
    const out = await crankLpFeesOnce(f.c as never, KEEPER, market.toBase58(), false);
    assert.equal(out, "no-fees");
    assert.equal(f.sent.length, 1);
  });
});
