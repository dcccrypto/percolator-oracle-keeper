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
 *   pumpswap       price from vault token reserves, decimal-adjusted, converted
 *                  to USD via the registry's SOL/USD reference market (see
 *                  `isSolUsdEntry` below) when the pool is WSOL-quoted (almost
 *                  always). Base/quote mint decimals are cached the same way
 *                  as Meteora's.
 *
 * Liveness checks — returns priceE6=0n + skipped=true on:
 *   - Pool account not found or empty data
 *   - On-chain pool owner does not match expected dexType
 *   - computeDexSpotPriceE6 returns 0n (sqrtPrice=0 / binStep=0 / base-amount=0)
 *   - PumpSwap: either vault amount === 0, or the pool is WSOL-quoted and no
 *     SOL/USD price was available this cycle (the reference market's own read
 *     failed/was skipped)
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
  SPL_MINT_DECIMALS_OFFSET,
  WSOL_MINT,
} from "@percolatorct/sdk";
import type { MarketEntry } from "./registry.ts";

/** Per-pool cached mint decimals (keyed by pool address string). */
export type DecimalsCache = Map<string, { base: number; quote: number }>;

/**
 * True when `entry` is (by convention) this registry's SOL/USD reference
 * market — a raydium-clmm or meteora-dlmm pool whose computed price is
 * treated as the current SOL/USD rate for the cycle. PumpSwap pools quote in
 * WSOL, not USD, so converting them to USD requires resolving this price
 * first (see {@link readAllPoolPricesE6} and {@link readPoolPriceE6}).
 *
 * Matches on `symbol === "SOL/USDC"` / `"SOL/USDT"` (the convention used by
 * every pre-seeded registry.json entry and by register-poll.ts), falling
 * back to a `label` prefix check for entries that lack `symbol`.
 */
export function isSolUsdEntry(entry: Pick<MarketEntry, "dexType" | "label" | "symbol">): boolean {
  if (entry.dexType !== "raydium-clmm" && entry.dexType !== "meteora-dlmm") return false;
  const sym = (entry.symbol ?? "").toUpperCase();
  if (sym === "SOL/USDC" || sym === "SOL/USDT") return true;
  const label = (entry.label ?? "").toUpperCase();
  return label.startsWith("SOL/USDC") || label.startsWith("SOL/USDT");
}

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
 * For Meteora DLMM and PumpSwap, mint decimals are fetched once and cached in
 * `decimalsCache`. Pass the same Map across all calls in a keeper cycle.
 *
 * For PumpSwap, both vault accounts are fetched on every call so the price
 * always reflects the current reserve balance. An explicit base-vault-amount=0
 * check guards against un-seeded pools that would produce a divide-by-zero.
 * PumpSwap pools quote in WSOL almost universally, so `solPriceE6` (the
 * current SOL/USD price, e6) is REQUIRED to produce a USD price for those —
 * callers should resolve it from this registry's SOL/USD reference market
 * (see {@link isSolUsdEntry}) before calling this for a pumpswap entry. A
 * WSOL-quoted pool with no `solPriceE6` supplied is skipped (not thrown).
 *
 * A returned `skipped=true` result means the pool is not live or failed a
 * validation check — the caller should skip pushing this market for the cycle.
 */
export async function readPoolPriceE6(
  mainnetConn: Connection,
  entry: Pick<MarketEntry, "poolAddress" | "dexType" | "label">,
  decimalsCache: DecimalsCache,
  solPriceE6?: bigint,
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

    // Cache mint decimals after the first successful read (same pattern as
    // Meteora above) — pump.fun base tokens are almost always 6dp and WSOL is
    // 9dp, but decimals are fetched from the real mints rather than assumed.
    if (!decimalsCache.has(entry.poolAddress)) {
      const [baseDecimals, quoteDecimals] = await Promise.all([
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.baseMint)),
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.quoteMint)),
      ]);
      decimalsCache.set(entry.poolAddress, { base: baseDecimals, quote: quoteDecimals });
      console.log(
        `[price-reader] PumpSwap ${shortPool} decimals cached:` +
          ` base(${poolParsed.baseMint.toBase58().slice(0, 8)}…)=${baseDecimals}` +
          ` quote(${poolParsed.quoteMint.toBase58().slice(0, 8)}…)=${quoteDecimals}`,
      );
    }
    const dec = decimalsCache.get(entry.poolAddress)!;

    const isWsolQuoted = poolParsed.quoteMint.equals(WSOL_MINT);
    if (isWsolQuoted && solPriceE6 === undefined) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: pool is WSOL-quoted but no SOL/USD price was available this cycle",
      };
    }

    let priceE6: bigint;
    try {
      priceE6 = computeDexSpotPriceE6(
        "pumpswap",
        data,
        { base: baseVaultData, quote: quoteVaultData },
        dec,
        solPriceE6,
      );
    } catch (err) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: `PumpSwap: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
 * FAST PATH: read ALL pool prices in a SINGLE getMultipleAccounts RPC call for
 * the pool accounts, plus (only when PumpSwap markets are present) ONE more
 * batched getMultipleAccounts call for their vaults/mints, and compute each
 * spot price locally. Same DEX-pool source as readPoolPriceE6 (no Pyth) —
 * collapses what would otherwise be N sequential getAccountInfo calls per
 * cycle, so the keeper can push far faster without hammering the RPC.
 *
 * Runs in two passes:
 *   1. raydium-clmm / meteora-dlmm price from the already-fetched pool data
 *      (unchanged from before), PLUS resolving this cycle's SOL/USD reference
 *      price from whichever entry {@link isSolUsdEntry} matches. PumpSwap
 *      entries are parsed (mints/vaults) but deferred to pass 2 — they can't
 *      be priced from the pool account alone.
 *   2. PumpSwap — batch-fetch every candidate's base/quote vault (and, for
 *      any pool without cached decimals yet, its base/quote mint) in ONE
 *      getMultipleAccountsInfo call, then compute each price using the
 *      SOL/USD price resolved in pass 1. A pool skipped this cycle (e.g. the
 *      SOL/USD reference itself failed) is simply omitted from `out` —
 *      identical retry-next-cycle semantics to every other skip path here.
 *
 * Mint decimals are cached the same way as before (keyed by poolAddress) —
 * after the first cycle a PumpSwap pool's decimals never need re-fetching.
 *
 * Returns a map of poolAddress → priceE6 (only pools that produced a valid price).
 */
export async function readAllPoolPricesE6(
  mainnetConn: Connection,
  entries: Array<Pick<MarketEntry, "poolAddress" | "dexType" | "label" | "symbol">>,
  decimalsCache: DecimalsCache,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (entries.length === 0) return out;
  const pubkeys = entries.map((e) => new PublicKey(e.poolAddress));
  const infos = await withRpcBackoff(() =>
    mainnetConn.getMultipleAccountsInfo(pubkeys, "confirmed"),
  );

  // ── Pass 1: raydium-clmm + meteora-dlmm, and resolve this cycle's SOL/USD ──
  let solPriceE6: bigint | undefined;
  interface PumpswapCandidate {
    entry: (typeof entries)[number];
    poolData: Uint8Array;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseVault: PublicKey;
    quoteVault: PublicKey;
  }
  const pumpswapCandidates: PumpswapCandidate[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const info = infos[i];
    if (!info || info.data.length === 0) continue;
    if (detectDexType(info.owner) !== entry.dexType) continue;
    const data = new Uint8Array(info.data);
    try {
      if (entry.dexType === "raydium-clmm") {
        const priceE6 = computeDexSpotPriceE6("raydium-clmm", data);
        if (priceE6 > 0n) {
          out.set(entry.poolAddress, priceE6);
          if (solPriceE6 === undefined && isSolUsdEntry(entry)) solPriceE6 = priceE6;
        }
      } else if (entry.dexType === "meteora-dlmm") {
        if (!decimalsCache.has(entry.poolAddress)) {
          const parsed = parseDexPool("meteora-dlmm", pubkeys[i], data);
          const [base, quote] = await Promise.all([
            withRpcBackoff(() => fetchMintDecimals(mainnetConn, parsed.baseMint)),
            withRpcBackoff(() => fetchMintDecimals(mainnetConn, parsed.quoteMint)),
          ]);
          decimalsCache.set(entry.poolAddress, { base, quote });
        }
        const priceE6 = computeDexSpotPriceE6(
          "meteora-dlmm",
          data,
          undefined,
          decimalsCache.get(entry.poolAddress)!,
        );
        if (priceE6 > 0n) {
          out.set(entry.poolAddress, priceE6);
          if (solPriceE6 === undefined && isSolUsdEntry(entry)) solPriceE6 = priceE6;
        }
      } else if (entry.dexType === "pumpswap") {
        const parsed = parseDexPool("pumpswap", pubkeys[i], data);
        if (!parsed.baseVault || !parsed.quoteVault) continue;
        pumpswapCandidates.push({
          entry,
          poolData: data,
          baseMint: parsed.baseMint,
          quoteMint: parsed.quoteMint,
          baseVault: parsed.baseVault,
          quoteVault: parsed.quoteVault,
        });
      }
    } catch {
      /* skip this pool for this cycle; next cycle retries */
    }
  }

  // ── Pass 2: PumpSwap — one batched fetch for vaults (+ uncached mints) ─────
  if (pumpswapCandidates.length > 0) {
    const extraAddrs: PublicKey[] = [];
    // Position of each candidate's [baseVault, quoteVault, baseMint?, quoteMint?]
    // within extraAddrs — mint positions are only present when decimals aren't
    // cached yet for that pool.
    const positions = pumpswapCandidates.map((c) => {
      const baseVaultPos = extraAddrs.push(c.baseVault) - 1;
      const quoteVaultPos = extraAddrs.push(c.quoteVault) - 1;
      let mintPos: { base: number; quote: number } | null = null;
      if (!decimalsCache.has(c.entry.poolAddress)) {
        const baseMintPos = extraAddrs.push(c.baseMint) - 1;
        const quoteMintPos = extraAddrs.push(c.quoteMint) - 1;
        mintPos = { base: baseMintPos, quote: quoteMintPos };
      }
      return { baseVaultPos, quoteVaultPos, mintPos };
    });

    const extraInfos = await withRpcBackoff(() =>
      mainnetConn.getMultipleAccountsInfo(extraAddrs, "confirmed"),
    );

    for (let c = 0; c < pumpswapCandidates.length; c++) {
      const { entry, poolData } = pumpswapCandidates[c];
      const { baseVaultPos, quoteVaultPos, mintPos } = positions[c];
      const baseVaultInfo = extraInfos[baseVaultPos];
      const quoteVaultInfo = extraInfos[quoteVaultPos];
      if (!baseVaultInfo || !quoteVaultInfo) continue;

      let dec = decimalsCache.get(entry.poolAddress);
      if (!dec) {
        if (!mintPos) continue; // should not happen — mintPos is only null when already cached
        const baseMintInfo = extraInfos[mintPos.base];
        const quoteMintInfo = extraInfos[mintPos.quote];
        if (
          !baseMintInfo ||
          !quoteMintInfo ||
          baseMintInfo.data.length <= SPL_MINT_DECIMALS_OFFSET ||
          quoteMintInfo.data.length <= SPL_MINT_DECIMALS_OFFSET
        ) {
          continue;
        }
        dec = {
          base: baseMintInfo.data[SPL_MINT_DECIMALS_OFFSET],
          quote: quoteMintInfo.data[SPL_MINT_DECIMALS_OFFSET],
        };
        decimalsCache.set(entry.poolAddress, dec);
        console.log(
          `[price-reader] PumpSwap ${entry.poolAddress.slice(0, 8)}… decimals cached (batched):` +
            ` base=${dec.base} quote=${dec.quote}`,
        );
      }

      try {
        const priceE6 = computeDexSpotPriceE6(
          "pumpswap",
          poolData,
          { base: new Uint8Array(baseVaultInfo.data), quote: new Uint8Array(quoteVaultInfo.data) },
          dec,
          solPriceE6,
        );
        if (priceE6 > 0n) out.set(entry.poolAddress, priceE6);
      } catch {
        // e.g. WSOL-quoted but solPriceE6 unavailable this cycle (SOL/USD read
        // itself failed) — skip and retry next cycle.
      }
    }
  }

  return out;
}
