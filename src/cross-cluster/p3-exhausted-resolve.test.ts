/**
 * p3-exhausted-resolve.ts: the guards that stand between an exhausted P3 market and an
 * irreversible tag 39 resolve. Fakes only; the market bytes are the captured SOL v18 fixture.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ExhaustedRegistry, buildResolveStalePermissionlessIx, exhaustedAlert, getExhaustedRegistry, makeExhaustedResolveJob, resolvePathText } from "./p3-exhausted-resolve.ts";
import { CFG_LAST_GOOD_ORACLE_SLOT, CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS, CONFIG_OFF, staleResolveWindow } from "./market-state.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const SOLK = new PublicKey(SOL);
const KEEPER = Keypair.generate();
const VAULT_LP = Keypair.generate().publicKey;
const LAST_GOOD = 1_000n;

function market(o: { staleSlots?: bigint; lastGood?: bigint; mode?: number } = {}): Buffer {
  const b = Buffer.from(fx("sol-market-v18"));
  b.writeBigUInt64LE(o.staleSlots ?? 100n, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
  b.writeBigUInt64LE(o.lastGood ?? LAST_GOOD, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  if (o.mode !== undefined) b[592 + 626] = o.mode;
  return b;
}

interface Opts {
  data?: Buffer | null;
  slot?: bigint;
  logs?: string[];
  simErr?: unknown;
  sendThrows?: boolean;
  status?: { err: unknown; confirmationStatus: string } | null;
  accountThrows?: boolean;
}
function stub(o: Opts = {}) {
  const sent: Transaction[] = [];
  let sims = 0;
  return {
    sent,
    sims: () => sims,
    conn: {
      async getMultipleAccountsInfo() {
        if (o.accountThrows) throw new Error("rpc down");
        const d = o.data === undefined ? market() : o.data;
        return [d === null ? null : { data: d }];
      },
      async getSlot() { return Number(o.slot ?? LAST_GOOD + 100n); },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async simulateTransaction() { sims++; return { value: { err: o.simErr ?? null, logs: o.logs ?? [] } }; },
      async sendRawTransaction(raw: Buffer) {
        if (o.sendThrows) throw new Error("send failed");
        sent.push(Transaction.from(raw));
        return "sigsigsigsigsigsigsig";
      },
      async getBlockHeight() { return 10; },
      async getSignatureStatuses() {
        const s = o.status === undefined ? { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" } : o.status;
        return { value: [s] };
      },
    },
  };
}
const ctx = (c: ReturnType<typeof stub>, dryRun = false) => ({ conn: c.conn as never, keeper: KEEPER, dryRun });
const mk = (reg: ExhaustedRegistry, vaultLpFor?: (m: PublicKey) => Promise<PublicKey | null>) =>
  makeExhaustedResolveJob({ wrapperProgramId: WRAPPER_PROGRAM_ID, registry: reg, vaultLpFor, withholdPushes: true, confirmOpts: { statusRetries: 0, statusRetryDelayMs: 0, deadlineMs: 50 } });
const marked = () => { const r = new ExhaustedRegistry(); r.mark(SOL, 9000n, 5000n); return r; };
const M = { marketAddress: SOL, label: "SOL" };

describe("ExhaustedRegistry", () => {
  it("mark is new once, then updates in place and keeps `since`", () => {
    let t = 5;
    const r = new ExhaustedRegistry(() => t);
    assert.equal(r.mark("a", 1n, 1n), true);
    t = 9;
    assert.equal(r.mark("a", 2n, 3n), false);
    assert.deepEqual(r.get("a"), { deficit: 2n, unfunded: 3n, since: 5, windowEnabled: null });
    assert.deepEqual(r.markets(), ["a"]);
    r.setWindow("zzz", true); // unknown market: no-op
    assert.equal(r.has("zzz"), false);
    r.clear("a");
    assert.equal(r.has("a"), false);
  });
  it("shouldWithholdPush needs an explicit enabled window (unknown/disabled fail to keep pushing)", () => {
    const r = marked();
    assert.equal(r.shouldWithholdPush(SOL, true), false);
    r.setWindow(SOL, false);
    assert.equal(r.shouldWithholdPush(SOL, true), false);
    r.setWindow(SOL, true);
    assert.equal(r.shouldWithholdPush(SOL, true), true);
    assert.equal(r.shouldWithholdPush(SOL, false), false);
  });
  it("getExhaustedRegistry is a process singleton", () => {
    assert.equal(getExhaustedRegistry(), getExhaustedRegistry());
  });
});

describe("text and alert builders", () => {
  it("resolvePathText covers disabled / matured / pending", () => {
    assert.match(resolvePathText({ enabled: false, lastGoodOracleSlot: 1n }), /only the market admin/);
    assert.match(resolvePathText({ enabled: true, staleSlots: 5n, lastGoodOracleSlot: 1n, remaining: 0n, matured: true }), /possible now/);
    assert.match(resolvePathText({ enabled: true, staleSlots: 5n, lastGoodOracleSlot: 1n, remaining: 3n, matured: false }), /in 3 slots/);
  });
  it("exhaustedAlert: unknown window, withholding text, and slotsUntilTag39", () => {
    const a = exhaustedAlert(SOL, "SOL", { deficit: 9n, unfunded: 4n }, null, false);
    assert.match(a.message, /resolve window unknown/);
    assert.equal(a.data?.permissionlessResolve, null);
    assert.equal(a.data?.slotsUntilTag39, null);
    const w = { enabled: true as const, staleSlots: 5n, lastGoodOracleSlot: 1n, remaining: 3n, matured: false };
    const b = exhaustedAlert(SOL, "SOL", { deficit: 9n, unfunded: 4n }, w, true);
    assert.match(b.message, /withholding mark pushes/);
    assert.equal(b.data?.slotsUntilTag39, "3");
  });
  it("buildResolveStalePermissionlessIx: tag 39, now_slot 0, single writable market", () => {
    const ix = buildResolveStalePermissionlessIx(WRAPPER_PROGRAM_ID, SOLK);
    assert.deepEqual([...ix.data], [39, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(ix.keys.length, 1);
  });
});

describe("job guards before a resolve is sent (fail closed)", () => {
  it("unparseable market address: skipped, no RPC", async () => {
    const c = stub();
    const o = await mk(marked()).run(ctx(c), { marketAddress: "not-a-key", label: "x" });
    assert.equal(o.kind, "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("account read throws: propagates (the sweep records a failure), nothing sent, mark kept", async () => {
    const reg = marked();
    const c = stub({ accountThrows: true });
    await assert.rejects(mk(reg).run(ctx(c), M), /rpc down/);
    assert.equal(c.sent.length, 0);
    assert.ok(reg.has(SOL));
  });
  it("missing account on an unmarked market: nothing; never simulates or sends", async () => {
    const c = stub({ data: null });
    assert.equal((await mk(new ExhaustedRegistry()).run(ctx(c), M)).kind, "nothing");
    assert.equal(c.sims(), 0);
    assert.equal(c.sent.length, 0);
  });
  it("missing / undecodable / truncated data never reaches a send", async () => {
    for (const data of [null, Buffer.alloc(0), Buffer.alloc(40), market().subarray(0, 700)]) {
      const c = stub({ data });
      await mk(marked()).run(ctx(c), M);
      assert.equal(c.sent.length, 0);
    }
  });
  it("Resolved / Recovery market: mark cleared, no send", async () => {
    for (const mode of [1, 2]) {
      const reg = marked();
      const c = stub({ data: market({ mode }) });
      assert.equal((await mk(reg).run(ctx(c), M)).kind, "done");
      assert.equal(reg.has(SOL), false);
      assert.equal(c.sent.length, 0);
    }
  });
  it("unmarked market, no vaultLpFor: nothing, never sends", async () => {
    const c = stub({ slot: LAST_GOOD + 500n });
    assert.equal((await mk(new ExhaustedRegistry()).run(ctx(c), M)).kind, "nothing");
    assert.equal(c.sent.length, 0);
  });
  it("unmarked market, no bound vault LP: nothing", async () => {
    const c = stub({ slot: LAST_GOOD + 500n });
    assert.equal((await mk(new ExhaustedRegistry(), async () => null).run(ctx(c), M)).kind, "nothing");
    assert.equal(c.sims(), 0);
  });
  it("detection simulation with unfunded=0 or hex/signed/NaN numbers does not mark", async () => {
    for (const line of [
      "Program log: p3_senior_draw deficit=5 moved=5 unfunded=0",
      "Program log: p3_senior_draw deficit=5 moved=0 unfunded=0x10",
      "Program log: p3_senior_draw deficit=5 moved=0 unfunded=-7",
      "Program log: p3_senior_draw deficit=5 moved=0 unfunded=NaN",
    ]) {
      const reg = new ExhaustedRegistry();
      const c = stub({ logs: [line], slot: LAST_GOOD + 500n });
      assert.equal((await mk(reg, async () => VAULT_LP).run(ctx(c), M)).kind, "nothing", line);
      assert.equal(reg.has(SOL), false);
      assert.equal(c.sent.length, 0);
    }
  });
  it("detection reads exact decimal beyond 2^53 without precision loss", async () => {
    const reg = new ExhaustedRegistry();
    const big = "18446744073709551615";
    const c = stub({ logs: [`Program log: p3_senior_draw deficit=${big} moved=0 unfunded=${big}`], slot: LAST_GOOD + 10n });
    const o = await mk(reg, async () => VAULT_LP).run(ctx(c), M);
    assert.equal(o.kind, "blocked");
    assert.equal(reg.get(SOL)?.unfunded, 18446744073709551615n);
    assert.equal(c.sent.length, 0);
  });
  it("window disabled (stale_slots 0): blocked, nothing sent, window recorded as disabled", async () => {
    const reg = marked();
    const c = stub({ data: market({ staleSlots: 0n }), slot: LAST_GOOD + 10_000n });
    assert.equal((await mk(reg).run(ctx(c), M)).kind, "blocked");
    assert.equal(c.sent.length, 0);
    assert.equal(reg.get(SOL)?.windowEnabled, false);
  });
  it("chain slot behind last_good_oracle_slot: not matured, nothing sent", async () => {
    const c = stub({ slot: LAST_GOOD - 5n });
    const o = await mk(marked()).run(ctx(c), M);
    assert.equal(o.kind, "blocked");
    assert.equal(c.sent.length, 0);
  });
  it("one slot short of the window: blocked; exactly at the window: sends", async () => {
    const short = stub({ slot: LAST_GOOD + 99n });
    assert.equal((await mk(marked()).run(ctx(short), M)).kind, "blocked");
    assert.equal(short.sent.length, 0);
    const at = stub({ slot: LAST_GOOD + 100n });
    assert.equal((await mk(marked()).run(ctx(at), M)).kind, "done");
    assert.equal(at.sent.length, 1);
  });
  it("matured window + dry-run: blocked, no sim, no send", async () => {
    const c = stub({ slot: LAST_GOOD + 500n });
    assert.equal((await mk(marked()).run(ctx(c, true), M)).kind, "blocked");
    assert.equal(c.sims(), 0);
    assert.equal(c.sent.length, 0);
  });
  it("staleResolveWindow reads stale_slots/last_good as decimal u64 from bytes (control)", () => {
    const w = staleResolveWindow(new Uint8Array(market({ staleSlots: 7n, lastGood: 2n ** 60n })), 2n ** 60n + 7n);
    assert.ok(w && w.enabled && w.matured && w.staleSlots === 7n);
  });
});

describe("a failed send is never recorded as done", () => {
  it("simulation refuses: failed, mark kept, nothing sent", async () => {
    const reg = marked();
    const c = stub({ simErr: { InstructionError: [1, { Custom: 12 }] } });
    const o = await mk(reg).run(ctx(c), M);
    assert.equal(o.kind, "failed");
    assert.equal(c.sent.length, 0);
    assert.ok(reg.has(SOL));
  });
  it("sendRawTransaction throws: propagates, mark kept", async () => {
    const reg = marked();
    const c = stub({ sendThrows: true });
    await assert.rejects(mk(reg).run(ctx(c), M), /send failed/);
    assert.ok(reg.has(SOL));
  });
  it("landed with an on-chain error: failed, mark kept", async () => {
    const reg = marked();
    const c = stub({ status: { err: { InstructionError: [1, { Custom: 3 }] }, confirmationStatus: "confirmed" } });
    const o = await mk(reg).run(ctx(c), M);
    assert.equal(o.kind, "failed");
    assert.match((o as { error: string }).error, /failed on chain/);
    assert.ok(reg.has(SOL));
  });
  it("never confirmed: failed (not landed), mark kept", async () => {
    const reg = marked();
    const c = stub({ status: null });
    const o = await mk(reg).run(ctx(c), M);
    assert.equal(o.kind, "failed");
    assert.match((o as { error: string }).error, /not landed/);
    assert.ok(reg.has(SOL));
  });
  it("only processed (not confirmed): not done, mark kept", async () => {
    const reg = marked();
    const c = stub({ status: { err: null, confirmationStatus: "processed" } });
    assert.equal((await mk(reg).run(ctx(c), M)).kind, "failed");
    assert.ok(reg.has(SOL));
  });
  it("landed OK: done with signature and mark cleared (control)", async () => {
    const reg = marked();
    const c = stub();
    const o = await mk(reg).run(ctx(c), M);
    assert.equal(o.kind, "done");
    assert.equal((o as { signature?: string }).signature, "sigsigsigsigsigsigsig");
    assert.equal(reg.has(SOL), false);
  });
});
