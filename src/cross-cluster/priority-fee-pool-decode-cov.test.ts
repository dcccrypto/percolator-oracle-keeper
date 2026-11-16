/**
 * Coverage pins for priority-fee.ts (env parse edge cases, process.env cache, ix off/on) and
 * stake-pool-decode.ts (version-byte dispatch, length guard, legacy path).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ComputeBudgetProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  addKeeperPriorityFee,
  KEEPER_PRIORITY_FEE_ENV,
  keeperPriorityFeeIxs,
  keeperPriorityFeeMicroLamports,
  MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS as CAP,
  parseKeeperPriorityFee,
  resetKeeperPriorityFeeCache,
} from "./priority-fee.ts";
import {
  decodeStakePoolAnyVersion,
  isStakePoolV5,
  STAKE_POOL_SIZE_V5,
  STAKE_POOL_VERSION_OFF,
  STAKE_POOL_VERSION_V5,
} from "./stake-pool-decode.ts";

describe("parseKeeperPriorityFee edge cases", () => {
  it("empty / whitespace-only / undefined are OFF with no note", () => {
    for (const raw of [undefined, "", "   "]) assert.deepEqual(parseKeeperPriorityFee(raw), { microLamports: 0, note: null });
  });
  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseKeeperPriorityFee(" 7 "), { microLamports: 7, note: null });
  });
  it("non-decimal forms are OFF with a note", () => {
    for (const raw of ["1e3", "-1", "0x10"]) {
      const r = parseKeeperPriorityFee(raw);
      assert.equal(r.microLamports, 0, raw);
      assert.match(r.note ?? "", /not a whole number/);
    }
  });
  it("cap boundary: cap is exact, cap+1 clamps", () => {
    assert.equal(parseKeeperPriorityFee(String(CAP)).note, null);
    const r = parseKeeperPriorityFee("100001");
    assert.equal(r.microLamports, CAP);
    assert.match(r.note ?? "", /above the cap/);
  });
  it("2^53+1 (unsafe integer) clamps to the cap", () => {
    const r = parseKeeperPriorityFee("9007199254740993");
    assert.equal(r.microLamports, CAP);
    assert.match(r.note ?? "", /clamped/);
  });
});

describe("keeperPriorityFeeMicroLamports cache", () => {
  const warn = console.warn;
  const log = console.log;
  let warns: string[];
  let logs: string[];
  beforeEach(() => {
    warns = [];
    logs = [];
    console.warn = (m: string) => void warns.push(String(m));
    console.log = (m: string) => void logs.push(String(m));
    delete process.env[KEEPER_PRIORITY_FEE_ENV];
    resetKeeperPriorityFeeCache();
  });
  afterEach(() => {
    console.warn = warn;
    console.log = log;
    delete process.env[KEEPER_PRIORITY_FEE_ENV];
    resetKeeperPriorityFeeCache();
  });

  it("process.env read is cached until reset; logs once", () => {
    process.env[KEEPER_PRIORITY_FEE_ENV] = "50";
    assert.equal(keeperPriorityFeeMicroLamports(), 50);
    process.env[KEEPER_PRIORITY_FEE_ENV] = "60";
    assert.equal(keeperPriorityFeeMicroLamports(), 50, "cached");
    assert.equal(logs.length, 1);
    resetKeeperPriorityFeeCache();
    assert.equal(keeperPriorityFeeMicroLamports(), 60);
    assert.equal(logs.length, 2);
  });
  it("a bad process.env value warns and caches OFF", () => {
    process.env[KEEPER_PRIORITY_FEE_ENV] = "abc";
    assert.equal(keeperPriorityFeeMicroLamports(), 0);
    assert.equal(warns.length, 1);
    assert.equal(logs.length, 0);
    assert.equal(keeperPriorityFeeMicroLamports(), 0);
    assert.equal(warns.length, 1, "no second warning from the cache");
  });
  it("an explicit env object is parsed every call, never cached, never logged", () => {
    assert.equal(keeperPriorityFeeMicroLamports({ [KEEPER_PRIORITY_FEE_ENV]: "9" }), 9);
    assert.equal(keeperPriorityFeeMicroLamports({ [KEEPER_PRIORITY_FEE_ENV]: "11" }), 11);
    assert.equal(keeperPriorityFeeMicroLamports({}), 0);
    assert.equal(keeperPriorityFeeMicroLamports({ [KEEPER_PRIORITY_FEE_ENV]: "x" }), 0);
    assert.equal(logs.length + warns.length, 0);
  });
  it("an explicit env object ignores a populated process.env cache", () => {
    process.env[KEEPER_PRIORITY_FEE_ENV] = "50";
    assert.equal(keeperPriorityFeeMicroLamports(), 50);
    assert.equal(keeperPriorityFeeMicroLamports({ [KEEPER_PRIORITY_FEE_ENV]: "3" }), 3);
  });
});

describe("keeperPriorityFeeIxs / addKeeperPriorityFee", () => {
  it("off: no instruction", () => {
    assert.deepEqual(keeperPriorityFeeIxs(0), []);
  });
  it("on: one SetComputeUnitPrice with the price", () => {
    const ixs = keeperPriorityFeeIxs(123);
    assert.equal(ixs.length, 1);
    assert.ok(ixs[0].programId.equals(ComputeBudgetProgram.programId));
    assert.equal(ixs[0].data[0], 3);
    assert.equal(Buffer.from(ixs[0].data).readBigUInt64LE(1), 123n);
  });
  it("a compute-budget ix that is not SetComputeUnitPrice does not block the append", () => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }));
    addKeeperPriorityFee(tx, 5);
    assert.equal(tx.instructions.length, 2);
  });
  it("a compute-budget ix with empty data does not count as a price", () => {
    const tx = new Transaction().add(new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(0) }));
    addKeeperPriorityFee(tx, 5);
    assert.equal(tx.instructions.length, 2);
  });
});

describe("stake-pool-decode dispatch", () => {
  it("isStakePoolV5 needs both length and version byte", () => {
    const short = new Uint8Array(STAKE_POOL_SIZE_V5 - 1);
    short[STAKE_POOL_VERSION_OFF] = STAKE_POOL_VERSION_V5;
    assert.equal(isStakePoolV5(short), false);
    const ok = new Uint8Array(STAKE_POOL_SIZE_V5);
    assert.equal(isStakePoolV5(ok), false);
    ok[STAKE_POOL_VERSION_OFF] = STAKE_POOL_VERSION_V5;
    assert.equal(isStakePoolV5(ok), true);
  });
  it("unknown layout throws instead of guessing", () => {
    assert.throws(() => decodeStakePoolAnyVersion(new Uint8Array(17)));
    assert.throws(() => decodeStakePoolAnyVersion(new Uint8Array(STAKE_POOL_SIZE_V5)));
  });
});
