/**
 * Microbenchmark of planSettleRound (per asset per round). No RPC. Prints mean ms/call for each
 * N in {100, 500, 2000} x maxTxsPerRound in {default(16), 1000} x mode {prefer, strict, off}, plus a sha256 of
 * every plan so a change can prove identical output (the hash column must not change before/after).
 *
 *   node --import tsx/esm scripts/bench-settle-pairing.ts [iters=400] [warmup=50]
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { PositionedPortfolio } from "../src/cross-cluster/positioned-refresh.ts";
import { planSettleRound } from "../src/cross-cluster/v22/settle-pairing.ts";
import type { PairingMode } from "../src/cross-cluster/v22/flags.ts";

const ITERS = Number(process.argv[2] ?? 400);
const WARM = Number(process.argv[3] ?? 50);

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
const mkCps = (n: number): PositionedPortfolio[] => {
  const out: PositionedPortfolio[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      pubkey: mkKey(),
      longLegs: Math.floor(rnd() * 3),
      shortLegs: Math.floor(rnd() * 3),
      isLp: false,
      lossWeight: BigInt(Math.floor(rnd() * 1_000_000)),
    });
  }
  return out;
};

const lp = mkKey();
const rows: string[] = [];
rows.push("N\tmaxTxs\tmode\tms/call\tplanHash");
for (const n of [100, 500, 2000]) {
  const counterparties = mkCps(n);
  for (const maxTxsPerRound of [undefined, 1000]) {
    for (const mode of ["prefer", "strict", "off"] as PairingMode[]) {
      const run = () => planSettleRound({ mode, lp, counterparties, maxTxsPerRound });
      for (let i = 0; i < WARM; i++) run();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < ITERS; i++) run();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / ITERS;
      const plan = run();
      const h = createHash("sha256")
        .update(JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v)))
        .digest("hex")
        .slice(0, 12);
      rows.push(`${n}\t${maxTxsPerRound ?? "default"}\t${mode}\t${ms.toFixed(3)}\t${h}`);
    }
  }
}
console.log(rows.join("\n"));
