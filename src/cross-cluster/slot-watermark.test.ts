/**
 * Slot-consistency watermark tests (the CATE LP drain fix, 2026-07-31).
 *
 * The failure mode these guard: a load-balanced RPC serving alternating
 * fresh/stale account snapshots, which published a two-level flapping price
 * (~1.6% apart) and let the engine ratchet the CATE LP to $0. The fix is
 * `readAtWatermark`: every pricing read carries `minContextSlot` = the highest
 * context slot already seen from that endpoint, so a lagging node can error
 * but can never silently serve the past.
 *
 * These tests exercise the REAL exported functions — `readAtWatermark`
 * directly, and `readAllPoolPricesE6` / `readPoolPriceE6` end-to-end through
 * fake Connections that capture the configs actually sent to the RPC — so a
 * regression that drops the `minContextSlot` wiring fails here.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/slot-watermark.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  readAtWatermark,
  resetSlotWatermarksForTests,
  readAllPoolPricesE6,
  readPoolPriceE6,
} from "./price-reader.ts";

beforeEach(() => {
  resetSlotWatermarksForTests();
});

function ctx<T>(slot: number, value: T) {
  return { context: { slot }, value };
}

describe("readAtWatermark", () => {
  it("passes undefined on the first read, then the last seen slot", async () => {
    const conn = { rpcEndpoint: "https://ep-a" } as Connection;
    const seen: Array<number | undefined> = [];
    const read = (mcs: number | undefined) => {
      seen.push(mcs);
      return Promise.resolve(ctx(100, "x"));
    };
    assert.equal(await readAtWatermark(conn, read), "x");
    await readAtWatermark(conn, read);
    assert.deepEqual(seen, [undefined, 100]);
  });

  it("rejects a response served below the requested slot (provider ignoring minContextSlot)", async () => {
    const conn = { rpcEndpoint: "https://ep-a" } as Connection;
    await readAtWatermark(conn, () => Promise.resolve(ctx(200, 0)));
    // Node claims slot 150 < watermark 200 twice, then catches up: the stale
    // responses must be DISCARDED (retried), never returned to the caller.
    const slots = [150, 150, 201];
    const served: string[] = ["stale-a", "stale-b", "fresh"];
    let i = 0;
    const value = await readAtWatermark(conn, () => {
      const r = ctx(slots[i], served[i]);
      i++;
      return Promise.resolve(r);
    });
    assert.equal(value, "fresh");
    assert.equal(i, 3);
    // And a node that NEVER catches up exhausts retries and throws — the
    // cycle skips rather than pricing off the past.
    await assert.rejects(
      readAtWatermark(conn, () => Promise.resolve(ctx(10, "ancient"))),
      /[Mm]inimum context slot/,
    );
  });

  it("keeps watermarks independent per endpoint", async () => {
    const connA = { rpcEndpoint: "https://ep-a" } as Connection;
    const connB = { rpcEndpoint: "https://ep-b" } as Connection;
    const seenA: Array<number | undefined> = [];
    const seenB: Array<number | undefined> = [];
    await readAtWatermark(connA, (m) => (seenA.push(m), Promise.resolve(ctx(500, 1))));
    await readAtWatermark(connB, (m) => (seenB.push(m), Promise.resolve(ctx(9, 1))));
    await readAtWatermark(connA, (m) => (seenA.push(m), Promise.resolve(ctx(501, 1))));
    await readAtWatermark(connB, (m) => (seenB.push(m), Promise.resolve(ctx(10, 1))));
    assert.deepEqual(seenA, [undefined, 500]);
    assert.deepEqual(seenB, [undefined, 9]);
  });

  it("retries a behind-node (minimum context slot) error, then succeeds", async () => {
    const conn = { rpcEndpoint: "https://ep-a" } as Connection;
    await readAtWatermark(conn, () => Promise.resolve(ctx(300, 0)));
    let calls = 0;
    const read = (_mcs: number | undefined) => {
      calls++;
      if (calls < 3) {
        return Promise.reject(
          new Error("failed to get info about account: Minimum context slot has not been reached"),
        );
      }
      return Promise.resolve(ctx(305, "fresh"));
    };
    assert.equal(await readAtWatermark(conn, read), "fresh");
    assert.equal(calls, 3);
  });

  it("gives up after MIN_SLOT_RETRIES behind-node errors", async () => {
    const conn = { rpcEndpoint: "https://ep-a" } as Connection;
    await readAtWatermark(conn, () => Promise.resolve(ctx(300, 0)));
    let calls = 0;
    await assert.rejects(
      readAtWatermark(conn, () => {
        calls++;
        return Promise.reject(new Error("Minimum context slot has not been reached"));
      }),
      /[Mm]inimum context slot/,
    );
    assert.equal(calls, 3);
  });

  it("propagates other errors immediately without retrying", async () => {
    const conn = { rpcEndpoint: "https://ep-a" } as Connection;
    let calls = 0;
    await assert.rejects(
      readAtWatermark(conn, () => {
        calls++;
        return Promise.reject(new Error("connection refused"));
      }),
      /connection refused/,
    );
    assert.equal(calls, 1);
  });
});

describe("watermark wiring in the real read paths", () => {
  const entry = {
    poolAddress: Keypair.generate().publicKey.toBase58(),
    dexType: "raydium-clmm" as const,
    label: "TEST/USDC — raydium-clmm",
    symbol: "TEST/USDC",
  };

  it("readAllPoolPricesE6 batch fetch carries the advancing watermark", async () => {
    const captured: Array<{ minContextSlot?: number }> = [];
    let slot = 1000;
    const conn = {
      rpcEndpoint: "https://ep-batch",
      getMultipleAccountsInfoAndContext: (
        keys: PublicKey[],
        config: { minContextSlot?: number },
      ) => {
        captured.push(config);
        slot += 7;
        return Promise.resolve(ctx(slot, keys.map(() => null)));
      },
    } as unknown as Connection;

    await readAllPoolPricesE6(conn, [entry], new Map());
    await readAllPoolPricesE6(conn, [entry], new Map());

    assert.equal(captured.length, 2);
    assert.equal(captured[0].minContextSlot, undefined);
    // Second cycle must demand at least the slot the first cycle was served at.
    assert.equal(captured[1].minContextSlot, 1007);
  });

  it("readAllPoolPricesE6 reference-pool fetch shares the same watermark", async () => {
    const refPool = Keypair.generate().publicKey;
    const capturedRef: Array<{ minContextSlot?: number }> = [];
    const conn = {
      rpcEndpoint: "https://ep-ref",
      getMultipleAccountsInfoAndContext: (keys: PublicKey[], _config: unknown) =>
        Promise.resolve(ctx(2000, keys.map(() => null))),
      getAccountInfoAndContext: (_pk: PublicKey, config: { minContextSlot?: number }) => {
        capturedRef.push(config);
        return Promise.resolve(ctx(2001, null));
      },
    } as unknown as Connection;

    // A pumpswap entry forces the SOL/USD reference resolution path.
    const psEntry = { ...entry, dexType: "pumpswap" as const };
    await readAllPoolPricesE6(conn, [psEntry], new Map(), refPool.toBase58());

    assert.equal(capturedRef.length, 1);
    // The batch fetch ran first at slot 2000 — the ref fetch must demand it.
    assert.equal(capturedRef[0].minContextSlot, 2000);
  });

  it("readPoolPriceE6 single-pool fetch carries the watermark", async () => {
    const captured: Array<{ minContextSlot?: number }> = [];
    const conn = {
      rpcEndpoint: "https://ep-single",
      getAccountInfoAndContext: (_pk: PublicKey, config: { minContextSlot?: number }) => {
        captured.push(config);
        return Promise.resolve(ctx(3000, null));
      },
    } as unknown as Connection;

    const r1 = await readPoolPriceE6(conn, entry, new Map());
    const r2 = await readPoolPriceE6(conn, entry, new Map());
    assert.equal(r1.skipped, true);
    assert.equal(r2.skipped, true);
    assert.equal(captured[0].minContextSlot, undefined);
    assert.equal(captured[1].minContextSlot, 3000);
  });
});

describe("no bare (context-less) pricing reads can sneak back in", () => {
  it("price-reader.ts only reads accounts via ...AndContext", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("./price-reader.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    // Bare forms return no context slot, so they cannot maintain the
    // watermark — their presence means a read escaped the fix.
    assert.doesNotMatch(src, /getAccountInfo\(/);
    assert.doesNotMatch(src, /getMultipleAccountsInfo\(/);
  });
});
