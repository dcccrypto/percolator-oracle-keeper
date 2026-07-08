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
 *   Simulate first via connection.simulateTransaction (fast fail for wrong authority
 *   or bad state), then send via connection.sendTransaction + confirmTransaction.
 *
 * NOTE on module-identity fix:
 *   The SDK (@percolatorct/sdk) has its own nested node_modules/@solana/web3.js.
 *   Using the SDK's simulateOrSend / buildIx causes the Transaction object it
 *   creates (SDK's Transaction class) to fail the `instanceof Transaction` check
 *   inside connection.simulateTransaction (which uses the keeper's Transaction
 *   class). This gives "Cannot read properties of undefined (reading
 *   'numRequiredSignatures')". Fix: import Transaction / TransactionInstruction /
 *   ComputeBudgetProgram directly from "@solana/web3.js" here — they resolve to
 *   the keeper's own node_modules copy — and build/sign/send without going
 *   through the SDK's simulateOrSend.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  encodePushAuthMark,
  ACCOUNTS_PUSH_AUTH_MARK,
  buildAccountMetas,
  parseAssetOracleProfileV17,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  PROGRAM_IDS_V17,
} from "@percolatorct/sdk";

const WRAPPER_PROGRAM_ID = new PublicKey(PROGRAM_IDS_V17.percolator);

const COMPUTE_UNIT_LIMIT = 200_000;

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
 * Build a TransactionInstruction for PushAuthMark using the keeper's own
 * @solana/web3.js TransactionInstruction (not the SDK's copy).
 *
 * The instruction encoding and account spec come from the SDK (pure data),
 * but the TransactionInstruction class is from the keeper's web3.js so it
 * is identity-compatible with keeper-owned Transaction objects.
 */
function buildPushAuthMarkIx(
  oracleAuthority: PublicKey,
  market: PublicKey,
  assetIndex: number,
  nowSlot: bigint,
  priceE6: bigint,
): TransactionInstruction {
  const accountMetas = buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, {
    oracleAuthority,
    market,
  });
  const data = encodePushAuthMark({ assetIndex, nowSlot, markE6: priceE6 });
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: accountMetas,
    // TransactionInstruction accepts Buffer | Uint8Array at runtime.
    data: data as unknown as Buffer,
  });
}

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

  // ── 3. Build instruction (using keeper's web3.js TransactionInstruction) ─
  const marketPk = new PublicKey(marketAddress);
  const ix = buildPushAuthMarkIx(
    keeper.publicKey,
    marketPk,
    assetIndex,
    nowSlot,
    priceE6,
  );

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

  // ── 5. Simulate first (fast-fail for wrong authority / bad state) ────────
  const bh = await devnetConn.getLatestBlockhash("confirmed");

  {
    const simTx = new Transaction();
    simTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    simTx.add(ix);
    simTx.recentBlockhash = bh.blockhash;
    simTx.feePayer = keeper.publicKey;
    simTx.sign(keeper);

    // Pass the already-signed Transaction without re-supplying signers so the
    // web3.js instanceof Transaction check succeeds (same module scope).
    const simResult = await devnetConn.simulateTransaction(simTx);
    if (simResult.value.err) {
      const lastLogs = (simResult.value.logs ?? []).slice(-5).join(" | ");
      throw new Error(
        `PushAuthMark sim failed [${marketAddress.slice(0, 8)}…]:` +
          ` ${JSON.stringify(simResult.value.err)} | logs: ${lastLogs}`,
      );
    }
  }

  // ── 6. Send ───────────────────────────────────────────────────────────────
  const sendTx = new Transaction();
  sendTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
  sendTx.add(ix);
  sendTx.recentBlockhash = bh.blockhash;
  sendTx.feePayer = keeper.publicKey;
  sendTx.sign(keeper);

  const signature = await devnetConn.sendRawTransaction(sendTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await devnetConn.confirmTransaction(
    {
      signature,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    },
    "confirmed",
  );

  return { pushed: true, signature, priceE6, nowSlot };
}

/**
 * FAST PATH: push PushAuthMark for MANY markets in ONE devnet transaction, and
 * do NOT wait for confirmation. One slot + one blockhash + one send per cycle
 * (vs a simulate/send/confirm per market) — this is what lets the on-chain mark
 * update near per-slot. The mark lands within a slot regardless of when we'd
 * confirm, so awaiting confirmation only adds latency.
 *
 * A batched tx is ATOMIC: every market in `pushes` must be pushable
 * (keeper == oracle_authority), so callers pass only markets that passed the
 * one-time authority check — a single bad market can't fail the whole batch.
 */
export async function pushAuthMarkBatch(
  devnetConn: Connection,
  keeper: Keypair,
  pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>,
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
  dryRun: boolean,
): Promise<{ pushed: boolean; signature?: string; count: number }> {
  if (pushes.length === 0) return { pushed: false, count: 0 };

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.min(COMPUTE_UNIT_LIMIT * pushes.length, 1_200_000),
    }),
  );
  for (const p of pushes) {
    tx.add(
      buildPushAuthMarkIx(
        keeper.publicKey,
        new PublicKey(p.marketAddress),
        p.assetIndex,
        nowSlot,
        p.priceE6,
      ),
    );
  }

  if (dryRun) {
    console.log(
      `[DRY-RUN] batched PushAuthMark × ${pushes.length} @ slot ${nowSlot} ` +
        `(${pushes.map((p) => `$${(Number(p.priceE6) / 1e6).toFixed(4)}`).join(", ")})`,
    );
    return { pushed: false, count: pushes.length };
  }

  tx.recentBlockhash = blockhash.blockhash;
  tx.feePayer = keeper.publicKey;
  tx.sign(keeper);

  // Fire-and-forget: skip preflight sim, and do NOT await confirmation.
  const signature = await devnetConn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });
  return { pushed: true, signature, count: pushes.length };
}
