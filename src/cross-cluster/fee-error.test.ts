/**
 * fee-error.ts: every function and branch, with real Solana error shapes. Callers: fee-jobs.ts (clipKeepingCode),
 * lp-fee-cranker.ts and stake-fee-pusher.ts (chainSlotOrNull, describeProgramError, formatWrapperCode, ORACLE_STALE,
 * staleResolveWait). errorText / programErrorCode are used through those and by tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CFG_LAST_GOOD_ORACLE_SLOT, CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS, CONFIG_OFF } from "./market-state.ts";
import {
  chainSlotOrNull,
  clipKeepingCode,
  describeProgramError,
  errorText,
  formatWrapperCode,
  ORACLE_STALE,
  programErrorCode,
  STALE_WAIT_SLOT_SKEW,
  staleResolveWait,
} from "./fee-error.ts";

function market(lastGood: bigint, staleSlots?: bigint): Buffer {
  const d = Buffer.from(readFileSync(new URL("./__fixtures__/v22-chillhouse-market-v19.b64", import.meta.url), "utf8").trim(), "base64");
  d.writeBigUInt64LE(lastGood, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  if (staleSlots !== undefined) d.writeBigUInt64LE(staleSlots, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
  return d;
}

const SIM_27 =
  "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1b. \nLogs: \n[]";

describe("fee-error errorText", () => {
  it("Error with logs joins message and logs", () => {
    const e = Object.assign(new Error("boom"), { logs: ["Program X failed: custom program error: 0x1b"] });
    assert.equal(errorText(e), "boom\nProgram X failed: custom program error: 0x1b");
    assert.equal(programErrorCode(e), 27);
  });
  it("Error with empty or non-array logs is just the message", () => {
    assert.equal(errorText(Object.assign(new Error("m"), { logs: [] })), "m");
    assert.equal(errorText(Object.assign(new Error("m"), { logs: "x" })), "m");
    assert.equal(errorText(new Error("plain")), "plain");
  });
  it("strings pass through; objects are JSON; null/undefined -> null", () => {
    assert.equal(errorText("abc"), "abc");
    assert.equal(errorText({ InstructionError: [1, { Custom: 27 }] }), '{"InstructionError":[1,{"Custom":27}]}');
    assert.equal(errorText(null), "null");
    assert.equal(errorText(undefined), "null");
  });
  it("a BigInt field makes JSON.stringify throw (caller must not pass raw BigInt objects)", () => {
    assert.throws(() => errorText({ Custom: 27n }), TypeError);
  });
  it("a function value (JSON.stringify -> undefined) falls back to String()", () => {
    assert.equal(errorText(() => 1), String(() => 1));
  });
});

describe("fee-error programErrorCode", () => {
  it("decimal InstructionError Custom", () => {
    assert.equal(programErrorCode({ InstructionError: [1, { Custom: 27 }] }), 27);
  });
  it("hex log-only failure", () => {
    assert.equal(programErrorCode(SIM_27), 27);
  });
  it("no code -> null", () => {
    assert.equal(programErrorCode("blockhash not found"), null);
    assert.equal(programErrorCode({ InstructionError: [0, "InvalidAccountData"] }), null);
  });
});

describe("fee-error formatWrapperCode", () => {
  it("named and unnamed", () => {
    assert.equal(formatWrapperCode(27), "OracleStale(27)");
    assert.equal(formatWrapperCode(999999), "Custom(999999)");
  });
});

describe("fee-error describeProgramError", () => {
  it("code first, simulation boilerplate stripped", () => {
    const s = describeProgramError("lp-fee", SIM_27);
    assert.match(s, /^lp-fee OracleStale\(27\) — Transaction simulation failed/);
  });
  it("no code: where: text", () => {
    assert.equal(describeProgramError("w", "Message: socket hang up\nstack"), "w: socket hang up");
  });
  it("clips only the human text", () => {
    const s = describeProgramError("w", `custom program error: 0x1b ${"x".repeat(300)}`, 20);
    assert.ok(s.startsWith("w OracleStale(27) — "));
    assert.ok(s.endsWith("…"));
  });
  it("code with empty text has no dash", () => {
    assert.equal(describeProgramError("w", "\n custom program error: 0x1b"), "w OracleStale(27)");
  });
});

describe("fee-error clipKeepingCode", () => {
  it("short text unchanged", () => assert.equal(clipKeepingCode("abc", 10), "abc"));
  it("no code: plain head", () => assert.equal(clipKeepingCode("x".repeat(50), 10), "x".repeat(10)));
  it("code visible in head: plain head", () => {
    const t = `custom program error: 0x1b ${"x".repeat(50)}`;
    assert.equal(clipKeepingCode(t, 30), t.slice(0, 30));
  });
  it("code already shown as (N) in head: plain head", () => {
    const t = `OracleStale(27) ${"x".repeat(20)} custom program error: 0x1b`;
    assert.equal(clipKeepingCode(t, 20), t.slice(0, 20));
  });
  it("code cut off: appended", () => {
    const t = `Error processing Instruction 1: custom p. ${"x".repeat(5)} custom program error: 0x1b`;
    assert.equal(clipKeepingCode(t, 40), `${t.slice(0, 40)}… [OracleStale(27)]`);
  });
});

describe("fee-error staleResolveWait", () => {
  const LAST = 1_000_000n;
  it("a matured 27 on a live market waits", () => {
    const r = staleResolveWait(ORACLE_STALE, market(LAST), LAST + 40_000n);
    assert.match(r ?? "", /^OracleStale\(27\): stale-resolve window matured/);
    assert.match(r ?? "", /40000 slots ago/);
  });
  it("age is clamped to 0 when the chain slot is behind last good", () => {
    const r = staleResolveWait(ORACLE_STALE, market(LAST, 1n), LAST - 5n);
    assert.match(r ?? "", /0 slots ago/);
  });
  it("skew lets a window just short of maturity count", () => {
    const stale = 18_000n;
    const m = market(LAST, stale);
    assert.notEqual(staleResolveWait(ORACLE_STALE, m, LAST + stale - STALE_WAIT_SLOT_SKEW), null);
    assert.equal(staleResolveWait(ORACLE_STALE, m, LAST + stale - STALE_WAIT_SLOT_SKEW - 1n), null);
  });
  it("a foreign/other code is never a wait", () => {
    assert.equal(staleResolveWait(1, market(LAST), LAST + 40_000n), null);
    assert.equal(staleResolveWait(null, market(LAST), LAST + 40_000n), null);
  });
  it("missing market bytes or chain slot -> failure", () => {
    assert.equal(staleResolveWait(ORACLE_STALE, null, LAST + 40_000n), null);
    assert.equal(staleResolveWait(ORACLE_STALE, market(LAST), null), null);
  });
  it("window disabled (stale slots 0) -> failure", () => {
    assert.equal(staleResolveWait(ORACLE_STALE, market(LAST, 0n), LAST + 40_000n), null);
  });
  it("27 without a matured window -> failure", () => {
    assert.equal(staleResolveWait(ORACLE_STALE, market(LAST), LAST + 10n), null);
  });
  it("non-live market bytes -> failure", () => {
    assert.equal(staleResolveWait(ORACLE_STALE, new Uint8Array(8), LAST + 40_000n), null);
  });
});

describe("fee-error chainSlotOrNull", () => {
  it("returns the slot as a BigInt", async () => {
    assert.equal(await chainSlotOrNull({ getSlot: async () => 123 }), 123n);
  });
  it("no getSlot -> null", async () => assert.equal(await chainSlotOrNull({}), null));
  it("getSlot rejects -> null", async () => {
    assert.equal(await chainSlotOrNull({ getSlot: async () => { throw new Error("rpc down"); } }), null);
  });
  it("non-integer slot -> null (BigInt throws)", async () => {
    assert.equal(await chainSlotOrNull({ getSlot: async () => 1.5 }), null);
  });
});

describe("fee-error foreign program codes", () => {
  it("a foreign program's Custom code in the logs is read as the code (no program id in InstructionError; see PR note)", () => {
    const e = Object.assign(new Error("Simulation failed."), {
      logs: ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1"],
    });
    assert.equal(programErrorCode(e), 1);
  });
});
