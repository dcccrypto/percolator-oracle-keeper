/**
 * Synthetic N-candidate world for the resolved-loser-force-close differential test and bench (not a production module).
 * Every candidate reuses the real CODEC loser portfolio bytes under a distinct, deterministic pubkey; the fake chain answers
 * each CloseResolved simulation by the last base58 character of the portfolio key so all outcome branches are exercised.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import type { LoserForceCloseConfig } from "./resolved-loser-force-close.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
export const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
export const NFT = new PublicKey("27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1");
export const CODEC = new PublicKey("DJM81s8hi5KnozZrgL5MzdJ8sN1mnxBzAY17VBTVkxwU");
export const MARKET = new Uint8Array(fx("v22-codec-market-v19-resolved"));
export const NOW_SLOT = 509_455_455n + 216_000n + 10n;
const PORTFOLIO = new Uint8Array(fx("v22-codec-pf-5vYAD3RK"));
const ELF = fx("wrapper-elf4096-rc22-s16ac-776d2491");
const PROGRAMDATA = new PublicKey("11111111111111111111111111111112");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** n distinct pseudo-random keys (mixed-case base58, so ICU order differs from raw byte order). */
export function syntheticKeys(n: number, seed = 7): PublicKey[] {
  const r = rng(seed);
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  while (out.length < n) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = Math.floor(r() * 256);
    const k = new PublicKey(b);
    const s = k.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

export const cfg = (over: Partial<LoserForceCloseConfig> = {}): LoserForceCloseConfig => ({
  wrapperProgramId: WRAPPER,
  nftProgramId: NFT,
  maxScanPerCycle: 32,
  maxClosesPerCycle: 8,
  maxChunkCallsPerPortfolio: 16,
  maxAtaCreatesPerCycle: 4,
  gateTtlMs: 600_000,
  confirm: { statusRetries: 0, statusRetryDelayMs: 0 },
  log: () => {},
  ...over,
});

export interface SyntheticWorld {
  conn: Record<string, unknown>;
  trace: string[];
}

/** `trace` records every simulated/queried portfolio key in call order (the observable sort order of the scan window). */
export function syntheticWorld(keys: PublicKey[]): SyntheticWorld {
  const trace: string[] = [];
  const flipped = new Uint8Array(PORTFOLIO);
  flipped[flipped.length - 1] ^= 0xff;
  const cls = (b58: string): number => b58.charCodeAt(b58.length - 1) % 4;
  const conn = {
    async getAccountInfo(k: PublicKey) {
      if (k.equals(WRAPPER)) {
        const d = Buffer.alloc(36);
        d.writeUInt32LE(2, 0);
        PROGRAMDATA.toBuffer().copy(d, 4);
        return { data: d, owner: LOADER, lamports: 1, executable: true };
      }
      if (k.equals(PROGRAMDATA)) return { data: ELF, owner: LOADER, lamports: 1, executable: false };
      return null;
    },
    async getMultipleAccountsInfo(ks: PublicKey[]) {
      trace.push(`ata:${ks.length}`);
      return ks.map((_k, i) => (i % 2 === 0 ? { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false } : null));
    },
    async getProgramAccounts() {
      return keys.map((k) => ({ pubkey: k, account: { data: Buffer.from(PORTFOLIO), owner: WRAPPER, lamports: 1, executable: false } }));
    },
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
    },
    async simulateTransaction(_tx: unknown, opts: { accounts?: { addresses: string[] } }) {
      const watch = opts.accounts!.addresses[0];
      trace.push(`sim:${watch}`);
      switch (cls(watch)) {
        case 0:
          return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 21 }] }, logs: [], accounts: null } };
        case 1:
          return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: [Buffer.from(flipped).toString("base64"), "base64"] }] } };
        case 2:
          return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: [Buffer.from(PORTFOLIO).toString("base64"), "base64"] }] } };
        default:
          return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 6 }] }, logs: [], accounts: null } };
      }
    },
    async sendRawTransaction() {
      throw new Error("never sent: dryRun");
    },
    async getSignatureStatuses() {
      return { value: [] };
    },
  };
  return { conn, trace };
}
