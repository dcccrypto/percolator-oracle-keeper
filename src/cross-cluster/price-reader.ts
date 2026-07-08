/**
 * cross-cluster/price-reader.ts
 *
 * Reads spot prices from mainnet DEX pools using the @percolatorct/sdk
 * dex-oracle module (detectDexType / parseDexPool / computeDexSpotPriceE6 /
 * fetchMintDecimals).
 *
 * Supported DEX types:
 *   raydium-clmm   price from sqrtPriceX64 (decimals embedded in pool data)
 *   meteora-dlmm   price from active_id/bin_step (caller-supplied decimals, cached)
 *   pumpswap       price from vault token reserves (vault accounts fetched per call)
 *
 * Liveness checks — returns priceE6=0n + skipped=true on:
 *   - Pool account not found or empty data
 *   - On-chain pool owner does not match expected dexType
 *   - computeDexSpotPriceE6 returns 0n (sqrtPrice=0 / binStep=0 / base-amount=0)
 *   - PumpSwap: either vault amount === 0
 *
 * RPC error handling:
 *   - HTTP 429 (rate-limit): exponential back-off with 20 % jitter (0.5 → 1 → 2 → 4 s)
 *   - Other errors: propagated to the caller (per-market isolation in the loop)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  detectDexType,
  parseDexPool,
  computeDexSpotPriceE6,
  fetchMintDecimals,
} from "@percolatorct/sdk";
import type { MarketEntry } from "./registry.ts";

/** Per-pool cached mint decimals (keyed by pool address string). */
export type DecimalsCache = Map<string, { base: number; quote: number }>;

export interface PriceReadResult {
  priceE6: bigint;
  /** Short description of the price source, e.g. "raydium-clmm:8sLbN…". */
  source: string;
  /** True when the pool was skipped due to a liveness/validation check. */
  skipped?: boolean;
  skipReason?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const MAX_RETRIES = 4;

function is429(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("429") || msg.includes("too many requests");
}

/**
 * Retry an RPC call only on 429 errors; propagate everything else immediately.
 * Delay sequence: 500 ms → 1 s → 2 s → 4 s (with 20 % jitter each step).
 */
async function withRpcBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delayMs = 500;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (is429(err) && attempt < MAX_RETRIES - 1) {
        const jitter = Math.floor(Math.random() * 0.2 * delayMs);
        const wait = delayMs + jitter;
        console.warn(
          `[price-reader] RPC 429 — backoff ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        delayMs = Math.min(delayMs * 2, 8_000);
      } else {
        throw err;
      }
    }
  }
  /* istanbul ignore next */
  throw new Error("unreachable");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the spot price (in e6) from a mainnet DEX pool.
 *
 * For Meteora DLMM, mint decimals are fetched once and cached in
 * `decimalsCache`. Pass the same Map across all calls in a keeper cycle.
 *
 * For PumpSwap, both vault accounts are fetched on every call so the price
 * always reflects the current reserve balance. An explicit base-vault-amount=0
 * check guards against un-seeded pools that would produce a divide-by-zero.
 *
 * A returned `skipped=true` result means the pool is not live or failed a
 * validation check — the caller should skip pushing this market for the cycle.
 */
export async function readPoolPriceE6(
  mainnetConn: Connection,
  entry: Pick<MarketEntry, "poolAddress" | "dexType" | "label">,
  decimalsCache: DecimalsCache,
): Promise<PriceReadResult> {
  const poolPk = new PublicKey(entry.poolAddress);
  const shortPool = entry.poolAddress.slice(0, 8) + "…";
  const source = `${entry.dexType}:${shortPool}`;

  // ── Fetch pool account ────────────────────────────────────────────────────
  const poolInfo = await withRpcBackoff(() =>
    mainnetConn.getAccountInfo(poolPk, "confirmed"),
  );
  if (!poolInfo) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason: "pool account not found on mainnet",
    };
  }
  if (poolInfo.data.length === 0) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason: "pool account has empty data",
    };
  }
  const data = new Uint8Array(poolInfo.data);

  // ── Validate owner matches expected DEX type ──────────────────────────────
  const detectedDex = detectDexType(poolInfo.owner);
  if (detectedDex !== entry.dexType) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason:
        `pool owner ${poolInfo.owner.toBase58()} does not match dexType=${entry.dexType}` +
        ` (detected: ${detectedDex ?? "unknown"})`,
    };
  }

  // ── Per-DEX price computation ─────────────────────────────────────────────

  if (entry.dexType === "raydium-clmm") {
    const priceE6 = computeDexSpotPriceE6("raydium-clmm", data);
    if (priceE6 === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "Raydium CLMM: sqrtPriceX64=0 (pool not initialised or live)",
      };
    }
    return { priceE6, source };
  }

  if (entry.dexType === "meteora-dlmm") {
    // Cache mint decimals after the first successful read.
    if (!decimalsCache.has(entry.poolAddress)) {
      const poolParsed = parseDexPool("meteora-dlmm", poolPk, data);
      const [baseDecimals, quoteDecimals] = await Promise.all([
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.baseMint)),
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.quoteMint)),
      ]);
      decimalsCache.set(entry.poolAddress, {
        base: baseDecimals,
        quote: quoteDecimals,
      });
      console.log(
        `[price-reader] Meteora ${shortPool} decimals cached:` +
          ` base(${poolParsed.baseMint.toBase58().slice(0, 8)}…)=${baseDecimals}` +
          ` quote(${poolParsed.quoteMint.toBase58().slice(0, 8)}…)=${quoteDecimals}`,
      );
    }
    const dec = decimalsCache.get(entry.poolAddress)!;
    const priceE6 = computeDexSpotPriceE6("meteora-dlmm", data, undefined, dec);
    if (priceE6 === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "Meteora DLMM: binStep=0 (pool not initialised or live)",
      };
    }
    return { priceE6, source };
  }

  if (entry.dexType === "pumpswap") {
    const poolParsed = parseDexPool("pumpswap", poolPk, data);
    if (!poolParsed.baseVault || !poolParsed.quoteVault) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: vault addresses missing from pool data",
      };
    }

    // Fetch both vault SPL token accounts
    const [baseVaultInfo, quoteVaultInfo] = await Promise.all([
      withRpcBackoff(() =>
        mainnetConn.getAccountInfo(poolParsed.baseVault!, "confirmed"),
      ),
      withRpcBackoff(() =>
        mainnetConn.getAccountInfo(poolParsed.quoteVault!, "confirmed"),
      ),
    ]);
    if (!baseVaultInfo || !quoteVaultInfo) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: vault account(s) not found on mainnet",
      };
    }

    const baseVaultData = new Uint8Array(baseVaultInfo.data);
    const quoteVaultData = new Uint8Array(quoteVaultInfo.data);

    // SPL token account: u64 amount is at byte offset 64.
    // Min length = 72 bytes (64 header + 8 for amount).
    const MIN_VAULT_LEN = 72;
    if (
      baseVaultData.length < MIN_VAULT_LEN ||
      quoteVaultData.length < MIN_VAULT_LEN
    ) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: `PumpSwap: vault data too short (base=${baseVaultData.length}, quote=${quoteVaultData.length})`,
      };
    }

    // Explicit base-vault-amount guard: an un-seeded pool has amount=0,
    // which would cause a divide-by-zero inside computeDexSpotPriceE6.
    const baseDv = new DataView(
      baseVaultData.buffer,
      baseVaultData.byteOffset,
      baseVaultData.byteLength,
    );
    const baseAmount =
      BigInt(baseDv.getUint32(64, true)) |
      (BigInt(baseDv.getUint32(68, true)) << 32n);
    if (baseAmount === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: base vault amount=0 (pool not seeded / not live)",
      };
    }

    const priceE6 = computeDexSpotPriceE6("pumpswap", data, {
      base: baseVaultData,
      quote: quoteVaultData,
    });
    if (priceE6 === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: computed price=0n",
      };
    }
    return { priceE6, source };
  }

  // TypeScript exhaustiveness guard
  return {
    priceE6: 0n,
    source,
    skipped: true,
    skipReason: `unsupported dexType: ${String(entry.dexType)}`,
  };
}

/**
 * FAST PATH: read ALL pool prices in a SINGLE getMultipleAccounts RPC call and
 * compute each spot price locally. Same DEX-pool source as readPoolPriceE6 (no
 * Pyth) — just collapses N sequential getAccountInfo calls into one, so the
 * keeper can push far faster without hammering the RPC. Meteora mint-decimals
 * are fetched once and cached (same as the single-read path); after the first
 * cycle everything comes from the one batched read.
 *
 * Returns a map of poolAddress → priceE6 (only pools that produced a valid price).
 */
export async function readAllPoolPricesE6(
  mainnetConn: Connection,
  entries: Array<Pick<MarketEntry, "poolAddress" | "dexType" | "label">>,
  decimalsCache: DecimalsCache,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (entries.length === 0) return out;
  const pubkeys = entries.map((e) => new PublicKey(e.poolAddress));
  const infos = await withRpcBackoff(() =>
    mainnetConn.getMultipleAccountsInfo(pubkeys, "confirmed"),
  );
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const info = infos[i];
    if (!info || info.data.length === 0) continue;
    if (detectDexType(info.owner) !== entry.dexType) continue;
    const data = new Uint8Array(info.data);
    try {
      let priceE6 = 0n;
      if (entry.dexType === "raydium-clmm") {
        priceE6 = computeDexSpotPriceE6("raydium-clmm", data);
      } else if (entry.dexType === "meteora-dlmm") {
        if (!decimalsCache.has(entry.poolAddress)) {
          const parsed = parseDexPool("meteora-dlmm", pubkeys[i], data);
          const [base, quote] = await Promise.all([
            withRpcBackoff(() => fetchMintDecimals(mainnetConn, parsed.baseMint)),
            withRpcBackoff(() => fetchMintDecimals(mainnetConn, parsed.quoteMint)),
          ]);
          decimalsCache.set(entry.poolAddress, { base, quote });
        }
        priceE6 = computeDexSpotPriceE6("meteora-dlmm", data, undefined, decimalsCache.get(entry.poolAddress)!);
      } else if (entry.dexType === "pumpswap") {
        priceE6 = computeDexSpotPriceE6("pumpswap", data);
      }
      if (priceE6 > 0n) out.set(entry.poolAddress, priceE6);
    } catch {
      /* skip this pool for this cycle; next cycle retries */
    }
  }
  return out;
}
