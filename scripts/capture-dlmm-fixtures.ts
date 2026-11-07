/**
 * Captures a Meteora DLMM pool plus the bin arrays around its active bin from MAINNET (read-only, one
 * getMultipleAccounts at one slot) into a test fixture JSON. Usage:
 *   tsx scripts/capture-dlmm-fixtures.ts <name> <pool> <outFile> [arraysEachSide=2]
 * Public RPC by default (RPC_URL overrides). No keys, no transactions.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { DLMM_PROGRAM_ID, binArrayAddress, binArrayIndexOf } from "../src/cross-cluster/dlmm-depth.ts";

const [name, poolStr, out, sideStr] = process.argv.slice(2);
if (!name || !poolStr || !out) throw new Error("usage: capture-dlmm-fixtures.ts <name> <pool> <outFile> [arraysEachSide]");
const side = Number(sideStr ?? "2");
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const pool = new PublicKey(poolStr);
const first = await conn.getAccountInfo(pool);
if (!first || !first.owner.equals(DLMM_PROGRAM_ID)) throw new Error("not a DLMM pool");
const center = binArrayIndexOf(Buffer.from(first.data).readInt32LE(76));
const idxs: number[] = [];
for (let i = center - side; i <= center + side; i++) idxs.push(i);
const addrs = idxs.map((i) => binArrayAddress(pool, i));
const res = await conn.getMultipleAccountsInfoAndContext([pool, ...addrs], "confirmed");
const b64 = (a: { data: Buffer } | null) => (a ? a.data.toString("base64") : null);
const mint = (off: number) => new PublicKey(Buffer.from(res.value[0]!.data).subarray(off, off + 32));
const dec = async (m: PublicKey) => {
  const a = await conn.getAccountInfo(m);
  return a!.data[44];
};
writeFileSync(
  out,
  JSON.stringify(
    {
      name,
      pool: poolStr,
      slot: res.context.slot,
      capturedAt: new Date().toISOString(),
      baseMint: mint(88).toBase58(),
      quoteMint: mint(120).toBase58(),
      baseDecimals: await dec(mint(88)),
      quoteDecimals: await dec(mint(120)),
      poolData: b64(res.value[0]),
      binArrays: idxs.map((index, k) => ({ index, address: addrs[k].toBase58(), data: b64(res.value[k + 1]) })),
    },
    null,
    1,
  ) + "\n",
);
console.log(name, "slot", res.context.slot, "arrays", idxs.map((i, k) => `${i}:${res.value[k + 1] ? "ok" : "MISSING"}`).join(" "));
