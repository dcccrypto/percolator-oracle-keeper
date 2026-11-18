/**
 * Decimal-only contract for the shared boot-time env parsers.
 * Number(raw) silently accepts hex/binary/octal/exponent/padded forms as guard thresholds;
 * those must fail boot instead (same class as the depth-capacity parser fix).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bootPositiveNumberEnv,
  parsePositiveLamportsFromSolEnv,
  parsePositiveNumberEnv,
} from "./env-utils.ts";

const K = "TEST_DECIMAL_ONLY_ENV";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[K];
  if (value === undefined) delete process.env[K];
  else process.env[K] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[K];
    else process.env[K] = prev;
  }
}

describe("parsePositiveNumberEnv is decimal-only", () => {
  const rejected = ["0x10", "0X1F", "0b11", "0o17", "1e3", "1E3", "1e-3", " 5 ", "\t7", "5_000", "+5", "5n", "Infinity", "1,000", "--1", "1.2.3", "."];
  for (const raw of rejected) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      withEnv(raw, () => assert.throws(() => parsePositiveNumberEnv(K, 9), /finite positive/));
    });
  }

  const accepted: Array<[string, number]> = [["5", 5], ["30000", 30000], ["0.5", 0.5], [".5", 0.5], ["5.", 5], ["007", 7], ["99.9", 99.9]];
  for (const [raw, want] of accepted) {
    it(`accepts decimal ${JSON.stringify(raw)}`, () => {
      withEnv(raw, () => assert.equal(parsePositiveNumberEnv(K, 9), want));
    });
  }

  it("keeps fallback for unset / empty / whitespace-only", () => {
    for (const raw of [undefined, "", "   "]) {
      withEnv(raw, () => assert.equal(parsePositiveNumberEnv(K, 9), 9));
    }
  });

  it("keeps zero rejection and exclusive max", () => {
    withEnv("0", () => assert.throws(() => parsePositiveNumberEnv(K, 9)));
    withEnv("0.0", () => assert.throws(() => parsePositiveNumberEnv(K, 9)));
    withEnv("100", () => assert.throws(() => parsePositiveNumberEnv(K, 9, 100), /less than 100/));
    withEnv("99.99", () => assert.equal(parsePositiveNumberEnv(K, 9, 100), 99.99));
  });

  it("rejects digit strings that overflow to Infinity", () => {
    withEnv("9".repeat(400), () => assert.throws(() => parsePositiveNumberEnv(K, 9)));
  });
});

describe("bootPositiveNumberEnv exits 1 on non-decimal", () => {
  for (const raw of ["0x10", "1e3", "0b11", " 5 ", "5_000"]) {
    it(`fatal exit for ${JSON.stringify(raw)}`, () => {
      const lines: string[] = [];
      let code: number | undefined;
      withEnv(raw, () => {
        const exit = ((c: number) => { code = c; return undefined as never; });
        bootPositiveNumberEnv(K, 9, undefined, exit, (l) => lines.push(l));
      });
      assert.equal(code, 1);
      assert.match(lines[0], /^\[fatal\] TEST_DECIMAL_ONLY_ENV must be a finite positive/);
    });
  }
});

describe("parsePositiveLamportsFromSolEnv same-class pins", () => {
  for (const raw of ["0x10", "1e3", "1e-9", "+1", "-1", "0b1", "1_0", "1.0000000001", "0.0000000001", "NaN"]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      withEnv(raw, () => assert.throws(() => parsePositiveLamportsFromSolEnv(K, 0.05)));
    });
  }
  it("accepts exact decimals and trailing-zero excess digits; trims whitespace (documented)", () => {
    withEnv("0.05", () => assert.equal(parsePositiveLamportsFromSolEnv(K, 1), 50_000_000));
    withEnv("1.123456789", () => assert.equal(parsePositiveLamportsFromSolEnv(K, 1), 1_123_456_789));
    withEnv("1.1234567890", () => assert.equal(parsePositiveLamportsFromSolEnv(K, 1), 1_123_456_789));
    withEnv(undefined, () => assert.equal(parsePositiveLamportsFromSolEnv(K, 0.05), 50_000_000));
  });
});
