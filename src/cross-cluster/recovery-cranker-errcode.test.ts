import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCustomErrorCode } from "./recovery-cranker.js";

test("BigInt-bearing error object does not throw", () => {
  assert.equal(parseCustomErrorCode({ InstructionError: [0n, { Custom: 22 }] }), 22);
  assert.equal(parseCustomErrorCode({ slot: 5n, msg: "x" }), null);
  assert.equal(parseCustomErrorCode({ a: 1n, e: { Custom: 7 } }), 7);
});

test("circular error object is unclassified, not a throw", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  assert.equal(parseCustomErrorCode(o), null);
});

test("structured InstructionError code wins over text", () => {
  assert.equal(
    parseCustomErrorCode({ InstructionError: [1, { Custom: 121 }], note: "custom program error: 0x5" }),
    121,
  );
});

test("decimal Custom matches with or without spaces; hex string; none", () => {
  assert.equal(parseCustomErrorCode('{"InstructionError":[0, {"Custom": 19}]}'), 19);
  assert.equal(parseCustomErrorCode('{"InstructionError":[0,{"Custom":19}]}'), 19);
  assert.equal(parseCustomErrorCode("Program failed: custom program error: 0x15"), 21);
  assert.equal(parseCustomErrorCode(null), null);
});
