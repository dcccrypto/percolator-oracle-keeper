/**
 * cross-cluster/p2b-markets.ts
 *
 * One batched read of what every v2.1 keeper task needs about a market: the market account, its
 * LP-vault registry and its vault_lp_state. Three accounts per market, `getMultipleAccountsInfoAndContext`
 * chunked at 100 keys, so a tick costs one RPC per ~33 markets however many tasks are due.
 *
 * Only the v2.1 layer uses this (it is never reached on today's programs: see p2b-feature.ts).
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { deriveLpVaultRegistry, parseLpVaultRegistry } from "@percolatorct/sdk";
import type { LpVaultRegistryV17 } from "@percolatorct/sdk";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import type { VaultLpState } from "./resolved-portfolio-cleanup.ts";
import { lpVaultRegistryBound, lpVaultRegistryExtFlag } from "./registry-flags.ts";

export interface MarketRef {
  marketAddress: string;
  label: string;
  /** Registry asset index (single-asset markets: 0). */
  assetIndex: number;
}

export interface VaultMarketSnapshot {
  ref: MarketRef;
  market: PublicKey;
  /** Chain slot of the read (context slot). */
  slot: number;
  marketData: Uint8Array | null;
  registryData: Uint8Array | null;
  /** null when there is no registry account or it did not parse. */
  registry: LpVaultRegistryV17 | null;
  /** Registry bound flag (byte 160); false on a missing registry or an invalid byte. */
  bound: boolean;
  /** Registry ext flag (byte 161). */
  extFlag: boolean;
  vaultLp: VaultLpState | null;
}

export type SnapshotConnection = Pick<Connection, "getMultipleAccountsInfoAndContext">;

/** Read the snapshot of every market in `markets`. A failed chunk leaves its markets out (never throws). */
export async function readVaultMarketSnapshots(
  conn: SnapshotConnection,
  programId: PublicKey,
  markets: ReadonlyArray<MarketRef>,
): Promise<Map<string, VaultMarketSnapshot>> {
  const out = new Map<string, VaultMarketSnapshot>();
  const PER_CHUNK = 33; // 3 accounts each -> 99 keys
  for (let i = 0; i < markets.length; i += PER_CHUNK) {
    const chunk = markets.slice(i, i + PER_CHUNK);
    const keys: PublicKey[] = [];
    const parsed: Array<{ ref: MarketRef; market: PublicKey } | null> = [];
    for (const ref of chunk) {
      let market: PublicKey;
      try {
        market = new PublicKey(ref.marketAddress);
      } catch {
        parsed.push(null);
        continue;
      }
      parsed.push({ ref, market });
      keys.push(market, deriveLpVaultRegistry(programId, market)[0], deriveVaultLpState(programId, market));
    }
    if (keys.length === 0) continue;
    let res;
    try {
      res = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
    } catch {
      continue;
    }
    let k = 0;
    for (const p of parsed) {
      if (!p) continue;
      const m = res.value[k++];
      const r = res.value[k++];
      const s = res.value[k++];
      const marketData = m ? new Uint8Array(m.data) : null;
      const registryData = r ? new Uint8Array(r.data) : null;
      let registry: LpVaultRegistryV17 | null = null;
      let bound = false;
      let extFlag = false;
      if (registryData) {
        try {
          registry = parseLpVaultRegistry(registryData);
        } catch {
          registry = null;
        }
        try {
          bound = lpVaultRegistryBound(registryData);
        } catch {
          bound = false;
        }
        extFlag = lpVaultRegistryExtFlag(registryData);
      }
      out.set(p.ref.marketAddress, {
        ref: p.ref,
        market: p.market,
        slot: res.context.slot,
        marketData,
        registryData,
        registry,
        bound,
        extFlag,
        vaultLp: s ? decodeVaultLpState(new Uint8Array(s.data)) : null,
      });
    }
  }
  return out;
}

/** u64 little-endian at `off`. */
export function readU64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}

/** u128 little-endian at `off`. */
export function readU128(d: Uint8Array, off: number): bigint {
  return readU64(d, off) | (readU64(d, off + 8) << 64n);
}
