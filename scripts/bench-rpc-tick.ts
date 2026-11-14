/**
 * Counting-mock RPC bench: how many RPC requests (and request bytes) does ONE v2.2 settle round make over N positioned
 * accounts? Wraps the recording fake connection with a per-method counter and prints a sha256 of what was decided
 * (every simulated + sent transaction's instruction tags/keys/data, and the round result), so a change can prove the
 * decisions are identical.
 *
 *   node --import tsx/esm scripts/bench-rpc-tick.ts [N=1000]
 */
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { fakeExecConn, execCtx, key } from "../src/cross-cluster/v22/test-helpers.ts";
import { runSettleRound, DEFAULT_SWEEP_ROUND_CONFIG } from "../src/cross-cluster/v22/sweep.ts";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";

const N = Number(process.argv[2] ?? 1000);

const cps: PositionedPortfolio[] = [];
for (let i = 0; i < N; i++) cps.push({ pubkey: key(100 + i), longLegs: 1 + (i % 2), shortLegs: i % 3 === 0 ? 1 : 0, isLp: false, lossWeight: BigInt((i * 7) % 5) });
const lp = key(1);
const anchor = key(2);
const market = key(3);

const f = fakeExecConn();
const counts: Record<string, number> = {};
let bytes = 0;
const conn = new Proxy(f.conn as object, {
  get(t, p, r) {
    const v = Reflect.get(t, p, r);
    if (typeof v !== "function" || typeof p !== "string") return v;
    return (...a: unknown[]) => {
      counts[p] = (counts[p] ?? 0) + 1;
      // request bytes: serialized tx for simulate/send, else the JSON of the args
      const a0 = a[0] as { serialize?: () => Uint8Array } | Uint8Array | undefined;
      bytes += a0 instanceof Uint8Array ? a0.length : a0 && typeof (a0 as { serialize?: unknown }).serialize === "function" ? (a0 as { serialize: () => Uint8Array }).serialize().length : JSON.stringify(a, (_k, x) => (typeof x === "bigint" ? String(x) : x)).length;
      return (v as (...x: unknown[]) => unknown).apply(t, a);
    };
  },
}) as typeof f.conn;

const deps = { exec: { ...execCtx(conn), keeper: Keypair.fromSeed(new Uint8Array(32).fill(9)) }, getSlot: () => conn.getSlot(), hold: () => {}, release: () => {} };
const res = await runSettleRound(deps, { market, label: "bench" }, { lp, counterparties: cps, anchor, nowSlot: 1000 }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "prefer" });

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const h = createHash("sha256");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
h.update(JSON.stringify({ sims: f.sims, sent: f.sent.map((s) => ({ tags: s.tags, keys: s.keys })), data: f.sentData.map((d) => d.map(hex)), simUnits: f.simUnits }));
h.update(JSON.stringify({ txsSent: res.txsSent, settled: res.settled, missing: res.missing, lpSettled: res.lpSettled, abandoned: res.abandoned, txs: res.plan.txs.length }, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
console.log(JSON.stringify({ N, txsPlanned: res.plan.txs.length, txsSent: res.txsSent, rpcCallsPerTick: total, byMethod: counts, requestBytes: bytes, decisionsSha256: h.digest("hex") }, null, 1));
