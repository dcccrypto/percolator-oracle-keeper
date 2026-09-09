/**
 * #71 — wallet-balance guard on the LIVE keeper.
 *
 * Two halves, deliberately:
 *
 *  1. Pure logic for the guard itself, including the fail-closed behaviour on an
 *     RPC error, which is the part most likely to be "simplified" later.
 *  2. A spawn test against the REAL production entry point proving the live path
 *     actually parses MIN_KEEPER_BALANCE_SOL. Unit-testing the parser alone would
 *     repeat the original mistake: rpc-url.ts and parsePositiveLamportsFromSolEnv
 *     were both correct and both tested while the live path used neither.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import {
  createWalletBalanceState,
  shouldRefreshBalance,
  applyBalanceReading,
  recordBalanceReadFailure,
  formatSol,
} from "./wallet-balance-guard.ts";

const MIN = 50_000_000; // 0.05 SOL

describe("#71 wallet-balance guard logic", () => {
  it("starts un-low with no reading", () => {
    const s = createWalletBalanceState();
    assert.equal(s.low, false);
    assert.equal(s.balanceLamports, null);
  });

  it("refreshes only once the interval has elapsed", () => {
    const s = createWalletBalanceState();
    s.lastCheckAt = 1_000;
    assert.equal(shouldRefreshBalance(s, 1_000 + 29_999, 30_000), false);
    assert.equal(shouldRefreshBalance(s, 1_000 + 30_000, 30_000), true);
  });

  it("goes low below the threshold and reports the edge once", () => {
    const s = createWalletBalanceState();
    assert.equal(applyBalanceReading(s, MIN - 1, MIN, 1), "went-low");
    assert.equal(s.low, true);
    // still low next cycle, but no repeated edge
    assert.equal(applyBalanceReading(s, MIN - 2, MIN, 2), null);
    assert.equal(s.low, true);
  });

  it("recovers at exactly the threshold — the bound is `< min`, not `<= min`", () => {
    const s = createWalletBalanceState();
    applyBalanceReading(s, MIN - 1, MIN, 1);
    assert.equal(applyBalanceReading(s, MIN, MIN, 2), "recovered");
    assert.equal(s.low, false);
  });

  it("FAILS CLOSED: an RPC error does not clear a low verdict", () => {
    const s = createWalletBalanceState();
    applyBalanceReading(s, MIN - 1, MIN, 1);
    assert.equal(s.low, true);
    recordBalanceReadFailure(s, 2);
    assert.equal(
      s.low,
      true,
      "a failed balance read must not resume pushes — not seeing the balance is not evidence of funds",
    );
  });

  it("a failed read still advances the clock, so it does not spin every cycle", () => {
    const s = createWalletBalanceState();
    recordBalanceReadFailure(s, 5_000);
    assert.equal(s.lastCheckAt, 5_000);
    assert.equal(shouldRefreshBalance(s, 5_001, 30_000), false);
  });

  it("formatSol is null-safe", () => {
    assert.equal(formatSol(null), "??");
    assert.equal(formatSol(50_000_000), "0.0500");
  });
});

// ── call-site proof ───────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "src", "cross-cluster.ts");

function runLiveEntry(env: Record<string, string>): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", ENTRY], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

function baseEnv(): Record<string, string> {
  const keeper = Keypair.generate();
  return {
    MAINNET_RPC_URL: "https://127.0.0.1:1",
    DEVNET_RPC_URL: "https://127.0.0.1:1",
    KEEPER_KEYPAIR: JSON.stringify(Array.from(keeper.secretKey)),
    DRY_RUN: "true",
    CRANK_ENABLED: "false",
    LP_FEE_CRANK_ENABLED: "false",
    REGISTER_SOURCE_URL: "",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    CC_HEALTH_PORT: "0",
    REGISTRY_PATH: path.join(ROOT, "__wallet_guard_nonexistent_registry__.json"),
  };
}

describe("#71 live entry parses MIN_KEEPER_BALANCE_SOL", () => {
  it("rejects a sub-lamport threshold that would round to zero", async () => {
    const result = await runLiveEntry({
      ...baseEnv(),
      MIN_KEEPER_BALANCE_SOL: "0.0000000004",
    });
    assert.equal(
      result.timedOut,
      false,
      `live entry did not reject a sub-lamport threshold:\n${result.output.slice(0, 1200)}`,
    );
    assert.equal(result.code, 1);
    assert.match(result.output, /MIN_KEEPER_BALANCE_SOL/);
  });

  it("accepts a normal threshold — the guard must not block a valid boot", async () => {
    const result = await runLiveEntry({ ...baseEnv(), MIN_KEEPER_BALANCE_SOL: "0.05" });
    assert.doesNotMatch(
      result.output,
      /MIN_KEEPER_BALANCE_SOL must be/,
      `a valid threshold was wrongly rejected:\n${result.output.slice(0, 1200)}`,
    );
  });
});
