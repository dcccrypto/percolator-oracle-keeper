/**
 * earn-exit.ts memo: differential test. A frozen copy of the pre-memo executeKeeperExits (REFERENCE) and the memoised one are run
 * over the same randomized markets / requests / refusals; the compiled transaction messages (keys + flags + data bytes) and the
 * outcomes must be byte-identical. Also pins the derivation drop on warm ticks.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedMessage } from "@solana/web3.js";
import {
  buildExecuteRedemptionIxV22,
  deriveLpVaultRegistry,
  deriveMarketVaultAccounts,
  getAtaSync,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import { resetJobCounters, simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import {
  EARN_EXIT_COOLDOWN_SLOTS,
  EARN_EXIT_EXPECTED,
  EARN_EXIT_UNITS,
  _clearEarnExitMemo,
  bookIsLossCurrent,
  executeKeeperExits,
  freshEarnExitState,
  selectKeeperRequests,
} from "./earn-exit.ts";
import type { EarnExitState } from "./earn-exit.ts";
import { key, v22Ctx } from "./test-helpers.ts";
import type { V22MarketCtx } from "./market.ts";

beforeEach(() => {
  resetJobCounters();
  _clearEarnExitMemo();
});

/** REFERENCE: executeKeeperExits exactly as on 33eda56 (no memo). */
async function referenceExits(exec: ExecContext, ctx: V22MarketCtx, requests: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>, maxPerTick: number, st: EarnExitState) {
  const gate = bookIsLossCurrent(ctx);
  if (!gate.ok) return { gate, outcomes: [] as Array<{ redemption: string; outcome: ExecOutcome }> };
  const [registry] = deriveLpVaultRegistry(ctx.programId, ctx.market);
  const now = BigInt(ctx.readSlot);
  const todo = selectKeeperRequests(requests, registry, (pk) => (st.cooldownUntil.get(pk.toBase58()) ?? 0n) > now).slice(0, maxPerTick);
  const mint = parseWrapperConfigV17(ctx.data).collateralMint;
  const vaultToken = deriveMarketVaultAccounts(ctx.programId, ctx.market, mint).vaultToken;
  const outcomes: Array<{ redemption: string; outcome: ExecOutcome }> = [];
  for (const { pubkey, req } of todo) {
    const dest = getAtaSync(req.redeemer, mint, true);
    const ix = buildExecuteRedemptionIxV22(ctx.sdk, exec.keeper.publicKey, req.redeemer, dest, vaultToken, ctx.registryDomain, {
      minPayoutAtoms: req.minPayoutAtoms,
      redeemerSigns: false,
      ...(ctx.bound && ctx.lpPortfolio ? { boundLpPortfolio: ctx.lpPortfolio } : {}),
    });
    const outcome = await simulateAndSend(exec, [ix], { job: "earn-exit-77", label: `${ctx.label} ${pubkey.toBase58().slice(0, 6)}`, units: EARN_EXIT_UNITS, expected: EARN_EXIT_EXPECTED });
    outcomes.push({ redemption: pubkey.toBase58(), outcome });
    if (outcome.kind !== "sent" && outcome.kind !== "dry-run") st.cooldownUntil.set(pubkey.toBase58(), now + EARN_EXIT_COOLDOWN_SLOTS);
  }
  return { gate, outcomes };
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s % n);
}

function request(registry: PublicKey, redeemer: number, floor: bigint, slot: bigint): Uint8Array {
  const b = Buffer.alloc(128);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(19, 8);
  b[10] = 6;
  Buffer.from(registry.toBytes()).copy(b, 16);
  Buffer.from(key(redeemer).toBytes()).copy(b, 48);
  b.writeBigUInt64LE(77n, 80);
  b.writeBigUInt64LE(slot, 96);
  b[104] = 1;
  b.writeBigUInt64LE(floor, 112);
  b[120] = 1;
  return new Uint8Array(b);
}

/** A recording connection: every simulated message is serialized (keys, flags, data); some are refused by a pure function of the bytes. */
function recorder(refuse: (ser: Buffer) => number | null) {
  const msgs: string[] = [];
  const conn = {
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000_000 };
    },
    async simulateTransaction(tx: { message: { serialize(): Uint8Array } }) {
      const ser = Buffer.from(tx.message.serialize());
      msgs.push(ser.toString("hex"));
      const code = refuse(ser);
      return { context: { slot: 1 }, value: { err: code === null ? null : { InstructionError: [2, { Custom: code }] }, logs: [], unitsConsumed: 7 } };
    },
  };
  return { conn, msgs };
}

function scenario(seed: number) {
  const r = lcg(seed);
  const keeper = Keypair.fromSeed(new Uint8Array(32).fill(seed));
  const markets = Array.from({ length: 6 }, (_, i) => {
    const base = v22Ctx({ bound: r(2) === 0 });
    const market = key(3000 + i);
    const registryDomain = r(2);
    // ctx.market / ctx.registryDomain are mirrored into ctx.sdk in production (buildV22MarketCtx); keep them in sync here.
    return { ...base, market, marketAddress: market.toBase58(), registryDomain, sdk: { ...base.sdk, market, registryDomain } } as V22MarketCtx;
  });
  const ticks: Array<Array<{ ctx: V22MarketCtx; reqs: Array<{ pubkey: PublicKey; data: Uint8Array }> }>> = [];
  for (let t = 0; t < 5; t++) {
    ticks.push(
      markets.map((m, i) => {
        let ctx = { ...m, readSlot: 5000 + t * 200 };
        // the collateral mint changes under one market mid-run (memo must not serve the stale vault)
        if (t >= 3 && i === 2) {
          const data = new Uint8Array(m.data);
          data.set(key(777).toBytes(), 48);
          ctx = { ...ctx, data };
        }
        // and one market flips bound -> unbound with a different lp portfolio
        if (t >= 2 && i === 4) ctx = { ...ctx, bound: !m.bound, lpPortfolio: key(950 + t) };
        const reg = deriveLpVaultRegistry(ctx.programId, ctx.market)[0];
        const n = 1 + r(6);
        const reqs = Array.from({ length: n }, (_, j) => ({
          pubkey: key(6000 + i * 50 + j),
          data: request(reg, 100 + r(5), BigInt(1 + r(1_000_000)) * (r(4) === 0 ? 2n ** 40n : 1n), BigInt(1000 + r(50))),
        }));
        return { ctx, reqs };
      }),
    );
  }
  return { keeper, ticks, maxPer: [1, 2, 3, 10][r(4)] };
}

async function run(impl: typeof executeKeeperExits, seed: number) {
  const sc = scenario(seed);
  const rec = recorder((ser) => {
    const sum = ser.reduce((a, b) => (a + b) | 0, 0);
    const m = Math.abs(sum) % 5;
    return m === 0 ? 117 : m === 1 ? 118 : m === 2 ? 6000 : null;
  });
  const exec: ExecContext = { conn: rec.conn as never, keeper: sc.keeper, dryRun: false, log: () => {}, confirm: { statusRetries: 0, statusRetryDelayMs: 0 } };
  // dry-run keeps the compile unsigned and skips send: outcomes are "dry-run" or "refused"
  exec.dryRun = true;
  const states = new Map<string, EarnExitState>();
  const outcomes: unknown[] = [];
  for (const tick of sc.ticks) {
    for (const { ctx, reqs } of tick) {
      let st = states.get(ctx.marketAddress);
      if (!st) states.set(ctx.marketAddress, (st = freshEarnExitState()));
      const res = await impl(exec, ctx, reqs, sc.maxPer, st);
      outcomes.push(JSON.parse(JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
    }
  }
  return { msgs: rec.msgs, outcomes, cooldowns: [...states].map(([k, s]) => [k, [...s.cooldownUntil].map(([a, b]) => [a, b.toString()])]) };
}

describe("earn-exit memo: differential vs the un-memoised reference", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: identical instructions (keys + flags + data), outcomes and cooldowns`, async () => {
      const before = await run(referenceExits as never, seed);
      _clearEarnExitMemo();
      const after = await run(executeKeeperExits, seed);
      assert.ok(before.msgs.length > 5, "scenario must build instructions");
      if (process.env.DBG) {
        const i = before.msgs.findIndex((m, k) => m !== after.msgs[k]);
        console.log("LEN", before.msgs.length, after.msgs.length, "first diff", i);
        const dec = (h: string) => VersionedMessage.deserialize(Buffer.from(h, "hex"));
        for (const m of [before.msgs[i], after.msgs[i]]) {
          const d = dec(m);
          console.log(d.staticAccountKeys.map((k) => k.toBase58().slice(0, 6)).join(","), d.compiledInstructions.map((c) => c.accountKeyIndexes.join(".") + "|" + Buffer.from(c.data).toString("hex")).join(" / "));
        }
      }
      assert.deepEqual(after.msgs, before.msgs);
      assert.deepEqual(after.outcomes, before.outcomes);
      assert.deepEqual(after.cooldowns, before.cooldowns);
    });
  }

  it("warm ticks derive >= 80% fewer PDAs than the reference", async () => {
    const orig = PublicKey.findProgramAddressSync.bind(PublicKey);
    let n = 0;
    (PublicKey as unknown as { findProgramAddressSync: typeof orig }).findProgramAddressSync = (s, p) => (n++, orig(s, p));
    try {
      const count = async (impl: typeof executeKeeperExits) => {
        _clearEarnExitMemo();
        const sc = scenario(11);
        const rec = recorder(() => null);
        const exec: ExecContext = { conn: rec.conn as never, keeper: sc.keeper, dryRun: true, log: () => {}, confirm: { statusRetries: 0, statusRetryDelayMs: 0 } };
        const sts = new Map<string, EarnExitState>();
        const tick = async (i: number) => {
          for (const { ctx, reqs } of sc.ticks[i]) {
            const st = sts.get(ctx.marketAddress) ?? freshEarnExitState();
            sts.set(ctx.marketAddress, st);
            await impl(exec, ctx, reqs, 10, st);
          }
        };
        await tick(0);
        await tick(1); // warm up (tick 1 has new redeemers: still counts toward cold work)
        n = 0;
        await tick(1);
        return n;
      };
      const ref = await count(referenceExits as never);
      const memo = await count(executeKeeperExits);
      assert.ok(ref > 0);
      assert.ok(memo <= ref * 0.2, `memo ${memo} vs reference ${ref}`);
    } finally {
      (PublicKey as unknown as { findProgramAddressSync: typeof orig }).findProgramAddressSync = orig;
    }
  });
});
