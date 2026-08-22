/**
 * Regression guard for CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS.
 *
 * This intentionally launches the real production entry point:
 *
 *   src/cross-cluster.ts
 *
 * rather than testing a copied parser/helper in isolation. The live keeper
 * imports keeper-loop.ts, where the cross-cluster circuit-breaker config is
 * consumed.
 *
 * confirmTrips=1 defeats the multi-observation confirmation property:
 * the first out-of-threshold trip can immediately confirm a relocation.
 * Production startup must therefore reject values below 2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const ENTRY = path.join(ROOT, "src", "cross-cluster.ts");

interface EntryResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
}

function runLiveEntry(
  env: Record<string, string>,
): Promise<EntryResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", ENTRY],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let timedOut = false;

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      output += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        output,
        timedOut,
      });
    });
  });
}

describe("live cross-cluster confirmTrips minimum", () => {
  it("rejects CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS=1 at startup", async () => {
    const keeper = Keypair.generate();

    const result = await runLiveEntry({
      CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS: "1",

      // Valid enough for the entry point to continue if the guard is missing.
      // The regression must fail specifically because confirmTrips=1 is rejected,
      // not because an unrelated required setting is absent.
      MAINNET_RPC_URL: "https://127.0.0.1:1",
      DEVNET_RPC_URL: "https://127.0.0.1:1",
      KEEPER_KEYPAIR: JSON.stringify(Array.from(keeper.secretKey)),

      // Prevent unrelated maintenance loops from doing useful work if the
      // production guard is absent. The negative-control run will eventually
      // hit the timeout instead of accidentally passing for another reason.
      DRY_RUN: "true",
      CRANK_ENABLED: "false",
      LP_FEE_CRANK_ENABLED: "false",
      REGISTER_SOURCE_URL: "",
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      CC_HEALTH_PORT: "0",

      REGISTRY_PATH: path.join(
        ROOT,
        "__confirm_trips_min_nonexistent_registry__.json",
      ),
    });

    assert.equal(
      result.timedOut,
      false,
      `live entry point did not reject confirmTrips=1 during startup:\n${result.output.slice(0, 1200)}`,
    );

    assert.equal(
      result.code,
      1,
      `expected startup exit code 1, got code=${result.code} signal=${result.signal}\n${result.output.slice(0, 1200)}`,
    );

    assert.match(
      result.output,
      /CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS.*(?:>=\s*2|at least 2)/,
      `startup failed for the wrong reason:\n${result.output.slice(0, 1200)}`,
    );
  });
});
