import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { reloadRegistryOnce, startRegistryReloadLoop } from "./registry-reload.ts";

function tmp(content?: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rr-")), "registry.json");
  if (content !== undefined) fs.writeFileSync(p, content);
  return p;
}

async function runLoop(intervalMs: number | undefined, clock: number[], cycles: number): Promise<number[]> {
  const sleeps: number[] = [];
  let i = 0;
  const reg: any = { markets: [], description: "" };
  const p = tmp(); // missing file: reload is a no-op
  await startRegistryReloadLoop(reg, {
    registryPath: p,
    intervalMs,
    now: () => clock[Math.min(i++, clock.length - 1)],
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= cycles) process.emit("SIGTERM");
    },
  });
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  return sleeps;
}

test("failed reload (malformed file) keeps the in-memory registry untouched", () => {
  const reg: any = { markets: [{ marketAddress: "A", label: "a" }], description: "d" };
  const before = reg.markets;
  const r = reloadRegistryOnce(reg, tmp("{not json"));
  assert.deepEqual(r, { added: 0, removed: 0, updated: 0 });
  assert.equal(reg.markets, before);
  assert.equal(reg.description, "d");
});

test("empty market list while markets tracked is refused (not cleared)", () => {
  const reg: any = { markets: [{ marketAddress: "A", label: "a" }], description: "d" };
  reloadRegistryOnce(reg, tmp(JSON.stringify({ description: "x", markets: [] })));
  assert.equal(reg.markets.length, 1);
});

test("loop sleeps interval - elapsed", async () => {
  assert.deepEqual(await runLoop(1000, [0, 300], 1), [700]);
});

test("loop with NaN / 0 / negative interval falls back to default and sleeps (no busy spin)", async () => {
  for (const bad of [NaN, 0, -5]) {
    assert.deepEqual(await runLoop(bad, [0, 0], 1), [15000], String(bad));
  }
});

test("overrun cycle still yields (floor 1ms)", async () => {
  assert.deepEqual(await runLoop(1000, [0, 5000], 1), [1]);
});

test("backwards clock step does not stretch the sleep beyond the interval", async () => {
  assert.deepEqual(await runLoop(1000, [10_000_000, 0], 1), [1000]);
});
