/**
 * Branch coverage for lp-fee-cranker.ts: account-read failures, terminal/recovery markets, bound-vault
 * paths (senior-draw observe, resolved harvest gate, P2b ext tail + race retry), stale-resolve waits,
 * the per-market aggregation and the fee-job mapping. Connection is a stub; no network.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { V17_EXPECTED_VERSION } from "@percolatorct/sdk";
import {
  buildCrankFeesIx,
  crankAllLpFeesOnce,
  crankLpFeesOnce,
  makeLpFeeJob,
  resolvedHarvestChangesState,
} from "./lp-fee-cranker.ts";
import { nonComputeBudget } from "./test-ix.ts";
import { setBondFeeDelegated } from "./v22/delegation.ts";
import { P2bFeatureGate, DEFAULT_P2B_GATE_CONFIG, setP2bGate } from "./p2b-feature.ts";

const KEEPER = Keypair.generate();
const FAST = { statusRetries: 1, statusRetryDelayMs: 0 };
const MARKET = () => Keypair.generate().publicKey.toBase58();
const WRAPPER_MAGIC = 0x5045_5243_5631_3600n;

afterEach(() => {
  setBondFeeDelegated(false);
  setP2bGate(null);
});

function registryBuf(o: { shares?: bigint; domain?: number; flags?: Partial<Record<"bound" | "ext" | "bond", number>> } = {}): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(WRAPPER_MAGIC, 0);
  b.writeUInt16LE(V17_EXPECTED_VERSION, 8);
  b.writeUInt8(5, 10);
  const shares = o.shares ?? 1_000_000n;
  b.writeBigUInt64LE(shares & 0xffff_ffff_ffff_ffffn, 16 + 64);
  b.writeBigUInt64LE(shares >> 64n, 16 + 72);
  b.writeUInt16LE(o.domain ?? 0, 16 + 132);
  b.writeUInt8(o.flags?.bound ?? 0, 160);
  b.writeUInt8(o.flags?.ext ?? 0, 161);
  b.writeUInt8(o.flags?.bond ?? 0, 162);
  return b;
}

/** A v19 market header: kind 1 (live/resolved/recovery by mode) or kind 8 (closed). */
function marketBuf(o: { kind?: number; mode?: number; materialized?: bigint; cTot?: bigint; staleSlots?: bigint; lastGood?: bigint } = {}): Buffer {
  const b = Buffer.alloc(592 + 806);
  b.writeBigUInt64LE(WRAPPER_MAGIC, 0);
  b.writeUInt16LE(19, 8);
  b.writeUInt8(o.kind ?? 1, 10);
  b.writeUInt8(o.mode ?? 0, 592 + 674);
  b.writeBigUInt64LE(o.materialized ?? 0n, 592 + 565);
  b.writeBigUInt64LE(o.cTot ?? 0n, 592 + 365);
  b.writeBigUInt64LE(o.staleSlots ?? 0n, 16 + 136);
  b.writeBigUInt64LE(o.lastGood ?? 0n, 16 + 152);
  return b;
}

function vaultLpStateBuf(lpPortfolio: PublicKey): Buffer {
  const b = Buffer.alloc(16 + 256);
  b.writeUInt8(9, 10);
  b.writeUInt8(1, 16 + 214);
  lpPortfolio.toBuffer().copy(b, 16 + 64);
  return b;
}

type Info = { data: Buffer } | null;
interface Opts {
  reads?: Array<Info[] | Error>;
  sim?: (() => unknown) | Error;
  sendError?: unknown;
  status?: { err: unknown; confirmationStatus: "confirmed" };
  slot?: number | Error | null;
}
function conn(o: Opts) {
  const calls = { reads: 0, sends: 0, sims: 0, sendOpts: [] as unknown[], lastTx: null as Buffer | null };
  const c: Record<string, unknown> = {
    async getMultipleAccountsInfo() {
      const r = (o.reads ?? [])[Math.min(calls.reads, (o.reads ?? []).length - 1)];
      calls.reads++;
      if (r instanceof Error || typeof r === "string") throw r;
      return r;
    },
    async getLatestBlockhash() {
      return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 };
    },
    async sendRawTransaction(raw: Buffer, opts: unknown) {
      calls.sends++;
      calls.lastTx = raw;
      calls.sendOpts.push(opts);
      if (o.sendError) throw o.sendError;
      return "sigsigsigsigsigsigsigsig";
    },
    async getBlockHeight() {
      return 2;
    },
    async getSignatureStatuses() {
      const s = o.status ?? { err: null, confirmationStatus: "confirmed" as const };
      return { value: [{ slot: 1, confirmations: 1, ...s }] };
    },
    async simulateTransaction() {
      calls.sims++;
      if (o.sim instanceof Error) throw o.sim;
      return o.sim ? o.sim() : { value: { err: null, logs: [] } };
    },
  };
  if (o.slot !== null && o.slot !== undefined) {
    c.getSlot = async () => {
      if (o.slot instanceof Error) throw o.slot;
      return o.slot as number;
    };
  }
  return { c: c as never, calls };
}

const reg = (o?: Parameters<typeof registryBuf>[0]): Info => ({ data: registryBuf(o) });
const mkt = (o?: Parameters<typeof marketBuf>[0]): Info => ({ data: marketBuf(o) });
const err = (code: number) => ({ InstructionError: [1, { Custom: code }] });
const crank = (c: never, obs?: { seniorDrawLogs: string[] }, dry = false) => crankLpFeesOnce(c, KEEPER, MARKET(), dry, FAST, obs);

describe("crankLpFeesOnce — read and market-state guards", () => {
  it("reports an account read failure", async () => {
    const { c } = conn({ reads: [new Error("rpc down")] });
    assert.deepEqual(await crank(c), { error: "account read failed: rpc down" });
  });

  it("skips a closed (tombstone) market, a Recovery market and a Resolved market that is not flat", async () => {
    for (const m of [mkt({ kind: 8 }), mkt({ mode: 2 }), mkt({ mode: 1, materialized: 3n })]) {
      const { c, calls } = conn({ reads: [[reg({ flags: { bound: 1 } }), m]] });
      assert.equal(await crank(c), "skipped");
      assert.equal(calls.sends, 0);
    }
  });

  it("skips a flat Resolved market when the vault is unbound", async () => {
    const { c, calls } = conn({ reads: [[reg(), mkt({ mode: 1 })]] });
    assert.equal(await crank(c), "skipped");
    assert.equal(calls.sends, 0);
  });

  it("returns an error for an invalid bound flag byte", async () => {
    const { c } = conn({ reads: [[reg({ flags: { bound: 7 } }), mkt()]] });
    const r = await crank(c);
    assert.ok(typeof r === "object" && /only 0\/1 are valid/.test(r.error), JSON.stringify(r));
  });

  it("steps aside for a bond-flagged registry once the v2.2 fee job owns it", async () => {
    setBondFeeDelegated(true);
    const { c, calls } = conn({ reads: [[reg({ flags: { bound: 1, bond: 1 } }), mkt()]] });
    assert.equal(await crank(c), "skipped");
    assert.equal(calls.sends, 0);
    setBondFeeDelegated(false);
    const again = conn({ reads: [[reg({ flags: { bound: 1, bond: 1 } }), mkt()]] });
    assert.equal(await crank(again.c), "cranked");
  });

  it("falls back to a send when the registry bytes are unparseable (layout change)", async () => {
    const { c, calls } = conn({ reads: [[{ data: Buffer.alloc(176) }, null]] });
    assert.equal(await crank(c), "cranked");
    assert.equal(calls.sends, 1);
  });

  it("a bound vault with zero shares is NOT skipped (it may still book a senior draw)", async () => {
    const { c, calls } = conn({ reads: [[reg({ shares: 0n, flags: { bound: 1 } }), mkt()]] });
    assert.equal(await crank(c), "cranked");
    assert.equal(calls.sends, 1);
  });

  it("dry-run logs and skips without sending", async () => {
    const { c, calls } = conn({ reads: [[reg(), mkt()]] });
    assert.equal(await crank(c, undefined, true), "skipped");
    assert.equal(calls.sends, 0);
  });
});

describe("crankLpFeesOnce — bound vault senior-draw observation", () => {
  const BOUND = [[reg({ flags: { bound: 1 } }), mkt()]];

  it("collects p3_senior_draw log lines and sends", async () => {
    const obs = { seniorDrawLogs: [] as string[] };
    const { c, calls } = conn({
      reads: BOUND,
      sim: () => ({ value: { err: null, logs: ["Program log: p3_senior_draw deficit=5 moved=5 unfunded=0", "Program log: other"] } }),
    });
    assert.equal(await crank(c, obs), "cranked");
    assert.deepEqual(obs.seniorDrawLogs, ["Program log: p3_senior_draw deficit=5 moved=5 unfunded=0"]);
    assert.equal(calls.sims, 1);
    assert.equal(calls.sends, 1);
  });

  it("tolerates a simulation without logs", async () => {
    const obs = { seniorDrawLogs: [] as string[] };
    const { c } = conn({ reads: BOUND, sim: () => ({ value: { err: null } }) });
    assert.equal(await crank(c, obs), "cranked");
    assert.deepEqual(obs.seniorDrawLogs, []);
  });

  it("a simulated Custom(38) is no-fees and nothing is sent", async () => {
    const { c, calls } = conn({ reads: BOUND, sim: () => ({ value: { err: err(38), logs: [] } }) });
    assert.equal(await crank(c, { seniorDrawLogs: [] }), "no-fees");
    assert.equal(calls.sends, 0);
  });

  it("a simulated OracleStale on a matured stale-resolve window is 'waiting'", async () => {
    const m = mkt({ staleSlots: 100n, lastGood: 0n });
    const { c, calls } = conn({ reads: [[reg({ flags: { bound: 1 } }), m]], sim: () => ({ value: { err: err(27), logs: [] } }), slot: 1000 });
    const r = await crank(c, { seniorDrawLogs: [] });
    assert.ok(typeof r === "object" && r.waiting === true && /OracleStale\(27\)/.test(r.error), JSON.stringify(r));
    assert.equal(calls.sends, 0);
  });

  it("a simulated OracleStale with no readable slot stays a send attempt (and a real failure if it fails)", async () => {
    const m = mkt({ staleSlots: 100n, lastGood: 0n });
    const { c, calls } = conn({ reads: [[reg({ flags: { bound: 1 } }), m]], sim: () => ({ value: { err: err(27), logs: [] } }), slot: new Error("no slot"), sendError: new Error("failed: custom program error: 0x1b") });
    const r = await crank(c, { seniorDrawLogs: [] });
    assert.ok(typeof r === "object" && !r.waiting && /27|0x1b/.test(r.error), JSON.stringify(r));
    assert.equal(calls.sends, 1);
  });

  it("a simulated non-stale error still proceeds to the send", async () => {
    const { c, calls } = conn({ reads: BOUND, sim: () => ({ value: { err: err(41), logs: [] } }) });
    assert.equal(await crank(c, { seniorDrawLogs: [] }), "cranked");
    assert.equal(calls.sends, 1);
  });

  it("without an observer a bound vault is not simulated", async () => {
    const { c, calls } = conn({ reads: BOUND });
    assert.equal(await crank(c), "cranked");
    assert.equal(calls.sims, 0);
  });
});

describe("crankLpFeesOnce — send/confirm outcomes", () => {
  const LIVE = [[reg(), mkt({ staleSlots: 100n, lastGood: 0n })]];

  it("a landed OracleStale on a matured window is 'waiting'", async () => {
    const { c } = conn({ reads: LIVE, status: { err: err(27), confirmationStatus: "confirmed" }, slot: 1000 });
    const r = await crank(c);
    assert.ok(typeof r === "object" && r.waiting === true, JSON.stringify(r));
  });

  it("a thrown OracleStale on a matured window is 'waiting'", async () => {
    const { c } = conn({ reads: LIVE, sendError: new Error("custom program error: 0x1b"), slot: 1000 });
    const r = await crank(c);
    assert.ok(typeof r === "object" && r.waiting === true, JSON.stringify(r));
  });

  it("OracleStale before the window matures stays a failure", async () => {
    const { c } = conn({ reads: LIVE, sendError: new Error("custom program error: 0x1b"), slot: 10 });
    const r = await crank(c);
    assert.ok(typeof r === "object" && !r.waiting, JSON.stringify(r));
  });
});

describe("crankLpFeesOnce — resolved harvest on a bound, terminal-flat market", () => {
  const RES = mkt({ mode: 1 });
  const regB = reg({ flags: { bound: 1 } });

  it("sends with skipPreflight when the simulation changes the market", async () => {
    const { c, calls } = conn({
      reads: [[regB, RES], [RES, null]],
      sim: () => ({ value: { err: null, logs: ["p3_senior_draw deficit=1 moved=1 unfunded=0"], accounts: [{ data: [Buffer.alloc(4).toString("base64")] }, null] } }),
    });
    const obs = { seniorDrawLogs: [] as string[] };
    assert.equal(await crank(c, obs), "cranked");
    assert.equal((calls.sendOpts[0] as { skipPreflight: boolean }).skipPreflight, true);
    assert.equal(obs.seniorDrawLogs.length, 1);
  });

  it("reports no-fees when nothing would change (both accounts absent before and after)", async () => {
    const { c, calls } = conn({ reads: [[regB, RES], [null, null]], sim: () => ({ value: { err: null, logs: [] } }) });
    assert.equal(await crank(c), "no-fees");
    assert.equal(calls.sends, 0);
  });

  it("maps a pre-07a1d0eb EngineLockActive(21) simulation to skipped", async () => {
    const { c } = conn({ reads: [[regB, RES], [RES, null]], sim: () => ({ value: { err: err(21), logs: [] } }) });
    assert.equal(await crank(c), "skipped");
  });

  it("maps a simulated Custom(38) to no-fees", async () => {
    const { c } = conn({ reads: [[regB, RES], [RES, null]], sim: () => ({ value: { err: err(38), logs: [] } }) });
    assert.equal(await crank(c), "no-fees");
  });

  it("reports another simulated error as a failure", async () => {
    const { c } = conn({ reads: [[regB, RES], [RES, null]], sim: () => ({ value: { err: err(41), logs: [] } }) });
    const r = await crank(c);
    assert.ok(typeof r === "object" && /resolved harvest sim/.test(r.error), JSON.stringify(r));
  });

  it("a send refused with EngineLockActive(21) after a 'changes' simulation is skipped", async () => {
    const { c } = conn({
      reads: [[regB, RES], [RES, null]],
      sim: () => ({ value: { err: null, logs: [], accounts: [null, null] } }),
      sendError: new Error("failed: custom program error: 0x15"),
    });
    // pre[0] exists, post[0] missing -> changed -> send -> thrown 21
    assert.equal(await crank(c), "skipped");
  });
});

describe("resolvedHarvestChangesState", () => {
  const tx = () => {
    const t = new Transaction();
    t.add(SystemProgram.transfer({ fromPubkey: KEEPER.publicKey, toPubkey: KEEPER.publicKey, lamports: 1 }));
    t.recentBlockhash = "1".repeat(32);
    t.feePayer = KEEPER.publicKey;
    return t;
  };
  const m = Keypair.generate().publicKey;
  const l = Keypair.generate().publicKey;
  const mk = (pre: Info[], simVal: unknown) => ({
    getMultipleAccountsInfo: async () => pre,
    simulateTransaction: async () => ({ value: simVal }),
  }) as never;
  const b64 = (n: number) => Buffer.alloc(4, n);

  it("no-change when both accounts' bytes are identical", async () => {
    const conn2 = mk([{ data: b64(1) }, { data: b64(2) }], { err: null, accounts: [{ data: [b64(1).toString("base64")] }, { data: [b64(2).toString("base64")] }] });
    assert.equal(await resolvedHarvestChangesState(conn2, tx(), m, l), "no-change");
  });

  it("changes when the ledger bytes differ", async () => {
    const conn2 = mk([{ data: b64(1) }, { data: b64(2) }], { err: null, accounts: [{ data: [b64(1).toString("base64")] }, { data: [b64(9).toString("base64")] }] });
    assert.equal(await resolvedHarvestChangesState(conn2, tx(), m, l), "changes");
  });

  it("changes when an account appears in the simulation but was absent before", async () => {
    const conn2 = mk([{ data: b64(1) }, null], { err: null, accounts: [{ data: [b64(1).toString("base64")] }, { data: [b64(2).toString("base64")] }] });
    assert.equal(await resolvedHarvestChangesState(conn2, tx(), m, l), "changes");
  });

  it("treats a missing accounts array as absent post-state", async () => {
    const conn2 = mk([null, null], { err: null });
    assert.equal(await resolvedHarvestChangesState(conn2, tx(), m, l), "no-change");
  });

  it("does not observe logs of a failed simulation, and clips an uncoded error", async () => {
    const obs = { seniorDrawLogs: [] as string[] };
    const conn2 = mk([null, null], { err: "BlockhashNotFound", logs: ["p3_senior_draw deficit=1 moved=1 unfunded=0"] });
    const r = await resolvedHarvestChangesState(conn2, tx(), m, l, obs);
    assert.ok(typeof r === "object" && /resolved harvest sim: "BlockhashNotFound"/.test(r.error), JSON.stringify(r));
    assert.deepEqual(obs.seniorDrawLogs, []);
  });

  it("never throws: a failing read becomes an error", async () => {
    const bad = { getMultipleAccountsInfo: async () => { throw new Error("rpc down"); }, simulateTransaction: async () => ({ value: {} }) } as never;
    const r = await resolvedHarvestChangesState(bad, tx(), m, l);
    assert.deepEqual(r, { error: "resolved harvest sim failed: rpc down" });
    const bad2 = { getMultipleAccountsInfo: async () => { throw "plain string"; }, simulateTransaction: async () => ({ value: {} }) } as never;
    assert.deepEqual(await resolvedHarvestChangesState(bad2, tx(), m, l), { error: "resolved harvest sim failed: plain string" });
  });
});

describe("crankLpFeesOnce — P2b ext tail", () => {
  const regExt = reg({ flags: { bound: 1, ext: 1 } });
  const lp = Keypair.generate().publicKey;
  const stateInfo: Info = { data: vaultLpStateBuf(lp) };

  /** Account keys of the sent tag-78 instruction. */
  const sentKeys = (raw: Buffer | null): number => nonComputeBudget(Transaction.from(raw!).instructions).at(-1)!.keys.length;

  it("appends the ext + vault LP tail ([7],[8]) when the ext flag is set", async () => {
    const { c, calls } = conn({ reads: [[regExt, mkt()], [stateInfo]] });
    assert.equal(await crank(c), "cranked");
    assert.equal(sentKeys(calls.lastTx), 9);
  });

  it("adds the bond tranche ([9]) on a bond registry", async () => {
    const { c, calls } = conn({ reads: [[reg({ flags: { bound: 1, ext: 1, bond: 1 } }), mkt()], [stateInfo]] });
    assert.equal(await crank(c), "cranked");
    assert.equal(sentKeys(calls.lastTx), 10);
  });

  it("fails closed when vault_lp_state is unreadable", async () => {
    for (const s of [null, { data: Buffer.alloc(8) }]) {
      const { c, calls } = conn({ reads: [[regExt, mkt()], [s]] });
      const r = await crank(c);
      assert.ok(typeof r === "object" && /vault_lp_state unreadable/.test(r.error), JSON.stringify(r));
      assert.equal(calls.sends, 0);
    }
  });

  it("reports a failed vault_lp_state read", async () => {
    for (const e of [new Error("rpc down"), "boom" as unknown as Error]) {
      const { c } = conn({ reads: [[regExt, mkt()], e] });
      const r = await crank(c);
      assert.ok(typeof r === "object" && /ext tail read failed/.test(r.error), JSON.stringify(r));
    }
  });

  describe("race: the ext appears between the registry read and the send", () => {
    const gateOn = () => setP2bGate(new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported"));
    const bound = reg({ flags: { bound: 1 } });

    it("retries once with the tail when a fresh registry now carries the flag", async () => {
      gateOn();
      // 1: [registry, market] (no flag) -> first send refused; 2: fresh registry (flag); 3: vault_lp_state
      const { c, calls } = conn({ reads: [[bound, mkt()], [regExt], [stateInfo]] });
      let n = 0;
      (c as { sendRawTransaction: unknown }).sendRawTransaction = async (raw: Buffer) => {
        calls.sends++;
        calls.lastTx = raw;
        if (n++ === 0) throw new Error("custom program error: 0x29");
        return "sigsigsigsigsigsigsigsig";
      };
      assert.equal(await crank(c), "cranked");
      assert.equal(calls.sends, 2);
      assert.equal(sentKeys(calls.lastTx), 9);
    });

    it("keeps the first outcome when the fresh registry has no flag, the tail fails, or the re-read throws", async () => {
      gateOn();
      const expectReads = [2, 3, 2];
      let k = 0;
      for (const second of [[bound], [regExt], new Error("rpc down")]) {
        const { c, calls } = conn({ reads: [[bound, mkt()], second as Info[], [null]], sendError: new Error("custom program error: 0x29") });
        const r = await crank(c);
        assert.ok(typeof r === "object" && "error" in r, JSON.stringify(r));
        assert.equal(calls.sends, 1);
        assert.equal(calls.reads, expectReads[k++]);
      }
      // fresh registry missing entirely
      const m = conn({ reads: [[bound, mkt()], [null]], sendError: new Error("custom program error: 0x29") });
      assert.ok(typeof (await crank(m.c)) === "object");
      assert.equal(m.calls.reads, 2);
      assert.equal(m.calls.sends, 1);
    });

    it("does not re-read when the P2b gate is off", async () => {
      const { c, calls } = conn({ reads: [[bound, mkt()], [regExt], [stateInfo]], sendError: new Error("custom program error: 0x29") });
      const r = await crank(c);
      assert.ok(typeof r === "object" && "error" in r);
      assert.equal(calls.reads, 1);
      assert.equal(calls.sends, 1);
    });
  });
});

describe("buildCrankFeesIx", () => {
  const p = () => ({
    keeper: KEEPER.publicKey,
    market: Keypair.generate().publicKey,
    registry: Keypair.generate().publicKey,
    ledger: Keypair.generate().publicKey,
    siblingLedger: Keypair.generate().publicKey,
    domainIdx: 0,
  });
  const tail = { vaultLpExt: Keypair.generate().publicKey, lpPortfolio: Keypair.generate().publicKey };

  it("6 accounts unbound, 7 bound without tail, 9 with ext tail, 10 with bond tranche", () => {
    assert.equal(buildCrankFeesIx({ ...p(), bound: false, tail: null }).keys.length, 6);
    assert.equal(buildCrankFeesIx({ ...p(), bound: true, tail: null }).keys.length, 7);
    assert.equal(buildCrankFeesIx({ ...p(), bound: false, tail }).keys.length, 6, "tail is ignored on an unbound vault");
    assert.equal(buildCrankFeesIx({ ...p(), bound: true, tail }).keys.length, 9);
    assert.equal(buildCrankFeesIx({ ...p(), bound: true, tail: { ...tail, bondTranche: Keypair.generate().publicKey } }).keys.length, 10);
  });
});

describe("crankAllLpFeesOnce — bucketing", () => {
  it("logs failed markets and keeps the rest", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (s: unknown) => void errors.push(String(s));
    try {
      const { c } = conn({ reads: [[reg(), mkt()]], sendError: new Error("boom") });
      const r = await crankAllLpFeesOnce(c, KEEPER, { markets: [{ marketAddress: MARKET() }, { marketAddress: MARKET() }] } as never, false);
      assert.equal(r.failed.length, 2);
      assert.match(errors.join("\n"), /\[lp-fee\] 2 market\(s\) failed/);
    } finally {
      console.error = origErr;
    }
  });

  it("buckets a 'waiting' outcome separately from failures", async () => {
    const m = MARKET();
    const { c } = conn({ reads: [[reg(), mkt({ staleSlots: 100n })]], sendError: new Error("custom program error: 0x1b"), slot: 1000 });
    const r = await crankAllLpFeesOnce(c, KEEPER, { markets: [{ marketAddress: m }] } as never, false);
    assert.equal(r.waiting.length, 1);
    assert.equal(r.waiting[0].market, m);
    assert.equal(r.failed.length, 0);
  });

  it("buckets no-fees", async () => {
    const m = MARKET();
    const { c } = conn({ reads: [[reg(), mkt()]], sendError: new Error("custom program error: 0x26") });
    const r = await crankAllLpFeesOnce(c, KEEPER, { markets: [{ marketAddress: m }] } as never, false);
    assert.deepEqual(r.noFees, [m]);
  });
});

describe("makeLpFeeJob", () => {
  const job = makeLpFeeJob(FAST);
  const run = (c: never, label = "SOL-PERP") => job.run({ conn: c, keeper: KEEPER, dryRun: false } as never, { marketAddress: MARKET(), label } as never);

  it("done: cranked without senior-draw events", async () => {
    const { c } = conn({ reads: [[reg(), mkt()]] });
    const o = await run(c);
    assert.equal(o.kind, "done");
    assert.ok(!("events" in o));
  });

  it("done with 'Earn absorbed' events when a booking landed", async () => {
    const line = "Program log: p3_senior_draw_booked moved=10 junior_cover=4 senior_loss=6 C=100 outstanding=6";
    const { c } = conn({ reads: [[reg({ flags: { bound: 1 } }), mkt()]], sim: () => ({ value: { err: null, logs: [line] } }) });
    const o = await run(c);
    assert.equal(o.kind, "done");
    assert.equal((o as { events?: unknown[] }).events?.length, 1);
  });

  it("nothing / skipped / waiting / failed", async () => {
    assert.equal((await run(conn({ reads: [[reg(), mkt()]], sendError: new Error("custom program error: 0x26") }).c)).kind, "nothing");
    assert.equal((await run(conn({ reads: [[null, null]] }).c)).kind, "skipped");
    const w = await run(conn({ reads: [[reg(), mkt({ staleSlots: 100n })]], sendError: new Error("custom program error: 0x1b"), slot: 1000 }).c);
    assert.equal(w.kind, "waiting");
    const f = await run(conn({ reads: [[reg(), mkt()]], sendError: new Error("boom") }).c);
    assert.equal(f.kind, "failed");
  });
});
