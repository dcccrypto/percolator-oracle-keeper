/**
 * Differential: the optimised gate/refresh must equal the pre-optimisation reference (copied verbatim from 12b4d5a)
 * over 2,000 random update / push / refresh / time sequences: state, isStandby, health JSON, activeAlerts.
 * Run with: node --import tsx/esm --test src/cross-cluster/pusher-role.differential.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_PUSHER_CONFIG, TakeoverGate, refreshTakeoverGate } from "./pusher-role.ts";

const SLOT_MS = 400;
const LAST_GOOD_SLOT_OFF = 168;
const SLICE_LEN = 176;
const CFG = { ...DEFAULT_PUSHER_CONFIG, takeoverSlots: 60n, staleStateMs: 30_000, alertHoldMs: 120_000 };

class OldGate {
  state = new Map<string, { lastGood: bigint; clusterSlot: bigint; at: number }>();
  takeoverAt = new Map<string, number>();
  takeoverCount = new Map<string, number>();
  labels = new Map<string, string>();
  constructor(private cfg = CFG, private now: () => number = Date.now) {}
  update(m: string, lastGood: bigint, clusterSlot: bigint, at = this.now()) {
    this.state.set(m, { lastGood, clusterSlot, at });
  }
  setLabel(m: string, l: string) {
    this.labels.set(m, l);
  }
  gapSlots(m: string, nowMs = this.now()): bigint | null {
    const s = this.state.get(m);
    if (!s || nowMs - s.at > this.cfg.staleStateMs) return null;
    const est = s.clusterSlot + BigInt(Math.max(0, Math.floor((nowMs - s.at) / SLOT_MS)));
    return est > s.lastGood ? est - s.lastGood : 0n;
  }
  isStandby(m: string, nowMs = this.now()): boolean {
    const g = this.gapSlots(m, nowMs);
    return g !== null && g < this.cfg.takeoverSlots;
  }
  recordPush(m: string, nowMs = this.now()) {
    this.takeoverAt.set(m, nowMs);
    this.takeoverCount.set(m, (this.takeoverCount.get(m) ?? 0) + 1);
  }
  activeAlerts(nowMs = this.now()) {
    const out: unknown[] = [];
    for (const [market, at] of this.takeoverAt) {
      if (nowMs - at > this.cfg.alertHoldMs) continue;
      const label = this.labels.get(market) ?? market;
      out.push({
        kind: "pusher-takeover",
        severity: "critical",
        subject: label,
        message:
          `the second pusher is the one keeping ${label} alive: the on-chain price was older than ${this.cfg.takeoverSlots} slots, ` +
          `so the primary keeper is NOT pushing this market (${this.takeoverCount.get(market) ?? 0} takeover push(es) since boot). Check the primary keeper.`,
        data: { market, takeoverPushes: this.takeoverCount.get(market) ?? 0 },
      });
    }
    return out;
  }
  health(markets: readonly string[], nowMs = this.now()) {
    const out: Record<string, unknown> = {};
    for (const m of markets) {
      const s = this.state.get(m);
      const g = this.gapSlots(m, nowMs);
      const at = this.takeoverAt.get(m);
      out[m] = {
        standby: this.isStandby(m, nowMs),
        gapSlots: g === null ? null : g.toString(),
        lastGoodSlot: s ? s.lastGood.toString() : null,
        takeoverPushes: this.takeoverCount.get(m) ?? 0,
        lastTakeoverAgoMs: at === undefined ? null : nowMs - at,
      };
    }
    return out;
  }
}

async function oldRefresh(conn: any, gate: OldGate, markets: readonly string[], nowMs: number) {
  try {
    if (markets.length === 0) return;
    const keys = markets.map((m) => new PublicKey(m));
    const [slot, infos] = await Promise.all([
      conn.getSlot("confirmed"),
      conn.getMultipleAccountsInfo(keys, { commitment: "confirmed", dataSlice: { offset: 0, length: SLICE_LEN } }),
    ]);
    infos.forEach((info: { data: Buffer } | null, i: number) => {
      if (!info || info.data.length < SLICE_LEN) return;
      gate.update(markets[i], info.data.readBigUInt64LE(LAST_GOOD_SLOT_OFF), BigInt(slot), nowMs);
    });
  } catch {
    /* fail open */
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

describe("takeover gate differential (old vs new)", () => {
  it("identical over 2,000 random sequences", async () => {
    const pool = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
    for (let seq = 0; seq < 2000; seq++) {
      const r = rng(seq + 1);
      let t = 1_000_000;
      const a = new OldGate(CFG, () => t);
      const b = new TakeoverGate(CFG, () => t);
      const pick = () => pool[Math.floor(r() * pool.length)];
      const subset = () => {
        const n = Math.floor(r() * 8);
        const o: string[] = [];
        for (let i = 0; i < n; i++) o.push(r() < 0.05 ? "not-a-pubkey" : pick()); // dupes + invalid allowed
        return o;
      };
      const steps = 5 + Math.floor(r() * 25);
      for (let k = 0; k < steps; k++) {
        const op = r();
        t += Math.floor(r() * 20_000);
        if (op < 0.25) {
          const m = pick();
          const lg = BigInt(Math.floor(r() * 1000));
          const cs = BigInt(Math.floor(r() * 1100));
          const at = r() < 0.5 ? undefined : t - Math.floor(r() * 40_000);
          a.update(m, lg, cs, at);
          b.update(m, lg, cs, at);
        } else if (op < 0.4) {
          const m = pick();
          a.recordPush(m);
          b.recordPush(m);
        } else if (op < 0.45) {
          const m = pick();
          a.setLabel(m, "L" + k);
          b.setLabel(m, "L" + k);
        } else if (op < 0.7) {
          const ms = subset();
          const slot = Math.floor(r() * 1100);
          const lg = Math.floor(r() * 1000);
          const mk = () => {
            const buf = Buffer.alloc(SLICE_LEN);
            buf.writeBigUInt64LE(BigInt(lg), LAST_GOOD_SLOT_OFF);
            return buf;
          };
          const shape = ms.map(() => {
            const x = r();
            return x < 0.15 ? null : x < 0.25 ? Buffer.alloc(10) : mk();
          });
          const fail = r() < 0.1;
          const conn = {
            getSlot: async () => {
              if (fail) throw new Error("rpc");
              return slot;
            },
            getMultipleAccountsInfo: async () => shape.map((d) => (d ? { data: d } : null)),
          };
          await oldRefresh(conn, a, ms, t);
          await refreshTakeoverGate(conn as never, b, ms, t);
        }
        const ms = [...pool.slice(0, 8), "unseen"];
        const nowQ = t + Math.floor(r() * 50_000);
        for (const m of ms) {
          assert.equal(b.isStandby(m, nowQ), a.isStandby(m, nowQ));
          assert.equal(b.gapSlots(m, nowQ), a.gapSlots(m, nowQ));
        }
        assert.equal(JSON.stringify(b.health(ms, nowQ)), JSON.stringify(a.health(ms, nowQ)));
        assert.equal(JSON.stringify(b.activeAlerts(nowQ)), JSON.stringify(a.activeAlerts(nowQ)));
      }
    }
  });
});
