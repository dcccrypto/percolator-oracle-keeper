/**
 * Microbenchmark: the pure-CPU planning half of one v2.2 sweep tick over N positioned accounts
 * (Stage A liquidation screen + settle-round plan, all pairing modes, anchor / no anchor). No RPC.
 * Prints median-of-5 ms per tick and a sha256 of the plan output (decisions) so a change can prove identical output.
 *
 *   node --import tsx/esm scripts/bench-plan-tick.ts [N=1000]
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";
import { planSettleRound } from "../src/cross-cluster/v22/settle-pairing.ts";
import type { PairingMode } from "../src/cross-cluster/v22/settle-pairing.ts";
import { markLiquidationCandidates } from "../src/cross-cluster/v22/liquidation.ts";
import type { MarginParams } from "../src/cross-cluster/v22/liquidation.ts";

const N = Number(process.argv[2] ?? 1000);

// deterministic xorshift
let s = 0x9e3779b9;
const rnd = (): number => {
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5; s >>>= 0;
  return s / 0x100000000;
};

const mkKey = (): PublicKey => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(rnd() * 256);
  return new PublicKey(b);
};

const cps: PositionedPortfolio[] = [];
for (let i = 0; i < N; i++) {
  const legs = 1 + Math.floor(rnd() * 3); // 1..3 legs: many weight ties
  const longLegs = Math.ceil(legs / 2);
  const shortLegs = legs - longLegs;
  const aBasis = 1_000_000_000_000n;
  const basis = BigInt(1 + Math.floor(rnd() * 5_000_000)) * 1_000n;
  cps.push({
    pubkey: mkKey(),
    longLegs,
    shortLegs,
    isLp: false,
    activeLegs: legs,
    lossWeight: BigInt(Math.floor(rnd() * 4)), // ties on purpose
    risk: {
      equity: BigInt(Math.floor(rnd() * 400_000_000)),
      legs: Array.from({ length: legs }, (_, k) => ({ assetIndex: 0, side: k % 2, basis: k % 2 ? -basis : basis, aBasis })),
    },
  });
}
const lp = mkKey();
const anchor = mkKey();
const params: MarginParams = {
  mmrBps: 500n,
  minNonzeroMmReq: 1_000n,
  assets: new Map([[0, { priceE6: 150_000_000n, rawTargetE6: 149_000_000n, aLong: aOne(), aShort: aOne() }]]),
};
function aOne(): bigint { return 1_000_000_000_000n; }

const modes: PairingMode[] = ["off", "prefer", "strict"];

function tick(): string {
  const h = createHash("sha256");
  const { marked, candidates } = markLiquidationCandidates(cps, { params, padBps: 500 });
  h.update(`cand:${candidates.size};` + marked.map((p) => p.liqWeight ?? 0).join(","));
  for (const mode of modes) {
    for (const a of [null, anchor]) {
      for (const wb of [32, 64]) {
        const plan = planSettleRound({ mode, lp, lpWeight: 5, counterparties: marked, anchor: a, weightBudget: wb, maxTxsPerRound: 16 });
        h.update(
          JSON.stringify({
            mode: plan.mode,
            lpTxIndex: plan.lpTxIndex,
            paired: plan.paired,
            lpDeferred: plan.lpDeferred,
            unpairedLpSettle: plan.unpairedLpSettle,
            phases: plan.phases,
            needsPushHold: plan.needsPushHold,
            notes: plan.notes,
            unvisited: plan.unvisited.map((p) => p.pubkey.toBase58()),
            txs: plan.txs.map((t) => [t.index, t.accrue, t.accrueTarget?.toBase58() ?? null, t.settlesLp, t.weight, t.refresh.map((p) => p.pubkey.toBase58())]),
          }),
        );
      }
    }
  }
  return h.digest("hex");
}

tick(); // warm up
const times: number[] = [];
let digest = "";
for (let r = 0; r < 5; r++) {
  const t0 = process.hrtime.bigint();
  digest = tick();
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const sorted = [...times].sort((a, b) => a - b);
console.log(JSON.stringify({ n: N, runsMs: times.map((t) => +t.toFixed(1)), medianMs: +sorted[2].toFixed(1), minMs: +sorted[0].toFixed(1), maxMs: +sorted[4].toFixed(1), sha256: digest }));
