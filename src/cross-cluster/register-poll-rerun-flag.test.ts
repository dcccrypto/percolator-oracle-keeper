import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollOnce, _resetSaveStateForTest } from "./register-poll.ts";
import type { Registry } from "./registry.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  _resetSaveStateForTest();
});

test("a rejected poll clears the queued re-run flag (no phantom extra poll next call)", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) await gate; // hold poll #1 open so a wake-up can queue behind it
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
  const config = {
    registryPath: path.join(dir, "registry.json"),
    db: { supabaseUrl: "http://x", supabaseAnonKey: "k", network: "devnet", mainnetConn: { getMultipleAccountsInfo: async () => [] } as never, dexCache: new Map() },
  };
  // First poll rejects (registry read throws after the fetch resolves); later polls are fine.
  let reads = 0;
  const registry = {
    get markets() {
      if (reads++ === 0) throw new Error("registry unreadable");
      return [];
    },
  } as unknown as Registry;

  const first = pollOnce(registry, config);
  const queued = pollOnce(registry, config); // wake-up arrives mid-poll -> flag set
  release();
  await assert.rejects(first);
  await assert.rejects(queued);
  assert.equal(calls, 1);

  await pollOnce(registry, config); // exactly one fresh poll expected
  assert.equal(calls, 2, "stale queued flag caused an extra poll");
});
