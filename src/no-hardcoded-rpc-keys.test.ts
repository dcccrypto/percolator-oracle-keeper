/**
 * A Helius mainnet key was hardcoded in src/dry-run.ts in a PUBLIC repo. Keys come from the environment only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(ts|mjs|js|json|md|sh)$/.test(f) && !f.endsWith("no-hardcoded-rpc-keys.test.ts")) out.push(f);
  }
  return out;
}

describe("no hardcoded RPC keys", () => {
  it("no source file embeds a ?api-key=<value> URL (placeholders like <your key> are fine)", () => {
    const hit = /api-key=(?!<|\$|\{|\.\.\.|\*)[0-9A-Za-z-]{16,}/;
    const offenders = walk("src").filter((f) => hit.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("dry-run fails closed when no mainnet RPC URL is configured (no built-in default)", () => {
    const env = { ...process.env };
    delete env.HELIUS_MAINNET_RPC_URL;
    delete env.MAINNET_RPC_URL;
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "src/dry-run.ts"], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /set HELIUS_MAINNET_RPC_URL/);
    assert.doesNotMatch(r.stdout + r.stderr, /Mainnet RPC :/, "must not have started reading anything");
  });
});
