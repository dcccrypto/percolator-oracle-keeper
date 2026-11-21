import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  ELF_FINGERPRINT_LEN,
  PROGRAMDATA_ELF_OFFSET,
  S16AC_WRAPPER_ELF_PREFIX_SHA256,
  S16acGateState,
  classifyS16acElfPrefix,
  readElfPrefix,
  s16acEngineDeployed,
} from "./s16ac-engine-gate.ts";

const PROGRAM = new PublicKey(new Uint8Array(32).fill(7));
const PROGRAM_DATA = new PublicKey(new Uint8Array(32).fill(9));
const TTL = 60_000;

/** A prefix whose sha256 we register in the known set (restored afterwards). */
function knownPrefix(): Uint8Array {
  const p = new Uint8Array(ELF_FINGERPRINT_LEN).fill(0xab);
  (S16AC_WRAPPER_ELF_PREFIX_SHA256 as Set<string>).add(createHash("sha256").update(p).digest("hex"));
  return p;
}
const otherPrefix = () => new Uint8Array(ELF_FINGERPRINT_LEN).fill(0x11);

function progAccount(): { data: Buffer } {
  const d = Buffer.alloc(36);
  d.set(PROGRAM_DATA.toBytes(), 4);
  return { data: d };
}

/** Fake connection: program account then ProgramData slice. */
function fakeConn(prefix: Uint8Array | null, calls: unknown[][] = []) {
  return {
    getAccountInfo: async (key: PublicKey, cfg: unknown) => {
      calls.push([key, cfg]);
      if (key.equals(PROGRAM)) return progAccount();
      return prefix ? { data: Buffer.from(prefix) } : null;
    },
  } as never;
}

describe("classifyS16acElfPrefix", () => {
  it("null, wrong length, all-zero -> unknown", () => {
    assert.equal(classifyS16acElfPrefix(null), "unknown");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(10).fill(1)), "unknown");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF_FINGERPRINT_LEN)), "unknown");
  });
  it("known -> s16ac, unregistered -> other", () => {
    assert.equal(classifyS16acElfPrefix(knownPrefix()), "s16ac");
    assert.equal(classifyS16acElfPrefix(otherPrefix()), "other");
  });
});

describe("readElfPrefix", () => {
  it("returns null when program missing or too short", async () => {
    assert.equal(await readElfPrefix({ getAccountInfo: async () => null } as never, PROGRAM), null);
    assert.equal(await readElfPrefix({ getAccountInfo: async () => ({ data: Buffer.alloc(35) }) } as never, PROGRAM), null);
  });
  it("returns null when ProgramData is missing", async () => {
    assert.equal(await readElfPrefix(fakeConn(null), PROGRAM), null);
  });
  it("reads the ProgramData slice at the ELF offset", async () => {
    const calls: unknown[][] = [];
    const p = otherPrefix();
    const out = await readElfPrefix(fakeConn(p, calls), PROGRAM);
    assert.deepEqual(Array.from(out!), Array.from(p));
    assert.ok((calls[1][0] as PublicKey).equals(PROGRAM_DATA));
    assert.deepEqual(calls[1][1], { commitment: "confirmed", dataSlice: { offset: PROGRAMDATA_ELF_OFFSET, length: ELF_FINGERPRINT_LEN } });
  });
});

describe("s16acEngineDeployed", () => {
  it("deployed -> on, and the answer is cached within the ttl", async () => {
    const calls: unknown[][] = [];
    const conn = fakeConn(knownPrefix(), calls);
    const st = new S16acGateState();
    let t = 1000;
    assert.deepEqual(await s16acEngineDeployed(conn, PROGRAM, st, TTL, () => t), { on: true, state: "s16ac" });
    const n = calls.length;
    t += TTL - 1;
    assert.deepEqual(await s16acEngineDeployed(conn, PROGRAM, st, TTL, () => t), { on: true, state: "s16ac" });
    assert.equal(calls.length, n, "no RPC while cached");
  });

  it("not deployed -> off (other), cached, then re-probed after the ttl", async () => {
    const calls: unknown[][] = [];
    const st = new S16acGateState();
    let t = 0;
    assert.deepEqual(await s16acEngineDeployed(fakeConn(otherPrefix(), calls), PROGRAM, st, TTL, () => t), { on: false, state: "other" });
    const n = calls.length;
    t = TTL - 1;
    await s16acEngineDeployed(fakeConn(otherPrefix(), calls), PROGRAM, st, TTL, () => t);
    assert.equal(calls.length, n);
    t = TTL; // boundary: expired
    const r = await s16acEngineDeployed(fakeConn(knownPrefix(), calls), PROGRAM, st, TTL, () => t);
    assert.deepEqual(r, { on: true, state: "s16ac" });
    assert.ok(calls.length > n, "re-probed");
    assert.equal(st.value!.at, TTL);
  });

  it("RPC error -> unknown/off, never throws, and unknown is not cached", async () => {
    const st = new S16acGateState();
    const boom = { getAccountInfo: async () => { throw new Error("rpc down"); } } as never;
    assert.deepEqual(await s16acEngineDeployed(boom, PROGRAM, st, TTL, () => 5), { on: false, state: "unknown" });
    assert.equal(st.value!.state, "unknown");
    // same instant, healthy RPC: unknown must be re-read, not pinned
    assert.deepEqual(await s16acEngineDeployed(fakeConn(knownPrefix()), PROGRAM, st, TTL, () => 5), { on: true, state: "s16ac" });
  });

  it("unreadable account -> unknown/off; default clock works", async () => {
    const st = new S16acGateState();
    const r = await s16acEngineDeployed({ getAccountInfo: async () => null } as never, PROGRAM, st, TTL);
    assert.deepEqual(r, { on: false, state: "unknown" });
  });
});
