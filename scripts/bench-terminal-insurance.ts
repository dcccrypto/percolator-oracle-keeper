/**
 * One terminal-insurance pass (windDownOnce over N Resolved v5-pool markets) with a zero-latency fake
 * Connection, median of 5, plus the raw cost of the derivations the pass performs. A real pass is
 * dominated by RPC round-trips; this isolates the CPU the keeper spends outside them.
 *
 *   node --import tsx/esm scripts/bench-terminal-insurance.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { creatorCollateralAta, TerminalInsuranceState, windDownOnce } from "../src/cross-cluster/terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "../src/cross-cluster/terminal-insurance.ts";

const fxDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cross-cluster", "__fixtures__");
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(fxDir, `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const KEEPER = Keypair.generate();
const CFG: TerminalInsuranceConfig = {
  wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0,
};
const ADMIN = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const VAULT = Keypair.generate().publicKey;

const marketBuf = Buffer.from(fx("textit-market-v18-fees"));
marketBuf[592 + 626] = 1;
marketBuf.writeBigUInt64LE(0n, 592 + 461);
marketBuf.writeBigUInt64LE(0n, 592 + 461 + 8);
marketBuf.writeBigUInt64LE(0n, 592 + 517);
const poolBuf = Buffer.from(fx("v22-sol-stake-pool-v5"));
MINT.toBuffer().copy(poolBuf, 72); VAULT.toBuffer().copy(poolBuf, 136);
WRAPPER.toBuffer().copy(poolBuf, 224); ADMIN.toBuffer().copy(poolBuf, 40);
poolBuf[280] = 0; poolBuf[408] = 1;
const ataKey = creatorCollateralAta(ADMIN, MINT);
const tokenAcct = Buffer.alloc(165);
MINT.toBuffer().copy(tokenAcct, 0); ADMIN.toBuffer().copy(tokenAcct, 32); tokenAcct[108] = 1;

const conn = {
  async getMultipleAccountsInfo() {
    return [
      { data: marketBuf, owner: WRAPPER, lamports: 1, executable: false },
      { data: poolBuf, owner: STAKE, lamports: 1, executable: false },
    ];
  },
  async getAccountInfo(key: PublicKey) {
    return key.equals(ataKey) ? { data: tokenAcct, owner: TOKEN, lamports: 1, executable: false } : null;
  },
  async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }; },
  async simulateTransaction() { return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 31 }] }, logs: [] } }; },
  async sendRawTransaction() { return "5ig111111111111111111111111111111111111111111111111111111111111"; },
  async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
  async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: [] }; },
} as unknown as TerminalConnection;

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const origLog = console.log, origWarn = console.warn;

async function pass(addrs: string[]): Promise<number> {
  const st = new TerminalInsuranceState();
  const t0 = performance.now();
  for (const a of addrs) await windDownOnce(conn, KEEPER, a, false, CFG, st);
  return performance.now() - t0;
}

console.log = () => {}; console.warn = () => {};
const rows: string[] = [];
for (const n of [20, 200]) {
  const addrs = Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
  await pass(addrs); // warmup
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) runs.push(await pass(addrs));
  rows.push(`pass N=${n}: median ${median(runs).toFixed(2)} ms  (runs ${runs.map((r) => r.toFixed(1)).join(", ")})`);
}
console.log = origLog; console.warn = origWarn;
rows.forEach((r) => console.log(r));

// Raw derivation costs (per call), same inputs the pass uses.
const addr = Keypair.generate().publicKey.toBase58();
const time = (name: string, f: () => unknown, it = 2000): void => {
  for (let i = 0; i < 200; i++) f();
  const t0 = performance.now();
  for (let i = 0; i < it; i++) f();
  console.log(`  ${name}: ${(((performance.now() - t0) / it) * 1000).toFixed(2)} us/call`);
};
time("new PublicKey(base58)", () => new PublicKey(addr));
time("creatorCollateralAta (findProgramAddressSync)", () => creatorCollateralAta(ADMIN, MINT));
time("deriveStakePool (not in scope)", () => deriveStakePool(new PublicKey(addr), STAKE));
