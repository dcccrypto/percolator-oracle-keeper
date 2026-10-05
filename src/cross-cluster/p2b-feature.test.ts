/**
 * v2.1 feature detection (p2b-feature.ts): probe classification, caching, log-once, modes, and the
 * tag-103 probe itself (simulate only, never send).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  DEFAULT_P2B_GATE_CONFIG,
  P2bFeatureGate,
  classifyProbeError,
  getP2bGate,
  isP2bSupported,
  makeTag103Probe,
  p2bGateConfigFromEnv,
  setP2bGate,
} from "./p2b-feature.ts";
import type { P2bProbeResult } from "./p2b-feature.ts";
import { KEEPER, PROGRAM, deriveLpVaultRegistry, deriveVaultLpState, fakeConn, registryBytes, vaultLpStateBytes } from "./p2b-test-helpers.ts";

const ie = (detail: unknown) => ({ InstructionError: [1, detail] });

describe("classifyProbeError (probe classification)", () => {
  it("InvalidInstructionData (not a Custom error) -> the program predates P2b", () => {
    assert.equal(classifyProbeError(ie("InvalidInstructionData")), "unsupported");
  });
  it("Custom(100) VaultLpAllocateRefused -> supported (decoded, no room)", () => {
    assert.equal(classifyProbeError(ie({ Custom: 100 })), "supported");
  });
  it("any other Custom code -> supported (the program decoded tag 103)", () => {
    assert.equal(classifyProbeError(ie({ Custom: 21 })), "supported");
    assert.equal(classifyProbeError(ie({ Custom: 0 })), "supported");
  });
  it("simulation ok -> supported", () => {
    assert.equal(classifyProbeError(null), "supported");
  });
  it("anything else is unknown, never a verdict: other instruction errors, tx-level errors", () => {
    assert.equal(classifyProbeError(ie("NotEnoughAccountKeys")), "unknown");
    assert.equal(classifyProbeError(ie("InvalidAccountData")), "unknown");
    assert.equal(classifyProbeError("BlockhashNotFound"), "unknown");
    assert.equal(classifyProbeError("AccountNotFound"), "unknown");
    assert.equal(classifyProbeError({ InstructionError: [0, "Custom"] }), "unknown");
  });
});

function gateWith(results: Array<P2bProbeResult | Error>, t0 = 1_000, cfg = DEFAULT_P2B_GATE_CONFIG) {
  let now = t0;
  const logs: string[] = [];
  let i = 0;
  const gate = new P2bFeatureGate(
    cfg,
    async () => {
      const r = results[Math.min(i++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    () => now,
    (l) => logs.push(l),
  );
  return { gate, logs, advance: (ms: number) => { now += ms; }, probes: () => i };
}

describe("P2bFeatureGate", () => {
  it("is OFF before it is determined, ON after a supported probe", async () => {
    const g = gateWith(["supported"]);
    assert.equal(g.gate.isSupported(), false);
    assert.equal(await g.gate.ensure(), true);
    assert.equal(g.gate.isSupported(), true);
    assert.ok(g.logs.some((l) => /supports P2b/.test(l)));
  });

  it("unsupported is cached for the long TTL and logged exactly once", async () => {
    const g = gateWith(["unsupported"]);
    assert.equal(await g.gate.ensure(), false);
    g.advance(60_000);
    assert.equal(await g.gate.ensure(), false);
    g.advance(60 * 60_000);
    assert.equal(await g.gate.ensure(), false);
    assert.equal(g.probes(), 1, "one probe inside the 6 h TTL");
    g.advance(7 * 60 * 60_000);
    await g.gate.ensure();
    assert.equal(g.probes(), 2, "re-probed after the TTL");
    assert.equal(g.logs.filter((l) => /predates P2b/.test(l)).length, 1, "logged once across both probes");
  });

  it("unknown (RPC error / no bound market) retries soon and never flips a known answer", async () => {
    const g = gateWith(["supported", new Error("429 Too Many Requests"), "unknown", "no-candidate"]);
    await g.gate.ensure();
    assert.equal(g.gate.isSupported(), true);
    g.advance(DEFAULT_P2B_GATE_CONFIG.supportedTtlMs + 1);
    await g.gate.ensure(); // probe throws -> unknown
    assert.equal(g.gate.isSupported(), true, "a transient failure keeps the last known answer");
    g.advance(DEFAULT_P2B_GATE_CONFIG.unknownRetryMs + 1);
    await g.gate.ensure();
    assert.equal(g.probes(), 3);
  });

  it("a never-determined gate (only unknowns) stays unsupported", async () => {
    const g = gateWith([new Error("boom")]);
    assert.equal(await g.gate.ensure(), false);
    assert.equal(g.gate.snapshot().supported, false);
    assert.equal(g.gate.snapshot().lastProbe, "unknown");
  });

  it("mode off never probes; mode on never probes and is supported", async () => {
    const off = gateWith(["supported"], 0, { ...DEFAULT_P2B_GATE_CONFIG, mode: "off" });
    assert.equal(await off.gate.ensure(), false);
    assert.equal(off.probes(), 0);
    const on = gateWith(["unsupported"], 0, { ...DEFAULT_P2B_GATE_CONFIG, mode: "on" });
    assert.equal(await on.gate.ensure(), true);
    assert.equal(on.probes(), 0);
  });

  it("reportUnsupported flips a supported auto gate off (a send hit InvalidInstructionData)", async () => {
    const g = gateWith(["supported"]);
    await g.gate.ensure();
    g.gate.reportUnsupported();
    assert.equal(g.gate.isSupported(), false);
  });

  it("concurrent ensure() calls share one probe", async () => {
    const g = gateWith(["supported"]);
    await Promise.all([g.gate.ensure(), g.gate.ensure(), g.gate.ensure()]);
    assert.equal(g.probes(), 1);
  });

  it("the process-wide gate is OFF until boot installs one", () => {
    setP2bGate(null);
    assert.equal(isP2bSupported(), false);
    const on = new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported");
    setP2bGate(on);
    assert.equal(getP2bGate(), on);
    assert.equal(isP2bSupported(), true);
    setP2bGate(null);
  });
});

describe("p2bGateConfigFromEnv", () => {
  it("defaults to auto with the documented TTLs", () => {
    const c = p2bGateConfigFromEnv({});
    assert.deepEqual(c, DEFAULT_P2B_GATE_CONFIG);
    assert.equal(c.mode, "auto");
  });
  it("parses the switch and rejects garbage", () => {
    assert.equal(p2bGateConfigFromEnv({ P2B_FEATURES: "OFF" }).mode, "off");
    assert.equal(p2bGateConfigFromEnv({ P2B_FEATURES: "on" }).mode, "on");
    assert.throws(() => p2bGateConfigFromEnv({ P2B_FEATURES: "maybe" }), /auto\|on\|off/);
    assert.throws(() => p2bGateConfigFromEnv({ P2B_PROBE_RETRY_MS: "-5" }), /positive integer/);
  });
});

describe("makeTag103Probe: simulate only, on a BOUND market", () => {
  const mk = () => Keypair.generate().publicKey;
  function world(boundIdx: number | null, sim: { err: unknown } | null) {
    const markets = [mk(), mk(), mk()];
    const accounts = new Map<string, Uint8Array>();
    markets.forEach((m, i) => {
      accounts.set(deriveLpVaultRegistry(PROGRAM, m)[0].toBase58(), registryBytes({ bound: i === boundIdx }));
      accounts.set(deriveVaultLpState(PROGRAM, m).toBase58(), vaultLpStateBytes({ lp: mk() }));
    });
    const c = fakeConn({ accounts, sims: sim ? [{ err: sim.err }] : undefined });
    const probe = makeTag103Probe({ conn: c.conn as never, keeper: KEEPER, programId: PROGRAM, markets: () => markets.map((m) => ({ marketAddress: m.toBase58() })) });
    return { c, probe, markets };
  }

  it("builds a 9-account tag-103 with u128::MAX on the first BOUND market and simulates it (never sends)", async () => {
    const w = world(1, { err: ie({ Custom: 100 }) });
    assert.equal(await w.probe(), "supported");
    assert.equal(w.c.sent.length, 0);
    assert.equal(w.c.count("sendRawTransaction"), 0);
    assert.equal(w.c.simulated.length, 1);
    const ix = w.c.simulated[0].instructions[1];
    assert.equal(ix.data[0], 103);
    assert.equal(ix.data.length, 17);
    assert.ok(ix.data.subarray(1).every((b) => b === 0xff), "amount = u128::MAX");
    assert.equal(ix.keys.length, 9);
    assert.ok(ix.keys[1].pubkey.equals(w.markets[1]), "the bound market (index 1), not the unbound index 0");
    assert.ok(ix.keys[0].pubkey.equals(KEEPER.publicKey));
  });

  it("InvalidInstructionData from the simulation -> unsupported", async () => {
    assert.equal(await world(0, { err: ie("InvalidInstructionData") }).probe(), "unsupported");
  });
  it("a clean simulation -> supported", async () => {
    assert.equal(await world(2, { err: null }).probe(), "supported");
  });
  it("a failure at instruction 0 (compute budget) is not an answer", async () => {
    assert.equal(await world(0, { err: { InstructionError: [0, "InvalidInstructionData"] } }).probe(), "unknown");
  });
  it("no bound market in the registry -> no-candidate and nothing is simulated", async () => {
    const w = world(null, { err: null });
    assert.equal(await w.probe(), "no-candidate");
    assert.equal(w.c.simulated.length, 0);
  });
  it("an empty registry -> no-candidate with no RPC at all", async () => {
    const c = fakeConn();
    const probe = makeTag103Probe({ conn: c.conn as never, keeper: KEEPER, programId: PROGRAM, markets: () => [] });
    assert.equal(await probe(), "no-candidate");
    assert.equal(c.calls.length, 0);
  });
  it("an RPC failure propagates to the gate, which maps it to unknown", async () => {
    const c = fakeConn({ readError: new Error("fetch failed") });
    const probe = makeTag103Probe({ conn: c.conn as never, keeper: KEEPER, programId: PROGRAM, markets: () => [{ marketAddress: mk().toBase58() }] });
    const gate = new P2bFeatureGate(DEFAULT_P2B_GATE_CONFIG, probe);
    assert.equal(await gate.ensure(), false);
    assert.equal(gate.snapshot().lastProbe, "unknown");
  });
});
