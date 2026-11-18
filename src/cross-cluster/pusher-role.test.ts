/**
 * F2: the second independent pusher: config, endpoint-difference guard, takeover gate (back-off), state refresh, alerts,
 * and that a duplicate push racing the primary is harmless.
 * Run with: node --import tsx/esm --test src/cross-cluster/pusher-role.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
} from "@percolatorct/sdk";
import { DEFAULT_PUSHER_CONFIG, TakeoverGate, pusherConfigFromEnv, refreshTakeoverGate, rpcEndpointProblem } from "./pusher-role.ts";
import { pushAuthMarkBatch, getQuarantinedMarkets } from "./auth-mark-pusher.ts";
import { advanceNoPushStreaks } from "./keeper-loop.ts";

const CFG = { ...DEFAULT_PUSHER_CONFIG, takeoverSlots: 60n, staleStateMs: 30_000, alertHoldMs: 120_000 };
const M = Keypair.generate().publicKey.toBase58();

describe("config", () => {
  it("defaults and env overrides; garbage throws", () => {
    assert.deepEqual(pusherConfigFromEnv({}), DEFAULT_PUSHER_CONFIG);
    assert.equal(pusherConfigFromEnv({ PUSHER_TAKEOVER_SLOTS: "150" }).takeoverSlots, 150n);
    assert.throws(() => pusherConfigFromEnv({ PUSHER_TAKEOVER_SLOTS: "0" }));
    assert.throws(() => pusherConfigFromEnv({ PUSHER_REFRESH_MS: "x" }));
  });
  it("the pusher's RPC endpoint must differ from the primary's", () => {
    const a = "https://devnet.helius-rpc.com/?api-key=AAA";
    assert.match(rpcEndpointProblem(a, a) ?? "", /OWN RPC endpoint/);
    assert.equal(rpcEndpointProblem(a, "https://devnet.helius-rpc.com/?api-key=BBB"), null);
    assert.equal(rpcEndpointProblem(a, "https://api.devnet.solana.com"), null);
    assert.equal(rpcEndpointProblem(a, undefined), null);
  });
});

describe("TakeoverGate: back off while the primary is healthy", () => {
  it("standby while the on-chain price is fresh; pushes once it is older than takeoverSlots", () => {
    let now = 1_000_000;
    const g = new TakeoverGate(CFG, () => now);
    g.update(M, 1_000n, 1_020n, now); // gap 20 < 60
    assert.equal(g.isStandby(M), true);
    now += 400 * 40; // +40 slots of wall clock, no new state: estimated gap 60 -> takeover
    assert.equal(g.isStandby(M), false);
    // but state older than staleStateMs is unknown -> push regardless
    const g2 = new TakeoverGate(CFG, () => now);
    g2.update(M, 1_000n, 1_001n, now - 31_000);
    assert.equal(g2.isStandby(M), false);
  });
  it("unknown state (never read) pushes: fail open", () => {
    assert.equal(new TakeoverGate(CFG).isStandby(M), false);
  });
  it("gap boundary: takeoverSlots-1 is standby, takeoverSlots is not", () => {
    const g = new TakeoverGate(CFG, () => 5);
    g.update(M, 100n, 159n, 5);
    assert.equal(g.isStandby(M), true);
    g.update(M, 100n, 160n, 5);
    assert.equal(g.isStandby(M), false);
  });
  it("a primary that pushes every few slots keeps the pusher silent forever", () => {
    let now = 0;
    const g = new TakeoverGate(CFG, () => now);
    for (let i = 0; i < 100; i++) {
      now += 2_000;
      const slot = BigInt(1_000 + i * 5);
      g.update(M, slot - 8n, slot, now); // primary last pushed 8 slots ago
      assert.equal(g.isStandby(M), true);
    }
  });
});

describe("takeover alerts and /health", () => {
  it("a takeover push pages (critical, names the market) and the alert lapses after the hold", () => {
    let now = 10_000;
    const g = new TakeoverGate(CFG, () => now);
    g.setLabel(M, "SOL");
    assert.deepEqual(g.activeAlerts(), []);
    g.recordPush(M);
    const a = g.activeAlerts();
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "pusher-takeover");
    assert.equal(a[0].severity, "critical");
    assert.equal(a[0].subject, "SOL");
    now += 120_001;
    assert.deepEqual(g.activeAlerts(), [], "primary back (no more takeover pushes): resolves");
  });
  it("health view", () => {
    let now = 50_000;
    const g = new TakeoverGate(CFG, () => now);
    g.update(M, 900n, 1_000n, now);
    g.recordPush(M);
    now += 1_000;
    const h = g.health([M, "other"])[M];
    assert.equal(h.standby, false);
    assert.equal(h.takeoverPushes, 1);
    assert.equal(h.lastGoodSlot, "900");
    assert.equal(h.lastTakeoverAgoMs, 1_000);
    assert.equal(g.health(["other"]).other.gapSlots, null);
  });
  it("a standby market counts as healthy: it is in the landed set, so its no-push streak never grows", () => {
    const stat = { marketAddress: M, noPushCycles: 0 };
    advanceNoPushStreaks([stat], new Set([M])); // keeper-loop adds standby markets to landedThisCycle
    assert.equal(stat.noPushCycles, 0);
    advanceNoPushStreaks([stat], new Set());
    assert.equal(stat.noPushCycles, 1);
  });
});

describe("refreshTakeoverGate", () => {
  const marketSlice = (lastGood: bigint): { data: Buffer } => {
    const b = Buffer.alloc(176);
    b.writeBigUInt64LE(lastGood, 168);
    return { data: b };
  };
  it("reads last_good_oracle_slot @168 and the cluster slot with a 176-byte slice", async () => {
    const seen: unknown[] = [];
    const conn = {
      async getSlot() { return 5_000; },
      async getMultipleAccountsInfo(_k: unknown, cfg: unknown) { seen.push(cfg); return [marketSlice(4_990n)]; },
    };
    const g = new TakeoverGate(CFG, () => 0);
    await refreshTakeoverGate(conn as never, g, [M], 0);
    assert.deepEqual(seen[0], { commitment: "confirmed", dataSlice: { offset: 0, length: 176 } });
    assert.equal(g.gapSlots(M, 0), 10n);
    assert.equal(g.isStandby(M, 0), true);
  });
  it("an RPC failure leaves no fresh state -> the gate opens (pushes) once the old state ages out", async () => {
    let now = 0;
    const g = new TakeoverGate(CFG, () => now);
    g.update(M, 100n, 110n, 0);
    const conn = { async getSlot() { throw new Error("down"); }, async getMultipleAccountsInfo() { throw new Error("down"); } };
    await refreshTakeoverGate(conn as never, g, [M], 0); // must not throw
    assert.equal(g.isStandby(M), true);
    now = 31_000;
    assert.equal(g.isStandby(M), false);
  });
});

// ── duplicate pushes: the primary advances the nonce under us ───────────────────
function marketAccount(oracleObservation: bigint): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, oracleObservation, true);
  return buf;
}
type Ix = { data: Uint8Array };

describe("duplicate pushes from two pushers are harmless", () => {
  it("the primary lands the same sequence first: the pusher gets Custom(19) in preflight, re-reads the nonce, retries ONCE, lands, and is never quarantined", async () => {
    const market = Keypair.generate().publicKey.toBase58();
    let chainSeq = 100n; // on-chain watermark
    let readSeq = 100n; // what getMultipleAccountsInfo returns (the pusher's view)
    const seqOf = (ix: Ix) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(27, true);
    const conn = {
      async getMultipleAccountsInfo() { return [{ data: marketAccount(readSeq) }]; },
      async simulateTransaction(tx: { instructions: Ix[] }) {
        const seq = seqOf(tx.instructions[1]);
        if (seq <= chainSeq) {
          readSeq = chainSeq; // the retry's fresh read sees the primary's push
          return { value: { err: { InstructionError: [1, { Custom: 19 }] } } };
        }
        return { value: { err: null } };
      },
      async sendRawTransaction() { return "sig"; },
    };
    // the primary pushed seq 101 after the pusher read the watermark 100
    chainSeq = 101n;
    const r = await pushAuthMarkBatch(conn as never, Keypair.generate(), [{ marketAddress: market, assetIndex: 0, priceE6: 1_000_000n }], 1n, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }, false);
    assert.equal(r.count, 1, "the pusher's push lands on retry above the primary's sequence");
    assert.ok(!getQuarantinedMarkets().includes(market));
  });
});

// ── K-BUG-PUSHERROLEASSETGAP: per-asset clock, >100 markets, clock step back ────────────────────────────────────
import { MARKET_GEOMETRY_BY_VERSION, VERSION_19, assetSlotOffset } from "../wrapper-market-group-offset.ts";

const GEO19 = { ok: true as const, version: VERSION_19, ...MARKET_GEOMETRY_BY_VERSION[VERSION_19] };
/** A VERSION-19 market account: cfg.last_good_oracle_slot @168 and asset k's profile.last_good_oracle_slot @ slot k + 216. */
function v19Market(cfgLastGood: bigint, assetLastGood: Record<number, bigint> = {}): Buffer {
  const b = Buffer.alloc(assetSlotOffset(GEO19, 6));
  b.writeBigUInt64LE(V17_MAGIC, 0);
  b.writeUInt16LE(VERSION_19, 8);
  b.writeBigUInt64LE(cfgLastGood, 168);
  for (const [k, v] of Object.entries(assetLastGood)) b.writeBigUInt64LE(v, assetSlotOffset(GEO19, Number(k)) + 216);
  return b;
}
/** RPC fake: honours dataSlice, rejects > 100 keys like a real node. */
function fakeRpc(accounts: Map<string, Buffer>, slot = 10_000) {
  const calls: number[] = [];
  return {
    calls,
    async getSlot() { return slot; },
    async getMultipleAccountsInfo(keys: Array<{ toBase58(): string }>, cfg: { dataSlice?: { offset: number; length: number } }) {
      calls.push(keys.length);
      if (keys.length > 100) throw new Error("Too many accounts requested (max 100)");
      return keys.map((k) => {
        const d = accounts.get(k.toBase58());
        if (!d) return null;
        const s = cfg.dataSlice;
        return { data: s ? d.subarray(s.offset, s.offset + s.length) : d };
      });
    },
  };
}

describe("lead 1: per-asset takeover clock (profile.last_good_oracle_slot, prog global_or_profile_resolve_matured_at_slot)", () => {
  it("asset 0 fresh but asset 2 stale: asset 0 stays standby, asset 2 is NOT standby (takeover)", async () => {
    const rpc = fakeRpc(new Map([[M, v19Market(9_995n, { 0: 9_995n, 1: 9_990n, 2: 100n })]]));
    const g = new TakeoverGate(CFG, () => 0);
    await refreshTakeoverGate(rpc as never, g, [M], 0, new Map([[M, [0, 1, 2]]]));
    assert.equal(g.isStandby(M, 0, 0), true);
    assert.equal(g.isStandby(M, 0, 1), true);
    assert.equal(g.isStandby(M, 0, 2), false, "asset 2 has been silent for 9,900 slots; the primary's asset-0 pushes must not hold the gate");
    assert.equal(g.gapSlots(M, 0, 2), 9_900n);
  });
  it("an unreadable asset profile fails open (push), it does not borrow asset 0's clock", async () => {
    const g = new TakeoverGate(CFG, () => 0);
    g.update(M, 9_995n, 10_000n, 0);
    assert.equal(g.isStandby(M, 0, 3), false);
  });
});

describe("lead 2: more than 100 markets in one refresh", () => {
  it("every market is read (chunked at 100 keys per RPC); one failing chunk only opens its own markets", async () => {
    const keys = Array.from({ length: 230 }, () => Keypair.generate().publicKey.toBase58());
    const accts = new Map(keys.map((k) => [k, v19Market(9_995n)]));
    const rpc = fakeRpc(accts);
    const g = new TakeoverGate(CFG, () => 0);
    await refreshTakeoverGate(rpc as never, g, keys, 0);
    assert.ok(rpc.calls.every((n) => n <= 100), `calls: ${rpc.calls}`);
    assert.equal(keys.filter((k) => g.isStandby(k, 0)).length, 230, "all 230 markets must be on standby while the primary is healthy");
  });
  it("a chunk that throws leaves only that chunk's markets without state", async () => {
    const keys = Array.from({ length: 150 }, () => Keypair.generate().publicKey.toBase58());
    const accts = new Map(keys.map((k) => [k, v19Market(9_995n)]));
    const rpc = fakeRpc(accts);
    const real = rpc.getMultipleAccountsInfo.bind(rpc);
    let n = 0;
    rpc.getMultipleAccountsInfo = async (k: never, c: never) => { if (n++ === 1) throw new Error("429"); return real(k, c); };
    const g = new TakeoverGate(CFG, () => 0);
    await refreshTakeoverGate(rpc as never, g, keys, 0);
    assert.equal(keys.slice(0, 100).every((k) => g.isStandby(k, 0)), true);
    assert.equal(keys.slice(100).some((k) => g.isStandby(k, 0)), false);
  });
});

describe("lead 3: wall clock steps backwards", () => {
  it("a state stamped in the 'future' is unknown (push), not fresh forever", () => {
    const g = new TakeoverGate(CFG, () => 0);
    g.update(M, 100n, 110n, 3_600_000); // stamped at t=1h, then the clock steps back to t=0
    assert.equal(g.gapSlots(M, 0), null);
    assert.equal(g.isStandby(M, 0), false);
  });
});
