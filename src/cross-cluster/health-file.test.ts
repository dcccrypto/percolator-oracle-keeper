import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healthFileConfigFromEnv, writeHealthSnapshot, startHealthFileMirror } from "./health-file.js";

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "health-file-"));
const FILE = "/abs/health.json";

describe("healthFileConfigFromEnv", () => {
  test("unset / blank file = off", () => {
    assert.equal(healthFileConfigFromEnv({}), null);
    assert.equal(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: "  " }), null);
  });
  test("relative path throws", () => {
    assert.throws(() => healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: "rel.json" }), /absolute/);
  });
  test("non-integer interval throws", () => {
    assert.throws(() => healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: FILE, KEEPER_HEALTH_FILE_MS: "1.5" }), /positive integer/);
  });
  test("default, floor and explicit interval", () => {
    assert.equal(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: FILE })!.intervalMs, 30_000);
    assert.equal(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: FILE, KEEPER_HEALTH_FILE_MS: "" })!.intervalMs, 30_000);
    assert.equal(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: FILE, KEEPER_HEALTH_FILE_MS: "10" })!.intervalMs, 5_000);
    assert.equal(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: FILE, KEEPER_HEALTH_FILE_MS: "60000" })!.intervalMs, 60_000);
  });
  test("LEAD 1: interval above the 32-bit timer limit must not reach setInterval (Node clamps it to 1 ms)", () => {
    const cfg = healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: FILE, KEEPER_HEALTH_FILE_MS: "99999999999" });
    assert.ok(cfg === null || cfg.intervalMs <= 2_147_483_647, `intervalMs=${cfg?.intervalMs}`);
  });
});

describe("writeHealthSnapshot", () => {
  test("writes {writtenAt, source, health} atomically", async () => {
    const d = tmpDir();
    const f = path.join(d, "sub", "h.json");
    assert.equal(await writeHealthSnapshot(async () => '{"ok":1}', f, "src", () => new Date(0)), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { writtenAt: "1970-01-01T00:00:00.000Z", source: "src", health: { ok: 1 } });
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ["h.json"]);
  });
  test("bad JSON / throwing reader returns false, keeps old file", async () => {
    const d = tmpDir();
    const f = path.join(d, "h.json");
    fs.writeFileSync(f, "old");
    assert.equal(await writeHealthSnapshot(async () => "{nope", f, "s"), false);
    assert.equal(await writeHealthSnapshot(async () => { throw new Error("x"); }, f, "s"), false);
    assert.equal(fs.readFileSync(f, "utf8"), "old");
    assert.deepEqual(fs.readdirSync(d), ["h.json"]);
  });
  test("LEAD 2: a failed rename must not leave the tmp file behind", async () => {
    const d = tmpDir();
    const f = path.join(d, "target");
    fs.mkdirSync(f); // rename(file -> existing non-empty dir) fails
    fs.writeFileSync(path.join(f, "keep"), "x");
    assert.equal(await writeHealthSnapshot(async () => "{}", f, "s"), false);
    assert.deepEqual(fs.readdirSync(d), ["target"]);
  });
  test("cleanup failure is swallowed (tmp path is a directory)", async () => {
    const d = tmpDir();
    const f = path.join(d, "h.json");
    fs.mkdirSync(`${f}.tmp-${process.pid}`);
    assert.equal(await writeHealthSnapshot(async () => "{}", f, "s"), false);
  });
});

describe("startHealthFileMirror", () => {
  test("ticks at 5s and on the interval, stop clears interval", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const d = tmpDir();
    const f = path.join(d, "h.json");
    let calls = 0;
    const stop = startHealthFileMirror({ file: f, intervalMs: 10_000 }, async () => { calls++; return "{}"; }, "s");
    t.mock.timers.tick(5_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    t.mock.timers.tick(5_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
    stop();
    t.mock.timers.tick(100_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
  });
  test("busy skips overlapping ticks while a read is in flight", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const f = path.join(tmpDir(), "h.json");
    let calls = 0;
    let release!: () => void;
    const stop = startHealthFileMirror({ file: f, intervalMs: 5_000 }, () => { calls++; return new Promise<string>((r) => { release = () => r("{}"); }); }, "s");
    t.mock.timers.tick(5_000);
    t.mock.timers.tick(5_000);
    assert.equal(calls, 1);
    release();
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(5_000);
    assert.equal(calls, 2);
    stop();
  });
  test("LEAD 3: a readHealth that never settles must not stop the mirror forever", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const f = path.join(tmpDir(), "h.json");
    let calls = 0;
    const stop = startHealthFileMirror({ file: f, intervalMs: 5_000 }, () => { calls++; return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("{}"); }, "s");
    for (let i = 0; i < 40; i++) {
      t.mock.timers.tick(5_000);
      await new Promise((r) => setImmediate(r));
    }
    stop();
    assert.ok(calls >= 2, `readHealth called ${calls}x`);
    assert.ok(fs.existsSync(f), "file was never written after the hang");
  });
});
