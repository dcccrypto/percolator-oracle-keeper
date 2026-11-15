/**
 * registry-reload.ts: the hot-reload loop (startRegistryReloadLoop), the in-place
 * `updated` reconcile, and the failure paths that must never blank a running keeper.
 * Tests only; complements registry-row-validation / registry-program-set tests.
 */
import { describe, it, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { reloadRegistryOnce, startRegistryReloadLoop } from "./registry-reload.ts";
import type { MarketEntry, Registry } from "./registry.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-reload-loop-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name: string, markets: unknown[], extra: Record<string, unknown> = {}): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, description: "disk", markets, ...extra }));
  return p;
};
const A = { label: "A", marketAddress: "11111111111111111111111111111112", poolAddress: "11111111111111111111111111111113", dexType: "pumpswap", assetIndex: 0 } as MarketEntry;
const B = { ...A, label: "B", marketAddress: "11111111111111111111111111111114" } as MarketEntry;
const live = (markets: MarketEntry[] = [A]): Registry => ({ version: 1, description: "mem", markets });

const origLog = console.log;
const origWarn = console.warn;
const origErr = console.error;
let logs: string[] = [];
const capture = () => {
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
};
afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origErr;
});

describe("reloadRegistryOnce reconcile", () => {
  it("counts an edited row as updated, swaps markets + description in place, keeps the object reference", () => {
    capture();
    const reg = live([A]);
    const ref = reg;
    const edited = { ...A, poolAddress: "11111111111111111111111111111115" };
    const p = write("upd.json", [edited]);
    assert.deepEqual(reloadRegistryOnce(reg, p), { added: 0, removed: 0, updated: 1 });
    assert.equal(reg, ref);
    assert.equal(reg.markets[0].poolAddress, edited.poolAddress);
    assert.equal(reg.description, "disk");
    assert.ok(logs.some((l) => l.includes("~ updated A")));
  });

  it("reports added + removed + updated together and logs each", () => {
    capture();
    const reg = live([A, { ...B, label: "OLD" }]);
    const p = write("mix.json", [{ ...A, label: "A2" }, { ...A, label: "C", marketAddress: "11111111111111111111111111111116" }]);
    // A updated, OLD (B's address) pruned, C added
    assert.deepEqual(reloadRegistryOnce(reg, p), { added: 1, removed: 1, updated: 1 });
    assert.equal(reg.markets.length, 2);
    assert.ok(logs.some((l) => l.includes("+ added C")));
    assert.ok(logs.some((l) => l.includes("- pruned OLD")));
    assert.ok(logs.some((l) => l.includes("+1 -1 ~1")));
  });

  it("an identical file is a no-op and leaves the in-memory objects untouched", () => {
    capture();
    const reg = live([A]);
    const before = reg.markets;
    assert.deepEqual(reloadRegistryOnce(reg, write("same.json", [A])), { added: 0, removed: 0, updated: 0 });
    assert.equal(reg.markets, before);
    assert.equal(reg.description, "mem");
  });

  it("a missing file is a silent no-op", () => {
    capture();
    const reg = live();
    assert.deepEqual(reloadRegistryOnce(reg, path.join(tmp, "nope.json")), { added: 0, removed: 0, updated: 0 });
    assert.deepEqual(logs, []);
  });

  it("an unparsable file is warned about and the in-memory registry is kept", () => {
    capture();
    const p = path.join(tmp, "bad.json");
    fs.writeFileSync(p, "{ not json");
    const reg = live();
    assert.deepEqual(reloadRegistryOnce(reg, p), { added: 0, removed: 0, updated: 0 });
    assert.equal(reg.markets.length, 1);
    assert.ok(logs.some((l) => l.includes("keeping current in-memory registry")));
  });

  it("an empty market list is refused while markets are tracked, but accepted when none are", () => {
    capture();
    const reg = live([A]);
    const p = write("empty.json", []);
    assert.deepEqual(reloadRegistryOnce(reg, p), { added: 0, removed: 0, updated: 0 });
    assert.equal(reg.markets.length, 1);
    assert.ok(logs.some((l) => l.includes("lists no markets while 1 are tracked")));
    logs = [];
    const none = live([]);
    assert.deepEqual(reloadRegistryOnce(none, p), { added: 0, removed: 0, updated: 0 });
    assert.ok(!logs.some((l) => l.includes("lists no markets")), "empty file is fine when nothing is tracked");
  });
});

describe("startRegistryReloadLoop", () => {
  it("reloads on every interval, picks up an on-disk change live, and stops on SIGTERM", async () => {
    capture();
    const reg = live([A]);
    const p = write("loop.json", [A]);
    const done = startRegistryReloadLoop(reg, { registryPath: p, intervalMs: 15 });
    try {
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(reg.markets.length, 1);
      write("loop.json", [A, B]);
      const deadline = Date.now() + 2000;
      while (reg.markets.length !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(reg.markets.length, 2, "loop must pick up the new row without a restart");
    } finally {
      process.emit("SIGTERM");
      await done;
    }
    assert.ok(logs.some((l) => l.includes("starting: path=") && l.includes("interval=15ms")));
    assert.ok(logs.some((l) => l.includes("stopped.")));
  });

  it("an unexpected throw inside a cycle is logged and does not kill the loop", async () => {
    capture();
    let reads = 0;
    // `markets` throws on every read; the in-try empty-list check is short-circuited, so the first read is outside
    // reloadRegistryOnce's own try/catch, so only the loop's defence-in-depth catch can save it.
    const reg = {
      version: 1,
      description: "mem",
      get markets(): MarketEntry[] {
        reads++;
        throw new Error("boom");
      },
      set markets(_v: MarketEntry[]) {},
    } as unknown as Registry;
    const p = write("throw.json", [A]);
    const done = startRegistryReloadLoop(reg, { registryPath: p, intervalMs: 10 });
    try {
      const deadline = Date.now() + 2000;
      while (reads < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.ok(reads >= 3, "loop kept cycling after a throw");
    } finally {
      process.emit("SIGINT");
      await done;
    }
    assert.ok(logs.some((l) => l.includes("unexpected error: boom")));
  });
});
