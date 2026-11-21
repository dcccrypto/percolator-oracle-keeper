/**
 * Unit coverage for the exported helpers of recovery-cranker.ts that the wire-format and
 * refresh tests do not reach: LP-portfolio discovery, the batched market read, layout verdicts,
 * plan pruning, overflow refreshes, landing waits and the crank-health adapters.
 * Every RPC dependency is a hand-built fake; no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ENGINE_NON_PROGRESS,
  MAX_REFRESH_PRUNES,
  MAX_REFRESH_PRUNE_BUDGET,
  crankSample,
  endedLossStale,
  fetchMarketPortfolios,
  findLpPortfolio,
  freshCrankMarketState,
  isBenignNoProgress,
  isDuplicateOfLandedTx,
  layoutHealthFor,
  observeMarket,
  readMarketsForCycle,
  refreshOverflow,
  refreshPruneBudget,
  reportCrankHealth,
  resolveCrankPlan,
  revertAdvice,
  v22AdlState,
  v22CrankSample,
  v22OwnedLayoutHealth,
  waitLanded,
} from "./recovery-cranker.ts";
import type { SimOutcome } from "./recovery-cranker.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { thresholdsFromEnv } from "./alerting.ts";
import { setCrankRefreshHealth } from "./refresh-coordination.ts";
import type { CrankPlan, PlannedCrank, PositionedPortfolio } from "./positioned-refresh.ts";
import { MARKET_LAYOUTS } from "./market-layout.ts";
import type { LayoutDetection } from "./market-layout.ts";

const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(new URL(`./__fixtures__/${name}.b64`, import.meta.url), "utf8").trim(), "base64");

const silence = <T>(fn: () => T): T => {
  const w = console.warn, e = console.error, l = console.log;
  console.warn = console.error = console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.error = e; console.log = l; }
};
const silenceAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn, e = console.error, l = console.log;
  console.warn = console.error = console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; }
};

const LP_DATA = fixture("sol-lp-portfolio-v18");
const TRADER_DATA = fixture("sol-trader-portfolio-v18");
const MARKET_OF_LP = new PublicKey(LP_DATA.subarray(16, 48));

describe("revertAdvice", () => {
  it("compute exhaustion wins over any code", () => {
    assert.match(revertAdvice(19, true), /ran out of compute/);
  });
  it("19 and lock-family codes mean staleness drift", () => {
    assert.match(revertAdvice(19, false), /deep-stale/);
    assert.match(revertAdvice(21, false), /deep-stale/);
  });
  it("anything else is unclassified", () => {
    assert.match(revertAdvice(null, false), /Unclassified/);
    assert.match(revertAdvice(7, false), /Unclassified/);
  });
});

describe("freshCrankMarketState", () => {
  it("starts clean", () => {
    const s = freshCrankMarketState();
    assert.equal(s.lpPortfolio, null);
    assert.equal(s.totalCranks, 0);
    assert.equal(s.terminal, false);
    assert.equal(s.obs, null);
  });
});

describe("fetchMarketPortfolios", () => {
  it("filters on length, magic and market, against the wrapper program", async () => {
    let seen: { program: PublicKey; cfg: any } | null = null;
    const conn = {
      getProgramAccounts: async (program: PublicKey, cfg: unknown) => {
        seen = { program, cfg };
        return [];
      },
    };
    const market = Keypair.generate().publicKey;
    await fetchMarketPortfolios(conn as never, market, 1234);
    assert.ok(seen);
    const s = seen as { program: PublicKey; cfg: any };
    assert.ok(s.program.equals(WRAPPER_PROGRAM_ID));
    assert.deepEqual(s.cfg.filters[0], { dataSize: 1234 });
    assert.equal(s.cfg.filters[2].memcmp.offset, 16);
    assert.equal(s.cfg.filters[2].memcmp.bytes, market.toBase58());
  });
});

describe("findLpPortfolio", () => {
  const pfPk = Keypair.generate().publicKey;
  const vaultLpData = (lp: PublicKey): Buffer => {
    const d = Buffer.alloc(16 + 256);
    d[10] = 9; // kind vault-lp state
    d[16 + 214] = 1; // state version
    lp.toBuffer().copy(d, 16 + 64);
    return d;
  };

  it("takes the vault_lp state's portfolio when it is a matcher-enabled portfolio of this market", async () => {
    const vls = deriveVaultLpState(WRAPPER_PROGRAM_ID, MARKET_OF_LP);
    const conn = {
      getAccountInfo: async (pk: PublicKey) =>
        pk.equals(vls)
          ? { owner: WRAPPER_PROGRAM_ID, data: vaultLpData(pfPk) }
          : { owner: WRAPPER_PROGRAM_ID, data: LP_DATA },
      getProgramAccounts: async () => assert.fail("must not scan"),
    };
    const got = await findLpPortfolio(conn as never, MARKET_OF_LP);
    assert.ok(got?.equals(pfPk));
  });

  it("falls back to the scan when the named portfolio belongs to another market", async () => {
    const other = Keypair.generate().publicKey;
    const vls = deriveVaultLpState(WRAPPER_PROGRAM_ID, other);
    const scanned = Keypair.generate().publicKey;
    const conn = {
      getAccountInfo: async (pk: PublicKey) =>
        pk.equals(vls)
          ? { owner: WRAPPER_PROGRAM_ID, data: vaultLpData(pfPk) }
          : { owner: WRAPPER_PROGRAM_ID, data: LP_DATA }, // LP of MARKET_OF_LP, not `other`
      getProgramAccounts: async () => [{ pubkey: scanned, account: { data: LP_DATA } }],
    };
    const got = await silenceAsync(() => findLpPortfolio(conn as never, other));
    assert.ok(got?.equals(scanned));
  });

  it("falls back to the scan when the vault_lp state is missing or foreign-owned", async () => {
    const scanned = Keypair.generate().publicKey;
    const conn = {
      getAccountInfo: async () => ({ owner: Keypair.generate().publicKey, data: Buffer.alloc(10) }),
      getProgramAccounts: async () => [
        { pubkey: Keypair.generate().publicKey, account: { data: TRADER_DATA } },
        { pubkey: scanned, account: { data: LP_DATA } },
      ],
    };
    const got = await findLpPortfolio(conn as never, MARKET_OF_LP);
    assert.ok(got?.equals(scanned));
  });

  it("swallows an RPC error on the state read and scans; null when nothing matcher-enabled exists", async () => {
    let scans = 0;
    const conn = {
      getAccountInfo: async () => { throw new Error("rpc down"); },
      getProgramAccounts: async () => {
        scans++;
        return [{ pubkey: Keypair.generate().publicKey, account: { data: TRADER_DATA } }];
      },
    };
    assert.equal(await findLpPortfolio(conn as never, MARKET_OF_LP), null);
    assert.ok(scans >= 1);
  });

  it("propagates a scan failure (the caller counts it as a discovery error)", async () => {
    const conn = {
      getAccountInfo: async () => null,
      getProgramAccounts: async () => { throw new Error("gpa failed"); },
    };
    await assert.rejects(findLpPortfolio(conn as never, MARKET_OF_LP), /gpa failed/);
  });
});

describe("readMarketsForCycle", () => {
  const mk = () => Keypair.generate().publicKey.toBase58();

  it("maps every returned account with the read slot, skips nulls and terminal markets", async () => {
    const [a, b, c] = [mk(), mk(), mk()];
    const states = new Map([[c, { ...freshCrankMarketState(), terminal: true }]]);
    let asked = 0;
    const conn = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[], cfg: any) => {
        asked = keys.length;
        assert.equal(cfg.commitment, "processed");
        return { context: { slot: 77 }, value: [{ data: Buffer.alloc(1) }, null] };
      },
    };
    const out = await readMarketsForCycle(conn as never, [{ marketAddress: a }, { marketAddress: b }, { marketAddress: c }], states);
    assert.equal(asked, 2, "terminal market is not read");
    assert.deepEqual([...out.keys()], [a]);
    assert.equal(out.get(a)?.context.slot, 77);
  });

  it("chunks at 100 keys and drops a chunk whose reply length mismatches or throws", async () => {
    const markets = Array.from({ length: 205 }, () => ({ marketAddress: mk() }));
    let call = 0;
    const conn = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        call++;
        if (call === 1) return { context: { slot: 1 }, value: keys.map(() => ({ data: Buffer.alloc(1) })) };
        if (call === 2) return { context: { slot: 1 }, value: [] }; // wrong length
        throw new Error("boom");
      },
    };
    const out = await readMarketsForCycle(conn as never, markets, new Map());
    assert.equal(call, 3);
    assert.equal(out.size, 100);
  });
});

function detectionFor(id: string, slots = 1): LayoutDetection {
  const layout = MARKET_LAYOUTS.find((l) => l.id === id);
  assert.ok(layout, `layout ${id} exists`);
  return { known: true, layout, slots };
}

describe("layoutHealthFor / v22OwnedLayoutHealth", () => {
  const unknown: LayoutDetection = { known: false, accountLen: 5, slots: null, version: null, reason: "too short" };

  it("unknown account: kind unknown, hasPositions null", () => {
    const h = layoutHealthFor(unknown, { storedPosLong: 1n, storedPosShort: 0n });
    assert.equal(h.kind, "unknown");
    assert.equal(h.id, "unknown");
    assert.equal(h.hasPositions, null);
    assert.equal(h.accountLen, 5);
  });

  it("variant-B market on the legacy path is unsupported", () => {
    const b = MARKET_LAYOUTS.find((l) => l.id === "v2.2-b");
    assert.ok(b, "variant-B row exists");
    const h = layoutHealthFor({ known: true, layout: b, slots: 1 }, { storedPosLong: 0n, storedPosShort: 0n });
    assert.equal(h.kind, "unsupported");
    assert.match(h.problem ?? "", /KEEPER_V22/);
    assert.equal(h.hasPositions, false);
  });

  it("known layout whose portfolio length the SDK cannot parse is unsupported", () => {
    const h = layoutHealthFor(detectionFor("v2.1-legacy"), null, 1);
    assert.equal(h.kind, "unsupported");
    assert.match(h.problem ?? "", /only reads 1-byte portfolios/);
    assert.equal(h.hasPositions, null);
  });

  it("known layout with a matching SDK length is ok; positions reflect the pre-read", () => {
    const d = detectionFor("v2.1-legacy");
    if (!d.known) throw new Error("unreachable");
    const h = layoutHealthFor(d, { storedPosLong: 0n, storedPosShort: 3n }, d.layout.portfolioAccountLen);
    assert.equal(h.kind, "ok");
    assert.equal(h.problem, null);
    assert.equal(h.hasPositions, true);
  });

  it("v22OwnedLayoutHealth: ok for a known layout, delegates for unknown", () => {
    const d = detectionFor("v2.2-drift");
    const ok = v22OwnedLayoutHealth(d, { storedPosLong: 1n, storedPosShort: 0n });
    assert.equal(ok.kind, "ok");
    assert.equal(ok.hasPositions, true);
    assert.equal(v22OwnedLayoutHealth(d, null).hasPositions, null);
    assert.equal(v22OwnedLayoutHealth({ known: false, accountLen: 1, slots: null, version: null, reason: "x" }, null).kind, "unknown");
  });

});

describe("refreshPruneBudget", () => {
  it("scales with targets, floored at MAX_REFRESH_PRUNES, capped unless uncapped", () => {
    assert.equal(refreshPruneBudget(1, { uncapped: false }), MAX_REFRESH_PRUNES);
    assert.equal(refreshPruneBudget(10, { uncapped: false }), 10);
    assert.equal(refreshPruneBudget(50, { uncapped: false }), MAX_REFRESH_PRUNE_BUDGET);
    assert.equal(refreshPruneBudget(50, { uncapped: true }), 50);
  });
  it("defaults the cap from the P2b feature flag without throwing", () => {
    assert.ok(refreshPruneBudget(2) >= MAX_REFRESH_PRUNES);
  });
});

describe("small predicates", () => {
  it("isDuplicateOfLandedTx", () => {
    assert.equal(isDuplicateOfLandedTx("AlreadyProcessed"), true);
    assert.equal(isDuplicateOfLandedTx({ AlreadyProcessed: null }), true);
    assert.equal(isDuplicateOfLandedTx({ InstructionError: [0, "x"] }), false);
    assert.equal(isDuplicateOfLandedTx(null), false);
    assert.equal(isDuplicateOfLandedTx("other"), false);
  });

  it("endedLossStale prefers the post-state, else the pre-crank counts", () => {
    assert.equal(endedLossStale({ staleLong: 5, staleShort: 5 }, { staleLong: 0n, staleShort: 0n }), false);
    assert.equal(endedLossStale({ staleLong: 0, staleShort: 0 }, { staleLong: 0n, staleShort: 1n }), true);
    assert.equal(endedLossStale({ staleLong: 0, staleShort: 2 }, null), true);
    assert.equal(endedLossStale({ staleLong: null, staleShort: null }, null), false);
  });

  const ix = new TransactionInstruction({ programId: WRAPPER_PROGRAM_ID, keys: [], data: Buffer.alloc(0) });
  const planOf = (kinds: PlannedCrank["kind"][]): Pick<CrankPlan, "cranks"> => ({
    cranks: kinds.map((kind) => ({ kind, portfolio: Keypair.generate().publicKey, ix })),
  });
  const err = (index: number, custom: number) => ({ InstructionError: [index, { Custom: custom }] });

  it("isBenignNoProgress: only Custom(22) on an accrue/catchup with a current clock", () => {
    const plan = planOf(["accrue", "refresh"]);
    const pre = { currentSlot: 100n };
    assert.equal(isBenignNoProgress(err(1, ENGINE_NON_PROGRESS), plan, pre, 101n), true);
    assert.equal(isBenignNoProgress(err(1, ENGINE_NON_PROGRESS), plan, pre, 200n), false, "clock behind");
    assert.equal(isBenignNoProgress(err(1, 21), plan, pre, 101n), false, "other code");
    assert.equal(isBenignNoProgress(err(2, ENGINE_NON_PROGRESS), plan, pre, 101n), false, "a refresh");
    assert.equal(isBenignNoProgress(err(5, ENGINE_NON_PROGRESS), plan, pre, 101n), false, "no such crank");
    assert.equal(isBenignNoProgress(err(0, ENGINE_NON_PROGRESS), plan, pre, 101n), false, "compute-budget ix");
    assert.equal(isBenignNoProgress(err(1, ENGINE_NON_PROGRESS), plan, null, 101n), false, "no pre-read");
    assert.equal(isBenignNoProgress("nope", plan, pre, 101n), false);
  });
});

describe("waitLanded", () => {
  it("landed / failed on the first definitive status", async () => {
    assert.equal(await waitLanded({ getSignatureStatuses: async () => ({ value: [{ err: null }] }) } as never, "s"), "landed");
    assert.equal(await waitLanded({ getSignatureStatuses: async () => ({ value: [{ err: { x: 1 } }] }) } as never, "s"), "failed");
  });
  it("keeps polling through nulls and RPC errors, then lands", async () => {
    let n = 0;
    const conn = {
      getSignatureStatuses: async () => {
        n++;
        if (n === 1) return { value: [null] };
        if (n === 2) throw new Error("blip");
        return { value: [{ err: null }] };
      },
    };
    assert.equal(await waitLanded(conn as never, "s", 1000, 1), "landed");
    assert.equal(n, 3);
  });
  it("times out when the signature never shows", async () => {
    assert.equal(await waitLanded({ getSignatureStatuses: async () => ({ value: [null] }) } as never, "s", 5, 1), "timeout");
  });
});

// ── plan resolution ──────────────────────────────────────────────────────────

const ix0 = new TransactionInstruction({ programId: WRAPPER_PROGRAM_ID, keys: [], data: Buffer.alloc(0) });
const pf = (): PositionedPortfolio => ({ pubkey: Keypair.generate().publicKey, longLegs: 1, shortLegs: 0, isLp: false });
const crank = (kind: PlannedCrank["kind"], portfolio: PublicKey): PlannedCrank => ({ kind, portfolio, ix: ix0 });
const okSim: SimOutcome = { err: null, logs: [], marketData: null };
const custom = (index: number, code: number): SimOutcome => ({ err: { InstructionError: [index, { Custom: code }] }, logs: [], marketData: null });

describe("resolveCrankPlan", () => {
  const market = Keypair.generate().publicKey;
  // plan: [accrue(market), refresh(t)...]; simulation index i maps to cranks[i-1]
  const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan => ({
    cranks: [crank("accrue", market), ...t.map((p) => crank("refresh", p.pubkey))],
    overflow: [],
    computeUnits: 300_000,
  });

  it("returns the first clean simulation untouched", async () => {
    const t = [pf()];
    const r = await resolveCrankPlan(build, t, async () => okSim);
    assert.equal(r.pruned.length, 0);
    assert.equal(r.plan.cranks.length, 2);
  });

  it("prunes a rejected refresh and re-simulates without it", async () => {
    const t = [pf(), pf()];
    const sims: number[] = [];
    const r = await resolveCrankPlan(build, t, async (plan) => {
      sims.push(plan.cranks.length);
      return plan.cranks.some((c) => c.portfolio.equals(t[0].pubkey)) ? custom(2, 22) : okSim;
    });
    assert.deepEqual(sims, [3, 2]);
    assert.equal(r.pruned.length, 1);
    assert.ok(r.pruned[0].pubkey.equals(t[0].pubkey));
    assert.equal(r.pruned[0].code, 22);
  });

  it("after maxPrunes drops every remaining refresh (degrades to accrual-only)", async () => {
    const t = [pf(), pf(), pf(), pf()];
    const r = await resolveCrankPlan(
      build,
      t,
      async (plan) => (plan.cranks.length > 1 ? custom(2, 22) : okSim),
      undefined,
      1,
    );
    assert.equal(r.plan.cranks.length, 1);
    assert.equal(r.pruned.length, 4);
    assert.equal(r.pruned.filter((p) => p.code === null).length, 3);
  });

  it("returns a failed accrual as-is (revert path), and an unparseable error too", async () => {
    const t = [pf()];
    const a = await resolveCrankPlan(build, t, async () => custom(1, 19));
    assert.ok(a.sim.err);
    assert.equal(a.pruned.length, 0);
    const b = await resolveCrankPlan(build, t, async () => ({ err: "weird", logs: null, marketData: null }));
    assert.equal(b.sim.err, "weird");
  });

  it("retries the same plan once at the transaction max on compute exhaustion", async () => {
    const cus: number[] = [];
    const r = await resolveCrankPlan(build, [pf()], async (plan) => {
      cus.push(plan.computeUnits);
      return plan.computeUnits < 1_400_000
        ? { err: { InstructionError: [1, "ProgramFailedToComplete"] }, logs: ["Program consumed: exceeded CUs meter at BPF instruction"], marketData: null }
        : okSim;
    });
    assert.equal(cus.length, 2);
    assert.equal(r.plan.computeUnits, cus[1]);
    assert.ok(cus[1] > cus[0]);
    assert.equal(r.pruned.length, 0);
  });

  it("drops a rejected repair/liquidate via the callback and records a repair as pruned", async () => {
    const t = [pf()];
    const repairKey = Keypair.generate().publicKey;
    const liqKey = Keypair.generate().publicKey;
    let withRepair = true;
    let withLiq = true;
    const b = (tt: ReadonlyArray<PositionedPortfolio>): CrankPlan => ({
      cranks: [
        ...(withRepair ? [{ ...crank("repair", repairKey), repair: { kind: "expire" } as never }] : []),
        ...(withLiq ? [crank("liquidate", liqKey)] : []),
        ...tt.map((p) => crank("refresh", p.pubkey)),
      ],
      overflow: [],
      computeUnits: 300_000,
    });
    const dropped: string[] = [];
    const r = await resolveCrankPlan(
      b,
      t,
      async (plan) => {
        const i = plan.cranks.findIndex((c) => c.kind === "repair" || c.kind === "liquidate");
        return i >= 0 ? custom(i + 1, 5) : okSim;
      },
      (c) => {
        dropped.push(c.kind);
        if (c.kind === "repair") withRepair = false;
        else withLiq = false;
      },
    );
    assert.deepEqual(dropped, ["repair", "liquidate"]);
    assert.equal(r.pruned.length, 1);
    assert.ok(r.pruned[0].repair);
    assert.equal(r.plan.cranks.length, 1);
  });

  it("without a callback a rejected repair is returned as the failure", async () => {
    const b = (): CrankPlan => ({ cranks: [{ ...crank("repair", market), repair: {} as never }], overflow: [], computeUnits: 1 });
    const r = await resolveCrankPlan(b, [], async () => custom(1, 5));
    assert.ok(r.sim.err);
  });
});

// ── overflow refreshes ───────────────────────────────────────────────────────

describe("refreshOverflow", () => {
  const owner = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;

  it("sends one tx for a chunk, waits for it and counts the landed refreshes", async () => {
    const targets = [pf(), pf()];
    const sent: CrankPlan[] = [];
    const r = await refreshOverflow({
      owner, market, overflow: targets,
      simulate: async () => okSim,
      send: async (p) => { sent.push(p); return "SIGNATURE0123456789"; },
      waitLanded: async () => "landed",
    });
    assert.equal(r.attempted, 2);
    assert.equal(r.refreshed, 2);
    assert.equal(r.error, null);
    assert.deepEqual(r.signatures, ["SIGNATURE0123456789"]);
    assert.equal(sent.length, 1);
  });

  it("reports a simulation failure and sends nothing", async () => {
    const r = await refreshOverflow({
      owner, market, overflow: [pf()],
      simulate: async () => custom(0, 19),
      send: async () => assert.fail("must not send"),
      waitLanded: async () => assert.fail("nothing to wait on"),
    });
    assert.match(r.error ?? "", /follow-up simulation failed Custom\(19\)/);
    assert.equal(r.refreshed, 0);
  });

  it("an unparseable simulation error is reported as JSON", async () => {
    const r = await refreshOverflow({
      owner, market, overflow: [pf()],
      simulate: async () => ({ err: "BlockhashNotFound", logs: null, marketData: null }),
      send: async () => "x",
      waitLanded: async () => "landed",
    });
    assert.match(r.error ?? "", /"BlockhashNotFound"/);
  });

  it("every refresh pruned: nothing is sent, the rejections are reported", async () => {
    const targets = [pf()];
    const r = await refreshOverflow({
      owner, market, overflow: targets,
      simulate: async (plan) => (plan.cranks.length > 0 ? custom(1, 22) : okSim),
      send: async () => assert.fail("must not send"),
      waitLanded: async () => assert.fail("nothing to wait on"),
    });
    assert.equal(r.signatures.length, 0);
    assert.equal(r.pruned.length, 1);
    assert.equal(r.pruned[0].code, 22);
    assert.equal(r.error, null);
  });

  it("a send throw is returned, not thrown; txs already sent are still awaited", async () => {
    const targets = Array.from({ length: 30 }, pf); // several chunks
    let sends = 0;
    const waited: string[] = [];
    const r = await refreshOverflow({
      owner, market, overflow: targets,
      simulate: async () => okSim,
      send: async () => {
        sends++;
        if (sends === 2) throw new Error("x".repeat(300));
        return `sig-${sends}-padding-padding`;
      },
      waitLanded: async (s) => { waited.push(s); return "landed"; },
    });
    assert.match(r.error ?? "", /^follow-up send failed: x{120}$/);
    assert.equal(waited.length, 1);
    assert.equal(r.refreshed > 0, true);
  });

  it("a tx that fails or times out becomes the error (first one wins)", async () => {
    const targets = Array.from({ length: 30 }, pf);
    let i = 0;
    const r = await refreshOverflow({
      owner, market, overflow: targets,
      simulate: async () => okSim,
      send: async () => `sig-number-${++i}-abcdef`,
      waitLanded: async (s) => (s.includes("-1-") ? "failed" : "timeout"),
    });
    assert.match(r.error ?? "", /follow-up tx sig-number-1… failed/);
    assert.equal(r.refreshed, 0);
  });
});

// ── health adapters ──────────────────────────────────────────────────────────

describe("crankSample / v22CrankSample / v22AdlState", () => {
  const obs = observeMarket(new Uint8Array(8), 10n, { currentSlot: 4n, staleLong: 2n, staleShort: 0n }, [
    { kind: "expire" } as never,
    { kind: "finalize" } as never,
  ]);

  it("observeMarket: counts lapsed buckets, carries stale counts, tolerates undecodable data", () => {
    assert.equal(obs.chainSlot, 10n);
    assert.equal(obs.engineSlot, 4n);
    assert.equal(obs.lapsedBuckets, 1);
    assert.equal(obs.staleLong, 2);
    assert.equal(obs.staleShort, 0);
    assert.equal(obs.adl, null);
    const bare = observeMarket(new Uint8Array(8), 1n, null, [], { skipAdl: true });
    assert.equal(bare.engineSlot, null);
    assert.equal(bare.staleLong, null);
    assert.equal(bare.staleShort, null);
  });

  it("crankSample is null without an observation, else merges the counters", () => {
    const st = { ...freshCrankMarketState(), totalCranks: 4, totalReverts: 2, consecutiveReverts: 1, lastRevertCode: 19 };
    assert.equal(crankSample("L", "M", st), null);
    const s = crankSample("L", "M", { ...st, obs });
    assert.equal(s?.label, "L");
    assert.equal(s?.totalOk, 4);
    assert.equal(s?.lastRevertCode, 19);
    assert.equal(s?.chainSlot, 10n);
  });

  const rec = (over: Record<string, unknown> = {}) => ({
    staleLong: 1, staleShort: 2, postStaleLong: null, postStaleShort: null, positioned: 3, overflow: 0,
    overflowRefreshed: 0, overflowError: null, lossStaleCycles: 1, status: "ok" as const, updatedAt: 1_000,
    ...over,
  });

  it("v22CrankSample: null for a missing or stale record", () => {
    assert.equal(v22CrankSample("L", "M", undefined, 1_000), null);
    assert.equal(v22CrankSample("L", "M", rec(), 1_000 + 500, 100), null);
  });

  it("v22CrankSample: neutral counters, slots only when the record carries them", () => {
    const a = v22CrankSample("L", "M", rec(), 1_050);
    assert.equal(a?.engineSlot, null);
    assert.equal(a?.chainSlot, 0n);
    assert.equal(a?.totalReverts, 0);
    assert.equal(a?.staleShort, 2);
    const b = v22CrankSample("L", "M", rec({ chainSlot: 9n, engineSlot: 7n }), 1_050);
    assert.equal(b?.chainSlot, 9n);
    assert.equal(b?.engineSlot, 7n);
    const c = v22CrankSample("L", "M", rec({ chainSlot: 9n }), 1_050);
    assert.equal(c?.engineSlot, null);
    const layout = { id: "v2.2-drift", problem: null, kind: "ok", accountLen: 1, provisional: false, hasPositions: null };
    const d = v22CrankSample("L", "M", rec({ layout, sweep: { pace: "x" } }), 1_050);
    assert.equal(d?.layout?.id, "v2.2-drift");
    assert.ok(d && "sweep" in d);
  });

  it("v22AdlState parses published fractions and integers; any bad field gives null", () => {
    const good = { reduceOnly: true, aLong: "1.000000", aShort: "0.500000", oiEffLong: "100", oiEffShort: "7" };
    const s = v22AdlState(good as never);
    assert.equal(s?.reduceOnly, true);
    assert.equal(s?.oiEffLong, 100n);
    assert.equal(s?.oiEffShort, 7n);
    assert.equal(v22AdlState({ ...good, oiEffLong: "-1" } as never), null);
    assert.equal(v22AdlState({ ...good, oiEffShort: "1.5" } as never), null);
    assert.equal(v22AdlState({ ...good, aLong: "garbage" } as never), null);
    assert.equal(v22AdlState({ ...good, aShort: "" } as never), null);
    const withAdl = v22CrankSample("L", "M", rec({ adl: good }), 1_050);
    assert.equal(withAdl?.adl?.oiEffLong, 100n);
  });
});

describe("reportCrankHealth", () => {
  function sink() {
    const calls = { health: [] as unknown[], reconciled: [] as unknown[] };
    const s = {
      thresholds: thresholdsFromEnv({}) as never,
      health: (_k: string, rec: unknown) => { calls.health.push(rec); },
      reconcile: async (_k: string, active: unknown[]) => { calls.reconciled.push(active); },
    };
    return { s: s as never, calls };
  }
  const entry = (label: string) => ({ label, marketAddress: Keypair.generate().publicKey.toBase58() });

  it("skips markets without state, consumes observations, emits a health line every third cycle", async () => {
    const withObs = entry("A");
    const noState = entry("B");
    const noSample = entry("C");
    const states = new Map<string, ReturnType<typeof freshCrankMarketState>>();
    const stA = freshCrankMarketState();
    stA.obs = observeMarket(new Uint8Array(8), 10n, { currentSlot: 10n, staleLong: 0n, staleShort: 0n }, []);
    states.set(withObs.marketAddress, stA);
    const stC = freshCrankMarketState();
    stC.lastActive = [{ kind: "x" } as never];
    states.set(noSample.marketAddress, stC);
    const { s, calls } = sink();
    const registry = { markets: [withObs, noState, noSample] } as never;
    await silenceAsync(() => reportCrankHealth(registry, states, 3, s));
    assert.equal(stA.obs, null, "observation consumed");
    assert.equal(stC.lastActive, undefined, "no sample clears the previous alerts");
    assert.equal(calls.health.length, 1);
    assert.equal(calls.reconciled.length, 1);
    await silenceAsync(() => reportCrankHealth(registry, states, 4, s));
    assert.equal(calls.health.length, 1, "no health line off-cadence");
  });

  it("uses the v2.2 published record when the market has no observation of its own", async () => {
    const m = entry("V22");
    setCrankRefreshHealth(m.marketAddress, {
      staleLong: 0, staleShort: 0, postStaleLong: null, postStaleShort: null, positioned: 0, overflow: 0,
      overflowRefreshed: 0, overflowError: null, lossStaleCycles: 0, status: "ok", updatedAt: Date.now(),
    });
    const states = new Map([[m.marketAddress, freshCrankMarketState()]]);
    const { s, calls } = sink();
    await silenceAsync(() => reportCrankHealth({ markets: [m] } as never, states, 3, s));
    assert.equal((calls.health[0] as { markets: unknown[] }).markets.length, 1);
  });

  it("an evaluation that throws keeps the previously active alerts and does not throw out", async () => {
    const m = entry("BAD");
    const st = freshCrankMarketState();
    const prev = { kind: "prev" } as never;
    st.lastActive = [prev];
    st.obs = observeMarket(new Uint8Array(8), 10n, { currentSlot: 10n, staleLong: 0n, staleShort: 0n }, []);
    const { s, calls } = sink();
    (s as { thresholds: unknown }).thresholds = null; // evaluateCrankHealth reads fields off it
    const active = await silenceAsync(() => reportCrankHealth({ markets: [m] } as never, new Map([[m.marketAddress, st]]), 1, s));
    assert.deepEqual(active, [prev]);
    assert.equal(st.obs, null);
    assert.deepEqual(calls.reconciled[0], [prev]);
  });

  it("a health sink that throws does not take the report down", async () => {
    const m = entry("H");
    const st = freshCrankMarketState();
    st.obs = observeMarket(new Uint8Array(8), 10n, { currentSlot: 10n, staleLong: 0n, staleShort: 0n }, []);
    const { calls } = sink();
    const throwing = {
      thresholds: thresholdsFromEnv({}),
      health: () => { throw new Error("sink down"); },
      reconcile: async (_k: string, a: unknown[]) => { calls.reconciled.push(a); },
    };
    await silenceAsync(() => reportCrankHealth({ markets: [m] } as never, new Map([[m.marketAddress, st]]), 3, throwing as never));
    assert.equal(calls.reconciled.length, 1);
  });
});
