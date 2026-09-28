/**
 * parseFailingPush — maps a REAL simulateTransaction `err` onto the offending
 * push inside a PushAuthMark batch (ix 0 = ComputeBudget, push k = ix k+1).
 * Shapes below are copied from the live keeper log / devnet getTransaction.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/push-error-parse.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFailingPush } from "./auth-mark-pusher.ts";

const real = (s: string): unknown => JSON.parse(s);

describe("parseFailingPush", () => {
  it("names the first push for the live Custom(19) shape", () => {
    assert.deepEqual(parseFailingPush(real('{"InstructionError":[1,{"Custom":19}]}'), 13), {
      position: 0,
      custom: 19,
    });
  });

  it("names a later push", () => {
    assert.deepEqual(parseFailingPush(real('{"InstructionError":[14,{"Custom":21}]}'), 16), {
      position: 13,
      custom: 21,
    });
  });

  it("keeps the position but no custom code for a non-Custom instruction error", () => {
    assert.deepEqual(parseFailingPush(real('{"InstructionError":[2,"InvalidAccountData"]}'), 3), {
      position: 1,
      custom: null,
    });
  });

  it("refuses to blame a market for the ComputeBudget ix (index 0) or an out-of-range index", () => {
    assert.equal(parseFailingPush(real('{"InstructionError":[0,{"Custom":1}]}'), 3), null);
    assert.equal(parseFailingPush(real('{"InstructionError":[4,{"Custom":19}]}'), 3), null);
  });

  it("returns null for transaction-level errors that name no instruction", () => {
    assert.equal(parseFailingPush("InsufficientFundsForFee", 3), null);
    assert.equal(parseFailingPush(real('"AccountNotFound"'), 3), null);
    assert.equal(parseFailingPush(real('{"InsufficientFundsForRent":{"account_index":0}}'), 3), null);
    assert.equal(parseFailingPush(null, 3), null);
  });
});
