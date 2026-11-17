import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
import { CFG_LAST_GOOD_ORACLE_SLOT, CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS, CONFIG_OFF, marketMode } from "./market-state.ts";
import { v22MarketBytes } from "./v22/test-helpers.ts";

const SIM_27 =
  "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1b. \nLogs: \n[...]";

describe("errorText", () => {
  it("Error: message, plus logs when present; non-array / empty logs ignored", () => {
    assert.equal(errorText(new Error("boom")), "boom");
    assert.equal(errorText(Object.assign(new Error("m"), { logs: ["a", "b"] })), "m\na\nb");
    assert.equal(errorText(Object.assign(new Error("m"), { logs: [] })), "m");
    assert.equal(errorText(Object.assign(new Error("m"), { logs: "nope" })), "m");
  });
  it("strings pass through; objects are JSON; null/undefined are 'null'; functions/symbols fall back to String()", () => {
    assert.equal(errorText("x"), "x");
    assert.equal(errorText({ InstructionError: [1, { Custom: 27 }] }), '{"InstructionError":[1,{"Custom":27}]}');
    assert.equal(errorText(null), "null");
    assert.equal(errorText(undefined), "null");
    assert.equal(errorText(5), "5");
    assert.match(errorText(() => 1), /=>/);
    assert.equal(errorText(Symbol("s")), "Symbol(s)");
  });
  it("never throws on a thrown value JSON cannot serialise (circular, BigInt): the error path must not itself throw", () => {
    const circ: Record<string, unknown> = { message: "rpc down" };
    circ.self = circ;
    assert.doesNotThrow(() => errorText(circ));
    assert.doesNotThrow(() => errorText({ slot: 1n }));
    assert.equal(typeof errorText(circ), "string");
    assert.match(errorText(circ), /rpc down/);
    assert.equal(programErrorCode({ InstructionError: [1, { Custom: 27 }], slot: 1n }), 27);
    assert.equal(describeProgramError("w", { InstructionError: [1, { Custom: 27 }], slot: 1n }).startsWith("w OracleStale(27)"), true);
  });
  it("a value whose toJSON and toString both throw yields a placeholder, not a throw", () => {
    const evil = { toJSON() { throw new Error("j"); }, toString() { throw new Error("s"); } };
    assert.equal(errorText(evil), "[unprintable error]");
  });
  it("describeProgramError survives an unserialisable error object", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    assert.doesNotThrow(() => describeProgramError("job", circ));
    assert.match(describeProgramError("job", { slot: 1n }), /^job: .*"slot":"1"/);
  });
});

describe("programErrorCode / formatWrapperCode", () => {
  it("decimal Custom, hex, and logs on an Error; none -> null", () => {
    assert.equal(programErrorCode({ InstructionError: [1, { Custom: 27 }] }), 27);
    assert.equal(programErrorCode(SIM_27), 27);
    assert.equal(programErrorCode(Object.assign(new Error("failed"), { logs: ["Program X failed: custom program error: 0x1b"] })), 27);
    assert.equal(programErrorCode("nothing here"), null);
    assert.equal(programErrorCode(null), null);
    assert.equal(programErrorCode(""), null);
  });
  it("names a known code, Custom(n) for an unknown one", () => {
    assert.equal(formatWrapperCode(ORACLE_STALE), "OracleStale(27)");
    assert.equal(formatWrapperCode(999_999), "Custom(999999)");
  });
  it("a u64-sized decimal code is not mistaken for a named one", () => {
    const c = programErrorCode(`"Custom": ${2n ** 64n}`);
    assert.equal(formatWrapperCode(c as number).startsWith("Custom("), true);
  });
});

describe("describeProgramError", () => {
  it("code first, boilerplate stripped, text clipped with an ellipsis", () => {
    const s = describeProgramError("tag 78", SIM_27);
    assert.match(s, /^tag 78 OracleStale\(27\) — Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1b\./);
    const long = describeProgramError("w", `custom program error: 0x1b ${"x".repeat(500)}`, 20);
    assert.ok(long.startsWith("w OracleStale(27) — "));
    assert.ok(long.endsWith("…"));
    assert.ok(long.length < 70);
  });
  it("no code: 'where: text'; empty text: no dangling dash", () => {
    assert.equal(describeProgramError("w", new Error("socket hang up")), "w: socket hang up");
    assert.equal(describeProgramError("w", Object.assign(new Error(""), { logs: ["Program Y failed: custom program error: 0x1b"] })), "w OracleStale(27)");
    assert.equal(describeProgramError("w", ""), "w: ");
  });
});

describe("clipKeepingCode", () => {
  it("short text is untouched", () => {
    assert.equal(clipKeepingCode("abc", 10), "abc");
    assert.equal(clipKeepingCode("abc", 3), "abc");
  });
  it("the R3.20 cut: head loses the code, so it is appended; head that still shows it is not duplicated", () => {
    const cut = clipKeepingCode(SIM_27, 100);
    assert.ok(cut.endsWith("… [OracleStale(27)]"), cut);
    assert.equal(clipKeepingCode(SIM_27, SIM_27.indexOf("0x1b") + 4), SIM_27.slice(0, SIM_27.indexOf("0x1b") + 4));
    assert.equal(clipKeepingCode("failed (27) and a very long tail ".repeat(5) + "custom program error: 0x1b", 20), "failed (27) and a ve");
  });
  it("a head cut mid-hex ('0x1' of '0x1b') is not mistaken for code 1", () => {
    const i = SIM_27.indexOf("0x1b");
    const out = clipKeepingCode(SIM_27, i + 3);
    assert.ok(out.endsWith("[OracleStale(27)]"), out);
  });
  it("no code in the text: plain slice", () => {
    assert.equal(clipKeepingCode("x".repeat(50), 10), "x".repeat(10));
  });
});

describe("staleResolveWait", () => {
  const market = (staleSlots: bigint, lastGood: bigint, lifecycle?: number) => {
    const d = Buffer.from(v22MarketBytes(lifecycle === undefined ? {} : { lifecycle }));
    d.writeBigUInt64LE(staleSlots, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
    d.writeBigUInt64LE(lastGood, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
    return new Uint8Array(d);
  };
  it("null for any code but 27, no market bytes, or no chain slot", () => {
    const m = market(18_000n, 0n);
    assert.equal(staleResolveWait(26, m, 100_000n), null);
    assert.equal(staleResolveWait(null, m, 100_000n), null);
    assert.equal(staleResolveWait(27, null, 100_000n), null);
    assert.equal(staleResolveWait(27, m, null), null);
  });
  it("27 on a matured window is a wait with the age; unmatured or disabled stays a failure", () => {
    const w = staleResolveWait(27, market(18_000n, 1_000n), 50_000n);
    assert.match(w as string, /^OracleStale\(27\): stale-resolve window matured \(last good oracle slot 1000, 49000 slots ago >= 18000\)/);
    assert.equal(staleResolveWait(27, market(18_000n, 40_000n), 50_000n), null);
    assert.equal(staleResolveWait(27, market(0n, 1_000n), 50_000n), null);
  });
  it("the skew only matters at the boundary: matured iff chainSlot + 32 - lastGood >= window", () => {
    const m = market(18_000n, 1_000n);
    const edge = 1_000n + 18_000n - STALE_WAIT_SLOT_SKEW;
    assert.notEqual(staleResolveWait(27, m, edge), null);
    assert.equal(staleResolveWait(27, m, edge - 1n), null);
  });
  it("a last-good slot ahead of the chain slot: age clamps to 0 (no negative age), and it is not matured", () => {
    assert.equal(staleResolveWait(27, market(18_000n, 90_000n), 50_000n), null); // not matured (clamp is unreachable from here)
  });
  it("u64-max last-good slot does not overflow into 'matured'", () => {
    assert.equal(staleResolveWait(27, market(18_000n, 2n ** 64n - 1n), 50_000n), null);
  });
  it("a truncated / garbage market buffer is a failure, not a wait (and does not throw)", () => {
    assert.doesNotThrow(() => staleResolveWait(27, new Uint8Array(0), 50_000n));
    assert.equal(staleResolveWait(27, new Uint8Array(0), 50_000n), null);
  });
  it("a non-Live market (Resolved / Recovery) is never a wait", () => {
    const m = market(18_000n, 1_000n);
    const base = Buffer.from(m);
    // locate the engine mode byte: the one byte whose flip changes marketMode()
    const idx = [...base.keys()].find((i) => {
      const t = Buffer.from(base);
      t[i] = 1;
      return marketMode(t) === 1 && marketMode(base) === 0;
    });
    assert.ok(idx !== undefined);
    for (const mode of [1, 2]) {
      const t = Buffer.from(base);
      t[idx as number] = mode;
      assert.equal(staleResolveWait(27, new Uint8Array(t), 50_000n), null);
    }
  });
});

describe("chainSlotOrNull", () => {
  it("bigint of the confirmed slot; null on no getSlot, a throw, or a non-integer", async () => {
    assert.equal(await chainSlotOrNull({ getSlot: async () => 42 }), 42n);
    assert.equal(await chainSlotOrNull({}), null);
    assert.equal(await chainSlotOrNull({ getSlot: async () => { throw new Error("x"); } }), null);
    assert.equal(await chainSlotOrNull({ getSlot: async () => Number.NaN }), null);
    assert.equal(await chainSlotOrNull({ getSlot: async () => 1.5 }), null);
  });
});
