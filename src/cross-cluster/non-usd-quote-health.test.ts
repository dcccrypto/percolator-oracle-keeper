/**
 * A pool refused for a non-WSOL, non-USD quote never self-heals, so the market's
 * /health `lastError` (and the K-1 market-no-push alert, which quotes it) must
 * say WHY instead of the generic "no pool price this cycle". The batch reader
 * records the reason per pool; the keeper loop turns it into lastError.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/non-usd-quote-health.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID } from "@percolatorct/sdk";
import { readAllPoolPricesE6, resetSlotWatermarksForTests } from "./price-reader.ts";
import { noPoolPriceReason } from "./keeper-loop.ts";

beforeEach(() => resetSlotWatermarksForTests());

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const CARDS = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");

type Acc = { owner?: PublicKey; data: Buffer };
const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });

function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

function pump(accts: Map<string, Acc>, quoteMint: PublicKey): string {
  const pool = Keypair.generate().publicKey;
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const d = Buffer.alloc(301);
  Keypair.generate().publicKey.toBuffer().copy(d, 43);
  quoteMint.toBuffer().copy(d, 75);
  bv.toBuffer().copy(d, 139);
  qv.toBuffer().copy(d, 171);
  accts.set(pool.toBase58(), { owner: PUMPSWAP_OWNER, data: d });
  accts.set(bv.toBase58(), { data: vault(1_000_000_000_000n) });
  accts.set(qv.toBase58(), { data: vault(250_000_000n) });
  return pool.toBase58();
}

function meteora(accts: Map<string, Acc>, quoteMint: PublicKey): string {
  const pool = Keypair.generate().publicKey;
  const d = Buffer.alloc(256);
  d.writeInt32LE(-2304, 76);
  d.writeUInt16LE(20, 80);
  Keypair.generate().publicKey.toBuffer().copy(d, 88);
  quoteMint.toBuffer().copy(d, 120);
  accts.set(pool.toBase58(), { owner: METEORA_DLMM_PROGRAM_ID, data: d });
  return pool.toBase58();
}

function mockConn(accts: Map<string, Acc>, ep: string): Connection {
  const get = (k: PublicKey) => accts.get(k.toBase58()) ?? null;
  return {
    rpcEndpoint: ep,
    getAccountInfoAndContext: (k: PublicKey) => Promise.resolve(ctx(get(k))),
    getMultipleAccountsInfoAndContext: (ks: PublicKey[]) => Promise.resolve(ctx(ks.map(get))),
  } as unknown as Connection;
}

describe("non-USD quote refusal reaches /health lastError", () => {
  it("batch reader records the reason for each refused pool, and only those", async () => {
    const accts = new Map<string, Acc>();
    const pCards = pump(accts, CARDS);
    const mCards = meteora(accts, CARDS);
    const pUsdc = pump(accts, USDC);
    const mUsdc = meteora(accts, USDC);
    const dec = new Map([
      [pCards, { base: 6, quote: 6 }],
      [mCards, { base: 6, quote: 6 }],
      [pUsdc, { base: 6, quote: 6 }],
      [mUsdc, { base: 6, quote: 6 }],
    ]);
    const reasons = new Map<string, string>();
    const out = await readAllPoolPricesE6(
      mockConn(accts, "https://ep-health-reason"),
      [
        { poolAddress: pCards, dexType: "pumpswap", label: "pc", symbol: "pc" },
        { poolAddress: mCards, dexType: "meteora-dlmm", label: "mc", symbol: "mc" },
        { poolAddress: pUsdc, dexType: "pumpswap", label: "pu", symbol: "pu" },
        { poolAddress: mUsdc, dexType: "meteora-dlmm", label: "mu", symbol: "mu" },
      ],
      dec,
      undefined,
      reasons,
    );
    assert.ok(!out.has(pCards) && !out.has(mCards));
    assert.ok(out.has(pUsdc) && out.has(mUsdc));
    assert.deepEqual([...reasons.keys()].sort(), [pCards, mCards].sort());
    const want = `quote mint ${CARDS.toBase58()} is neither WSOL nor a USD stable`;
    assert.ok(reasons.get(pCards)!.startsWith("pumpswap ") && reasons.get(pCards)!.includes(want), reasons.get(pCards));
    assert.ok(reasons.get(mCards)!.startsWith("meteora ") && reasons.get(mCards)!.includes(want), reasons.get(mCards));

    assert.equal(
      noPoolPriceReason(reasons, pCards),
      `no pool price this cycle: ${reasons.get(pCards)}`,
    );
  });

  it("the sink is optional (existing callers unchanged)", async () => {
    const accts = new Map<string, Acc>();
    const pCards = pump(accts, CARDS);
    const out = await readAllPoolPricesE6(
      mockConn(accts, "https://ep-health-nosink"),
      [{ poolAddress: pCards, dexType: "pumpswap", label: "pc", symbol: "pc" }],
      new Map([[pCards, { base: 6, quote: 6 }]]),
    );
    assert.equal(out.size, 0);
  });

  it("a pool with no recorded reason keeps the generic message", () => {
    assert.equal(noPoolPriceReason(new Map(), "anyPool"), "no pool price this cycle");
    assert.equal(
      noPoolPriceReason(new Map([["other", "x"]]), "anyPool"),
      "no pool price this cycle",
    );
  });
});
