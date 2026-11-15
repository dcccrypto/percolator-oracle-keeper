/**
 * K-LOTSCALE2: a token under $0.000001 on a lot_exp > 0 market reaches the push in per-lot units.
 *
 * perLotMarkFromE12 (K-LOTSCALE, #291) can push such a price, but the reader dropped it (e6 == 0) before the push.
 * This drives the real path: reader (pumpswap pool bytes) -> smoother -> breaker -> pusher -> raw tx, and proves
 * a lot_exp 0 market behaves exactly as before (same drop, same message, no extra RPC).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/tiny-price-e2e.test.ts
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { acceptedPublishE12, newMarketStat, runCycle, tinyE12Of, resetCrossClusterCircuitBreakerStates } from "./keeper-loop.ts";
import type { LoopConfig, LoopState } from "./keeper-loop.ts";
import { priceUnitsOfRegistry } from "./multi-asset.ts";
import { PROFILE_LOT_EXP_OFF } from "./auth-mark-pusher.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";
import { createTickPublisher } from "./tick-publisher.ts";
import { resetSlotWatermarksForTests } from "./price-reader.ts";
import type { Registry } from "./registry.ts";

const keeper = Keypair.generate();
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", "k6-2xhs-market-v22.b64"), "utf8").trim(), "base64"));
const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** The live market fixture with asset 0's authority = keeper and lot_exp = `lotExp`. */
function marketAccount(lotExp: number): Uint8Array {
  const g = selectMarketGroupOffset(FIXTURE);
  assert.ok(g.ok);
  const out = new Uint8Array(FIXTURE);
  out.set(keeper.publicKey.toBytes(), assetSlotOffset(g, 0) + 120);
  out[assetSlotOffset(g, 0) + PROFILE_LOT_EXP_OFF] = lotExp;
  return out;
}

const mint = Keypair.generate().publicKey;
const baseVault = Keypair.generate().publicKey;
const quoteVault = Keypair.generate().publicKey;
function pumpPool(): Buffer {
  const b = Buffer.alloc(301);
  mint.toBuffer().copy(b, 43);
  USDC.toBuffer().copy(b, 75);
  baseVault.toBuffer().copy(b, 139);
  quoteVault.toBuffer().copy(b, 171);
  return b;
}
function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}
/** USDC-quoted pumpswap pool (6dp / 6dp): price = quote / base. e12 = quote * 1e12 / base. */
const TINY = { base: 100_000_000_000_000_000n, quote: 50_000_000_000n }; // $0.0000005 (e12 = 500,000), $50k depth
const NORMAL = { base: 25_000_000_000_000n, quote: 50_000_000_000n }; // $0.002 (e6 = 2,000)

interface Rig {
  sent: Uint8Array[];
  multiCalls: number;
  reserves: { base: bigint; quote: bigint };
  lotExp: number;
}
let rig: Rig;
const ctx = <T>(value: T) => ({ context: { slot: 1 }, value });

function conns(poolAddress: string) {
  let n = 0;
  const mainnet = {
    rpcEndpoint: `fake://mainnet-${Math.random()}`,
    getMultipleAccountsInfoAndContext() {
      // 1st call of a read: the pool account; 2nd: its two vaults.
      const first = n++ % 2 === 0;
      return Promise.resolve(ctx(first ? [{ owner: PUMPSWAP_OWNER, data: pumpPool() }] : [{ data: vault(rig.reserves.base) }, { data: vault(rig.reserves.quote) }]));
    },
  } as never;
  void poolAddress;
  const devnet = {
    rpcEndpoint: `fake://devnet-${Math.random()}`,
    async getAccountInfo() {
      return { data: marketAccount(rig.lotExp) };
    },
    async getMultipleAccountsInfo(pks: unknown[]) {
      rig.multiCalls++;
      return pks.map(() => ({ data: marketAccount(rig.lotExp) }));
    },
    async getSlot() { return 1234; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 }; },
    async getBalance() { return 5_000_000_000; },
    async simulateTransaction() { return { value: { err: null } }; },
    async sendRawTransaction(raw: Uint8Array) { rig.sent.push(new Uint8Array(raw)); return "sigFAKE" + rig.sent.length; },
    async getSignatureStatuses() { return { value: [] }; },
    async getTransaction() { return null; },
  } as never;
  return { mainnet, devnet };
}

function setup() {
  const poolAddress = Keypair.generate().publicKey.toBase58();
  const marketAddress = Keypair.generate().publicKey.toBase58();
  const registry = {
    markets: [{ label: "TINY/USD", marketAddress, assetIndex: 0, assets: [{ assetIndex: 0, source: "pool", poolAddress, dexType: "pumpswap", mainnetCa: mint.toBase58(), symbol: "TINY/USD" }] }],
  } as unknown as Registry;
  const state: LoopState = {
    dlmmObserve: false,
    startedAt: Date.now() - 5_000,
    lastCycleAt: null,
    cycleCount: 1,
    timeoutCount: 0,
    tickPublisher: createTickPublisher(),
    lastSuccessfulPushAt: null,
    consecutiveBatchReadFailures: 0,
    wallet: createWalletBalanceState(),
    lastBatchReadError: null,
    cycleAttempted: 0,
    cyclePushed: 0,
    zeroPushStreak: 0,
    terminalMarkets: new Set(),
    landedThisCycle: new Set(),
    standbyThisCycle: new Set(),
    stats: new Map(priceUnitsOfRegistry(registry.markets).map((u) => [u.key, newMarketStat(u)])),
  };
  return { poolAddress, marketAddress, registry, state, ...conns(poolAddress), decimals: new Map([[poolAddress, { base: 6, quote: 6 }]]) };
}

const config: LoopConfig = { intervalMs: 1000, healthPort: 0, healthBind: "127.0.0.1", dryRun: false, minKeeperBalanceLamports: 1_000_000, balanceCheckIntervalMs: 60_000 };

/** Run `cycles` cycles 5 s apart (the 15 s smoother window needs 3 samples spanning most of it). */
async function runCycles(s: ReturnType<typeof setup>, cycles: number) {
  const log = console.log, warn = console.warn, err = console.error;
  if (!process.env.DBG) console.log = console.warn = console.error = () => {};
  try {
    for (let i = 0; i < cycles; i++) {
      s.state.cycleCount++;
      await runCycle(s.mainnet, s.devnet, keeper, s.registry, s.decimals as never, s.state, config);
      mock.timers.tick(5_000);
    }
  } finally {
    console.log = log; console.warn = warn; console.error = err;
  }
}

function containsU64LE(tx: Uint8Array, v: bigint): boolean {
  const needle = Buffer.alloc(8);
  needle.writeBigUInt64LE(v);
  return Buffer.from(tx).includes(needle);
}

beforeEach(() => {
  resetSlotWatermarksForTests();
  resetCrossClusterCircuitBreakerStates();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  rig = { sent: [], multiCalls: 0, reserves: TINY, lotExp: 9 };
});
afterEach(() => mock.timers.reset());

describe("tiny price (e6 == 0, e12 > 0) end to end", () => {
  it("lot_exp 9 market at $0.0000005: pushed as the per-lot mark 500,000,000", async () => {
    const s = setup();
    await runCycles(s, 6);
    const stat = s.state.stats.get(s.marketAddress + "#0")!;
    assert.ok(rig.sent.length >= 1, `a push landed (errors: ${stat.lastErrorMsg})`);
    assert.ok(containsU64LE(rig.sent[rig.sent.length - 1], 500_000_000n), "tx carries the per-lot mark = e12 x 10^9 / 1e6");
    assert.equal(stat.lastErrorMsg, null);
    assert.ok(stat.totalPushes >= 1);
  });

  it("steady tiny price does not trip the breaker cycle after cycle", async () => {
    const s = setup();
    await runCycles(s, 10);
    const stat = s.state.stats.get(s.marketAddress + "#0")!;
    assert.ok(stat.totalPushes >= 5, `pushes ${stat.totalPushes}`);
    assert.doesNotMatch(stat.lastErrorMsg ?? "", /circuit breaker/);
  });

  it("a tiny price cannot bypass the breaker: $0.002 -> $0.0000005 is rate-limited, never pushed as the tiny mark", async () => {
    const s = setup();
    rig.reserves = NORMAL; rig.lotExp = 8; // $0.002 (e6 = 2,000) x 10^8
    await runCycles(s, 6);
    const before = rig.sent.length;
    assert.ok(before >= 1, "baseline pushed at $0.002");
    rig.reserves = TINY; // the tiny per-lot mark would be 500,000 x 10^8 / 1e6 = 50,000
    await runCycles(s, 8);
    const stat = s.state.stats.get(s.marketAddress + "#0")!;
    assert.ok(stat.totalErrors > 0, "the breaker blocked the unconfirmed -100% moves");
    for (const tx of rig.sent) assert.equal(containsU64LE(tx, 50_000n), false, "the tiny mark never lands on a -100% jump");
    // what did land is the clamped relocation edge (>= the 30% band), carried at e12 and converted back to a per-lot mark
    assert.ok(stat.lastPriceE6 >= 1_000n, `published ${stat.lastPriceE6}`);
  });

  it("a tiny baseline that jumps back above $0.000001 is clamped at e12, not floored up to $0.000001", async () => {
    const s = setup();
    await runCycles(s, 6); // baseline $0.0000005
    const before = rig.sent.length;
    assert.ok(before >= 1);
    rig.reserves = { base: 100_000_000_000_000_000n, quote: 130_000_000_000n }; // $0.0000013 (e6 = 1, +160%)
    await runCycles(s, 8);
    for (const tx of rig.sent.slice(before)) {
      assert.equal(containsU64LE(tx, 1_000_000_000n) || containsU64LE(tx, 1_300_000_000n), false, "never the e6-floored $0.000001 mark nor the unclamped $0.0000013");
    }
    assert.ok(rig.sent.slice(before).some((tx) => containsU64LE(tx, 650_000_000n)), "the +30% band edge ($0.00000065) lands");
  });

  it("source-frozen clock sees tiny-price changes (normal -> sub-$0.000001 -> moving tiny)", async () => {
    const s = setup();
    rig.reserves = NORMAL; rig.lotExp = 8; // $0.002: the e6 path sets the clock
    await runCycles(s, 3);
    const stat = s.state.stats.get(s.marketAddress + "#0")!;
    const e6Since = stat.sourceUnchangedSince;
    assert.notEqual(e6Since, null);
    rig.reserves = TINY; // $0.0000005: a different raw reading, so the clock restarts
    await runCycles(s, 1);
    const tinySince = stat.sourceUnchangedSince!;
    assert.ok(tinySince > e6Since!, "dropping under $0.000001 is a source change");
    assert.equal(stat.lastRawPriceE6, 0n, "the raw e6 read is 0, not the stale $0.002");
    await runCycles(s, 2); // same tiny price: the clock holds
    assert.equal(stat.sourceUnchangedSince, tinySince);
    rig.reserves = { base: TINY.base, quote: 51_000_000_000n }; // $0.00000051: still tiny, but moved
    await runCycles(s, 1);
    assert.ok(stat.sourceUnchangedSince! > tinySince, "a moving tiny price is not frozen");
  });

  it("default scale (lot_exp 0): dropped exactly as before - no push, same error, no push built", async () => {
    const s = setup();
    rig.lotExp = 0;
    await runCycles(s, 6);
    const stat = s.state.stats.get(s.marketAddress + "#0")!;
    assert.equal(rig.sent.length, 0);
    assert.equal(stat.totalPushes, 0);
    assert.equal(stat.totalErrors, 6);
    assert.match(stat.lastErrorMsg ?? "", /no price|zero|below|unreadable|not priced|price/i);
    assert.equal(stat.sourcePriceE6, 0n);
    assert.equal(rig.multiCalls, 1, "one lot_exp read for the unit, cached (lot_exp is immutable); no push was built");
  });

  it("default scale (lot_exp 0) with a normal price: e6 payload, and the only market read is the pusher's own", async () => {
    const s = setup();
    rig.reserves = NORMAL;
    rig.lotExp = 0;
    await runCycles(s, 6);
    const stat = s.state.stats.get(s.marketAddress + "#0")!;
    assert.ok(rig.sent.length >= 1);
    assert.ok(containsU64LE(rig.sent[rig.sent.length - 1], 2_000n), "mark = priceE6 (2,000)");
    assert.equal(stat.lastPriceE6, 2_000n);
    assert.equal(rig.multiCalls, rig.sent.length, "one generation read per push, none for a lot_exp lookup");
  });

  it("lot_exp 6 with a normal price keeps the e6 path (priceE6 x 10^6)", async () => {
    const s = setup();
    rig.reserves = NORMAL; // $0.002, e6 2,000
    rig.lotExp = 6;
    await runCycles(s, 6);
    assert.ok(rig.sent.length >= 1);
    assert.ok(containsU64LE(rig.sent[rig.sent.length - 1], 2_000_000_000n), "2,000 x 10^6");
  });
});

describe("tiny-price helpers", () => {
  const p = (e6?: bigint) => new Map(e6 === undefined ? [] : [["a", e6]]);
  it("tinyE12Of only fires when e6 is missing/0 and 0 < e12 < 1e6", () => {
    assert.equal(tinyE12Of(p(), new Map([["a", 500_000n]]), "a"), 500_000n);
    assert.equal(tinyE12Of(p(0n), new Map([["a", 5n]]), "a"), 5n);
    assert.equal(tinyE12Of(p(2n), new Map([["a", 2_000_000n]]), "a"), null, "e6 present: the e6 path, unchanged");
    assert.equal(tinyE12Of(p(), new Map([["a", 1_000_000n]]), "a"), null);
    assert.equal(tinyE12Of(p(), new Map(), "a"), null);
    assert.equal(tinyE12Of(p(), new Map([["a", 0n]]), "a"), null);
  });
  it("acceptedPublishE12: unchanged / hold / clamp mirror acceptedPublishPrice and stay >= 1", () => {
    assert.deepEqual(acceptedPublishE12(500_000n, 5e-7, 5e-7), { priceE12: 500_000n, priceUsd: 5e-7 });
    assert.equal(acceptedPublishE12(500_000n, 5e-7, 4e-7, 4e-7).priceE12, 400_000n);
    const up = acceptedPublishE12(900_000n, 9e-7, 6e-7, 5e-7); // clamped below the smoothed price: rounds down
    assert.ok(up.priceE12 <= 600_000n);
    assert.equal(acceptedPublishE12(10n, 1e-11, 1e-20, 1e-11).priceE12, 1n);
  });
});
