/**
 * parseCrossClusterPositiveNumberEnv must accept plain decimals only (same rule as
 * parsePositiveNumberEnv, #355): Number() would turn 0x10, 1e3, 0b11, +5 into a
 * different threshold instead of failing the boot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCrossClusterPositiveNumberEnv } from "./keeper-loop.ts";

const VAR = "CC_POSNUM_DECIMAL_TEST";

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

describe("parseCrossClusterPositiveNumberEnv decimal-only", () => {
  it("rejects hex, binary, octal, exponent and signed forms", () => {
    for (const bad of ["0x10", "0b11", "0o7", "1e3", "1E3", "+5", "-5", "Infinity", "NaN", "5abc", "1_000"]) {
      assert.throws(
        () => withEnv(bad, () => parseCrossClusterPositiveNumberEnv(VAR, 1)),
        /finite positive number/,
        `should reject ${bad}`,
      );
    }
  });

  it("accepts plain decimals, trimmed", () => {
    assert.equal(withEnv("15000", () => parseCrossClusterPositiveNumberEnv(VAR, 1)), 15000);
    assert.equal(withEnv(" 2.5 ", () => parseCrossClusterPositiveNumberEnv(VAR, 1)), 2.5);
    assert.equal(withEnv(".5", () => parseCrossClusterPositiveNumberEnv(VAR, 1)), 0.5);
  });

  it("falls back when unset or blank; enforces zero and exclusive max", () => {
    assert.equal(withEnv(undefined, () => parseCrossClusterPositiveNumberEnv(VAR, 7)), 7);
    assert.equal(withEnv("  ", () => parseCrossClusterPositiveNumberEnv(VAR, 7)), 7);
    assert.throws(() => withEnv("0", () => parseCrossClusterPositiveNumberEnv(VAR, 7)));
    assert.throws(() => withEnv("100", () => parseCrossClusterPositiveNumberEnv(VAR, 7, 100)), /less than 100/);
    assert.equal(withEnv("99.9", () => parseCrossClusterPositiveNumberEnv(VAR, 7, 100)), 99.9);
  });
});
