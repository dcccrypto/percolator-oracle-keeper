/**
 * Proves the LIVE entry point (src/cross-cluster.ts — what launchd runs via
 * start-keeper.sh -> `npm run cross-cluster:live`) actually rejects an insecure
 * RPC endpoint.
 *
 * This deliberately spawns the real entry point rather than testing rpc-url.ts
 * in isolation: the recurring defect in this repo's PR history is a correct pure
 * helper that nothing calls, where reverting the wiring leaves every test green.
 * Only loopback URLs are used, and validation runs before any network I/O, so
 * the process exits without connecting anywhere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../cross-cluster.ts",
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The entry point statically imports the whole keeper before it reaches the RPC
// check, so a cold start is ~5-10s alone and far longer under a parallel full
// suite. 30s was too tight there; fail only if it is truly hung.
const SPAWN_TIMEOUT_MS = 180_000;

function runEntry(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // Run node + the tsx loader directly: `npx tsx` adds a package lookup and a
    // second process hop before the entry point even starts to load.
    const child = spawn(process.execPath, ["--import", "tsx/esm", ENTRY], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

// Independent child processes: run both cold starts side by side.
describe("live entry point rejects insecure RPC endpoints", { concurrency: true }, () => {
  it("exits 1 on a plaintext http:// RPC URL", { timeout: SPAWN_TIMEOUT_MS + 10_000 }, async () => {
    const { code, out } = await runEntry({
      MAINNET_RPC_URL: "http://127.0.0.1:1/rpc",
      DEVNET_RPC_URL: "http://127.0.0.1:1/rpc",
      ALLOW_INSECURE_LOCAL_RPC: "",
    });
    assert.equal(code, 1, `expected fatal exit, got ${code}\n${out.slice(0, 400)}`);
    assert.match(out, /must use secure https protocol/);
  });

  it("exits 1 on a malformed RPC URL", { timeout: SPAWN_TIMEOUT_MS + 10_000 }, async () => {
    const { code, out } = await runEntry({
      MAINNET_RPC_URL: "not-a-url",
      DEVNET_RPC_URL: "http://127.0.0.1:1/rpc",
      ALLOW_INSECURE_LOCAL_RPC: "",
    });
    assert.equal(code, 1, `expected fatal exit, got ${code}`);
    assert.match(out, /is not a valid URL/);
  });
});
