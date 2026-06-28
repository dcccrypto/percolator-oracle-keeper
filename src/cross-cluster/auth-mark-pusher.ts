/**
 * cross-cluster/auth-mark-pusher.ts
 *
 * Builds and sends (or dry-runs) PushAuthMark instructions to devnet markets.
 *
 * Pre-push authority check:
 *   Before each push the keeper reads the market's oracle_authority from the
 *   devnet slab. If it does not match the keeper's pubkey, the push is skipped
 *   with a warning (never throws). This prevents wasted SOL on markets that
 *   have had their oracle authority changed.
 *
 * Dry-run mode:
 *   Builds and logs the instruction payload but does not call simulate or send.
 *   Zero SOL consumed.
 *
 * Live mode:
 *   simulate=true first (fast fail for wrong authority / bad state),
 *   then simulate=false to confirm.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  encodePushAuthMark,
  ACCOUNTS_PUSH_AUTH_MARK,
  buildAccountMetas,
  buildIx,
  simulateOrSend,
  parseAssetOracleProfileV17,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  PROGRAM_IDS_V17,
} from "@percolatorct/sdk";

const WRAPPER_PROGRAM_ID = new PublicKey(PROGRAM_IDS_V17.percolator);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PushResult {
  /** Whether a transaction was sent (false in dry-run or on authority mismatch). */
  pushed: boolean;
  /** True when the instruction was built but not sent (dry-run). */
  dryRun?: boolean;
  /** Transaction signature — present only when pushed=true and dryRun=false. */
  signature?: string;
  /** True when the market's oracle_authority does not match the keeper. */
  authorityMismatch?: boolean;
  /** Price that was pushed (or would have been). */
  priceE6: bigint;
  /** Devnet slot used in the instruction. */
  nowSlot: bigint;
}

// ── Oracle-authority read ─────────────────────────────────────────────────────

/**
 * Fetch the oracle_authority for a given asset slot from a devnet slab account.
 *
 * Returns null if:
 *   - The account does not exist on devnet
 *   - The data is too short to hold an oracle profile at the requested slot
 *   - Any parse error occurs
 *
 * The caller should treat null as "cannot verify — skip push with warning."
 */
export async function fetchOracleAuthority(
  devnetConn: Connection,
  marketAddress: string,
  assetIndex: number,
): Promise<PublicKey | null> {
  try {
    const pk = new PublicKey(marketAddress);
    const info = await devnetConn.getAccountInfo(pk, "confirmed");
    if (!info) return null;
    const data = new Uint8Array(info.data);
    const profileOff =
      V17_MARKET_GROUP_OFF +
      V17_MARKET_GROUP_LEN +
      assetIndex * V17_MARKET_ASSET_SLOT_LEN;
    // parseAssetOracleProfileV17 needs at least 80 bytes after profileOff
    if (data.length < profileOff + 80) return null;
    const profile = parseAssetOracleProfileV17(data, profileOff);
    return profile.oracleAuthority;
  } catch {
    return null;
  }
}

// ── Push instruction ──────────────────────────────────────────────────────────

/**
 * Push (or dry-run) a PushAuthMark instruction to a devnet market.
 *
 * The authority check is always performed — even in dry-run mode — because
 * reporting an authority mismatch is useful feedback when iterating on
 * market creation flows without spending SOL.
 *
 * @param devnetConn    Devnet RPC connection
 * @param keeper        Keeper keypair (oracle_authority on the market)
 * @param marketAddress Devnet slab address
 * @param assetIndex    Asset slot index (almost always 0)
 * @param priceE6       Price to push, in e6 format (must be > 0)
 * @param dryRun        If true, build the ix and log it but do not send
 */
export async function pushAuthMark(
  devnetConn: Connection,
  keeper: Keypair,
  marketAddress: string,
  assetIndex: number,
  priceE6: bigint,
  dryRun: boolean,
): Promise<PushResult> {
  // ── 1. Fetch current devnet slot ─────────────────────────────────────────
  const nowSlot = BigInt(await devnetConn.getSlot("confirmed"));

  // ── 2. Oracle-authority pre-check ────────────────────────────────────────
  const onChainAuthority = await fetchOracleAuthority(
    devnetConn,
    marketAddress,
    assetIndex,
  );
  if (onChainAuthority === null) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… oracle_authority not readable — skipping`,
    );
    return { pushed: false, authorityMismatch: true, priceE6, nowSlot };
  }
  if (!onChainAuthority.equals(keeper.publicKey)) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… oracle_authority=` +
        `${onChainAuthority.toBase58().slice(0, 8)}…` +
        ` != keeper=${keeper.publicKey.toBase58().slice(0, 8)}… — skipping`,
    );
    return { pushed: false, authorityMismatch: true, priceE6, nowSlot };
  }

  // ── 3. Build instruction ─────────────────────────────────────────────────
  const ix = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, {
      oracleAuthority: keeper.publicKey,
      market: new PublicKey(marketAddress),
    }),
    data: encodePushAuthMark({ assetIndex, nowSlot, markE6: priceE6 }),
  });

  // ── 4. Dry-run: log and return ───────────────────────────────────────────
  if (dryRun) {
    console.log(
      `[DRY-RUN] PushAuthMark market=${marketAddress.slice(0, 8)}…` +
        ` assetIndex=${assetIndex}` +
        ` priceE6=${priceE6} ($${(Number(priceE6) / 1e6).toFixed(4)})` +
        ` nowSlot=${nowSlot}`,
    );
    return { pushed: false, dryRun: true, priceE6, nowSlot };
  }

  // ── 5. Live: simulate then send ──────────────────────────────────────────
  const simResult = await simulateOrSend({
    connection: devnetConn,
    ix,
    signers: [keeper],
    simulate: true,
    computeUnitLimit: 200_000,
  });
  if (simResult.err) {
    const lastLogs = (simResult.logs ?? []).slice(-5).join(" | ");
    throw new Error(
      `PushAuthMark sim failed [${marketAddress.slice(0, 8)}…]:` +
        ` ${String(simResult.err)} | logs: ${lastLogs}`,
    );
  }

  const sendResult = await simulateOrSend({
    connection: devnetConn,
    ix,
    signers: [keeper],
    simulate: false,
    commitment: "confirmed",
    computeUnitLimit: 200_000,
  });
  if (sendResult.err) {
    throw new Error(
      `PushAuthMark send failed [${marketAddress.slice(0, 8)}…]: ${String(sendResult.err)}`,
    );
  }

  return { pushed: true, signature: sendResult.signature!, priceE6, nowSlot };
}
