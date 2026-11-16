import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { pollOnce, _resetSaveStateForTest, MAX_SAVE_ATTEMPTS } from "./register-poll.ts";
import type { Registry } from "./registry.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  _resetSaveStateForTest();
});

function setup() {
  const slab = Keypair.generate().publicKey.toBase58();
  const pool = Keypair.generate().publicKey.toBase58();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ slab_address: slab, dex_pool_address: pool, symbol: "T", mint_address: pool, mainnet_ca: null }]), { status: 200 })) as typeof fetch;
  const dexCache = new Map([[pool, "pumpswap" as const]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
  const registryPath = path.join(dir, "registry.json");
  const config = {
    registryPath,
    db: { supabaseUrl: "http://x", supabaseAnonKey: "k", network: "devnet", mainnetConn: { getMultipleAccountsInfo: async () => [] } as never, dexCache },
  };
  const registry = { markets: [] } as unknown as Registry;
  return { slab, registryPath, config, registry };
}

test("a failed registry save is retried next cycle, not dropped", async () => {
  const { slab, registryPath, config, registry } = setup();
  fs.mkdirSync(registryPath); // writeFileSync -> EISDIR: save fails
  assert.equal(await pollOnce(registry, config), 1);
  fs.rmdirSync(registryPath); // disk recovers; next poll has NO new changes to reconcile
  await pollOnce(registry, config);
  const saved = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(saved.markets[0].marketAddress, slab);
});

test("save retries are capped so a dead disk cannot loop forever", async () => {
  const { registryPath, config, registry } = setup();
  fs.mkdirSync(registryPath);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errs.push(String(m));
  try {
    for (let i = 0; i < MAX_SAVE_ATTEMPTS + 3; i++) await pollOnce(registry, config);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.filter((e) => e.includes("saveRegistry")).length, MAX_SAVE_ATTEMPTS);
});
