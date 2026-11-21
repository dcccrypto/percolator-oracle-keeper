/**
 * A throw while the keeper BOOTS must exit 1; a throw after the push loop is running must not exit.
 *
 * cross-cluster.ts's process-wide uncaughtException handler logs and stays up (72eb1a6: a fault in a running loop must
 * never kill the keeper). It used to do the same during boot, so a boot-time config error either ended with exit 0 (a
 * strict v2.2 / lev-guard flag, the registry, KEEPER_KEYPAIR: nothing held the event loop yet) or left a keeper with no
 * push loop (a KEEPER_PUSH_DEPTH / _ONCHAIN / KEEPER_HEALTH_FILE error, read inside startKeeperLoop after the boot crank
 * and every background loop had started: no exit, no AuthMark push, cranks and jobs running on frozen marks). Boots the
 * REAL entry points in child processes.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(root, "src", "cross-cluster.ts");
const pusher = join(root, "src", "pusher.ts");
const tmp = mkdtempSync(join(tmpdir(), "boot-fault-"));
const badJson = join(tmp, "bad.json");
writeFileSync(badJson, "{ not json");
const KP = JSON.stringify(Array.from(Keypair.generate().secretKey));

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    ALLOW_INSECURE_LOCAL_RPC: "true",
    MAINNET_RPC_URL: "http://127.0.0.1:9",
    DEVNET_RPC_URL: "http://127.0.0.1:9",
    DEVNET_RPC_FALLBACK_URLS: "off",
    KEEPER_DRY_RUN: "1",
    KEEPER_KEYPAIR: KP,
    REGISTRY_PATH: "/nonexistent/registry.json",
    CC_HEALTH_BIND: "127.0.0.1",
    CC_HEALTH_PORT: String(41000 + Math.floor(Math.random() * 20000)),
  };
}

interface Run { code: number | null; out: string; err: string; cycles: () => number; alive: () => boolean; kill: () => void; exited: Promise<void> }

function boot(extra: Record<string, string>, nodeArgs: string[] = [], file = entry): Run {
  const child = spawn(process.execPath, [...nodeArgs, "--import", "tsx/esm", file], { cwd: root, env: { ...baseEnv(), ...extra } });
  const r = { code: null as number | null, out: "", err: "" } as Run;
  child.stdout.on("data", (d) => (r.out += d));
  child.stderr.on("data", (d) => ((r.out += d), (r.err += d)));
  let done = false;
  r.exited = new Promise((res) => child.on("exit", (c) => ((r.code = c), (done = true), res())));
  r.cycles = () => (r.out.match(/=== Cycle/g) ?? []).length;
  r.alive = () => !done;
  r.kill = () => child.kill("SIGKILL");
  return r;
}

const EXIT_WAIT_MS = 120_000;
async function exitOf(r: Run): Promise<number | "still running"> {
  const t = setTimeout(r.kill, EXIT_WAIT_MS);
  await r.exited;
  clearTimeout(t);
  return r.code ?? "still running";
}
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((res) => setTimeout(res, 250));
  }
  return cond();
}

/** Lines that mean a loop or the boot crank had started: the v2.2 layer, the boot crank, the recovery crank loop. */
const STARTED = /\[v22\] layer ON|\[cranker\]\[boot\]|Recovery crank loop starting/;

describe("every boot-time config error exits 1", () => {
  // [name, env, error expected on stderr, entry point, must be refused before any loop or the boot crank starts]
  const cases: Array<[string, Record<string, string>, RegExp, string, boolean]> = [
    ["KEEPER_PUSH_DEPTH typo", { KEEPER_V22: "on", KEEPER_PUSH_DEPTH: "onn" }, /KEEPER_PUSH_DEPTH="onn"/, entry, true],
    ["KEEPER_PUSH_DEPTH_ONCHAIN typo", { KEEPER_V22: "on", KEEPER_PUSH_DEPTH: "on", KEEPER_PUSH_DEPTH_ONCHAIN: "onn" }, /KEEPER_PUSH_DEPTH_ONCHAIN="onn"/, entry, true],
    ["KEEPER_HEALTH_FILE not absolute", { KEEPER_V22: "on", KEEPER_HEALTH_FILE: "health.json" }, /KEEPER_HEALTH_FILE must be an absolute path/, entry, true],
    ["KEEPER_V22_SWEEP typo", { KEEPER_V22: "on", KEEPER_V22_SWEEP: "onn" }, /KEEPER_V22_SWEEP="onn"/, entry, false],
    ["KEEPER_LEV_W1 typo", { KEEPER_LEV_W1: "yess" }, /KEEPER_LEV_W1="yess"/, entry, false],
    ["KEEPER_LEV_W1 typo with the v2.2 layer on", { KEEPER_V22: "on", KEEPER_LEV_W1: "yess" }, /KEEPER_LEV_W1="yess"/, entry, false],
    ["registry not JSON", { REGISTRY_PATH: badJson }, /SyntaxError/, entry, false],
    ["registry unreadable (a directory)", { REGISTRY_PATH: tmp }, /EISDIR/, entry, false],
    ["KEEPER_KEYPAIR invalid", { KEEPER_KEYPAIR: "[1,2," }, /SyntaxError/, entry, false],
    ["pusher: KEEPER_PUSH_DEPTH typo", { KEEPER_PUSH_DEPTH: "onn" }, /KEEPER_PUSH_DEPTH="onn"/, pusher, false],
  ];
  it("exit code 1 with the error and a [fatal] line on stderr, and no push cycle ran", { timeout: EXIT_WAIT_MS + 60_000 }, async () => {
    const runs = cases.map(([, extra, , file]) => boot(extra, [], file));
    const codes = await Promise.all(runs.map(exitOf));
    cases.forEach(([name], i) =>
      console.log(`[boot-case] ${name}: exit=${codes[i]} cycles=${runs[i].cycles()} fatal=${/\[fatal\]/.test(runs[i].err)} started=${STARTED.test(runs[i].out)}`),
    );
    cases.forEach(([name, , re, , early], i) => {
      assert.equal(codes[i], 1, `${name}: exit (output: ${runs[i].out.slice(-400)})`);
      assert.match(runs[i].err, re, `${name}: error on stderr`);
      assert.match(runs[i].err, /\[fatal\]/, `${name}: [fatal] line on stderr`);
      assert.equal(runs[i].cycles(), 0, `${name}: no push cycle`);
      if (early) assert.doesNotMatch(runs[i].out, STARTED, `${name}: refused before any loop or the boot crank started`);
    });
  });
});

describe("after boot the resilience guard is unchanged", () => {
  it("a valid config keeps running and pushing cycles (keeper and pusher)", { timeout: 180_000 }, async () => {
    const runs = [boot({ KEEPER_PUSH_DEPTH: "on", KEEPER_PUSH_DEPTH_ONCHAIN: "off" }), boot({ KEEPER_PUSH_DEPTH: "on" }, [], pusher)];
    try {
      for (const r of runs) {
        assert.ok(await until(() => r.cycles() >= 2 || !r.alive(), 150_000), `no cycles (output: ${r.out.slice(-400)})`);
        assert.ok(r.alive(), `exited ${r.code} (output: ${r.out.slice(-400)})`);
      }
    } finally {
      for (const r of runs) r.kill();
    }
  });

  it("a throw and a rejection after the push loop started are logged, and the keeper keeps cycling", { timeout: 180_000 }, async () => {
    // Preload: on the first "=== Cycle" line (the push loop is running), throw from a timer and leave a rejection unhandled.
    const inject =
      "data:text/javascript," +
      encodeURIComponent(
        'const log = console.log; let fired = false; console.log = (...a) => { log(...a); if (!fired && String(a[0]).includes("=== Cycle 1 ")) { fired = true; ' +
          'setTimeout(() => { throw new Error("injected runtime fault"); }, 0); Promise.reject(new Error("injected runtime rejection")); } };',
      );
    const r = boot({}, ["--import", inject]);
    try {
      assert.ok(await until(() => r.out.includes("injected runtime rejection") || !r.alive(), 150_000), `fault not injected (output: ${r.out.slice(-400)})`);
      assert.ok(await until(() => r.cycles() >= 3 || !r.alive(), 60_000), `cycling stopped (output: ${r.out.slice(-400)})`);
      assert.ok(r.alive(), `exited ${r.code} after a runtime fault (output: ${r.out.slice(-400)})`);
      assert.match(r.out, /\[keeper\]\[uncaughtException\] Error: injected runtime fault/);
      assert.match(r.out, /\[keeper\]\[unhandledRejection\] Error: injected runtime rejection/);
      assert.doesNotMatch(r.out, /\[fatal\]/);
    } finally {
      r.kill();
    }
  });
});
