/**
 * Bankruptcy pass: a positioned portfolio whose post-refresh equity is <= 0
 * gets a SECOND no-observation crank in the same transaction, which the
 * engine's auto-crank planner resolves to Liquidate.
 *
 * Live case (ANSEM, 2026-09-29, fixtures captured at slot 505586003):
 * `DcVGSEfZ` capital 0, PnL -223M, long leg open. The keeper refreshed it once
 * per cycle and the next accrual re-staled it, so it was never liquidated and
 * its loss kept drawing down the Earn vault's counterparty backing. Devnet
 * simulation: [ExpireBackingBucket d1, crank(LP,obs), crank(DcVG), crank(DcVG),
 * crank(LP)] -> err=null, DcVG legs 0, loss_stale 0, bankruptcy_hlock 0.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/bankruptcy-liquidate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { IX_TAG } from "@percolatorct/sdk";
import { isBankruptPortfolio } from "./positioned-refresh.ts";
import { crankAllOnce } from "./recovery-cranker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

// Read one slot after the fixture's current_slot (505584900): no catch-up needed.
const SLOT = 505584901;
const ANSEM = new PublicKey("5bVTTMRceF9qEERjPWvqxtrDighE846QkVXSJm4uC8Tk");
const LP = new PublicKey("2SewEcvfyyEx3HE8NL8jjH6YJdtzGvZKvWbS2QqxhtZP");
const BANKRUPT = new PublicKey("DcVGSEfZtu8A8yyNSwLMJsfyT3ZobTvDxdx5X9wtvytX");

describe("isBankruptPortfolio", () => {
  it("flags the live ANSEM bankrupt trader, not its LP", () => {
    assert.equal(isBankruptPortfolio(fixture("ansem-bankrupt-portfolio-v18")), true);
    assert.equal(isBankruptPortfolio(fixture("ansem-lp-portfolio-v18")), false);
  });
  it("does not flag solvent positioned traders or flat accounts", () => {
    assert.equal(isBankruptPortfolio(fixture("cate-trader-portfolio-v18")), false);
    assert.equal(isBankruptPortfolio(fixture("cate-flat-portfolio-v18")), false);
    assert.equal(isBankruptPortfolio(new Uint8Array(10)), false);
  });
});

describe("crankAllOnce liquidates a bankrupt positioned account", () => {
  function fakeConn() {
    const sent: Transaction[] = [];
    const sims: { cranks: string[] }[] = [];
    const conn = {
      async getAccountInfoAndContext() {
        return { context: { slot: SLOT }, value: { data: fixture("ansem-market-v18") } };
      },
      async getAccountInfo() {
        return { data: fixture("ansem-market-v18") };
      },
      async getProgramAccounts() {
        return [
          { pubkey: LP, account: { data: fixture("ansem-lp-portfolio-v18") } },
          { pubkey: BANKRUPT, account: { data: fixture("ansem-bankrupt-portfolio-v18") } },
        ];
      },
      async getSlot() {
        return SLOT;
      },
      async getLatestBlockhash() {
        return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 };
      },
      async simulateTransaction(tx: VersionedTransaction, cfg: { accounts?: { addresses: string[] } }) {
        const keys = tx.message.staticAccountKeys;
        sims.push({
          cranks: tx.message.compiledInstructions
            .filter((ix) => ix.data[0] === IX_TAG.PermissionlessCrank)
            .map((ix) => keys[ix.accountKeyIndexes[2]].toBase58()),
        });
        // Post-state: the refreshed accounts as they are live (the bankrupt one
        // stays bankrupt after a refresh; only the second crank liquidates it).
        const addrs = cfg.accounts?.addresses ?? [];
        const accounts = addrs.map((a) => {
          const d =
            a === ANSEM.toBase58()
              ? fixture("ansem-market-v18")
              : a === BANKRUPT.toBase58()
                ? fixture("ansem-bankrupt-portfolio-v18")
                : fixture("ansem-lp-portfolio-v18");
          return { data: [d.toString("base64"), "base64"] };
        });
        return { context: { slot: SLOT }, value: { err: null, logs: [], accounts } };
      },
      async sendRawTransaction(raw: Buffer) {
        sent.push(Transaction.from(raw));
        return "sig" + sent.length;
      },
    };
    return { conn, sent, sims };
  }

  it("sends refresh + liquidate cranks on the bankrupt account in one transaction", async () => {
    const { conn, sent } = fakeConn();
    await crankAllOnce(
      conn as never,
      Keypair.generate(),
      { markets: [{ marketAddress: ANSEM.toBase58(), label: "ANSEM", lpPortfolio: LP.toBase58() }] } as never,
      false,
    );
    assert.equal(sent.length, 1);
    const targets = sent[0].instructions
      .filter((ix) => ix.data[0] === IX_TAG.PermissionlessCrank)
      .map((ix) => ix.keys[2].pubkey.toBase58());
    const onBankrupt = targets.filter((t) => t === BANKRUPT.toBase58()).length;
    assert.equal(onBankrupt, 2, `expected refresh + liquidate on DcVGSEfZ, got cranks ${targets.map((t) => t.slice(0, 8)).join(",")}`);
    // Order: accrue(LP) first, the bankrupt pair next, the LP refresh last (it
    // absorbs the liquidation's ADL/loss and must be re-certified after it).
    assert.equal(targets[0], LP.toBase58());
    assert.equal(targets[targets.length - 1], LP.toBase58());
    // The expiry repair for the lapsed ANSEM domain-1 bucket leads the tx.
    assert.equal(sent[0].instructions.find((ix) => ix.data[0] === IX_TAG.ExpireBackingBucket)?.data[1], 1);
  });
});
