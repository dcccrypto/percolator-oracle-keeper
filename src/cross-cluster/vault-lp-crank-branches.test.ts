/**
 * Branch coverage for vault-lp-crank.ts beyond p3-senior-draw.test.ts: lone-LP suppression,
 * busy/in-flight, RPC-error fallbacks, simulation failure reporting, the thrown-error path,
 * default sleep/clock, and sink-failure tolerance. Mocked RPC only; no network.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { parseSeniorDrawLogs, reportSeniorDraw, VaultLpCranker } from "./vault-lp-crank.ts";
import { ExhaustedRegistry } from "./p3-exhausted-resolve.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { setLoneLpCrankSuppressor, setProtectiveTrigger } from "./v22/delegation.ts";
import type { Alert } from "./alerting.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const KEEPER = Keypair.generate();
const MKT = Keypair.generate().publicKey;
const MK = MKT.toBase58();
const VAULT_LP = Keypair.generate().publicKey;
const L = (s: string) => `Program log: ${s}`;

function vaultLpState(): Buffer {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
  MKT.toBuffer().copy(b, 16); VAULT_LP.toBuffer().copy(b, 16 + 64);
  b[16 + 214] = 1;
  return b;
}

class Sink {
  fired: Array<{ scope: string; a: Alert }> = [];
  async fire(scope: string, a: Alert) { this.fired.push({ scope, a }); return true; }
}
class ThrowSink { async fire(): Promise<boolean> { throw new Error("sink down"); } }

interface Opts {
  getInfo?: () => Promise<unknown>;
  sim?: () => Promise<unknown>;
  send?: () => Promise<string>;
  slot?: () => Promise<number>;
  blockhash?: () => Promise<unknown>;
}
function conn(o: Opts = {}) {
  const c = { lookups: 0, sims: 0, sent: 0 };
  return {
    c,
    conn: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        c.lookups++;
        if (o.getInfo) return o.getInfo();
        return keys.map(() => ({ data: vaultLpState() }));
      },
      async getSlot() { return o.slot ? o.slot() : 1; },
      async getLatestBlockhash() { return o.blockhash ? o.blockhash() : { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async simulateTransaction() { c.sims++; return o.sim ? o.sim() : { value: { err: null, logs: [] } }; },
      async sendRawTransaction() { c.sent++; return o.send ? o.send() : "sig"; },
    },
  };
}
const mk = (cn: ReturnType<typeof conn>, sink: unknown = new Sink(), extra: Record<string, unknown> = {}) =>
  new VaultLpCranker(cn.conn as never, KEEPER, sink as never, { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 60_000, sleep: async () => {}, registry: new ExhaustedRegistry(), ...extra });

afterEach(() => { setLoneLpCrankSuppressor(null); setProtectiveTrigger(null); });

describe("parseSeniorDrawLogs edge shapes", () => {
  it("v2.2 booked line with nav/stray/c_eff/harvestable first parses by field name", () => {
    const ev = parseSeniorDrawLogs([L("p3_senior_draw_booked nav=9 stray=1 c_eff=5 harvestable=2 moved=10 junior_cover=4 senior_loss=6 C=90 outstanding=6")]);
    assert.deepEqual(ev, [{ kind: "booked", moved: 10n, juniorCover: 4n, seniorLoss: 6n, seniorClaim: 90n, outstanding: 6n }]);
  });
  it("booked line missing a field is dropped, not half-parsed", () => {
    assert.deepEqual(parseSeniorDrawLogs([L("p3_senior_draw_booked moved=1 junior_cover=1 senior_loss=0 C=5")]), []);
  });
  it("undefined logs yield no events", () => {
    assert.deepEqual(parseSeniorDrawLogs(undefined), []);
  });
});

describe("onPushLanded control flow", () => {
  it("suppressed: counted, first new mark triggers a protective round, same mark does not retrigger", async () => {
    const triggered: string[] = [];
    setLoneLpCrankSuppressor((m) => m === MK);
    setProtectiveTrigger((m) => triggered.push(m));
    const cn = conn();
    const k = mk(cn);
    assert.equal(await k.onPushLanded(MK, 1n), "suppressed");
    assert.equal(await k.onPushLanded(MK, 1n), "suppressed");
    assert.equal(await k.onPushLanded(MK, 2n), "suppressed");
    assert.deepEqual(triggered, [MK, MK]);
    assert.equal(k.stats.suppressed, 3);
    assert.equal(cn.c.sims, 0);
  });

  it("busy: a second distinct move during an in-flight crank is skipped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const cn = conn({ sim: async () => { await gate; return { value: { err: null, logs: [] } }; } });
    const k = mk(cn);
    const first = k.onPushLanded(MK, 1n);
    await new Promise((r) => setImmediate(r));
    assert.equal(await k.onPushLanded(MK, 2n), "busy");
    release();
    assert.equal(await first, "cranked");
    assert.equal(k.stats.cranked, 1);
  });

  it("thrown RPC error: failed, lastMark cleared so the same mark retries", async () => {
    let fail = true;
    const cn = conn({ blockhash: async () => { if (fail) throw new Error("rpc boom"); return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; } });
    const k = mk(cn);
    assert.equal(await k.onPushLanded(MK, 5n), "failed");
    assert.equal(k.stats.failed, 1);
    fail = false;
    assert.equal(await k.onPushLanded(MK, 5n), "cranked");
  });

  it("non-Error throw is stringified", async () => {
    const cn = conn({ send: async () => { throw "plain string"; } });
    const k = mk(cn);
    assert.equal(await k.onPushLanded(MK, 5n), "failed");
  });

  it("simulation failure with senior-draw logs reports exhaustion and returns failed", async () => {
    const sink = new Sink();
    const reg = new ExhaustedRegistry();
    const cn = conn({ sim: async () => ({ value: { err: { InstructionError: [0, { Custom: 99 }] }, logs: [L("p3_senior_draw deficit=9 moved=1 unfunded=8")] } }) });
    const k = mk(cn, sink, { registry: reg });
    assert.equal(await k.onPushLanded(MK, 7n), "failed");
    assert.equal(cn.c.sent, 0);
    assert.equal(sink.fired.length, 1);
    assert.equal(sink.fired[0].a.severity, "critical");
  });

  it("simulation failure with null logs still fails cleanly", async () => {
    const cn = conn({ sim: async () => ({ value: { err: "boom", logs: null } }) });
    const k = mk(cn);
    assert.equal(await k.onPushLanded(MK, 7n), "failed");
  });

  it("Custom(22) is benign and sends nothing", async () => {
    const cn = conn({ sim: async () => ({ value: { err: { InstructionError: [1, { Custom: 22 }] }, logs: [] } }) });
    const k = mk(cn);
    assert.equal(await k.onPushLanded(MK, 7n), "benign");
    assert.equal(k.stats.benign, 1);
    assert.equal(cn.c.sent, 0);
  });

  it("landed crank with exhaustion reads the tag 39 window (null when market unreadable)", async () => {
    const sink = new Sink();
    const cn = conn({
      getInfo: async () => [{ data: vaultLpState() }],
      sim: async () => ({ value: { err: null, logs: [L("p3_senior_draw deficit=9 moved=1 unfunded=8")] } }),
    });
    // windowFor reads [market]; the stub returns vault-LP bytes, which are not a Live market -> null window.
    const k = mk(cn, sink);
    assert.equal(await k.onPushLanded(MK, 8n, "LBL"), "cranked");
    assert.equal(sink.fired.length, 1);
    assert.equal(sink.fired[0].a.severity, "critical");
  });

  it("default sleep/clock path works with settleMs 0 and explicit label default", async () => {
    const cn = conn();
    const k = new VaultLpCranker(cn.conn as never, KEEPER, new Sink(), { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 1000, settleMs: 0 });
    assert.equal(await k.onPushLanded(MK, 1n), "cranked");
  });

  it("default settle path sleeps via setTimeout when no sleep is injected", async () => {
    const cn = conn();
    const k = new VaultLpCranker(cn.conn as never, KEEPER, new Sink(), { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 1000, settleMs: 1 });
    assert.equal(await k.onPushLanded(MK, 1n), "cranked");
  });
});

describe("vaultLpFor / windowFor", () => {
  it("caches within ttl, refreshes after ttl, keeps last answer on RPC error", async () => {
    let t = 0;
    let broken = false;
    const cn = conn({ getInfo: async () => { if (broken) throw new Error("down"); return [{ data: vaultLpState() }]; } });
    const k = mk(cn, new Sink(), { lookupTtlMs: 100, now: () => t });
    const lp = await k.vaultLpFor(MKT);
    assert.ok(lp?.equals(VAULT_LP));
    await k.vaultLpFor(MKT);
    assert.equal(cn.c.lookups, 1);
    t = 500; broken = true;
    assert.ok((await k.vaultLpFor(MKT))?.equals(VAULT_LP)); // stale answer kept
    assert.equal(cn.c.lookups, 2);
  });

  it("backwards clock step: a cache stamped in the future is expired, not served (stale not-bound)", async () => {
    let t = 1_000_000;
    let bound = false;
    const cn = conn({ getInfo: async () => (bound ? [{ data: vaultLpState() }] : [null]) });
    const k = mk(cn, new Sink(), { lookupTtlMs: 60_000, now: () => t });
    assert.equal(await k.vaultLpFor(MKT), null); // recorded at t: not bound
    bound = true; // chain changed
    t -= 10 * 60_000; // clock stepped back 10 min
    assert.ok((await k.vaultLpFor(MKT))?.equals(VAULT_LP));
    assert.equal(cn.c.lookups, 2);
  });

  it("backwards clock step: an old lpPortfolio is not reused", async () => {
    let t = 1_000_000;
    let state: Buffer | null = vaultLpState();
    const cn = conn({ getInfo: async () => [state ? { data: state } : null] });
    const k = mk(cn, new Sink(), { lookupTtlMs: 60_000, now: () => t });
    assert.ok((await k.vaultLpFor(MKT))?.equals(VAULT_LP));
    state = null; // unbound on chain
    t -= 10 * 60_000;
    assert.equal(await k.vaultLpFor(MKT), null);
  });

  it("RPC error with nothing cached returns null", async () => {
    const cn = conn({ getInfo: async () => { throw new Error("down"); } });
    assert.equal(await mk(cn).vaultLpFor(MKT), null);
  });

  it("missing or undecodable state account is not bound", async () => {
    assert.equal(await mk(conn({ getInfo: async () => [null] })).vaultLpFor(MKT), null);
    assert.equal(await mk(conn({ getInfo: async () => [{ data: Buffer.alloc(8) }] })).vaultLpFor(MKT), null);
  });

  it("onPushLanded on an unbound market returns not-bound", async () => {
    const cn = conn({ getInfo: async () => [null] });
    assert.equal(await mk(cn).onPushLanded(MK, 1n), "not-bound");
  });

  it("windowFor: null on missing market account and on RPC error", async () => {
    assert.equal(await mk(conn({ getInfo: async () => [null] })).windowFor(MKT), null);
    assert.equal(await mk(conn({ getInfo: async () => { throw new Error("x"); } })).windowFor(MKT), null);
    assert.equal(await mk(conn({ slot: async () => { throw new Error("x"); } })).windowFor(MKT), null);
  });
});

describe("reportSeniorDraw", () => {
  it("sink.fire throwing never breaks the path (exhaustion and booked)", async () => {
    const ev = await reportSeniorDraw(
      new ThrowSink(), MK, "L",
      [L("p3_senior_draw deficit=9 moved=1 unfunded=8"), L("p3_senior_draw_booked moved=5 junior_cover=1 senior_loss=4 C=9 outstanding=4"), L("p3_senior_draw_restored to_seniors=3 C=9 outstanding=1")],
      { registry: new ExhaustedRegistry() },
    );
    assert.equal(ev.length, 3);
  });

  it("window undefined appends the next-fee-cycle note; a provided window flows to the registry", async () => {
    const sink = new Sink();
    await reportSeniorDraw(sink, MK, "L", [L("p3_senior_draw deficit=9 moved=1 unfunded=8")], { registry: new ExhaustedRegistry() });
    assert.match(sink.fired[0].a.message, /p3-exhausted job on the next fee cycle/);
    const sink2 = new Sink();
    await reportSeniorDraw(sink2, MK, "L", [L("p3_senior_draw deficit=9 moved=1 unfunded=8")], {
      registry: new ExhaustedRegistry(),
      window: { enabled: true, staleSlots: 100n, lastGoodSlot: 1n, slotsSinceGood: 10n, remaining: 90n, matured: false } as never,
      withholdPushes: false,
    });
    assert.doesNotMatch(sink2.fired[0].a.message, /next fee cycle/);
  });

  it("default registry and null logs: no events, no alerts", async () => {
    const sink = new Sink();
    assert.deepEqual(await reportSeniorDraw(sink, MK, "L", null), []);
    assert.equal(sink.fired.length, 0);
  });
});

void deriveVaultLpState;
