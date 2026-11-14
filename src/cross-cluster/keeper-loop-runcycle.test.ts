/**
 * keeper-loop runCycle + makeHealthHandler: an in-process harness (fake devnet/mainnet Connection, injected
 * config hooks, no network, no timers) that drives one real cycle through the real pusher and reads /health back.
 *
 * Markets are multi-asset rows with FIXED sources, so a cycle needs no DEX pool bytes: the price is the configured
 * mark, and the rest of the path (authority check, blockhash, wallet guard, batch push, per-market bookkeeping) is
 * the production code.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { makeHealthHandler, newMarketStat, runCycle } from "./keeper-loop.ts";
import type { LoopConfig, LoopState } from "./keeper-loop.ts";
import { priceUnitsOfRegistry } from "./multi-asset.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";
import { createTickPublisher } from "./tick-publisher.ts";
import type { Registry } from "./registry.ts";

const keeper = Keypair.generate();
const here = dirname(fileURLToPath(import.meta.url));
/** A real Live v2.2 market account (asset 0 is pushable), the same fixture k6-multi-asset.test.ts uses. */
const FIXTURE = new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", "k6-2xhs-market-v22.b64"), "utf8").trim(), "base64"));

/** The fixture with its asset-0 oracle authority (profile offset 120, as fetchOracleAuthority reads it) replaced. */
async function marketAccountFor(authority: Uint8Array): Promise<Uint8Array> {
  const g = selectMarketGroupOffset(FIXTURE);
  assert.ok(g.ok, "fixture has a known layout");
  const out = new Uint8Array(FIXTURE);
  out.set(authority, assetSlotOffset(g, 0) + 120);
  return out;
}

interface Knobs {
  account: Uint8Array;
  failAccountInfo: boolean;
  failSlot: boolean;
  failBalance: boolean;
  failMultiple: boolean;
  balance: number;
  sent: number;
  balanceCalls: number;
}
let knobs: Knobs;

function fakeDevnet() {
  return {
    rpcEndpoint: `fake://devnet-${Math.random()}`,
    async getAccountInfo() {
      if (knobs.failAccountInfo) throw new Error("429 too many requests");
      return { data: knobs.account };
    },
    async getMultipleAccountsInfo(pks: unknown[]) {
      if (knobs.failMultiple) throw new Error("socket hang up");
      return pks.map(() => ({ data: knobs.account }));
    },
    async getSlot() {
      if (knobs.failSlot) throw new Error("slot rpc down");
      return 1234;
    },
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 };
    },
    async getBalance() {
      knobs.balanceCalls++;
      if (knobs.failBalance) throw new Error("balance rpc down");
      return knobs.balance;
    },
    async simulateTransaction() {
      return { value: { err: null } };
    },
    async sendRawTransaction() {
      knobs.sent++;
      return "sigFAKE" + knobs.sent;
    },
    async getSignatureStatuses() {
      return { value: [] };
    },
    async getTransaction() {
      return null;
    },
  };
}

const mainnet = {} as never; // fixed sources never touch it: no pool units, no depth flags

/** A fresh multi-asset market (fresh address, so module-level pusher/breaker state never leaks between tests). */
function freshRegistry(n = 1): Registry {
  return {
    markets: Array.from({ length: n }, (_, i) => ({
      label: `FIX${i}/USD`,
      marketAddress: Keypair.generate().publicKey.toBase58(),
      assetIndex: 0,
      assets: [{ assetIndex: 0, source: "fixed", fixedPriceE6: "2000000" }],
    })),
  } as unknown as Registry;
}

function freshState(registry: Registry): LoopState {
  return {
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
}

const baseConfig: LoopConfig = {
  intervalMs: 1000,
  healthPort: 0,
  healthBind: "127.0.0.1",
  dryRun: false,
  minKeeperBalanceLamports: 1_000_000,
  balanceCheckIntervalMs: 60_000,
};

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, warn = console.warn, err = console.error;
  if (!process.env.DBG) console.log = console.warn = console.error = () => {};
  return fn().finally(() => {
    console.log = log;
    console.warn = warn;
    console.error = err;
  });
}

async function cycle(registry: Registry, state: LoopState, config: LoopConfig = baseConfig, dev = fakeDevnet()) {
  await quiet(() => runCycle(mainnet, dev as never, keeper, registry, new Map(), state, config));
}

function health(state: LoopState, registry: Registry, config: LoopConfig = baseConfig): { code: number; body: Record<string, unknown> | null } {
  let code = 0;
  let payload = "";
  const res = {
    writeHead(c: number) {
      code = c;
    },
    end(p?: string) {
      payload = p ?? "";
    },
  };
  makeHealthHandler(state, config, registry)({ url: "/health" } as never, res as never);
  return { code, body: payload ? JSON.parse(payload) : null };
}

beforeEach(async () => {
  knobs = {
    account: await marketAccountFor(keeper.publicKey.toBytes()),
    failAccountInfo: false,
    failSlot: false,
    failBalance: false,
    failMultiple: false,
    balance: 5_000_000_000,
    sent: 0,
    balanceCalls: 0,
  };
});

describe("runCycle", () => {
  it("success: pushes the fixed mark, stamps the market and counts the push", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    await cycle(registry, state);
    const key = `${registry.markets[0].marketAddress}#0`;
    const stat = state.stats.get(key)!;
    assert.equal(knobs.sent, 1, "one batched tx");
    assert.equal(stat.lastPriceE6, 2_000_000n);
    assert.equal(stat.totalPushes, 1);
    assert.ok(stat.lastSig?.startsWith("sigFAKE"));
    assert.equal(state.cyclePushed, 1);
    assert.equal(state.cycleAttempted, 1);
    assert.ok(state.lastSuccessfulPushAt !== null);
    assert.ok(state.landedThisCycle.has(key));
  });

  it("dry run: nothing is sent, but the market counts as landed", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    await cycle(registry, state, { ...baseConfig, dryRun: true });
    const stat = state.stats.get(`${registry.markets[0].marketAddress}#0`)!;
    assert.equal(knobs.sent, 0);
    assert.equal(state.cyclePushed, 1);
    assert.ok(state.lastSuccessfulPushAt !== null);
    assert.equal(stat.lastErrorMsg, null);
  });

  it("RPC error during the push: every market gets the error, the cycle does not throw, and the next cycle recovers", async () => {
    const registry = freshRegistry(2);
    const state = freshState(registry);
    const dev = fakeDevnet();
    knobs.failMultiple = true;
    await cycle(registry, state, baseConfig, dev);
    for (const m of registry.markets) {
      const s = state.stats.get(`${m.marketAddress}#0`)!;
      // the pusher swallows a failed generation read and drops the market from the batch; the loop records that
      assert.equal(s.totalErrors, 1);
      assert.match(s.lastErrorMsg ?? "", /dropped from batch/);
      assert.equal(s.totalPushes, 0);
    }
    assert.equal(state.lastSuccessfulPushAt, null);
    // the retry: same state, RPC healthy again
    knobs.failMultiple = false;
    state.cycleCount++;
    await cycle(registry, state, baseConfig, dev);
    for (const m of registry.markets) assert.equal(state.stats.get(`${m.marketAddress}#0`)!.totalPushes, 1);
    assert.ok(state.lastSuccessfulPushAt !== null);
  });

  it("a send that throws leaves no market stamped as pushed", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    const dev = fakeDevnet();
    dev.sendRawTransaction = async () => {
      throw new Error("Blockhash not found");
    };
    await cycle(registry, state, baseConfig, dev);
    const s = state.stats.get(`${registry.markets[0].marketAddress}#0`)!;
    assert.equal(s.totalPushes, 0);
    assert.ok(s.totalErrors >= 1);
    assert.ok(s.lastErrorMsg);
    assert.equal(state.lastSuccessfulPushAt, null);
    assert.equal(state.cyclePushed, 0);
  });

  it("slot read failure after pricing propagates (the loop's own try/catch owns it)", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    knobs.failSlot = true;
    await assert.rejects(cycle(registry, state), /slot rpc down/);
    assert.equal(knobs.sent, 0);
  });

  it("authority RPC error: not latched as unpushable, the check is retried next cycle", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    const dev = fakeDevnet();
    let reads = 0;
    const inner = dev.getAccountInfo;
    dev.getAccountInfo = async () => {
      reads++;
      return inner();
    };
    knobs.failAccountInfo = true;
    await cycle(registry, state, baseConfig, dev);
    const s = state.stats.get(`${registry.markets[0].marketAddress}#0`)!;
    assert.equal(s.authorityMismatch, false);
    assert.equal(reads, 1);
    knobs.failAccountInfo = false;
    await cycle(registry, state, baseConfig, dev);
    assert.equal(reads, 2, "the unreadable authority was asked for again");
    assert.equal(s.authorityMismatch, false);
    assert.equal(s.totalPushes, 2, "an unchecked market is still pushed while its authority read keeps failing");
    assert.equal(s.lastErrorMsg, null);
  });

  it("skip: a market whose oracle authority is not the keeper is not pushed", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    knobs.account = await marketAccountFor(Keypair.generate().publicKey.toBytes());
    await cycle(registry, state);
    const s = state.stats.get(`${registry.markets[0].marketAddress}#0`)!;
    assert.equal(s.authorityMismatch, true);
    assert.match(s.lastErrorMsg ?? "", /oracle_authority != keeper/);
    assert.equal(knobs.sent, 0);
    assert.equal(state.cycleAttempted, 0);
  });

  it("skip: terminal, standby and withheld markets are not pushed (and not counted as failures)", async () => {
    const registry = freshRegistry(3);
    const [term, standby, withheld] = registry.markets.map((m) => m.marketAddress);
    const state = freshState(registry);
    state.terminalMarkets.add(term);
    await cycle(registry, state, {
      ...baseConfig,
      standby: (m) => m === standby,
      withholdPush: (m) => m === withheld,
    });
    assert.equal(knobs.sent, 0);
    assert.ok(state.standbyThisCycle?.has(`${standby}#0`));
    assert.match(state.stats.get(`${withheld}#0`)!.lastErrorMsg ?? "", /push withheld/);
    assert.equal(state.stats.get(`${term}#0`)!.totalErrors, 0);
  });

  it("skip: a low wallet pauses pushes, and an unreadable balance does not clear a low verdict", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    const config = { ...baseConfig, balanceCheckIntervalMs: 0 };
    knobs.balance = 10; // below the 1_000_000 floor
    await cycle(registry, state, config);
    assert.equal(state.wallet.low, true);
    assert.equal(knobs.sent, 0);
    assert.equal(health(state, registry).body?.walletLow, true);
    knobs.failBalance = true;
    await cycle(registry, state, config);
    assert.equal(state.wallet.low, true, "an RPC failure is not evidence of funds");
    assert.equal(knobs.sent, 0);
    knobs.failBalance = false;
    knobs.balance = 5_000_000_000;
    await cycle(registry, state, config);
    assert.equal(state.wallet.low, false);
    assert.equal(knobs.sent, 1);
  });

  it("an empty registry is a no-op cycle", async () => {
    const registry = { markets: [] } as unknown as Registry;
    const state = freshState(registry);
    await cycle(registry, state);
    assert.equal(knobs.sent, 0);
    assert.equal(state.cyclePushed, 0);
  });

  it("onPushLanded is never fired for a multi-asset asset", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    let fired = 0;
    await cycle(registry, state, {
      ...baseConfig,
      onPushLanded: () => {
        fired++;
      },
    });
    assert.equal(fired, 0);
    assert.equal(state.cyclePushed, 1);
  });
});

describe("makeHealthHandler", () => {
  it("404s on any other path", () => {
    const registry = freshRegistry();
    let code = 0;
    makeHealthHandler(freshState(registry), baseConfig, registry)(
      { url: "/metrics" } as never,
      { writeHead: (c: number) => (code = c), end() {} } as never,
    );
    assert.equal(code, 404);
  });

  it("serves / like /health (200 with a markets board)", () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    let code = 0;
    let body = "";
    makeHealthHandler(state, baseConfig, registry)(
      { url: "/" } as never,
      { writeHead: (c: number) => (code = c), end: (p?: string) => (body = p ?? "") } as never,
    );
    assert.equal(code, 200);
    assert.ok(JSON.parse(body).markets);
  });

  it("healthy: after a landed push the board reports ok with a push timestamp", async () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    await cycle(registry, state);
    state.lastCycleAt = Date.now();
    const { code, body } = health(state, registry);
    assert.equal(code, 200);
    assert.equal(body?.status, "ok");
    assert.equal(body?.consecutiveBatchReadFailures, 0);
    assert.deepEqual(body?.noPushMarkets, []);
    assert.match(String(body?.lastSuccessfulPushAgo), /^\d+s$/);
    assert.equal(body?.dryRun, false);
    assert.equal(body?.intervalMs, 1000);
    const row = (body?.markets as Record<string, Record<string, unknown>>)[registry.markets[0].marketAddress];
    assert.ok(row, "one row per market");
  });

  it("stale: no push for longer than the stall window reports stalled-pricing, still HTTP 200", () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    state.lastSuccessfulPushAt = Date.now() - 10 * 60_000;
    state.lastCycleAt = Date.now();
    state.zeroPushStreak = 50;
    state.startedAt = Date.now() - 60 * 60_000;
    const { code, body } = health(state, registry);
    assert.equal(code, 200, "a 5xx would restart-loop the keeper");
    assert.equal(body?.status, "stalled-pricing");
  });

  it("stale: repeated batch read failures are named in the body", () => {
    const registry = freshRegistry();
    const state = freshState(registry);
    state.startedAt = Date.now() - 60 * 60_000;
    state.consecutiveBatchReadFailures = 9;
    state.lastBatchReadError = "pool rpc down";
    const { body } = health(state, registry);
    assert.equal(body?.consecutiveBatchReadFailures, 9);
    assert.equal(body?.lastBatchReadError, "pool rpc down");
    assert.equal(body?.status, "stalled-pricing");
  });

  it("a terminal market reads resolved/terminal, not a stale error", () => {
    const registry = freshRegistry();
    const addr = registry.markets[0].marketAddress;
    const state = freshState(registry);
    state.stats.get(`${addr}#0`)!.lastErrorMsg = "old error";
    state.terminalMarkets.add(addr);
    const body = health(state, registry).body!;
    const row = (body.markets as Record<string, Record<string, unknown>>)[addr];
    assert.equal(row.terminal, true);
    for (const a of row.assets as Array<Record<string, unknown>>) assert.equal(a.lastError, null, "a terminal market never shows an old error");
  });

  it("a deregistered market leaves the board after a cycle", async () => {
    const registry = freshRegistry(2);
    const state = freshState(registry);
    const gone = registry.markets[1].marketAddress;
    const trimmed = { markets: [registry.markets[0]] } as unknown as Registry;
    await cycle(trimmed, state);
    assert.equal(state.stats.has(`${gone}#0`), false);
  });
});
