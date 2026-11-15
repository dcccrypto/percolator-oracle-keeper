/** Branch coverage for pre-resolve.ts: blocker reasons, terminal (F-9) warnings/blockers, wind-down report. Offline fakes only. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { drainFeeLegsBeforeResolve, windDownAfterResolve } from "./pre-resolve.ts";
import type { PreResolveConnection, PreResolveDeps } from "./pre-resolve.ts";
import type { TerminalInsuranceConfig, windDownOnce } from "./terminal-insurance.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sol = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const STAKE_CFG = {
  wrapperProgramId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
  stakeProgramId: new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3"),
  minRealShares: 0n,
  maxDeadShareBps: 100n,
  minPushAtoms: 1n,
};
const TCFG = { wrapperProgramId: STAKE_CFG.wrapperProgramId, stakeProgramId: STAKE_CFG.stakeProgramId } as unknown as TerminalInsuranceConfig;

function drained(src: Buffer): Buffer {
  const b = Buffer.from(src);
  b.copy(b, 16 + 512, 16 + 496, 16 + 512);
  b.copy(b, 16 + 544, 16 + 528, 16 + 544);
  return b;
}
const empty = drained(sol);
const stakeDrained = (() => { const b = Buffer.from(sol); b.copy(b, 16 + 544, 16 + 528, 16 + 544); return b; })();

function conn(first: Buffer | null, after: Buffer | null = first): PreResolveConnection {
  let n = 0;
  return {
    async getAccountInfo() {
      n++;
      const d = n === 1 ? first : after;
      return d ? { data: d, owner: STAKE_CFG.wrapperProgramId, lamports: 1, executable: false } : null;
    },
  } as unknown as PreResolveConnection;
}

const noop: PreResolveDeps = {
  crankLp: async () => "cranked",
  pushStake: async () => ({ kind: "done", detail: "" }),
};
type Insp = NonNullable<PreResolveDeps["inspectTerminal"]>;
const withTerminal = (r: Awaited<ReturnType<Insp>>): PreResolveDeps => ({ ...noop, inspectTerminal: async () => r });
const live = (budget: bigint, materializedPortfolios: bigint) => ({ kind: "live" as const, budget, materializedPortfolios });
const run = (deps: PreResolveDeps, c = conn(empty), tcfg: TerminalInsuranceConfig | null = TCFG) =>
  drainFeeLegsBeforeResolve(c, Keypair.generate(), SOL, false, STAKE_CFG, undefined, deps, tcfg ?? undefined);

describe("drainFeeLegsBeforeResolve: market lookup", () => {
  it("throws when the market account is missing (not yet created / already closed)", async () => {
    await assert.rejects(run(noop, conn(null)), /not found/);
  });
  it("throws when the post-drain re-read finds the market gone", async () => {
    await assert.rejects(run(noop, conn(sol, null)), /not found/);
  });
  it("rejects an unparseable market address", async () => {
    await assert.rejects(drainFeeLegsBeforeResolve(conn(empty), Keypair.generate(), "nope", false, STAKE_CFG, undefined, noop));
  });
});

describe("creator leg", () => {
  it("unreadable creator leg (unknown market layout) -> warning to check by hand, not a blocker", async () => {
    const r = await run(noop, conn(empty.subarray(0, 700)), null);
    assert.equal(r.after.creatorClaimable, null);
    assert.match(r.warnings.join("|"), /creator leg unreadable/);
    assert.equal(r.safeToResolve, true);
  });
});

describe("blocker reasons", () => {
  it("LP error object is rendered as `error: <msg>` (refused tx)", async () => {
    const deps: PreResolveDeps = { ...noop, crankLp: async () => ({ error: "Custom(21) refused" }) };
    const r = await run(deps, conn(sol, stakeDrained), null);
    assert.equal(r.safeToResolve, false);
    assert.match(r.blockers.join("|"), /LP leg 13690922 atoms still owed \(tag 78 error: Custom\(21\) refused\)/);
  });
  it("stake failed -> error text; stake skipped -> reason; stake other kind -> kind (partial drain)", async () => {
    const lpOnly = (() => { const b = Buffer.from(sol); b.copy(b, 16 + 512, 16 + 496, 16 + 512); return b; })();
    const mk = (s: Awaited<ReturnType<PreResolveDeps["pushStake"]>>): PreResolveDeps => ({ ...noop, pushStake: async () => s });
    const f = await run(mk({ kind: "failed", error: "rpc boom" }), conn(lpOnly), null);
    assert.match(f.blockers[0], /tag 87: rpc boom/);
    const s = await run(mk({ kind: "skipped", reason: "no pool" }), conn(lpOnly), null);
    assert.match(s.blockers[0], /tag 87: no pool/);
    const d = await run(mk({ kind: "done", detail: "partial" }), conn(lpOnly), null);
    assert.match(d.blockers[0], /tag 87: done\)/);
    assert.equal(d.lp, "not-needed", "LP leg already drained, only stake is partial");
  });
  it("no terminal config -> terminal undefined, no F-9 checks", async () => {
    const r = await run({ ...noop, inspectTerminal: async () => { throw new Error("must not run"); } }, conn(empty), null);
    assert.equal(r.terminal, undefined);
  });
  it("terminal config but no inspectTerminal dep -> skipped", async () => {
    const r = await run(noop);
    assert.equal(r.terminal, undefined);
  });
});

describe("F-9 stake-bound terminal budget", () => {
  const baseWarn = 2; // protocol + creator on the SOL fixture
  it("not stake-bound -> reported, no extra warning/blocker", async () => {
    const r = await run(withTerminal({ state: live(5n, 0n), stakeBound: false, budget: 5n, support: null }));
    assert.deepEqual(r.terminal, { stakeBound: false, budget: 5n, support: null });
    assert.equal(r.warnings.length, baseWarn);
    assert.equal(r.safeToResolve, true);
  });
  it("stake-bound, budget null -> nothing added", async () => {
    const r = await run(withTerminal({ state: null, stakeBound: true, budget: null, support: "supported" }));
    assert.equal(r.warnings.length, baseWarn);
    assert.equal(r.safeToResolve, true);
  });
  it("stake-bound, zero budget -> nothing added", async () => {
    const r = await run(withTerminal({ state: live(0n, 3n), stakeBound: true, budget: 0n, support: "unsupported" }));
    assert.equal(r.warnings.length, baseWarn);
    assert.equal(r.safeToResolve, true);
  });
  it("supported + live with materialized portfolios -> both warnings, still safe", async () => {
    const r = await run(withTerminal({ state: live(9n, 2n), stakeBound: true, budget: 9n, support: "supported" }));
    assert.equal(r.warnings.length, baseWarn + 2);
    assert.match(r.warnings.join("|"), /ALL 2 materialized portfolio/);
    assert.match(r.warnings.join("|"), /run this again to wind down/);
    assert.equal(r.safeToResolve, true);
  });
  it("supported, zero materialized portfolios -> only the wind-down warning", async () => {
    const r = await run(withTerminal({ state: live(9n, 0n), stakeBound: true, budget: 9n, support: "supported" }));
    assert.equal(r.warnings.length, baseWarn + 1);
    assert.doesNotMatch(r.warnings.join("|"), /materialized/);
  });
  it("closed state never gets the portfolios warning", async () => {
    const r = await run(withTerminal({ state: { kind: "closed" }, stakeBound: true, budget: 9n, support: "supported" }));
    assert.doesNotMatch(r.warnings.join("|"), /materialized/);
  });
  it("null state with a budget skips the portfolios warning", async () => {
    const r = await run(withTerminal({ state: null, stakeBound: true, budget: 9n, support: "supported" }));
    assert.doesNotMatch(r.warnings.join("|"), /materialized/);
  });
  it("unsupported -> BLOCKER 'no tag 29 (pre-F-9)'", async () => {
    const r = await run(withTerminal({ state: live(9n, 0n), stakeBound: true, budget: 9n, support: "unsupported" }));
    assert.equal(r.safeToResolve, false);
    assert.match(r.blockers[0], /STRANDED.*no tag 29 \(pre-F-9\)/);
  });
  it("unknown support -> BLOCKER 'could not be probed'", async () => {
    const r = await run(withTerminal({ state: live(9n, 0n), stakeBound: true, budget: 9n, support: "unknown" }));
    assert.equal(r.safeToResolve, false);
    assert.match(r.blockers[0], /could not be probed for tag 29/);
  });
  it("null support (probe skipped) is also a blocker", async () => {
    const r = await run(withTerminal({ state: live(9n, 0n), stakeBound: true, budget: 9n, support: null }));
    assert.equal(r.safeToResolve, false);
    assert.match(r.blockers[0], /could not be probed/);
  });
});

describe("windDownAfterResolve", () => {
  type R = Awaited<ReturnType<typeof windDownOnce>>;
  const mk = (p: Partial<R> & { outcome: R["outcome"] }): typeof windDownOnce =>
    (async () => ({ steps: [], state: null, budget: null, stakeBound: false, support: null, ...p })) as typeof windDownOnce;
  const call = (run: typeof windDownOnce) => windDownAfterResolve(conn(empty), Keypair.generate(), SOL, false, TCFG, run);

  it("unknown state, not stake-bound -> complete", async () => {
    const r = await call(mk({ outcome: { kind: "nothing", detail: "x" } }));
    assert.equal(r.state, "unknown");
    assert.equal(r.complete, true);
    assert.equal(r.outcome, JSON.stringify({ kind: "nothing", detail: "x" }));
  });
  it("stake-bound with budget left and outcome not done -> incomplete", async () => {
    const r = await call(mk({
      outcome: { kind: "nothing", detail: "cooldown" }, stakeBound: true, budget: 5n, support: "supported",
      state: { kind: "resolved", budget: 5n, materializedPortfolios: 1n, resolvedSlot: 1n, cTot: 0n },
    }));
    assert.equal(r.state, "resolved");
    assert.equal(r.complete, false);
  });
  it("outcome done -> complete even with a budget", async () => {
    const r = await call(mk({ outcome: { kind: "done", detail: "ok" }, stakeBound: true, budget: 5n }));
    assert.equal(r.complete, true);
  });
  it("stake-bound with zero or null budget -> complete", async () => {
    assert.equal((await call(mk({ outcome: { kind: "nothing", detail: "" }, stakeBound: true, budget: 0n }))).complete, true);
    assert.equal((await call(mk({ outcome: { kind: "nothing", detail: "" }, stakeBound: true, budget: null }))).complete, true);
  });
  it("failed outcome -> incomplete even with no budget", async () => {
    const r = await call(mk({ outcome: { kind: "failed", error: "refused" } }));
    assert.equal(r.complete, false);
  });
  it("default runner (windDownOnce) is used and never throws on an unreachable market", async () => {
    const c = { getMultipleAccountsInfo: async () => [null, null], getAccountInfo: async () => null } as unknown as PreResolveConnection;
    const r = await windDownAfterResolve(c, Keypair.generate(), SOL, true, TCFG);
    assert.equal(typeof r.complete, "boolean");
    assert.equal(r.market, SOL);
  });
});
