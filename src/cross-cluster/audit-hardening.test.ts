/**
 * Tests for the 2026-07-31 audit-hardening fixes — each one pins the exact
 * failure mode the audit found, against the REAL exported functions.
 *
 *  1. -32016 code matching: a provider that rewords the min-context-slot
 *     message must still trigger the retry + poisoned-watermark counter.
 *  2. Pass-2 containment: a pumpswap vault-batch failure must not discard
 *     the pass-1 (meteora/raydium) prices — it used to skip the WHOLE cycle
 *     for every market.
 *  3. Wipe-the-board guard: a SUCCESSFUL empty DB result against 3+ locally
 *     registered markets must be refused (RLS/config drift returns 200 [],
 *     not an error — ABSENCE_THRESHOLD alone passes it in ~90s and retires
 *     everything).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/audit-hardening.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  readAtWatermark,
  readAllPoolPricesE6,
  resetSlotWatermarksForTests,
} from "./price-reader.ts";
import { pollOnce } from "./register-poll.ts";
import type { Registry, MarketEntry } from "./registry.ts";

beforeEach(() => resetSlotWatermarksForTests());

function ctx<T>(slot: number, value: T) {
  return { context: { slot }, value };
}

// ── 1. JSON-RPC code -32016 vs reworded message ─────────────────────────────

describe("isMinContextSlotError matches the JSON-RPC code, not just the text", () => {
  it("a reworded -32016 error still retries and still trips the poison counter", async () => {
    const conn = { rpcEndpoint: "https://ep-code" } as Connection;
    await readAtWatermark(conn, () => Promise.resolve(ctx(1_000_000, 0)));
    // Provider rewords the message entirely — only the code survives.
    const reworded = Object.assign(new Error("node not caught up to requested state"), {
      code: -32016,
    });
    let calls = 0;
    // Retried MIN_SLOT_RETRIES times (proves it was classified as min-slot,
    // not an immediate-throw "other" error)…
    await assert.rejects(
      readAtWatermark(conn, () => {
        calls++;
        return Promise.reject(reworded);
      }),
    );
    assert.equal(calls, 3);
    // …and after 3 such reads the watermark is dropped (poison counter ran).
    await assert.rejects(readAtWatermark(conn, () => Promise.reject(reworded)));
    await assert.rejects(readAtWatermark(conn, () => Promise.reject(reworded)));
    const seen: Array<number | undefined> = [];
    await readAtWatermark(conn, (mcs) => {
      seen.push(mcs);
      return Promise.resolve(ctx(5, "fresh"));
    });
    assert.deepEqual(seen, [undefined]);
  });

  it("an unrelated error with a different code is NOT treated as min-slot", async () => {
    const conn = { rpcEndpoint: "https://ep-code2" } as Connection;
    let calls = 0;
    const err = Object.assign(new Error("connection refused"), { code: -32005 });
    await assert.rejects(
      readAtWatermark(conn, () => {
        calls++;
        return Promise.reject(err);
      }),
      /connection refused/,
    );
    assert.equal(calls, 1); // no retry — immediate propagation
  });
});

// ── 2. Pass-2 containment ────────────────────────────────────────────────────

const METEORA_OWNER = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

/** Minimal meteora-dlmm pool: activeId/binStep at the SDK's parse offsets
 *  (same fixture shape as meteora-wsol.test.ts makePool). */
function makeMeteoraPool(activeId: number, binStep: number): Uint8Array {
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  dv.setInt32(76, activeId, true);
  dv.setUint16(80, binStep, true);
  return buf;
}

describe("pumpswap vault-batch failure is contained to pumpswap markets", () => {
  it("pass-1 meteora price survives a pass-2 throw", async () => {
    const meteoraEntry = {
      poolAddress: Keypair.generate().publicKey.toBase58(),
      dexType: "meteora-dlmm" as const,
      label: "MET/USDC — meteora-dlmm",
      symbol: "MET/USDC",
    };
    const pumpswapEntry = {
      poolAddress: Keypair.generate().publicKey.toBase58(),
      dexType: "pumpswap" as const,
      label: "PUMP/WSOL — pumpswap",
      symbol: "PUMP/WSOL",
    };
    let batchCall = 0;
    const conn = {
      rpcEndpoint: "https://ep-contain",
      getMultipleAccountsInfoAndContext: (keys: PublicKey[]) => {
        batchCall++;
        if (batchCall === 1) {
          // pass 1: pool accounts, in entry order
          return Promise.resolve(
            ctx(100, [
              { owner: METEORA_OWNER, data: Buffer.from(makeMeteoraPool(0, 100)) },
              { owner: PUMPSWAP_OWNER, data: Buffer.alloc(400) },
            ]),
          );
        }
        // pass 2: the pumpswap vault batch — the failing read
        return Promise.reject(new Error("429 Too Many Requests — and backoff exhausted"));
      },
    } as unknown as Connection;

    // Decimals pre-cached so the meteora path needs no extra RPC.
    const decimals = new Map([[meteoraEntry.poolAddress, { base: 6, quote: 6 }]]);
    const out = await readAllPoolPricesE6(conn, [meteoraEntry, pumpswapEntry], decimals);

    // The audit failure mode: `out` used to be lost entirely (the throw
    // propagated). Now the meteora price MUST be present…
    const met = out.get(meteoraEntry.poolAddress);
    assert.ok(met !== undefined && met > 0n, "pass-1 meteora price was discarded");
    // …and only the pumpswap market goes unpriced this cycle.
    assert.equal(out.get(pumpswapEntry.poolAddress), undefined);
  });
});

// ── 3. Wipe-the-board guard ──────────────────────────────────────────────────

function entry(sym: string): MarketEntry {
  return {
    marketAddress: Keypair.generate().publicKey.toBase58(),
    assetIndex: 0,
    poolAddress: Keypair.generate().publicKey.toBase58(),
    dexType: "pumpswap",
    label: `${sym}/USDC — pumpswap`,
    symbol: sym,
  } as MarketEntry;
}

describe("register-poll refuses a successful-but-empty DB result against 3+ local markets", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetchRows(rows: unknown[]): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  it("3 local markets + 200 [] FOREVER → registry still untouched past the absence threshold", async () => {
    stubFetchRows([]);
    const registry: Registry = { markets: [entry("A"), entry("B"), entry("C")] } as Registry;
    const before = registry.markets.map((m) => m.marketAddress);
    const registryPath = join(mkdtempSync(join(tmpdir(), "wm-guard-")), "registry.json");
    const cfg = {
      db: { url: "https://db.example", key: "k", network: "devnet" },
      registryPath,
      // no connection/expectedOwner → owner filter skipped
    } as never;
    // One empty poll proves nothing (the absence threshold alone survives it)
    // — the guard's whole point is surviving SUSTAINED drift. Run well past
    // ABSENCE_THRESHOLD: unguarded, poll 3 retires all three markets.
    for (let i = 0; i < 5; i++) {
      const n = await pollOnce(registry, cfg);
      assert.equal(n, 0);
    }
    assert.equal(existsSync(registryPath), false, "must not persist during a refused reconcile");
    assert.deepEqual(
      registry.markets.map((m) => m.marketAddress),
      before,
      "guard must leave the registry exactly as it was",
    );
  });

  it("2 local markets + 200 [] → normal retirement path still works (threshold applies)", async () => {
    stubFetchRows([]);
    const registry: Registry = { markets: [entry("A"), entry("B")] } as Registry;
    const registryPath = join(mkdtempSync(join(tmpdir(), "wm-guard2-")), "registry.json");
    const cfg = {
      db: { url: "https://db.example", key: "k", network: "devnet" },
      registryPath,
    } as never;
    // Below ABSENCE_THRESHOLD polls: entries survive on absence counts.
    await pollOnce(registry, cfg);
    await pollOnce(registry, cfg);
    assert.equal(registry.markets.length, 2, "absence threshold not yet reached");
    await pollOnce(registry, cfg);
    assert.equal(registry.markets.length, 0, "small boards must still retire normally");
  });
});
