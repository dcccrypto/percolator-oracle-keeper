/**
 * Test helpers for the TX_V1 PushAuthMark path (tx-v1.test.ts).
 *
 * `legacyGoldenScenarios` is deliberately written against ONLY the pre-v1 pusher API
 * (`pushAuthMarkBatch(conn, keeper, pushes, nowSlot, blockhash, dryRun)` + a legacy-only
 * mock connection), so the very same function can be run against the base commit's
 * auth-mark-pusher.ts to produce the golden hashes pinned in tx-v1.test.ts.
 */
import { createHash } from "node:crypto";
import { Keypair, VersionedTransaction, type PublicKey } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
} from "@percolatorct/sdk";

export const GOLDEN_BLOCKHASH = { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1 };
export const GOLDEN_NOW_SLOT = 505_000_000n;

/** Minimal live-market slab: magic, version, market_id 1, oracle_observation = `seq`, and a tail so it is "Live". */
export function marketAccount(seq: bigint, extra = 0): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN; // asset 0
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8 + extra);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, seq, true);
  return buf;
}

export function seededKeypair(tag: number, i: number): Keypair {
  const seed = new Uint8Array(32);
  seed[0] = tag;
  seed[1] = i & 0xff;
  seed[2] = (i >> 8) & 0xff;
  seed[31] = 0x5a;
  return Keypair.fromSeed(seed);
}

export function seededMarkets(tag: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => seededKeypair(tag, i + 1).publicKey.toBase58());
}

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

type LegacyIx = { keys: Array<{ pubkey: PublicKey }> };
type PushBatch = (
  conn: never,
  keeper: Keypair,
  pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>,
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
  dryRun: boolean,
) => Promise<{ pushedMarkets: string[]; skippedMarkets: string[] }>;

/**
 * Legacy-only mock: preflight outcome is decided per tx from the markets it carries.
 * - `locked` market anywhere in a tx -> `{"InstructionError":[1+pos,{"Custom":21}]}`.
 * - `opaque` market in a multi-push tx -> a non-instruction error (forces one-at-a-time isolation);
 *   alone -> the same non-instruction error (strike).
 */
function legacyConn(markets: string[], locked: Set<string>, opaque: Set<string>, sent: Uint8Array[]) {
  return {
    async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
      return pks.map((pk) => (markets.includes(pk.toBase58()) ? { data: marketAccount(100n) } : null));
    },
    async simulateTransaction(tx: { instructions: LegacyIx[] }) {
      const ms = tx.instructions.slice(1).map((ix) => ix.keys[1]!.pubkey.toBase58());
      if (ms.some((m) => opaque.has(m))) return { value: { err: "AccountInUse", logs: [] } };
      const at = ms.findIndex((m) => locked.has(m));
      return { value: { err: at >= 0 ? { InstructionError: [at + 1, { Custom: 21 }] } : null, logs: [] } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(Uint8Array.from(raw));
      return `sig${sent.length}`;
    },
    async getSignatureStatuses() {
      return { value: [] };
    },
  };
}

/**
 * Three legacy scenarios (clean 30, one locked market in 30, one opaque failure in 15).
 * Returns the sha256 of every sent wire, in send order, plus the pushed/skipped sets.
 */
export async function legacyGoldenScenarios(pushAuthMarkBatch: PushBatch): Promise<Record<string, { sent: string[]; pushed: number; skipped: string[] }>> {
  const keeper = seededKeypair(7, 0);
  const out: Record<string, { sent: string[]; pushed: number; skipped: string[] }> = {};
  const scenarios: Array<[string, number, number, (ms: string[]) => { locked: Set<string>; opaque: Set<string> }]> = [
    ["clean30", 1, 30, () => ({ locked: new Set(), opaque: new Set() })],
    ["locked30", 2, 30, (ms) => ({ locked: new Set([ms[5]!]), opaque: new Set() })],
    ["opaque15", 3, 15, (ms) => ({ locked: new Set(), opaque: new Set([ms[2]!]) })],
  ];
  for (const [name, tag, n, mk] of scenarios) {
    const ms = seededMarkets(tag, n);
    const { locked, opaque } = mk(ms);
    const sent: Uint8Array[] = [];
    const conn = legacyConn(ms, locked, opaque, sent);
    const res = await pushAuthMarkBatch(
      conn as never,
      keeper,
      ms.map((m, i) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n + BigInt(i) })),
      GOLDEN_NOW_SLOT,
      GOLDEN_BLOCKHASH,
      false,
    );
    out[name] = { sent: sent.map(sha256), pushed: res.pushedMarkets.length, skipped: [...res.skippedMarkets].sort() };
  }
  return out;
}

/** Markets carried by a sent wire (legacy or v1), decoded with web3.js (independent of the SDK encoder). */
export function marketsInWire(wire: Uint8Array, wrapper: string): string[] {
  const vt = VersionedTransaction.deserialize(wire);
  const keys = vt.message.staticAccountKeys;
  return vt.message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex]!.toBase58() === wrapper)
    .map((ix) => keys[ix.accountKeyIndexes[1]!]!.toBase58());
}
