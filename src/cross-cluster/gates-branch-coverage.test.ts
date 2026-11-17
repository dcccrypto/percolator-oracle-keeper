/** Branch coverage for the small gate/flag/metric modules: registry-flags, layout-guard-metrics, s16ac-engine-gate. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  LP_VAULT_REGISTRY_BOUND_FLAG_OFF,
  LP_VAULT_REGISTRY_EXT_FLAG_OFF,
  lpVaultRegistryBound,
  lpVaultRegistryExtFlag,
} from "./registry-flags.ts";
import { layoutGuardSnapshot, noteLayoutGuardRefusal, resetLayoutGuardMetrics } from "./layout-guard-metrics.ts";
import {
  ELF_FINGERPRINT_LEN,
  PROGRAMDATA_ELF_OFFSET,
  S16AC_WRAPPER_ELF_PREFIX_SHA256,
  S16acGateState,
  classifyS16acElfPrefix,
  readElfPrefix,
  s16acEngineDeployed,
} from "./s16ac-engine-gate.ts";

describe("registry-flags", () => {
  const buf = (len: number, off?: number, v?: number) => {
    const d = new Uint8Array(len);
    if (off !== undefined && v !== undefined) d[off] = v;
    return d;
  };
  it("bound flag: short account is unbound; 0 unbound; 1 bound; anything else throws", () => {
    assert.equal(lpVaultRegistryBound(buf(LP_VAULT_REGISTRY_BOUND_FLAG_OFF)), false);
    assert.equal(lpVaultRegistryBound(buf(200, LP_VAULT_REGISTRY_BOUND_FLAG_OFF, 0)), false);
    assert.equal(lpVaultRegistryBound(buf(200, LP_VAULT_REGISTRY_BOUND_FLAG_OFF, 1)), true);
    assert.throws(() => lpVaultRegistryBound(buf(200, LP_VAULT_REGISTRY_BOUND_FLAG_OFF, 2)), /bound flag is 2/);
  });
  it("ext flag: short account, 0, 1 and an unexpected byte (never throws)", () => {
    assert.equal(lpVaultRegistryExtFlag(buf(LP_VAULT_REGISTRY_EXT_FLAG_OFF)), false);
    assert.equal(lpVaultRegistryExtFlag(buf(200, LP_VAULT_REGISTRY_EXT_FLAG_OFF, 0)), false);
    assert.equal(lpVaultRegistryExtFlag(buf(200, LP_VAULT_REGISTRY_EXT_FLAG_OFF, 1)), true);
    assert.equal(lpVaultRegistryExtFlag(buf(200, LP_VAULT_REGISTRY_EXT_FLAG_OFF, 7)), false);
  });
});

describe("layout-guard-metrics", () => {
  beforeEach(() => resetLayoutGuardMetrics());
  it("counts by code and version, null version is not keyed, repeat refusals log once", () => {
    const orig = console.error;
    const logs: string[] = [];
    console.error = (m: string) => { logs.push(m); };
    try {
      noteLayoutGuardRefusal("NO_ROW_FOR_LENGTH", 3, () => 10);
      noteLayoutGuardRefusal("NO_ROW_FOR_LENGTH", 3, () => 11); // existing keys + already logged
      noteLayoutGuardRefusal("AMBIGUOUS_ROW", null, () => 12); // null version
      noteLayoutGuardRefusal("AMBIGUOUS_ROW", null); // default clock
    } finally {
      console.error = orig;
    }
    const s = layoutGuardSnapshot();
    assert.equal(s.refusals, 4);
    assert.deepEqual(s.byCode, { NO_ROW_FOR_LENGTH: 2, AMBIGUOUS_ROW: 2 });
    assert.deepEqual(s.byVersion, { "3": 2 });
    assert.equal(s.lastCode, "AMBIGUOUS_ROW");
    assert.equal(s.lastVersion, null);
    assert.ok(typeof s.lastAt === "number" && s.lastAt > 12);
    assert.equal(logs.length, 2);
    assert.match(logs[1], /unreadable/);
  });
  it("reset clears everything", () => {
    noteLayoutGuardRefusal("X", 1);
    resetLayoutGuardMetrics();
    assert.deepEqual(layoutGuardSnapshot(), { refusals: 0, byCode: {}, byVersion: {}, lastCode: null, lastVersion: null, lastAt: null });
  });
});

describe("s16ac-engine-gate", () => {
  const prefix = (fill: number) => new Uint8Array(ELF_FINGERPRINT_LEN).fill(fill);
  it("classify: null, short, all-zero are unknown; unrecognised is other", () => {
    assert.equal(classifyS16acElfPrefix(null), "unknown");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(10)), "unknown");
    assert.equal(classifyS16acElfPrefix(prefix(0)), "unknown");
    assert.equal(classifyS16acElfPrefix(prefix(1)), "other");
    assert.ok(S16AC_WRAPPER_ELF_PREFIX_SHA256.size >= 6);
  });
  it("classify: a prefix whose sha256 is in the set is s16ac", () => {
    const p = prefix(9);
    const h = require_hash(p);
    (S16AC_WRAPPER_ELF_PREFIX_SHA256 as Set<string>).add(h);
    try {
      assert.equal(classifyS16acElfPrefix(p), "s16ac");
    } finally {
      (S16AC_WRAPPER_ELF_PREFIX_SHA256 as Set<string>).delete(h);
    }
  });

  const progId = Keypair.generate().publicKey;
  const pdAddr = Keypair.generate().publicKey;
  const progData = Buffer.concat([Buffer.alloc(4), pdAddr.toBytes()]);
  const fakeConn = (map: Record<string, { data: Buffer } | null>, calls: unknown[][] = []) => ({
    getAccountInfo: async (k: PublicKey, c?: unknown) => {
      calls.push([k.toBase58(), c]);
      return (map[k.toBase58()] ?? null) as never;
    },
  });
  it("readElfPrefix: missing program, short program, missing programdata, and the happy path", async () => {
    assert.equal(await readElfPrefix(fakeConn({}), progId), null);
    assert.equal(await readElfPrefix(fakeConn({ [progId.toBase58()]: { data: Buffer.alloc(35) } }), progId), null);
    assert.equal(await readElfPrefix(fakeConn({ [progId.toBase58()]: { data: progData } }), progId), null);
    const calls: unknown[][] = [];
    const elf = Buffer.alloc(ELF_FINGERPRINT_LEN, 5);
    const r = await readElfPrefix(fakeConn({ [progId.toBase58()]: { data: progData }, [pdAddr.toBase58()]: { data: elf } }, calls), progId);
    assert.equal(r?.length, ELF_FINGERPRINT_LEN);
    assert.deepEqual((calls[1][1] as { dataSlice: { offset: number } }).dataSlice.offset, PROGRAMDATA_ELF_OFFSET);
  });
  it("s16acEngineDeployed: off for other, caches non-unknown within ttl, re-reads after ttl and for unknown, never throws", async () => {
    const elf = Buffer.alloc(ELF_FINGERPRINT_LEN, 5);
    const calls: unknown[][] = [];
    const conn = fakeConn({ [progId.toBase58()]: { data: progData }, [pdAddr.toBase58()]: { data: elf } }, calls);
    const st = new S16acGateState();
    assert.deepEqual(await s16acEngineDeployed(conn, progId, st, 1000, () => 0), { on: false, state: "other" });
    const n = calls.length;
    assert.deepEqual(await s16acEngineDeployed(conn, progId, st, 1000, () => 500), { on: false, state: "other" });
    assert.equal(calls.length, n, "cache hit makes no RPC");
    await s16acEngineDeployed(conn, progId, st, 1000, () => 1500);
    assert.ok(calls.length > n, "expired ttl re-reads");

    const st2 = new S16acGateState();
    assert.deepEqual(await s16acEngineDeployed(fakeConn({}), progId, st2, 1000, () => 0), { on: false, state: "unknown" });
    let throwCalls = 0;
    const throwing = { getAccountInfo: async () => { throwCalls++; throw new Error("rpc down"); } };
    assert.deepEqual(await s16acEngineDeployed(throwing, progId, st2, 1000, () => 1), { on: false, state: "unknown" });
    assert.equal(throwCalls, 1, "unknown is not served from cache");
    assert.equal(st2.value?.state, "unknown");
  });
  it("s16acEngineDeployed: a known build gates ON and is cached", async () => {
    const elf = Buffer.alloc(ELF_FINGERPRINT_LEN, 5);
    const h = require_hash(elf);
    (S16AC_WRAPPER_ELF_PREFIX_SHA256 as Set<string>).add(h);
    try {
      const conn = fakeConn({ [progId.toBase58()]: { data: progData }, [pdAddr.toBase58()]: { data: elf } });
      const st = new S16acGateState();
      assert.deepEqual(await s16acEngineDeployed(conn, progId, st, 1000, () => 0), { on: true, state: "s16ac" });
      assert.deepEqual(await s16acEngineDeployed(fakeConn({}), progId, st, 1000, () => 1), { on: true, state: "s16ac" });
      assert.deepEqual(await s16acEngineDeployed(conn, progId, new S16acGateState(), 1000), { on: true, state: "s16ac" }); // default clock
    } finally {
      (S16AC_WRAPPER_ELF_PREFIX_SHA256 as Set<string>).delete(h);
    }
  });
});

import { createHash } from "node:crypto";
function require_hash(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
