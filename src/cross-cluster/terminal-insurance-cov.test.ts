/**
 * K-COV: branches of terminal-insurance.ts the other suites never reach: a Live market, a non-v18 header,
 * a throwing tag-29 probe, env config parsing, and inspectStakeBoundBudget.
 * Run with: node --import tsx/esm --test src/cross-cluster/terminal-insurance-cov.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  inspectStakeBoundBudget,
  makeTerminalInsuranceJob,
  tag29Support,
  TerminalInsuranceState,
  terminalInsuranceConfigFromEnv,
  windDownOnce,
  buildRecoverTerminalInsuranceIx,
} from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const TEXTIT = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
const KEEPER = Keypair.generate();
const CFG: TerminalInsuranceConfig = {
  wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0,
};
const MODE_ABS = 592 + 626;

function resolvedMarket(): Buffer {
  const b = Buffer.from(fx("textit-market-v18-fees"));
  b[MODE_ABS] = 1;
  return b;
}

/** A connection whose market/pool read returns `accounts`; everything else throws if touched. */
function readOnly(accounts: Array<{ data: Buffer; owner: PublicKey } | null>) {
  let reads = 0;
  const conn = {
    async getMultipleAccountsInfo() { reads++; return accounts.map((a) => (a ? { ...a, lamports: 1, executable: false } : null)); },
    async getLatestBlockhash() { throw new Error("rpc down"); },
  };
  return { conn: conn as unknown as TerminalConnection, reads: () => reads };
}

describe("windDownOnce: market-state gates", () => {
  it("a Live market is a quiet nothing and clears its unbooked-budget streak", async () => {
    const st = new TerminalInsuranceState();
    st.unbookedStreak.set(TEXTIT.toBase58(), 2);
    const { conn } = readOnly([{ data: Buffer.from(fx("textit-market-v18-fees")), owner: WRAPPER }, null]);
    const r = await windDownOnce(conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(r.outcome.kind, "nothing");
    assert.match((r.outcome as { detail: string }).detail, /market is Live/);
    assert.equal(r.state?.kind, "live");
    assert.equal(st.unbookedStreak.has(TEXTIT.toBase58()), false);
    assert.equal(r.steps.length, 0);
  });

  it("a market account that is not a v18 header is skipped, not failed", async () => {
    const bad = Buffer.from(fx("textit-market-v18-fees"));
    bad.writeUInt16LE(17, 8);
    const { conn } = readOnly([{ data: bad, owner: WRAPPER }, null]);
    const r = await windDownOnce(conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.deepEqual(r.outcome, { kind: "skipped", reason: "not a v18 market header" });
    assert.equal(r.state, null);
  });

  it("an unparseable market address fails without touching the chain", async () => {
    const { conn, reads } = readOnly([]);
    const r = await windDownOnce(conn, KEEPER, "not-a-pubkey", false, CFG, new TerminalInsuranceState());
    assert.deepEqual(r.outcome, { kind: "failed", error: "unparseable market address" });
    assert.equal(reads(), 0);
  });

  it("a missing market account fails; a market owned by another program is skipped; a throwing read is a failed outcome", async () => {
    const st = new TerminalInsuranceState();
    const missing = await windDownOnce(readOnly([null, null]).conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.deepEqual(missing.outcome, { kind: "failed", error: "market account not found" });
    const foreign = await windDownOnce(readOnly([{ data: resolvedMarket(), owner: Keypair.generate().publicKey }, null]).conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(foreign.outcome.kind, "skipped");
    const boom = { async getMultipleAccountsInfo() { throw new Error("socket hang up"); } } as unknown as TerminalConnection;
    const thrown = await windDownOnce(boom, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.deepEqual(thrown.outcome, { kind: "failed", error: "account read failed: socket hang up" });
    const nonError = { async getMultipleAccountsInfo() { throw "plain string"; } } as unknown as TerminalConnection;
    assert.deepEqual((await windDownOnce(nonError, KEEPER, TEXTIT.toBase58(), false, CFG, st)).outcome, { kind: "failed", error: "account read failed: plain string" });
  });

  it("a Resolved market with no pool account is reported as no stake pool bound (no tag 29)", async () => {
    const r = await windDownOnce(readOnly([{ data: resolvedMarket(), owner: WRAPPER }, null]).conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "skipped");
    assert.match((r.outcome as { reason: string }).reason, /no stake pool bound/);
    assert.equal(r.stakeBound, false);
  });

  it("the job wrapper returns windDownOnce's outcome", async () => {
    const job = makeTerminalInsuranceJob(CFG);
    assert.equal(job.name, "terminal-insurance");
    const { conn } = readOnly([{ data: Buffer.from(fx("textit-market-v18-fees")), owner: WRAPPER }, null]);
    const out = await job.run({ conn, keeper: KEEPER, dryRun: true } as never, { marketAddress: TEXTIT.toBase58() } as never);
    assert.equal(out.kind, "nothing");
  });
});

describe("tag29Support: a throwing probe is unknown and cached as such (re-probed next call)", () => {
  it("getLatestBlockhash throws -> unknown, st.support set to unknown", async () => {
    const st = new TerminalInsuranceState();
    const probe = buildRecoverTerminalInsuranceIx({
      stakeProgramId: STAKE, wrapperProgramId: WRAPPER, caller: KEEPER.publicKey, market: TEXTIT,
      pool: Keypair.generate().publicKey, poolVault: Keypair.generate().publicKey, collateralMint: Keypair.generate().publicKey, amount: 0n,
    });
    const v = await tag29Support(readOnly([]).conn, KEEPER, probe, st, CFG);
    assert.equal(v, "unknown");
    assert.equal(st.support?.value, "unknown");
  });
});

describe("config", () => {
  it("terminalInsuranceConfigFromEnv: defaults, overrides, and rejects", () => {
    const d = terminalInsuranceConfigFromEnv({});
    assert.equal(d.unbookedAlertCycles, 3);
    assert.equal(d.receiptCleanup, true);
    assert.equal(d.cleanup?.pdaGraceSlots, 216_000n);
    const off = terminalInsuranceConfigFromEnv({ TERMINAL_CLEANUP_ENABLED: "false", TERMINAL_RECEIPT_CLEANUP_ENABLED: "false", ALERT_TERMINAL_BUDGET_CYCLES: "5", TERMINAL_PDA_GRACE_SLOTS: " 42 " });
    assert.equal(off.cleanup, undefined);
    assert.equal(off.receiptCleanup, false);
    assert.equal(off.unbookedAlertCycles, 5);
    assert.equal(terminalInsuranceConfigFromEnv({ TERMINAL_PDA_GRACE_SLOTS: "42" }).cleanup?.pdaGraceSlots, 42n);
    assert.equal(terminalInsuranceConfigFromEnv({ TERMINAL_PDA_GRACE_SLOTS: "  " }).cleanup?.pdaGraceSlots, 216_000n);
    assert.throws(() => terminalInsuranceConfigFromEnv({ ALERT_TERMINAL_BUDGET_CYCLES: "0" }), /positive integer/);
    assert.throws(() => terminalInsuranceConfigFromEnv({ ALERT_TERMINAL_BUDGET_CYCLES: "x" }), /positive integer/);
    assert.throws(() => terminalInsuranceConfigFromEnv({ TERMINAL_PDA_GRACE_SLOTS: "-1" }), /non-negative integer/);
  });
});

describe("inspectStakeBoundBudget: never throws", () => {
  it("a throwing read gives all-null", async () => {
    const boom = { async getMultipleAccountsInfo() { throw new Error("x"); } } as unknown as TerminalConnection;
    assert.deepEqual(await inspectStakeBoundBudget(boom, KEEPER, TEXTIT.toBase58(), CFG, new TerminalInsuranceState()), { state: null, stakeBound: false, budget: null, support: null });
  });
  it("missing market / missing pool / tombstone", async () => {
    const st = new TerminalInsuranceState();
    assert.equal((await inspectStakeBoundBudget(readOnly([null, null]).conn, KEEPER, TEXTIT.toBase58(), CFG, st)).state, null);
    const noPool = await inspectStakeBoundBudget(readOnly([{ data: Buffer.from(fx("textit-market-v18-fees")), owner: WRAPPER }, null]).conn, KEEPER, TEXTIT.toBase58(), CFG, st);
    assert.equal(noPool.stakeBound, false);
    assert.equal(noPool.state?.kind, "live");
    const tomb = Buffer.from(fx("textit-market-v18-fees"));
    tomb[10] = 8;
    const t = await inspectStakeBoundBudget(readOnly([{ data: tomb, owner: WRAPPER }, null]).conn, KEEPER, TEXTIT.toBase58(), CFG, st);
    assert.equal(t.budget, null);
    assert.equal(t.state?.kind, "closed");
  });
});
