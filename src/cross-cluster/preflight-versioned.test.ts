/**
 * PERF (v22-keep-1113): the push preflight simulates the batch as a VersionedTransaction with
 * { sigVerify: false, replaceRecentBlockhash: true }, so web3.js no longer refetches a blockhash before every
 * simulate (its legacy-Transaction path does, every 30 s). Pins: that config, no getLatestBlockhash call from the
 * preflight, and that the simulated instructions are byte-identical to the transaction that is then sent.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/preflight-versioned.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { V17_MARKET_GROUP_LEN, V17_ASSET_ORACLE_WRAPPER_LEN } from "@percolatorct/sdk";
import { pushAuthMarkBatch, resetTerminalPushLogForTests } from "./auth-mark-pusher.ts";
import { selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { simInstructions } from "./sim-tx-test-helper.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SOL = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
const g = selectMarketGroupOffset(SOL);
assert.ok(g.ok);
const MARKET_ID_OFF = (g as { marketGroupOff: number }).marketGroupOff + V17_MARKET_GROUP_LEN + V17_ASSET_ORACLE_WRAPPER_LEN;
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

describe("push preflight simulates a VersionedTransaction", () => {
  it("config, no blockhash refetch, and the simulated ixs equal the sent ixs", async () => {
    resetTerminalPushLogForTests();
    const markets = Array.from({ length: 3 }, (_, i) => ({ addr: Keypair.generate().publicKey.toBase58(), id: 9100n + BigInt(i) }));
    const byAddr = new Map(markets.map((m) => [m.addr, m]));
    const sims: Array<{ tx: unknown; cfg: unknown }> = [];
    const sent: Buffer[] = [];
    let blockhashCalls = 0;
    const conn = {
      async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
        return pks.map((pk) => {
          const b = Buffer.from(SOL);
          b.writeBigUInt64LE(byAddr.get(pk.toBase58())!.id, MARKET_ID_OFF);
          return { data: b };
        });
      },
      async getLatestBlockhash() {
        blockhashCalls++;
        return BLOCKHASH;
      },
      async simulateTransaction(tx: unknown, cfg: unknown) {
        sims.push({ tx, cfg });
        return { value: { err: null } };
      },
      async sendRawTransaction(raw: Buffer) {
        sent.push(Buffer.from(raw));
        return "sig";
      },
    };
    const out = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      markets.map((m) => ({ marketAddress: m.addr, assetIndex: 0, priceE6: 1_000_000n })),
      100n,
      BLOCKHASH,
      false,
    );
    assert.equal(out.pushedMarkets.length, 3);
    assert.equal(sims.length, 1);
    assert.ok(sims[0].tx instanceof VersionedTransaction, "versioned, so web3.js does not swap the blockhash");
    assert.deepEqual(sims[0].cfg, { sigVerify: false, replaceRecentBlockhash: true });
    assert.equal(blockhashCalls, 0);
    assert.equal(sent.length, 1);
    const sentIxs = Transaction.from(sent[0]).instructions;
    const simIxs = simInstructions(sims[0].tx);
    assert.equal(simIxs.length, sentIxs.length);
    simIxs.forEach((ix, i) => {
      assert.equal(ix.programId.toBase58(), sentIxs[i].programId.toBase58());
      assert.deepEqual(Buffer.from(ix.data), Buffer.from(sentIxs[i].data));
      assert.deepEqual(
        ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
        sentIxs[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      );
    });
  });
});
