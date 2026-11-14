/**
 * stake-fee-pusher: the branches the fixture tests did not reach (env parsing, floor-flag read,
 * every decideStakeFeePush guard, every classifyStakeFeeError arm, and the failure paths of
 * pushStakeFeesOnce). Mocked connection only; no live RPC, no real clock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { SimulatedTransactionResponse } from "@solana/web3.js";
import {
  CONFIG_OFF,
  CFG_LAST_GOOD_ORACLE_SLOT,
  CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS,
} from "./market-state.ts";
import {
  STAKE_FLOOR_JUNIOR,
  STAKE_FLOOR_SENIOR,
  STAKE_MINIMUM_LIQUIDITY,
  buildStakeAccrueFeesIx,
  classifyStakeFeeError,
  decideStakeFeePush,
  makeStakeFeeJob,
  pushStakeFeesOnce,
  readStakeFloorFlags,
  stakeFeeConfigFromEnv,
} from "./stake-fee-pusher.ts";
import type { StakeFeeConfig, StakeFeeConnection } from "./stake-fee-pusher.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const CFG: StakeFeeConfig = {
  wrapperProgramId: WRAPPER,
  stakeProgramId: STAKE,
  minRealShares: 0n,
  maxDeadShareBps: 100n,
  minPushAtoms: 1n,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 },
};
const KEEPER = Keypair.generate();
const market = new PublicKey(SOL);
const pool = (o: Partial<{ poolMode: number; riskMode: number; isInitialized: boolean; slab: PublicKey; percolatorProgram: PublicKey; totalLpSupply: bigint }> = {}) => ({
  slab: market, poolMode: 0, totalLpSupply: 3_100_001_000n, isInitialized: true, percolatorProgram: WRAPPER, ...o,
});

describe("stakeFeeConfigFromEnv", () => {
  it("defaults when nothing is set (blank counts as unset)", () => {
    const c = stakeFeeConfigFromEnv({ STAKE_FEE_MIN_REAL_SHARES: "  " });
    assert.equal(c.minRealShares, 0n);
    assert.equal(c.maxDeadShareBps, 100n);
    assert.equal(c.minPushAtoms, 1n);
  });
  it("reads overrides", () => {
    const c = stakeFeeConfigFromEnv({ STAKE_FEE_MIN_REAL_SHARES: "7", STAKE_FEE_MAX_DEAD_SHARE_BPS: " 250 ", STAKE_FEE_MIN_PUSH_ATOMS: "5000" });
    assert.deepEqual([c.minRealShares, c.maxDeadShareBps, c.minPushAtoms], [7n, 250n, 5000n]);
  });
  it("rejects a non-integer and an out-of-range bps instead of guessing", () => {
    assert.throws(() => stakeFeeConfigFromEnv({ STAKE_FEE_MIN_PUSH_ATOMS: "1.5" }), /non-negative integer/);
    assert.throws(() => stakeFeeConfigFromEnv({ STAKE_FEE_MIN_PUSH_ATOMS: "-1" }), /non-negative integer/);
    assert.throws(() => stakeFeeConfigFromEnv({ STAKE_FEE_MAX_DEAD_SHARE_BPS: "0" }), /1\.\.10000/);
    assert.throws(() => stakeFeeConfigFromEnv({ STAKE_FEE_MAX_DEAD_SHARE_BPS: "10001" }), /1\.\.10000/);
    assert.equal(stakeFeeConfigFromEnv({ STAKE_FEE_MAX_DEAD_SHARE_BPS: "10000" }).maxDeadShareBps, 10_000n);
  });
});

describe("readStakeFloorFlags", () => {
  it("v1-sized data reads the reserved area at 288, v2+ at 320, and a short buffer is 0 (legacy)", () => {
    const flagIdx = 381 - 320; // STAKE_FLOOR_FLAGS_RESERVED_INDEX (v2+ absolute 381)
    const v2 = new Uint8Array(400);
    v2[320 + flagIdx] = STAKE_FLOOR_SENIOR | STAKE_FLOOR_JUNIOR;
    assert.equal(readStakeFloorFlags(v2), 3);
    const v1 = new Uint8Array(383);
    v1[288 + flagIdx] = STAKE_FLOOR_JUNIOR;
    assert.equal(readStakeFloorFlags(v1), STAKE_FLOOR_JUNIOR);
    assert.equal(readStakeFloorFlags(new Uint8Array(10)), 0);
    const edge = new Uint8Array(384); // exactly the v2+ cutoff
    edge[320 + flagIdx] = STAKE_FLOOR_SENIOR;
    assert.equal(readStakeFloorFlags(edge), STAKE_FLOOR_SENIOR);
  });
});

describe("decideStakeFeePush guards, in order", () => {
  it("owed 0 / negative / below minPushAtoms is nothing and never looks at the pool", () => {
    assert.deepEqual(decideStakeFeePush({ market, owed: 0n, pool: null }, CFG), { action: "nothing", owed: 0n });
    assert.deepEqual(decideStakeFeePush({ market, owed: -3n, pool: null }, CFG), { action: "nothing", owed: 0n });
    assert.deepEqual(decideStakeFeePush({ market, owed: 4n, pool: null }, { ...CFG, minPushAtoms: 10n }), { action: "nothing", owed: 4n });
  });
  it("no pool and an uninitialised pool are skips", () => {
    assert.deepEqual(decideStakeFeePush({ market, owed: 5n, pool: null }, CFG), { action: "skip", reason: "no stake pool for this market" });
    assert.deepEqual(decideStakeFeePush({ market, owed: 5n, pool: pool({ isInitialized: false }) }, CFG), { action: "skip", reason: "stake pool not initialized" });
  });
  it("a pool bound to another market or wrapper is blocked, the reason names the wrapper", () => {
    const other = Keypair.generate().publicKey;
    assert.deepEqual(decideStakeFeePush({ market, owed: 5n, pool: pool({ slab: other }) }, CFG), { action: "blocked", reason: "pool.slab is a different market" });
    const d = decideStakeFeePush({ market, owed: 5n, pool: pool({ percolatorProgram: other }) }, CFG);
    assert.equal(d.action, "blocked");
    assert.match((d as { reason: string }).reason, new RegExp(other.toBase58()));
  });
  it("only a FIRST_LOSS (risk mode 1) insurance pool pushes; FEE_ONLY is skipped, a pre-v5 pool (no risk mode) is left to the program", () => {
    const fee = decideStakeFeePush({ market, owed: 5n, pool: pool({ riskMode: 2 }) }, CFG);
    assert.equal(fee.action, "skip");
    assert.match((fee as { reason: string }).reason, /risk mode 2 is not FIRST_LOSS/);
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool({ riskMode: 1 }) }, CFG).action, "push");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool() }, CFG).action, "push");
    const mode = decideStakeFeePush({ market, owed: 5n, pool: pool({ poolMode: 1 }) }, CFG);
    assert.equal(mode.action, "skip");
    assert.match((mode as { reason: string }).reason, /pool mode 1/);
  });
  it("minRealShares equal to the real supply is refused (strictly more is required)", () => {
    const total = STAKE_MINIMUM_LIQUIDITY + 50n;
    const d = decideStakeFeePush({ market, owed: 5n, pool: pool({ totalLpSupply: total }) }, { ...CFG, minRealShares: 50n, maxDeadShareBps: 10_000n });
    assert.equal(d.action, "skip");
    assert.match((d as { reason: string }).reason, /no real stakers/);
    const up = decideStakeFeePush({ market, owed: 5n, pool: pool({ totalLpSupply: total + 1n }) }, { ...CFG, minRealShares: 50n, maxDeadShareBps: 10_000n });
    assert.deepEqual(up, { action: "push", owed: 5n, realShares: 51n });
  });
});

describe("classifyStakeFeeError arms", () => {
  const at = (index: number, custom: number) => ({ InstructionError: [index, { Custom: custom }] });
  it("27 at tag 87 is the stale wait only when the window is confirmed matured; otherwise a failure", () => {
    assert.deepEqual(classifyStakeFeeError(at(1, 27), null, "stale window matured"), { kind: "waiting", reason: "tag 87 stale window matured" });
    const f = classifyStakeFeeError(at(1, 27), null, null);
    assert.equal(f.kind, "failed");
  });
  it("an unknown wrapper code at tag 87 is a failure naming tag 87", () => {
    const f = classifyStakeFeeError(at(1, 9999), null);
    assert.equal(f.kind, "failed");
    assert.match((f as { error: string }).error, /^tag 87 /);
  });
  it("53 and 21 at the STAKE instruction (index 2) are not the wrapper meanings", () => {
    for (const c of [53, 21]) {
      const f = classifyStakeFeeError(at(2, c), null);
      assert.equal(f.kind, "failed");
      assert.match((f as { error: string }).error, new RegExp(`^stake AccrueFees Custom\\(${c}\\)`));
    }
  });
  it("another index is reported as 'ix N'; the last two relevant log lines are appended", () => {
    const f = classifyStakeFeeError(at(3, 5), ["Program log: noise", "Program log: Error: one", "Program log: AccrueFees failed", "Program log: failed again"]);
    assert.equal(f.kind, "failed");
    assert.match((f as { error: string }).error, /^ix 3 .* — Program log: AccrueFees failed \/ Program log: failed again$/);
  });
  it("a non-instruction error is 'tx' with the raw JSON", () => {
    const f = classifyStakeFeeError("BlockhashNotFound", null);
    assert.deepEqual(f, { kind: "failed", error: 'tx "BlockhashNotFound"' });
  });
});

describe("buildStakeAccrueFeesIx", () => {
  it("lays out caller(s), pool(w), vault, clock, slab with the trailing slab required by mode 0", () => {
    const [caller, pl, vault, slab] = [1, 2, 3, 4].map(() => Keypair.generate().publicKey);
    const ix = buildStakeAccrueFeesIx({ stakeProgramId: STAKE, caller, pool: pl, vault, slab });
    assert.equal(ix.keys.length, 5);
    assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[true, false], [false, true], [false, false], [false, false], [false, false]]);
    assert.ok(ix.keys[0].pubkey.equals(caller) && ix.keys[1].pubkey.equals(pl) && ix.keys[2].pubkey.equals(vault) && ix.keys[4].pubkey.equals(slab));
  });
});

type Mkt = { data?: Uint8Array; owner?: PublicKey } | null;
type Pl = { data?: Uint8Array; owner?: PublicKey } | null;

function conn(o: {
  market?: Mkt;
  pool?: Pl;
  readThrows?: boolean;
  simErr?: unknown;
  simThrows?: boolean;
  sendThrows?: boolean;
  status?: { err: unknown } | null;
  slot?: number | "throws" | "absent";
}) {
  const calls = { sims: 0, sends: 0, slots: 0 };
  const m: Mkt = o.market === undefined ? { data: fx("sol-market-v18-fees"), owner: WRAPPER } : o.market;
  const p: Pl = o.pool === undefined ? { data: fx("sol-stake-pool-v18"), owner: STAKE } : o.pool;
  const acct = (a: Mkt) => (a ? { data: Buffer.from(a.data ?? new Uint8Array(0)), owner: a.owner ?? WRAPPER, lamports: 1, executable: false } : null);
  const c: Record<string, unknown> = {
    async getMultipleAccountsInfo() {
      if (o.readThrows) throw new Error("rpc 429 " + "x".repeat(300));
      return [acct(m), acct(p)];
    },
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 };
    },
    async simulateTransaction(_tx: VersionedTransaction) {
      calls.sims++;
      if (o.simThrows) throw new Error("simulate boom");
      return { context: { slot: 1 }, value: { err: o.simErr ?? null, logs: null } as SimulatedTransactionResponse };
    },
    async sendRawTransaction() {
      calls.sends++;
      if (o.sendThrows) throw new Error("send boom");
      return "5igSig1111111111111111111111111111111111111111111111111111111111";
    },
    async getBlockHeight() {
      return Number.MAX_SAFE_INTEGER;
    },
    async getSignatureStatuses() {
      const s = o.status === undefined ? { err: null } : o.status;
      return { context: { slot: 3 }, value: [s ? { slot: 2, confirmations: 1, confirmationStatus: "confirmed", ...s } : null] };
    },
  };
  if (o.slot !== "absent") {
    c.getSlot = async () => {
      calls.slots++;
      if (o.slot === "throws") throw new Error("slot boom");
      return o.slot ?? 0;
    };
  }
  return { conn: c as unknown as StakeFeeConnection, calls };
}

describe("pushStakeFeesOnce failure paths", () => {
  it("an unparseable market address fails before any RPC", async () => {
    const { conn: c, calls } = conn({});
    assert.deepEqual(await pushStakeFeesOnce(c, KEEPER, "not-a-pubkey", false, CFG), { kind: "failed", error: "unparseable market address" });
    assert.equal(calls.sims + calls.sends, 0);
  });
  it("a missing market account fails; a market owned by another program is skipped, never pushed", async () => {
    assert.deepEqual(await pushStakeFeesOnce(conn({ market: null }).conn, KEEPER, SOL, false, CFG), { kind: "failed", error: "market account not found" });
    const other = Keypair.generate().publicKey;
    const { conn: c, calls } = conn({ market: { data: fx("sol-market-v18-fees"), owner: other } });
    const r = await pushStakeFeesOnce(c, KEEPER, SOL, false, CFG);
    assert.equal(r.kind, "skipped");
    assert.match((r as { reason: string }).reason, new RegExp(other.toBase58()));
    assert.equal(calls.sims + calls.sends, 0);
  });
  it("a Resolved market (mode byte set) is skipped locally: tag 87 is Live-only", async () => {
    const d = Buffer.from(fx("sol-market-v18-fees"));
    d[592 + 626] = 1;
    const { conn: c, calls } = conn({ market: { data: d, owner: WRAPPER } });
    const r = await pushStakeFeesOnce(c, KEEPER, SOL, false, CFG);
    assert.equal(r.kind, "skipped");
    assert.match((r as { reason: string }).reason, /Live-only/);
    assert.equal(calls.sims + calls.sends, 0);
  });
  it("an RPC read error and an undecodable pool are failures with clipped text, nothing sent", async () => {
    const a = await pushStakeFeesOnce(conn({ readThrows: true }).conn, KEEPER, SOL, false, CFG);
    assert.equal(a.kind, "failed");
    assert.ok((a as { error: string }).error.startsWith("account read/decode failed: rpc 429"));
    assert.ok((a as { error: string }).error.length < 160);
    const { conn: c, calls } = conn({ pool: { data: new Uint8Array(10), owner: STAKE } });
    const b = await pushStakeFeesOnce(c, KEEPER, SOL, false, CFG);
    assert.equal(b.kind, "failed");
    assert.match((b as { error: string }).error, /^account read\/decode failed/);
    assert.equal(calls.sims + calls.sends, 0);
  });
  it("a pool account owned by another program counts as no pool: skipped", async () => {
    const r = await pushStakeFeesOnce(conn({ pool: { data: fx("sol-stake-pool-v18"), owner: Keypair.generate().publicKey } }).conn, KEEPER, SOL, false, CFG);
    assert.deepEqual(r, { kind: "skipped", reason: "no stake pool for this market" });
  });
  it("a market with nothing owed above minPushAtoms is 'nothing', no simulation", async () => {
    const { conn: c, calls } = conn({});
    assert.deepEqual(await pushStakeFeesOnce(c, KEEPER, SOL, false, { ...CFG, minPushAtoms: 10n ** 18n }), { kind: "nothing" });
    assert.equal(calls.sims, 0);
  });
  it("a refused simulation is classified and never sent (53 = nothing to push)", async () => {
    const { conn: c, calls } = conn({ simErr: { InstructionError: [1, { Custom: 53 }] } });
    const r = await pushStakeFeesOnce(c, KEEPER, SOL, false, CFG);
    assert.equal(r.kind, "nothing");
    assert.equal(calls.sends, 0);
  });
  it("a simulation OracleStale on a matured stale-resolve window is 'waiting' (reads the slot), else a failure", async () => {
    const d = Buffer.from(fx("sol-market-v18-fees"));
    d.writeBigUInt64LE(100n, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
    d.writeBigUInt64LE(1_000n, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
    const err = { InstructionError: [1, { Custom: 27 }] };
    const wait = conn({ market: { data: d, owner: WRAPPER }, simErr: err, slot: 5_000 });
    const w = await pushStakeFeesOnce(wait.conn, KEEPER, SOL, false, CFG);
    assert.equal(w.kind, "waiting");
    assert.equal(wait.calls.slots, 1);
    assert.equal(wait.calls.sends, 0);
    // slot unreadable (throws) or the connection has no getSlot: stays a failure
    for (const slot of ["throws", "absent"] as const) {
      const x = conn({ market: { data: d, owner: WRAPPER }, simErr: err, slot });
      const f = await pushStakeFeesOnce(x.conn, KEEPER, SOL, false, CFG);
      assert.equal(f.kind, "failed");
      assert.equal(x.calls.slots, slot === "throws" ? 1 : 0);
    }
    // window disabled (live fixture: stale_slots 0) -> failure even with a readable slot
    const off = await pushStakeFeesOnce(conn({ simErr: err, slot: 5_000 }).conn, KEEPER, SOL, false, CFG);
    assert.equal(off.kind, "failed");
  });
  it("an OracleStale at the STAKE instruction does not read the slot at all", async () => {
    const { conn: c, calls } = conn({ simErr: { InstructionError: [2, { Custom: 27 }] }, slot: 5_000 });
    const r = await pushStakeFeesOnce(c, KEEPER, SOL, false, CFG);
    assert.equal(r.kind, "failed");
    assert.equal(calls.slots, 0);
  });
  it("a throwing simulate or send is a failure, never a throw", async () => {
    const s = await pushStakeFeesOnce(conn({ simThrows: true }).conn, KEEPER, SOL, false, CFG);
    assert.equal(s.kind, "failed");
    assert.match((s as { error: string }).error, /simulate boom/);
    const t = await pushStakeFeesOnce(conn({ sendThrows: true }).conn, KEEPER, SOL, false, CFG);
    assert.equal(t.kind, "failed");
    assert.match((t as { error: string }).error, /send boom/);
  });
  it("a send whose status never appears is 'not landed' (retried next cycle); a landed one reports '?' when the sim logs no accrual", async () => {
    const nl = conn({ status: null });
    const a = await pushStakeFeesOnce(nl.conn, KEEPER, SOL, false, CFG);
    assert.equal(a.kind, "failed");
    assert.match((a as { error: string }).error, /^not landed/);
    assert.equal(nl.calls.sends, 1);
    const ok = await pushStakeFeesOnce(conn({}).conn, KEEPER, SOL, false, CFG);
    assert.equal(ok.kind, "done");
    assert.match((ok as { detail: string }).detail, /sim accrued \?/);
  });
  it("dry-run with no accrual log says '?' and sends nothing", async () => {
    const { conn: c, calls } = conn({});
    const r = await pushStakeFeesOnce(c, KEEPER, SOL, true, CFG);
    assert.equal(r.kind, "skipped");
    assert.match((r as { reason: string }).reason, /^DRY-RUN: would push \d+ atoms \(sim accrued \?\)$/);
    assert.equal(calls.sends, 0);
  });
  it("a landed-but-failed tx is classified from the status error", async () => {
    const r = await pushStakeFeesOnce(conn({ status: { err: { InstructionError: [1, { Custom: 53 }] } } }).conn, KEEPER, SOL, false, CFG);
    assert.equal(r.kind, "nothing");
  });
});

describe("makeStakeFeeJob", () => {
  it("runs pushStakeFeesOnce with the job context (dry-run honoured)", async () => {
    const { conn: c, calls } = conn({});
    const job = makeStakeFeeJob(CFG);
    assert.equal(job.name, "stake-fee");
    const r = await job.run({ conn: c, keeper: KEEPER, dryRun: true } as never, { marketAddress: SOL, label: "SOL" } as never);
    assert.equal(r.kind, "skipped");
    assert.equal(calls.sends, 0);
    assert.equal(calls.sims, 1);
  });
});
