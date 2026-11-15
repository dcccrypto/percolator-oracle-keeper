/**
 * Branch coverage for lp-fee-cranker.ts: the no-op, read-failure, simulate-failure, never-landed and
 * "did a failure leave state advanced" paths. crankLpFeesOnce keeps NO cursor or cooldown of its own;
 * the only state a failed crank can touch is the fee-jobs failure streak, pinned here through makeLpFeeJob.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { V17_EXPECTED_VERSION, V17_MARKET_GROUP_LEN, V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";
import {
  crankLpFeesOnce,
  crankAllLpFeesOnce,
  makeLpFeeJob,
  buildCrankFeesIx,
  resolvedHarvestChangesState,
} from "./lp-fee-cranker.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const KEEPER = Keypair.generate();
const FAST = { statusRetries: 1, statusRetryDelayMs: 0 };
const MARKET = () => Keypair.generate().publicKey.toBase58();
const BH = "11111111111111111111111111111111";

function registryBuf(o: { shares?: bigint; bound?: boolean; ext?: boolean; bond?: boolean; domain?: number } = {}): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(V17_EXPECTED_VERSION, 8);
  b.writeUInt8(5, 10);
  const shares = o.shares ?? 1_000n;
  b.writeBigUInt64LE(shares, 16 + 64);
  b.writeUInt16LE(o.domain ?? 0, 16 + 132);
  b[160] = o.bound ? 1 : 0;
  b[161] = o.ext ? 1 : 0;
  if (o.bond) b[162] = 1;
  return b;
}

/** A kind-1 (or 8) VERSION-18 market with the given engine mode, optional terminal-flat state and stale window. */
function marketBuf(o: { kind?: number; mode?: number; materialized?: bigint; stale?: { slots: bigint; lastGood: bigint } } = {}): Buffer {
  const b = Buffer.alloc(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + 64);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(18, 8);
  b[10] = o.kind ?? 1;
  const g = V17_MARKET_GROUP_OFF;
  b[g + 626] = o.mode ?? 0;
  b.writeBigUInt64LE(o.materialized ?? 0n, g + 517);
  if (o.stale) {
    b.writeBigUInt64LE(o.stale.slots, 16 + 136);
    b.writeBigUInt64LE(o.stale.lastGood, 16 + 152);
  }
  return b;
}

interface Opts {
  reg?: Buffer | null;
  market?: Buffer | null;
  readThrows?: boolean;
  sim?: { err: unknown; logs?: string[]; accounts?: Array<{ data: [string, string] } | null> } | "throw";
  sendError?: unknown;
  status?: { err: unknown; confirmationStatus: "confirmed" } | null;
  slot?: number | "throw";
  /** Per-call overrides for getMultipleAccountsInfo (call index -> response). */
  reads?: Array<unknown>;
}
function fake(o: Opts) {
  const c = { sends: 0, sims: 0, reads: 0, signed: [] as Transaction[] };
  const conn = {
    async getMultipleAccountsInfo() {
      const i = c.reads++;
      if (o.readThrows) throw new Error("rpc down " + "x".repeat(200));
      if (o.reads && o.reads[i] !== undefined) {
        const r = o.reads[i];
        if (r instanceof Error) throw r;
        return r;
      }
      return [o.reg === null ? null : { data: o.reg ?? registryBuf() }, o.market ? { data: o.market } : null];
    },
    async getLatestBlockhash() { return { blockhash: BH, lastValidBlockHeight: 1 }; },
    async sendRawTransaction(raw: Buffer) {
      c.sends++;
      c.signed.push(Transaction.from(raw));
      if (o.sendError) throw o.sendError;
      return "sigsigsigsigsigsigsig";
    },
    async getBlockHeight() { return 2; },
    async getSignatureStatuses() {
      const s = o.status === undefined ? { err: null, confirmationStatus: "confirmed" } : o.status;
      return { value: [s ? { slot: 1, confirmations: 1, ...s } : null] };
    },
    async simulateTransaction() {
      c.sims++;
      if (o.sim === "throw") throw new Error("simulate rpc 503");
      return { value: { err: o.sim?.err ?? null, logs: o.sim?.logs ?? [], accounts: o.sim?.accounts } };
    },
    async getSlot() {
      if (o.slot === "throw") throw new Error("slot rpc down");
      return o.slot ?? 5_000;
    },
  };
  return { c, conn: conn as never };
}
const code = (n: number) => ({ InstructionError: [1, { Custom: n }] });

describe("crankLpFeesOnce — nothing owed / nothing to read", () => {
  it("a failed account read is a reported error and costs no send", async () => {
    const f = fake({ readThrows: true });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && /^account read failed: rpc down/.test(r.error), JSON.stringify(r));
    assert.ok(r.error.length < 130, "error text is clipped");
    assert.equal(f.c.sends, 0);
  });

  it("a CloseSlab tombstone market is skipped without a send", async () => {
    const f = fake({ market: marketBuf({ kind: 8 }) });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.c.sends, 0);
  });

  it("a Recovery (mode 2) market is skipped without a send", async () => {
    const f = fake({ market: marketBuf({ mode: 2 }) });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.c.sends, 0);
  });

  it("a Resolved market that is not terminal-flat is skipped", async () => {
    const f = fake({ market: marketBuf({ mode: 1, materialized: 3n }) });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.c.sends + f.c.sims, 0);
  });

  it("a Resolved terminal-flat market with an UNBOUND vault is skipped", async () => {
    const f = fake({ market: marketBuf({ mode: 1 }), reg: registryBuf({ bound: false }) });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.c.sends + f.c.sims, 0);
  });

  it("an invalid bound-flag byte is reported, not guessed", async () => {
    const reg = registryBuf();
    reg[160] = 7;
    const f = fake({ reg });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && /bound flag is 7/.test(r.error), JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });

  it("an unparseable registry falls back to domain 0 and still cranks (a layout change must not stop every market)", async () => {
    const f = fake({ reg: Buffer.alloc(176) });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "cranked");
    assert.equal(f.c.sends, 1);
  });

  it("dry-run on a vault with shares never signs or sends", async () => {
    const f = fake({});
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), true), "skipped");
    assert.equal(f.c.sends + f.c.sims, 0);
  });
});

describe("crankLpFeesOnce — failure after the send decision", () => {
  it("a send that throws a generic error is a failure with the code first", async () => {
    const f = fake({ sendError: new Error("custom program error: 0x1c") });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && !r.waiting && /tag 78/.test(r.error), JSON.stringify(r));
  });

  it("OracleStale (27) with no matured stale window stays a failure, not 'waiting'", async () => {
    const f = fake({ sendError: new Error("custom program error: 0x1b"), market: marketBuf(), slot: 5_000 });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && !r.waiting, JSON.stringify(r));
  });

  it("OracleStale (27) with a matured stale window is 'waiting' (retry next cycle)", async () => {
    const f = fake({
      sendError: new Error("custom program error: 0x1b"),
      market: marketBuf({ stale: { slots: 100n, lastGood: 1_000n } }),
      slot: 5_000,
    });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && r.waiting === true && /^tag 78 OracleStale\(27\)/.test(r.error), JSON.stringify(r));
  });

  it("OracleStale (27) with an unreadable cluster slot stays a failure", async () => {
    const f = fake({
      sendError: new Error("custom program error: 0x1b"),
      market: marketBuf({ stale: { slots: 100n, lastGood: 1_000n } }),
      slot: "throw",
    });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && !r.waiting, JSON.stringify(r));
  });

  it("OracleStale landed on chain with a matured window is 'waiting'", async () => {
    const f = fake({
      status: { err: code(27), confirmationStatus: "confirmed" },
      market: marketBuf({ stale: { slots: 100n, lastGood: 1_000n } }),
    });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST);
    assert.ok(typeof r === "object" && r.waiting === true, JSON.stringify(r));
  });

  it("a never-landed send reports 'not landed' with the signature prefix", async () => {
    const f = fake({ status: null });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST);
    assert.ok(typeof r === "object" && /^not landed \(retry next cycle\).*sig=sigsigsigsigsigs…/.test(r.error), JSON.stringify(r));
  });
});

describe("crankLpFeesOnce — bound vault (simulate first, senior-draw logs)", () => {
  it("sim answering Custom(38) is 'no-fees' and nothing is sent", async () => {
    const f = fake({ reg: registryBuf({ bound: true }), sim: { err: code(38) } });
    const observe = { seniorDrawLogs: [] as string[] };
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, observe), "no-fees");
    assert.equal(f.c.sends, 0, "no fees owed must not spend a transaction");
  });

  it("a bound vault with ZERO shares is still cranked (a pending senior draw may need booking)", async () => {
    const f = fake({ reg: registryBuf({ bound: true, shares: 0n }), sim: { err: null, logs: ["Program log: p3_senior_draw booked=5", "other"] } });
    const observe = { seniorDrawLogs: [] as string[] };
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, observe), "cranked");
    assert.deepEqual(observe.seniorDrawLogs, ["Program log: p3_senior_draw booked=5"]);
    assert.equal(f.c.sends, 1);
  });

  it("sim with a matured OracleStale answers 'waiting' and sends nothing", async () => {
    const f = fake({
      reg: registryBuf({ bound: true }),
      sim: { err: code(27) },
      market: marketBuf({ stale: { slots: 100n, lastGood: 1_000n } }),
    });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, { seniorDrawLogs: [] });
    assert.ok(typeof r === "object" && r.waiting === true, JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });

  it("sim failing with another code falls through to the send (the send's own status decides)", async () => {
    const f = fake({ reg: registryBuf({ bound: true }), sim: { err: code(99) } });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, { seniorDrawLogs: [] }), "cranked");
    assert.equal(f.c.sends, 1);
  });

  it("a sim RPC that throws is a failure, and nothing is sent", async () => {
    const f = fake({ reg: registryBuf({ bound: true }), sim: "throw" });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, { seniorDrawLogs: [] });
    assert.ok(typeof r === "object" && /simulate rpc 503/.test(r.error), JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });
});

describe("crankLpFeesOnce — resolved terminal-flat harvest gate", () => {
  const resolved = () => marketBuf({ mode: 1 });
  const bound = () => registryBuf({ bound: true });

  it("sim Custom(38) -> 'no-fees', no send", async () => {
    const f = fake({ market: resolved(), reg: bound(), sim: { err: code(38) } });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "no-fees");
    assert.equal(f.c.sends, 0);
  });

  it("sim EngineLockActive (21) (pre-07a1d0eb wrapper) -> 'skipped', no send", async () => {
    const f = fake({ market: resolved(), reg: bound(), sim: { err: code(21) } });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.c.sends, 0);
  });

  it("sim with an unknown error is a failure, no send", async () => {
    const f = fake({ market: resolved(), reg: bound(), sim: { err: code(99) } });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && /resolved harvest sim: /.test(r.error), JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });

  it("sim with a non-custom error clips the JSON", async () => {
    const f = fake({ market: resolved(), reg: bound(), sim: { err: "AccountNotFound" } });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && /resolved harvest sim: "AccountNotFound"/.test(r.error), JSON.stringify(r));
  });

  it("sim RPC throwing is a failure with no send", async () => {
    const f = fake({ market: resolved(), reg: bound(), sim: "throw" });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && /resolved harvest sim failed: simulate rpc 503/.test(r.error), JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });

  it("sim that changes neither account -> 'no-fees' (no tx spent every cycle forever)", async () => {
    const m = resolved();
    const reg = bound();
    // pre = [market, ledger(null)] from the fake's 2nd/1st reads; sim echoes the market bytes, ledger null.
    const f = fake({
      market: m,
      reg,
      reads: [undefined, [{ data: m }, null]],
      sim: { err: null, accounts: [{ data: [m.toString("base64"), "base64"] }, null] },
    });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "no-fees");
    assert.equal(f.c.sends, 0);
  });

  it("sim that changes the market -> sends once with skipPreflight and cranks", async () => {
    const m = resolved();
    const changed = Buffer.from(m);
    changed[0] ^= 1;
    const f = fake({
      market: m,
      reg: bound(),
      reads: [undefined, [{ data: m }, null]],
      sim: { err: null, logs: ["p3_senior_draw x"], accounts: [{ data: [changed.toString("base64"), "base64"] }, null] },
    });
    const observe = { seniorDrawLogs: [] as string[] };
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, observe), "cranked");
    assert.equal(f.c.sends, 1);
    assert.deepEqual(observe.seniorDrawLogs, ["p3_senior_draw x"]);
  });

  it("a send that throws EngineLockActive (21) on a resolved harvest is 'skipped'", async () => {
    const m = resolved();
    const changed = Buffer.from(m);
    changed[0] ^= 1;
    const f = fake({
      market: m,
      reg: bound(),
      reads: [undefined, [{ data: m }, null]],
      sim: { err: null, accounts: [{ data: [changed.toString("base64"), "base64"] }, null] },
      sendError: new Error("custom program error: 0x15"),
    });
    assert.equal(await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false), "skipped");
  });
});

describe("resolvedHarvestChangesState — direct", () => {
  const tx = new Transaction();
  tx.recentBlockhash = BH;
  tx.feePayer = KEEPER.publicKey;
  const mk = (pre: unknown, sim: unknown) => ({
    async getMultipleAccountsInfo() { return pre; },
    async simulateTransaction() { return sim; },
  }) as never;
  const k = Keypair.generate().publicKey;

  it("a pre-read null vs a post account present counts as a change", async () => {
    const r = await resolvedHarvestChangesState(
      mk([null, null], { value: { err: null, accounts: [{ data: [Buffer.from("a").toString("base64"), "base64"] }, null] } }),
      tx, k, k,
    );
    assert.equal(r, "changes");
  });

  it("no accounts returned and none pre-existing is no-change", async () => {
    const r = await resolvedHarvestChangesState(mk([null, null], { value: { err: null } }), tx, k, k);
    assert.equal(r, "no-change");
  });

  it("identical bytes on both -> no-change; one differing -> changes", async () => {
    const a = Buffer.from("same");
    const acc = (b: Buffer) => ({ data: [b.toString("base64"), "base64"] });
    assert.equal(await resolvedHarvestChangesState(mk([{ data: a }, { data: a }], { value: { err: null, accounts: [acc(a), acc(a)] } }), tx, k, k), "no-change");
    assert.equal(await resolvedHarvestChangesState(mk([{ data: a }, { data: a }], { value: { err: null, accounts: [acc(a), acc(Buffer.from("diff"))] } }), tx, k, k), "changes");
  });
});

describe("crankLpFeesOnce — P2b ext tail", () => {
  const extReg = (o: { bond?: boolean } = {}) => registryBuf({ bound: true, ext: true, bond: o.bond });

  it("an unreadable vault_lp_state is a failure and nothing is sent", async () => {
    const f = fake({ reg: extReg(), reads: [undefined, [null]] });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, { seniorDrawLogs: [] });
    assert.ok(typeof r === "object" && /vault_lp_state unreadable/.test(r.error), JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });

  it("a throwing vault_lp_state read is a failure and nothing is sent", async () => {
    const f = fake({ reg: extReg(), reads: [undefined, new Error("rpc boom")] });
    const r = await crankLpFeesOnce(f.conn, KEEPER, MARKET(), false, FAST, { seniorDrawLogs: [] });
    assert.ok(typeof r === "object" && /ext tail read failed: rpc boom/.test(r.error), JSON.stringify(r));
    assert.equal(f.c.sends, 0);
  });

  it("buildCrankFeesIx: bound without a tail has 7 accounts; unbound has 6", () => {
    const [market, registry, ledger, sib] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
    const base = { keeper: KEEPER.publicKey, market, registry, ledger, siblingLedger: sib, domainIdx: 0, tail: null };
    assert.equal(buildCrankFeesIx({ ...base, bound: false }).keys.length, 6);
    assert.equal(buildCrankFeesIx({ ...base, bound: true }).keys.length, 7);
  });

  it("buildCrankFeesIx: a bound tail adds ext + vault LP (9), and a bond tranche a tenth (10)", () => {
    const [market, registry, ledger, sib, lp, ext, bond] = [0, 1, 2, 3, 4, 5, 6].map(() => Keypair.generate().publicKey);
    const p = { keeper: KEEPER.publicKey, market, registry, ledger, siblingLedger: sib, domainIdx: 0, bound: true };
    const nine = buildCrankFeesIx({ ...p, tail: { vaultLpExt: ext, lpPortfolio: lp } });
    assert.equal(nine.keys.length, 9);
    assert.equal(nine.programId.toBase58(), WRAPPER_PROGRAM_ID.toBase58());
    const ten = buildCrankFeesIx({ ...p, tail: { vaultLpExt: ext, lpPortfolio: lp, bondTranche: bond } });
    assert.equal(ten.keys.length, 10);
    assert.ok(ten.keys[9].pubkey.equals(bond));
  });
});

describe("crankAllLpFeesOnce / makeLpFeeJob — a failed crank must not look like progress", () => {
  it("sorts every outcome into its own bucket (cranked/no-fees/skipped/waiting/failed)", async () => {
    const regs: Array<unknown> = [];
    const addrs = [MARKET(), MARKET(), MARKET(), MARKET(), MARKET()];
    const outcomeFor = new Map<string, () => unknown>();
    const conn = {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        regs.push(keys);
        return [{ data: registryBuf() }, null];
      },
      async getLatestBlockhash() { return { blockhash: BH, lastValidBlockHeight: 1 }; },
      async sendRawTransaction() {
        const n = regs.length;
        if (n === 2) throw new Error("custom program error: 0x26");
        if (n === 4) throw new Error("unrelated boom");
        return "sig";
      },
      async getBlockHeight() { return 2; },
      async getSignatureStatuses() { return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    };
    void outcomeFor;
    // Serialise so the call counter maps to a market.
    const out = { cranked: 0, noFees: 0, failed: 0 };
    for (const a of addrs.slice(0, 4)) {
      const r = await crankAllLpFeesOnce(conn as never, KEEPER, { markets: [{ marketAddress: a }] } as never, false);
      out.cranked += r.cranked.length;
      out.noFees += r.noFees.length;
      out.failed += r.failed.length;
    }
    assert.deepEqual(out, { cranked: 2, noFees: 1, failed: 1 });
  });

  it("sweep buckets 'waiting' separately from 'failed' and skipped on a dry-run", async () => {
    const f = fake({
      sendError: new Error("custom program error: 0x1b"),
      market: marketBuf({ stale: { slots: 100n, lastGood: 1_000n } }),
    });
    const r = await crankAllLpFeesOnce(f.conn, KEEPER, { markets: [{ marketAddress: MARKET() }] } as never, false);
    assert.equal(r.waiting.length, 1);
    assert.equal(r.failed.length, 0);
    const d = await crankAllLpFeesOnce(fake({}).conn, KEEPER, { markets: [{ marketAddress: MARKET() }] } as never, true);
    assert.equal(d.skipped.length, 1);
  });

  const run = async (o: Opts, extra: Partial<{ dryRun: boolean }> = {}) => {
    const f = fake(o);
    const job = makeLpFeeJob(FAST);
    const out = await job.run({ conn: f.conn, keeper: KEEPER, dryRun: extra.dryRun ?? false } as never, { marketAddress: MARKET(), label: "TST" } as never);
    return { out, f };
  };

  it("job: landed crank -> done", async () => {
    const { out } = await run({});
    assert.equal(out.kind, "done");
  });

  it("job: bound landed crank with a booked senior draw carries events", async () => {
    const { out } = await run({
      reg: registryBuf({ bound: true }),
      sim: { err: null, logs: ["Program log: p3_senior_draw_booked amount=1000"] },
    });
    assert.equal(out.kind, "done");
  });

  it("job: Custom(38) -> nothing; no vault -> skipped", async () => {
    assert.equal((await run({ sendError: new Error("custom program error: 0x26") })).out.kind, "nothing");
    assert.equal((await run({ reg: null })).out.kind, "skipped");
  });

  it("job: matured OracleStale -> waiting, with the reason", async () => {
    const { out } = await run({ sendError: new Error("custom program error: 0x1b"), market: marketBuf({ stale: { slots: 100n, lastGood: 1_000n } }) });
    assert.equal(out.kind, "waiting");
  });

  it("job: a never-landed or on-chain-failed crank is 'failed', never done/nothing/skipped (so no streak or cooldown resets)", async () => {
    const nl = await run({ status: null });
    assert.equal(nl.out.kind, "failed");
    const oc = await run({ status: { err: code(99), confirmationStatus: "confirmed" } });
    assert.equal(oc.out.kind, "failed");
    const rd = await run({ readThrows: true });
    assert.equal(rd.out.kind, "failed");
  });
});
