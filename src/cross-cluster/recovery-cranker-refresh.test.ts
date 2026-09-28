/**
 * Regression test for the positioned-portfolio refresh, through the
 * cranker's real entry point (crankAllOnce) with a fake RPC serving the
 * CATE devnet bytes captured 2026-09-28 (see positioned-refresh.test.ts).
 *
 * Before the fix the cranker sent only the LP accrual crank, so the trader
 * (and the LP, re-staled by its own accrual) stayed stale and the market
 * stayed loss_stale_active=1: every risk-increasing trade reverted Custom(21).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/recovery-cranker-refresh.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { IX_TAG } from "@percolatorct/sdk";
import { crankAllOnce } from "./recovery-cranker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const CATE = new PublicKey("CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE");
const CATE_LP = new PublicKey("JAbvCce1twNVzpeLGMkgzdE2TqbRPz2oHeod9kaMFsum");
const CATE_TRADER = new PublicKey("6c7hV3Km5hDkNSrqn3ievcShwkg8fB9agZy8PnVfHVFG");
const CATE_FLAT = new PublicKey("65iKyg4cie2aJu2tQT23UckWWANVvurxDMeRJyyeMEo7");

const catePortfolios = () => [
  { pubkey: CATE_LP, data: fixture("cate-lp-portfolio-v18") },
  { pubkey: CATE_TRADER, data: fixture("cate-trader-portfolio-v18") },
  { pubkey: CATE_FLAT, data: fixture("cate-flat-portfolio-v18") },
];

function crankKind(data: Uint8Array): "obs" | "noobs" {
  assert.equal(data[0], IX_TAG.PermissionlessCrank);
  const n = data[9];
  assert.equal(data.length, 10 + 3 * n);
  return n === 0 ? "noobs" : "obs";
}

describe("crankAllOnce on a positioned, loss-stale market", () => {
  function fakeConn() {
    const sent: Transaction[] = [];
    const simulated: number[] = [];
    const conn = {
      async getAccountInfoAndContext(pk: PublicKey) {
        assert.ok(pk.equals(CATE));
        // Read one slot after the account's slot_last: no catch-up needed.
        return { context: { slot: 505227150 }, value: { data: fixture("cate-market-v18") } };
      },
      async getAccountInfo(pk: PublicKey) {
        assert.ok(pk.equals(CATE));
        return { data: fixture("cate-market-v18") };
      },
      async getProgramAccounts() {
        return catePortfolios().map((p) => ({ pubkey: p.pubkey, account: { data: p.data } }));
      },
      async getSlot() { return 505227150; },
      async getLatestBlockhash() {
        return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 };
      },
      async simulateTransaction(tx: Transaction | VersionedTransaction) {
        const n = tx instanceof VersionedTransaction ? tx.message.compiledInstructions.length : tx.instructions.length;
        simulated.push(n);
        return { context: { slot: 505227150 }, value: { err: null, logs: [], accounts: null } };
      },
      async sendRawTransaction(raw: Buffer) {
        sent.push(Transaction.from(raw));
        return "sig" + sent.length;
      },
    };
    return { conn, sent, simulated };
  }

  it("sends accrue(LP, obs) + refresh(trader) + refresh(LP) in one transaction", async () => {
    const { conn, sent } = fakeConn();
    const keeper = Keypair.generate();
    await crankAllOnce(
      conn as never,
      keeper,
      { markets: [{ marketAddress: CATE.toBase58(), label: "CATE", lpPortfolio: CATE_LP.toBase58() }] } as never,
      false,
    );
    assert.equal(sent.length, 1, "exactly one crank transaction");
    const cranks = sent[0].instructions.filter((ix) => ix.data[0] === IX_TAG.PermissionlessCrank);
    assert.deepEqual(
      cranks.map((ix) => [ix.keys[2].pubkey.toBase58(), crankKind(ix.data)]),
      [
        [CATE_LP.toBase58(), "obs"],
        [CATE_TRADER.toBase58(), "noobs"],
        [CATE_LP.toBase58(), "noobs"],
      ],
    );
  });
});
