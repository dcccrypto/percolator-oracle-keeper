/**
 * env-utils numeric parsing: plain decimal only (same rule as #315 / #333).
 * `Number(raw)` used to accept hex/binary/octal/exponent forms, silently turning a typo into a
 * different guard threshold (e.g. MAX_PRICE_MOVE_PCT=0x10 -> 16).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveNumberEnv, parsePositiveLamportsFromSolEnv } from "./env-utils.ts";

const VAR = "ENV_UTILS_TEST_VAR";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
}

describe("parsePositiveNumberEnv: plain decimal only", () => {
  const ok: Array<[string, number]> = [
    ["15", 15],
    ["2.5", 2.5],
    ["0.5", 0.5],
    [".5", 0.5],
    [" 5 ", 5], // surrounding whitespace is trimmed, value unambiguous
    ["007", 7],
  ];
  for (const [raw, want] of ok) {
    it(`accepts ${JSON.stringify(raw)} -> ${want}`, () => {
      assert.equal(withEnv(raw, () => parsePositiveNumberEnv(VAR, 10)), want);
    });
  }

  const bad = ["0x10", "0X1f", "0b11", "0o7", "1e3", "1E3", "5e-1", "+5", "-5", "1_000", "1.", "5 5", "1,5", "Infinity", "NaN", "0x", "."];
  for (const raw of bad) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => withEnv(raw, () => parsePositiveNumberEnv(VAR, 10)), new RegExp(VAR));
    });
  }

  it("still applies the max bound", () => {
    assert.throws(() => withEnv("100", () => parsePositiveNumberEnv(VAR, 10, 100)), /less than 100/);
  });
});

describe("parsePositiveLamportsFromSolEnv: edge forms (already strict, pinned)", () => {
  const ok: Array<[string, number]> = [
    ["1", 1_000_000_000],
    ["1.", 1_000_000_000],
    [".5", 500_000_000],
    [" 0.05 ", 50_000_000],
    ["0.000000001", 1],
    ["0.0000000010", 1], // trailing zero past 9 digits is exact
  ];
  for (const [raw, want] of ok) {
    it(`accepts ${JSON.stringify(raw)} -> ${want}`, () => {
      assert.equal(withEnv(raw, () => parsePositiveLamportsFromSolEnv(VAR, 0.05)), want);
    });
  }
  const bad = ["-1", "+1", "1e3", "0x10", "1.5e0", ".", "0", "0.0", "0.0000000001", "9007199.254740992", "9007199.254740993", "1 2"];
  for (const raw of bad) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      assert.throws(() => withEnv(raw, () => parsePositiveLamportsFromSolEnv(VAR, 0.05)), new RegExp(VAR));
    });
  }
  it("accepts the largest safe lamport amount, rejects one more", () => {
    assert.equal(withEnv("9007199.254740991", () => parsePositiveLamportsFromSolEnv(VAR, 0.05)), Number.MAX_SAFE_INTEGER);
    assert.throws(() => withEnv("9007199.254740992", () => parsePositiveLamportsFromSolEnv(VAR, 0.05)), /unsafe/);
  });
});
