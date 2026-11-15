/**
 * End-to-end: the real scripts/preflight-v22fresh.ts restart-escalation webhook path.
 *
 * The child process preloads a tiny module that swaps globalThis.fetch for a stub answering the alert webhook with
 * a fixed HTTP status, so no network or TLS is involved. Threshold 1 makes the very first launch escalate with an
 * alert due. The preflight then refuses (no RPC env), which is fine: noteLaunch runs before that check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HOOK = "https://alert.invalid/hook";

function runPreflight(status: number): Promise<{ code: number | null; out: string; rec: Record<string, unknown>; calls: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-hook-"));
  const restartLog = path.join(dir, "restarts.json");
  const callsFile = path.join(dir, "calls.txt");
  const stub = path.join(dir, "stub-fetch.mjs");
  fs.writeFileSync(
    stub,
    [
      `import fs from "node:fs";`,
      `globalThis.fetch = async (input, init) => {`,
      `  if (String(input) === ${JSON.stringify(HOOK)}) {`,
      `    fs.appendFileSync(${JSON.stringify(callsFile)}, "x");`,
      `    return new Response("", { status: ${status} });`,
      `  }`,
      `  throw new Error("unexpected fetch in hermetic preflight test");`,
      `};`,
    ].join("\n"),
  );
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, KEEPER_RESTART_LOG: restartLog, KEEPER_RESTART_ALERT_N: "1", KEEPER_ALERT_WEBHOOK_URL: HOOK };
    // Keep the child hermetic: the refusal must come from the missing RPC env, never a real endpoint.
    delete env.DEVNET_RPC_URL;
    delete env.WRAPPER_PROGRAM_ID;
    delete env.REGISTRY_PATH;
    delete env.KEEPER_HEALTH_FILE;
    const c = spawn(process.execPath, ["--import", "tsx/esm", "--import", stub, "scripts/preflight-v22fresh.ts"], { env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => {
      try {
        if (!fs.existsSync(restartLog)) throw new Error(`child wrote no restart log (exit ${code}):\n${out}`);
        const rec = JSON.parse(fs.readFileSync(restartLog, "utf8")) as Record<string, unknown>;
        const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").length : 0;
        resolve({ code, out, rec, calls });
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test("preflight: a non-2xx alert webhook reply is a failed delivery -> stamp rolled back so the next launch retries", { timeout: 120_000 }, async () => {
  const r = await runPreflight(503);
  assert.equal(r.calls, 1, r.out);
  assert.match(r.out, /\[ALERT\] v2\.2 keeper restarted 1x/);
  assert.match(r.out, /\[preflight\] alert webhook failed: Error/);
  assert.equal(r.rec.alertFails, 1, JSON.stringify(r.rec));
  assert.equal("lastAlertAt" in r.rec, false, JSON.stringify(r.rec));
  assert.doesNotMatch(r.out, /alert\.invalid/, "webhook URL must not be logged");
  assert.equal(r.code, 1, r.out); // refused later for the missing RPC env, after noteLaunch
});

test("preflight: a 2xx alert webhook reply keeps the stamp (no retry, no failure count)", { timeout: 120_000 }, async () => {
  const r = await runPreflight(200);
  assert.equal(r.calls, 1, r.out);
  assert.doesNotMatch(r.out, /alert webhook failed/);
  assert.equal(typeof r.rec.lastAlertAt, "number", JSON.stringify(r.rec));
  assert.equal("alertFails" in r.rec, false, JSON.stringify(r.rec));
  assert.equal(r.code, 1, r.out); // ran past noteLaunch to the missing-RPC-env refusal
});
