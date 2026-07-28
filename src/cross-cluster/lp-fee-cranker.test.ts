/**
 * Regression tests for the LP-fee distribution loop.
 *
 * Verified on devnet 2026-07-28 before this loop existed: a fresh market with a
 * 500-notional round trip accrued exactly 1_440_000 atoms of LP fee on the slab
 * (48% of $3.00, the correct split) and NOTHING ever moved it, so every LP
 * depositor saw 0% APY forever. After one LpVaultCrankFees:
 *
 *     lpFeeWithdrawnAtoms  0        -> 1440000
 *     vault feeDistribution 0       -> 1440000
 *
 * The loop's whole job is to make that call happen. These tests pin the two
 * conditions under which it must NOT call (they are normal, not faults) and the
 * error it must treat as success.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { crankLpFeesOnce, crankAllLpFeesOnce } from "./lp-fee-cranker.ts";

const KEEPER = Keypair.generate();

/** Connection stub: control which of [registry, ledger] exist, and how send behaves. */
function fakeConn(opts: {
  registry?: boolean;
  ledger?: boolean;
  sendError?: unknown;
}) {
  let sends = 0;
  return {
    get sends() { return sends; },
    conn: {
      async getMultipleAccountsInfo() {
        return [
          opts.registry === false ? null : { data: Buffer.alloc(176) },
          opts.ledger === false ? null : { data: Buffer.alloc(240) },
        ];
      },
      async getLatestBlockhash() {
        return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
      },
      async sendRawTransaction() {
        sends++;
        if (opts.sendError) throw opts.sendError;
        return "sig";
      },
      async confirmTransaction() { return { value: { err: null } }; },
    },
  };
}

const MARKET = () => Keypair.generate().publicKey.toBase58();

describe("crankLpFeesOnce — only spend a transaction when there is something to move", () => {
  it("distributes when a vault and a depositor ledger both exist", async () => {
    const f = fakeConn({});
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "cranked");
    assert.equal(f.sends, 1);
  });

  it("skips a market whose creator never made an LP vault", async () => {
    const f = fakeConn({ registry: false });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.sends, 0, "no vault must cost no transaction");
  });

  it("skips a market with no LP depositor yet, instead of failing every cycle", async () => {
    // The backing ledger is created LAZILY by the first DepositToLpVault, so on
    // a brand-new market it does not exist. Cranking anyway fails
    // IncorrectProgramId — alarming in logs, but it only means "no LPs yet".
    const f = fakeConn({ ledger: false });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.sends, 0, "no depositors must cost no transaction");
  });

  it("treats Custom(38) NoFeesToCrank as healthy, not as a failure", async () => {
    // The expected answer on any quiet market. Reporting it as an error would
    // page someone every cycle for a market that is working fine.
    const f = fakeConn({ sendError: new Error('failed: {"InstructionError":[1,{"Custom":38}]}') });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "no-fees");
  });

  it("also decodes the hex form of the same error", async () => {
    const f = fakeConn({ sendError: new Error("custom program error: 0x26") });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "no-fees");
  });

  it("reports a genuine failure rather than swallowing it", async () => {
    const f = fakeConn({ sendError: new Error("blockhash not found") });
    const r = await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && "error" in r);
  });

  it("never sends in dry-run", async () => {
    const f = fakeConn({});
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), true), "skipped");
    assert.equal(f.sends, 0);
  });

  it("returns an error for an unparseable market instead of throwing", async () => {
    const f = fakeConn({});
    const r = await crankLpFeesOnce(f.conn as never, KEEPER, "not-a-pubkey", false);
    assert.ok(typeof r === "object" && "error" in r);
  });
});

describe("crankAllLpFeesOnce — one bad market must not stop the sweep", () => {
  it("buckets every market and never throws", async () => {
    const markets = [MARKET(), MARKET(), MARKET()];
    const conn = {
      async getMultipleAccountsInfo() { return [{ data: Buffer.alloc(176) }, { data: Buffer.alloc(240) }]; },
      async getLatestBlockhash() { return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 }; },
      async sendRawTransaction() { throw new Error("boom"); },
      async confirmTransaction() { return { value: { err: null } }; },
    };
    const r = await crankAllLpFeesOnce(
      conn as never,
      KEEPER,
      { markets: markets.map((m) => ({ marketAddress: m })) } as never,
      false,
    );
    assert.equal(r.failed.length, 3, "each market reported independently");
    assert.equal(r.cranked.length, 0);
  });

  it("keeps going when markets are in different states", async () => {
    let call = 0;
    const conn = {
      async getMultipleAccountsInfo() {
        call++;
        // 1st: full, 2nd: no vault, 3rd: no ledger
        if (call === 2) return [null, null];
        if (call === 3) return [{ data: Buffer.alloc(176) }, null];
        return [{ data: Buffer.alloc(176) }, { data: Buffer.alloc(240) }];
      },
      async getLatestBlockhash() { return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 }; },
      async sendRawTransaction() { return "sig"; },
      async confirmTransaction() { return { value: { err: null } }; },
    };
    const r = await crankAllLpFeesOnce(
      conn as never,
      KEEPER,
      { markets: [{ marketAddress: MARKET() }, { marketAddress: MARKET() }, { marketAddress: MARKET() }] } as never,
      false,
    );
    assert.equal(r.cranked.length + r.skipped.length, 3);
    assert.equal(r.failed.length, 0);
  });
});
