import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healthFileConfigFromEnv, startHealthFileMirror, writeHealthSnapshot } from "./health-file.js";

test("interval above setInterval's 2^31-1 ms limit is rejected at boot", () => {
  const env = { KEEPER_HEALTH_FILE: "/tmp/h.json" };
  assert.throws(() => healthFileConfigFromEnv({ ...env, KEEPER_HEALTH_FILE_MS: String(2 ** 31) }), /KEEPER_HEALTH_FILE_MS/);
  assert.throws(() => healthFileConfigFromEnv({ ...env, KEEPER_HEALTH_FILE_MS: "99999999999999" }), /KEEPER_HEALTH_FILE_MS/);
  assert.equal(healthFileConfigFromEnv({ ...env, KEEPER_HEALTH_FILE_MS: String(2 ** 31 - 1) })?.intervalMs, 2 ** 31 - 1);
});

test("stop() cancels the pending first-tick timeout", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    let reads = 0;
    const stop = startHealthFileMirror({ file: "/nonexistent/x.json", intervalMs: 30_000 }, async () => {
      reads++;
      return "{}";
    }, "t");
    stop();
    mock.timers.tick(10_000);
    assert.equal(reads, 0);
  } finally {
    mock.timers.reset();
  }
});

test("failed rename removes the temp file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-"));
  try {
    const file = path.join(dir, "h.json");
    fs.mkdirSync(file); // rename of a file onto a directory fails
    const ok = await writeHealthSnapshot(async () => "{}", file, "t");
    assert.equal(ok, false);
    assert.deepEqual(fs.readdirSync(dir), ["h.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
