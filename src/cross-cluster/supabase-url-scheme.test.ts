/**
 * Regression guard for SUPABASE_URL's transport scheme (#65).
 *
 * Like confirm-trips-min.test.ts, this launches the REAL production entry point
 *
 *   src/cross-cluster.ts
 *
 * rather than unit-testing validateRpcEndpoint in isolation. That distinction is
 * the whole point of this file: rpc-url.ts's rule was already correct and already
 * tested, and the live path still had no scheme check on SUPABASE_URL at all. A
 * passing unit test on the helper proved nothing about the call site, so this
 * asserts the call site.
 *
 * Why it matters more than the anon key it carries: this feed supplies
 * `dex_pool_address`, which becomes the AuthMark every trade in that market
 * settles against (#100). Whoever controls a plaintext Supabase response picks
 * the settlement price.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "src", "cross-cluster.ts");

interface EntryResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

function runLiveEntry(env: Record<string, string>): Promise<EntryResult> {
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

/** Env that lets startup proceed far enough to reach (or miss) the scheme check. */
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
    SUPABASE_ANON_KEY: "anon-key-placeholder",
    CC_HEALTH_PORT: "0",
    ALLOW_INSECURE_LOCAL_RPC: "",
    REGISTRY_PATH: path.join(ROOT, "__supabase_url_scheme_nonexistent_registry__.json"),
  };
}

describe("#65 live SUPABASE_URL transport scheme", () => {
  it("rejects a plaintext http:// SUPABASE_URL at startup", async () => {
    const result = await runLiveEntry({
      ...baseEnv(),
      SUPABASE_URL: "http://registry.attacker.example",
    });

    assert.equal(
      result.timedOut,
      false,
      `live entry point did not reject a plaintext SUPABASE_URL:\n${result.output.slice(0, 1200)}`,
    );
    assert.equal(result.code, 1, `expected exit 1, got ${result.code}`);
    assert.match(
      result.output,
      /SUPABASE_URL must use secure https protocol/,
      `expected the scheme rejection to name SUPABASE_URL:\n${result.output.slice(0, 1200)}`,
    );
  });

  it("rejects a non-http scheme too", async () => {
    const result = await runLiveEntry({
      ...baseEnv(),
      SUPABASE_URL: "ftp://registry.attacker.example",
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.match(result.output, /SUPABASE_URL must use secure https protocol/);
  });

  it("allows plaintext http:// for a LOCAL host when ALLOW_INSECURE_LOCAL_RPC=true", async () => {
    const result = await runLiveEntry({
      ...baseEnv(),
      ALLOW_INSECURE_LOCAL_RPC: "true",
      SUPABASE_URL: "http://127.0.0.1:54321",
    });
    // Must NOT die with the scheme error. It may exit for an unrelated reason or
    // run on until the timeout; either is fine, the scheme must not be the cause.
    assert.doesNotMatch(
      result.output,
      /SUPABASE_URL must use secure https protocol/,
      `local http was wrongly rejected under the opt-in:\n${result.output.slice(0, 1200)}`,
    );
  });

  it("does not reject an unset SUPABASE_URL — registration is optional", async () => {
    const result = await runLiveEntry({ ...baseEnv(), SUPABASE_URL: "" });
    assert.doesNotMatch(
      result.output,
      /SUPABASE_URL must use secure https protocol/,
      `an absent SUPABASE_URL must not be treated as insecure:\n${result.output.slice(0, 1200)}`,
    );
  });
});
