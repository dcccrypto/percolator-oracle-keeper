/**
 * Unit tests for cross-cluster/fee-error.ts: every exported classifier/formatter, table-driven.
 *
 * The code→name table below is the `PercolatorError` enum of percolator-prog src/v16_program.rs:574 (variant ordinal
 * == `Custom(n)`, 0..64), copied at prog 1dd268ad. `formatWrapperCode` must agree with it for every ordinal; a
 * disagreement is a mapping bug, not a test to loosen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import {
  ORACLE_STALE,
  STALE_WAIT_SLOT_SKEW,
  chainSlotOrNull,
  clipKeepingCode,
  describeProgramError,
  errorText,
  formatWrapperCode,
  programErrorCode,
  staleResolveWait,
} from "./fee-error.ts";
import { CFG_LAST_GOOD_ORACLE_SLOT, CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS, CONFIG_OFF } from "./market-state.ts";

const PROG_ERROR_ENUM: readonly string[] = [
  "InvalidMagic",
  "InvalidVersion",
  "AlreadyInitialized",
  "NotInitialized",
  "InvalidAccountKind",
  "InvalidAccountLen",
  "ExpectedSigner",
  "ExpectedWritable",
  "Unauthorized",
  "InvalidInstruction",
  "InvalidMint",
  "InvalidTokenAccount",
  "InvalidVaultAccount",
  "InvalidTokenProgram",
  "EngineInvalidConfig",
  "EngineArithmeticOverflow",
  "EngineProvenanceMismatch",
  "EngineHiddenLeg",
  "EngineInvalidLeg",
  "EngineStale",
  "EngineBStale",
  "EngineLockActive",
  "EngineNonProgress",
  "EngineRecoveryRequired",
  "EngineCounterOverflow",
  "EngineCounterUnderflow",
  "OracleInvalid",
  "OracleStale",
  "OracleConfTooWide",
  "InvalidOracleKey",
  "LpVaultAlreadyExists",
  "LpVaultNotFound",
  "LpVaultPaused",
  "LpVaultSharesOutstanding",
  "LpVaultZeroAmount",
  "LpVaultInsufficientShares",
  "LpVaultCooldownActive",
  "LpVaultOiReservationViolated",
  "LpVaultNoFeesToCrank",
  "LpVaultSupplyMismatch",
  "LpVaultAuthorityMismatch",
  "LpVaultZeroSharesMinted",
  "NftRegistryNotFound",
  "NftPortfolioNotTransferable",
  "NftTransferSelfOrZero",
  "NftInvalidMintAuthority",
  "NftPortfolioProvenance",
  "InsuranceWithdrawCooldownActive",
  "InsuranceWithdrawCeilingExceeded",
  "EngineInsufficientInitialMargin",
  "LpVaultDepositBelowMinimumLiquidity",
  "FeeSplitFloorViolation",
  "FeeSplitSumInvalid",
  "NoInsuranceReserveToClaim",
  "StakePoolNotBound",
  "StakePoolOwnerMismatch",
  "StakePoolAuthorityMismatch",
  "StakePoolMarketMismatch",
  "StakePoolWrapperMismatch",
  "StakePoolModeMismatch",
  "StakeProgramNotPinned",
  "AssetSlotAlreadyConfigured",
  "CreatorFeeOverClaim",
  "LpVaultBackingBucketNotEmpty",
  "RentExemptRequired",
];

const hex = (n: number) => `0x${n.toString(16)}`;
const simFailed = (code: number) =>
  `Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: ${hex(code)}. \n` +
  `Logs: \n[\n  "Program X failed: custom program error: ${hex(code)}"\n]. \nCatch the \`SendTransactionError\` and call \`getLogs()\` on it for full details.`;

function marketBytes(lastGood: bigint, staleSlots?: bigint): Buffer {
  const d = Buffer.from(readFileSync(new URL("./__fixtures__/v22-chillhouse-market-v19.b64", import.meta.url), "utf8").trim(), "base64");
  d.writeBigUInt64LE(lastGood, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  if (staleSlots !== undefined) d.writeBigUInt64LE(staleSlots, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
  return d;
}

describe("constants", () => {
  it("ORACLE_STALE is the prog OracleStale ordinal and the skew is 32 slots", () => {
    assert.equal(PROG_ERROR_ENUM[ORACLE_STALE], "OracleStale");
    assert.equal(ORACLE_STALE, 27);
    assert.equal(STALE_WAIT_SLOT_SKEW, 32n);
  });
});

describe("formatWrapperCode vs the prog PercolatorError enum", () => {
  for (const [code, name] of PROG_ERROR_ENUM.entries()) {
    it(`Custom(${code}) -> ${name}(${code})`, () => {
      assert.equal(formatWrapperCode(code), `${name}(${code})`);
    });
  }
  for (const code of [999, 65535, -1]) {
    it(`unknown code ${code} -> Custom(${code})`, () => {
      assert.equal(formatWrapperCode(code), `Custom(${code})`);
    });
  }
});

describe("errorText", () => {
  const cases: [string, unknown, string][] = [
    ["plain string", "boom", "boom"],
    ["Error", new Error("bad"), "bad"],
    ["Error with empty logs array", Object.assign(new Error("bad"), { logs: [] }), "bad"],
    ["Error with non-array logs", Object.assign(new Error("bad"), { logs: "nope" }), "bad"],
    ["Error with logs appended", Object.assign(new Error("bad"), { logs: ["l1", "l2"] }), "bad\nl1\nl2"],
    ["object", { InstructionError: [1, { Custom: 27 }] }, '{"InstructionError":[1,{"Custom":27}]}'],
    ["null", null, "null"],
    ["undefined", undefined, "null"],
    ["number", 42, "42"],
  ];
  for (const [label, input, want] of cases) it(label, () => assert.equal(errorText(input), want));

  it("a value JSON.stringify cannot render falls back to String()", () => {
    const fn = () => 1; // JSON.stringify(fn) is undefined
    assert.equal(errorText(fn), String(fn));
    assert.equal(errorText(Symbol("s")), "Symbol(s)");
  });
});

describe("programErrorCode", () => {
  const cases: [string, unknown, number | null][] = [
    ["hex in a message", new Error("custom program error: 0x1b"), 27],
    ["uppercase hex", "custom program error: 0x1B", 27],
    ["web3.js SendTransactionError text", simFailed(27), 27],
    ["code only in the nested logs", Object.assign(new Error("Simulation failed."), { logs: ["Program P failed: custom program error: 0x36"] }), 54],
    ["decimal Custom object", { InstructionError: [0, { Custom: 30 }] }, 30],
    ["decimal Custom string", '{"Custom": 12}', 12],
    ["no code", new Error("blockhash not found"), null],
    ["null", null, null],
    ["non-Error throw (number)", 7, null],
  ];
  for (const [label, input, want] of cases) it(label, () => assert.equal(programErrorCode(input), want));
});

describe("describeProgramError", () => {
  it("puts Name(code) first, after `where`, and drops the Simulation failed boilerplate", () => {
    const out = describeProgramError("lp-fee", simFailed(27));
    assert.ok(out.startsWith("lp-fee OracleStale(27) — Transaction simulation failed"), out);
    assert.ok(!out.includes("Simulation failed. "), out);
    assert.ok(!out.includes("\n"), out);
  });

  it("keeps the code even when the human text is clipped to a few chars", () => {
    const out = describeProgramError("w", simFailed(27), 5);
    assert.equal(out, "w OracleStale(27) — Trans…");
  });

  it("does not clip text at or under maxText", () => {
    assert.equal(describeProgramError("w", "custom program error: 0x1b", 26), "w OracleStale(27) — custom program error: 0x1b");
  });

  it("unnamed code -> Custom(n)", () => {
    assert.equal(describeProgramError("w", "custom program error: 0x3e7", 100), "w Custom(999) — custom program error: 0x3e7");
  });

  it("no code: `where: text` (clipped)", () => {
    assert.equal(describeProgramError("w", new Error("socket hang up")), "w: socket hang up");
    assert.equal(describeProgramError("w", "x".repeat(10), 4), "w: xxxx…");
  });

  it("code with an empty text has no dash tail", () => {
    assert.equal(describeProgramError("w", { Custom: 27 }, 0).startsWith("w OracleStale(27)"), true);
    assert.equal(describeProgramError("w", "\ncustom program error: 0x1b"), "w OracleStale(27)");
  });

  it("strips a bare `Message:` prefix and keeps only the first line", () => {
    assert.equal(describeProgramError("w", "Message: first\nsecond"), "w: first");
  });

  it("non-Error throws: object / null / number", () => {
    assert.equal(describeProgramError("w", { InstructionError: [1, { Custom: 27 }] }).startsWith("w OracleStale(27)"), true);
    assert.equal(describeProgramError("w", null), "w: null");
    assert.equal(describeProgramError("w", 42), "w: 42");
  });

  it("reads the code from nested SendTransactionError logs", () => {
    const err = Object.assign(new Error("Simulation failed."), { logs: ["Program P failed: custom program error: 0x1b"] });
    assert.ok(describeProgramError("w", err).startsWith("w OracleStale(27)"));
  });

  it("never echoes a secret key or a full keypair that is not in the error text", () => {
    const kp = Keypair.generate();
    const secretJson = JSON.stringify(Array.from(kp.secretKey));
    const out = describeProgramError("w", simFailed(27));
    assert.ok(!out.includes(secretJson));
    assert.ok(!out.includes(Buffer.from(kp.secretKey).toString("base64")));
    // A thrown Keypair is not stringified into the message beyond what the caller passed in.
    assert.ok(!describeProgramError("w", new Error("rpc 429")).includes("secret"));
  });
});

describe("clipKeepingCode", () => {
  it("returns short text unchanged", () => {
    assert.equal(clipKeepingCode("abc", 3), "abc");
    assert.equal(clipKeepingCode("abc", 10), "abc");
  });
  it("plain clip when there is no code", () => {
    assert.equal(clipKeepingCode("x".repeat(20), 5), "xxxxx");
  });
  it("plain clip when the head still shows the code", () => {
    const t = "custom program error: 0x1b and a long trailing explanation";
    assert.equal(clipKeepingCode(t, 30), t.slice(0, 30));
  });
  it("plain clip when the head shows `(code)`", () => {
    const t = "OracleStale(27) then a long trailing explanation with custom program error: 0x1b";
    assert.equal(clipKeepingCode(t, 20), t.slice(0, 20));
  });
  it("appends [Name(code)] when the clip cuts the code off (the R3.20 `custom p` case)", () => {
    const out = clipKeepingCode(simFailed(27), 100);
    assert.ok(out.endsWith("… [OracleStale(27)]"), out);
    assert.equal(out.slice(0, 100), simFailed(27).slice(0, 100));
  });
  it("uses Custom(n) for an unnamed code", () => {
    const t = `${"a".repeat(30)} custom program error: 0x3e7`;
    assert.equal(clipKeepingCode(t, 10), `${"a".repeat(10)}… [Custom(999)]`);
  });
});

describe("staleResolveWait", () => {
  const LAST = 1_000_000n;
  const WINDOW = 18_000n;
  const mk = (lastGood = LAST, stale: bigint | undefined = WINDOW) => marketBytes(lastGood, stale);

  it("matured window on a Live market -> waiting reason with the code first", () => {
    const why = staleResolveWait(27, mk(), LAST + WINDOW + 10n);
    assert.ok(why?.startsWith("OracleStale(27): stale-resolve window matured"), String(why));
    assert.match(why!, new RegExp(`last good oracle slot ${LAST}, ${WINDOW + 10n} slots ago >= ${WINDOW}`));
    assert.match(why!, /retry next cycle/);
  });
  it("the slot skew lets a window maturing within 32 slots count", () => {
    assert.ok(staleResolveWait(27, mk(), LAST + WINDOW - STALE_WAIT_SLOT_SKEW));
    assert.equal(staleResolveWait(27, mk(), LAST + WINDOW - STALE_WAIT_SLOT_SKEW - 1n), null);
  });
  it("chain slot behind last good slot -> age 0", () => {
    const why = staleResolveWait(27, mk(LAST + 10n, 1n), LAST); // within the 32-slot skew
    assert.match(why!, /0 slots ago/);
  });
  const nulls: [string, number | null, Uint8Array | null, bigint | null][] = [
    ["code is not OracleStale", 26, mk(), LAST + WINDOW * 2n],
    ["no code", null, mk(), LAST + WINDOW * 2n],
    ["no market bytes", 27, null, LAST + WINDOW * 2n],
    ["no chain slot", 27, mk(), null],
    ["window not matured", 27, mk(), LAST + 100n],
    ["window disabled (0 slots)", 27, mk(LAST, 0n), LAST + WINDOW * 2n],
    ["not a decodable Live market", 27, new Uint8Array(32), LAST + WINDOW * 2n],
  ];
  for (const [label, code, data, slot] of nulls) it(`null: ${label}`, () => assert.equal(staleResolveWait(code, data, slot), null));
});

describe("chainSlotOrNull", () => {
  it("returns the confirmed slot as a bigint", async () => {
    let seen: unknown;
    const slot = await chainSlotOrNull({ getSlot: async (c) => ((seen = c), 123) });
    assert.equal(slot, 123n);
    assert.equal(seen, "confirmed");
  });
  it("null when the connection has no getSlot", async () => {
    assert.equal(await chainSlotOrNull({}), null);
  });
  it("null when getSlot rejects", async () => {
    assert.equal(await chainSlotOrNull({ getSlot: async () => { throw new Error("rpc down"); } }), null);
  });
});
