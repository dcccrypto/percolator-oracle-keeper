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
/** Solana hard limit on a serialized transaction. */
const MAX_TX_BYTES = 1232;
/** Safety margin under MAX_TX_BYTES (signature/blockhash jitter). */
const TX_SIZE_MARGIN = 32;

/**
 * Build one PushAuthMark tx for a slice of markets and return it with its
 * serialized size, so the caller can size-check BEFORE sending.
 */
function buildPushTx(
  keeper: Keypair,
  pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>,
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): { tx: Transaction; size: number } {
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
  tx.recentBlockhash = blockhash.blockhash;
  tx.feePayer = keeper.publicKey;
  // web3.js's serialize() THROWS ("Transaction too large: N > 1232") instead of
  // returning an oversized length, so a naive `.length` size probe crashes the
  // very loop that is supposed to split the batch. Treat a throw as "does not
  // fit" (Infinity) and let the caller close the chunk.
  let size: number;
  try {
    size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  return { tx, size };
}

/**
 * Split `pushes` into chunks that each serialize under the 1232-byte tx limit.
 *
 * OUTAGE 2026-07-13: this used to build ONE transaction containing EVERY
 * registered market. At 18 markets it fit (1230B); the 19th and 20th
 * registration pushed it to 1270B — over Solana's hard 1232-byte limit — so
 * `sendRawTransaction` threw "Transaction too large: 1270 > 1232" on EVERY
 * cycle. Because the batch was all-or-nothing, a single oversized batch froze
 * the AuthMark for ALL markets simultaneously (every market's mark stuck at
 * the same slot), and since the failure happened before submission, it left
 * no on-chain trace at all. The keeper had no chunking and no size check, so
 * it could never recover on its own — and it would break again at whatever
 * market count the next registration crossed.
 *
 * Chunking on MEASURED serialized size (not a hard-coded market count) means
 * the batch is now correct for any registry size, and for markets whose
 * account lists differ in size.
 */
function chunkPushes(
  keeper: Keypair,
  pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>,
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): Array<Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>> {
  const chunks: Array<Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>> = [];
  let current: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }> = [];

  for (const p of pushes) {
    const candidate = [...current, p];
    const { size } = buildPushTx(keeper, candidate, nowSlot, blockhash);
    if (size <= MAX_TX_BYTES - TX_SIZE_MARGIN) {
      current = candidate;
      continue;
    }
    // Adding this market overflows the tx — close the current chunk.
    if (current.length > 0) {
      chunks.push(current);
      current = [p];
    } else {
      // A single market that somehow doesn't fit on its own: push it alone and
      // let the send surface the real error rather than silently dropping it.
      chunks.push([p]);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function pushAuthMarkBatch(
  devnetConn: Connection,
  keeper: Keypair,
  pushes: Array<{ marketAddress: string; assetIndex: number; priceE6: bigint }>,
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
  dryRun: boolean,
): Promise<{ pushed: boolean; signature?: string; count: number }> {
  if (pushes.length === 0) return { pushed: false, count: 0 };

  const chunks = chunkPushes(keeper, pushes, nowSlot, blockhash);

  if (dryRun) {
    console.log(
      `[DRY-RUN] PushAuthMark × ${pushes.length} in ${chunks.length} tx(s) @ slot ${nowSlot} ` +
        `(${pushes.map((p) => `$${(Number(p.priceE6) / 1e6).toFixed(4)}`).join(", ")})`,
    );
    return { pushed: false, count: pushes.length };
  }

  let firstSig: string | undefined;
  let pushedCount = 0;
  const errors: string[] = [];

  for (const chunk of chunks) {
    const { tx } = buildPushTx(keeper, chunk, nowSlot, blockhash);
    tx.sign(keeper);
    try {
      // Fire-and-forget: skip preflight sim, and do NOT await confirmation.
      const signature = await devnetConn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
      firstSig ??= signature;
      pushedCount += chunk.length;
    } catch (err) {
      // One oversized/failing chunk must NOT block the others — the old
      // all-or-nothing batch is exactly what froze every market at once.
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${chunk.length} market(s): ${msg.slice(0, 120)}`);
    }
  }

  if (errors.length > 0) {
    console.error(`[push] ${errors.length}/${chunks.length} chunk(s) failed — ${errors.join(" | ")}`);
  }

  return { pushed: pushedCount > 0, signature: firstSig, count: pushedCount };
}
