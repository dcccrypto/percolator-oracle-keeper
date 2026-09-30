/**
 * cross-cluster/resolved-portfolio-cleanup.ts
 *
 * Close every materialized portfolio on a RESOLVED market, permissionlessly,
 * so stake tag 29 (wrapper tag 41 underneath) can recover the stakers'
 * terminal insurance budget. E2E B12: tag 41 on a Resolved market requires
 * `materialized_portfolio_count == 0`, and one abandoned account stranded the
 * budget forever on 6377376a.
 *
 * Closed on the P3 FINAL wrapper b2b2559e (feat/p3-vault-owned-lp). Verified
 * against that source:
 *   CloseResolved (tag 30, `[30][fee_rate_per_slot u128]`, handler
 *     v16_program.rs:22430): [0] portfolio OWNER (need not sign, except inside
 *     `force_close_delay_slots` or for an NFT-escrowed portfolio, GH#496),
 *     [1] market (w), [2] portfolio (w), and when there is a payout
 *     [3] a token account OWNED BY the portfolio owner (w, unencumbered, same
 *     mint), [4] canonical wrapper vault (w), [5] vault authority, [6] SPL Token.
 *     The payout can only go to the owner. A vault-LP portfolio (owner = the
 *     market's LP-vault registry PDA) is refused: it settles via tag 101.
 *   ClosePortfolio (tag 8, `[8][portfolio_id u64][expected_sequence u64]
 *     [position_epoch u64]`, handler :15742): [0] closer (signer, w),
 *     [1] market (w), [2] portfolio (w), [3] the portfolio OWNER (w) — in
 *     Resolved mode anyone may deregister an EMPTY portfolio when [3] is its
 *     owner, and the rent goes there. The engine's emptiness predicate still
 *     refuses anything holding a claim. The call binds (portfolio_id,
 *     matcher sequence, position epoch), read live from the account.
 *   Portfolio layout block is byte-identical to deployed 6377376a.
 *
 * Rent-stranding guard (security B12 review): a permissionless tag-8 close
 * pays the portfolio's rent (~0.067 SOL) to its OWNER. If that owner is a
 * program PDA with no lamport-withdraw path, the rent is stranded there. Two
 * such owners exist and are SKIPPED before any close is attempted; their
 * holders reclaim through their own paths:
 *   - the NFT escrow PDA `["mint_authority"]` under the NFT program
 *     (wrapper derive_nft_mint_authority, b2b2559e v16_program.rs:5994);
 *   - the market's LP-vault registry PDA (a vault LP emptied after tag 101).
 *
 * Gate: 6377376a checks the same binding and then answers a non-owner closer
 * with `Unauthorized` = Custom(8) (v18.2 handle_close_portfolio). So a
 * simulated tag 8 on a real portfolio with a fresh binding and the owner at [3]
 * returns Custom(8) on 6377376a — "unsupported", a no-op — and anything else
 * on b2b2559e. Cached with a TTL so an upgrade is picked up without a restart.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  deriveLpVaultRegistry,
  deriveMarketVaultAccounts,
  parsePortfolioV17,
  V17_PORTFOLIO_ACCOUNT_LEN,
} from "@percolatorct/sdk";
import { parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";

export const WRAPPER_TAG_CLOSE_PORTFOLIO = 8;
export const WRAPPER_TAG_CLOSE_RESOLVED = 30;
/** Wrapper `Unauthorized` (enum position 8). */
export const WRAPPER_ERR_UNAUTHORIZED = 8;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const COMPUTE_UNIT_LIMIT = 800_000;

export function encodeCloseResolved(): Buffer {
  const b = Buffer.alloc(17);
  b[0] = WRAPPER_TAG_CLOSE_RESOLVED; // fee_rate_per_slot is ignored by the handler (`_fee_rate_per_slot`); 0
  return b;
}

export function encodeClosePortfolio(portfolioId: bigint, expectedSequence: bigint, positionEpoch: bigint): Buffer {
  const b = Buffer.alloc(25);
  b[0] = WRAPPER_TAG_CLOSE_PORTFOLIO;
  b.writeBigUInt64LE(portfolioId, 1);
  b.writeBigUInt64LE(expectedSequence, 9);
  b.writeBigUInt64LE(positionEpoch, 17);
  return b;
}

export function ownerAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

export function buildCreateAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ownerAta(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export function buildCloseResolvedIx(p: {
  wrapperProgramId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  collateralMint: PublicKey;
}): TransactionInstruction {
  const v = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, p.collateralMint);
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: [
      { pubkey: p.owner, isSigner: false, isWritable: false },
      { pubkey: p.market, isSigner: false, isWritable: true },
      { pubkey: p.portfolio, isSigner: false, isWritable: true },
      { pubkey: ownerAta(p.owner, p.collateralMint), isSigner: false, isWritable: true },
      { pubkey: v.vaultToken, isSigner: false, isWritable: true },
      { pubkey: v.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: v.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: encodeCloseResolved(),
  });
}

export function buildClosePortfolioIx(p: {
  wrapperProgramId: PublicKey;
  closer: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  owner: PublicKey;
  portfolioId: bigint;
  expectedSequence: bigint;
  positionEpoch: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: [
      { pubkey: p.closer, isSigner: true, isWritable: true },
      { pubkey: p.market, isSigner: false, isWritable: true },
      { pubkey: p.portfolio, isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: false, isWritable: true },
    ],
    data: encodeClosePortfolio(p.portfolioId, p.expectedSequence, p.positionEpoch),
  });
}

export type CleanupSupport = "supported" | "unsupported" | "unknown";

/**
 * Classify a simulation of [CU, ClosePortfolio(owner at [3])]. Custom(8) at
 * the ClosePortfolio instruction is the 6377376a signature -> unsupported.
 * Any other instruction error there (e.g. the engine refusing a non-empty
 * portfolio) means the permissionless path exists -> supported.
 */
export function classifyCleanupProbe(err: unknown, simOk: boolean): CleanupSupport {
  if (simOk) return "supported";
  const ie = parseInstructionError(err);
  if (!ie || ie.index !== 1) return "unknown";
  return ie.custom === WRAPPER_ERR_UNAUTHORIZED ? "unsupported" : "supported";
}

/** The NFT program's `["mint_authority"]` PDA: owner of every NFT-escrowed portfolio. */
export function nftEscrowAuthority(nftProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], nftProgramId)[0];
}

/**
 * Owners the cleanup must never close for, because the rent would be stranded
 * in a PDA (security B12 review). Returns the reason, or null if closable.
 */
export function pdaOwnerSkipReason(owner: PublicKey, market: PublicKey, cfg: Pick<CleanupConfig, "wrapperProgramId" | "nftProgramId">): string | null {
  if (owner.equals(deriveLpVaultRegistry(cfg.wrapperProgramId, market)[0])) {
    return "owner is the LP-vault registry PDA: rent would be stranded; settles via VaultLpSettleResolved (tag 101) and its own reclaim path";
  }
  if (owner.equals(nftEscrowAuthority(cfg.nftProgramId))) {
    return "owner is the NFT escrow PDA (mint_authority): rent would be stranded; the NFT holder reclaims through the NFT path";
  }
  return null;
}

export interface CleanupConfig {
  wrapperProgramId: PublicKey;
  nftProgramId: PublicKey;
  /** Portfolios attempted per market per cycle. */
  maxPerCycle: number;
  /** Owner token accounts the keeper may create (rent it pays) per market per cycle. */
  maxAtaCreatesPerCycle: number;
  probeTtlMs: number;
  confirm?: ConfirmOptions;
  now?: () => number;
}

export class CleanupState {
  support: { value: CleanupSupport; at: number } | null = null;
}

export type CleanupConnection = Pick<
  Connection,
  "getProgramAccounts" | "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses"
>;

export interface CleanupResult {
  support: CleanupSupport;
  closed: number;
  progressed: number;
  /** Portfolios that could not be closed this cycle, with why. */
  remaining: Array<{ portfolio: string; reason: string }>;
}

interface Pf {
  pubkey: PublicKey;
  owner: PublicKey;
  portfolioId: bigint;
  matcherSequence: bigint;
  positionEpoch: bigint;
}

function why(err: unknown, logs: string[] | null, ixIndex: Record<number, string>): string {
  const ie = parseInstructionError(err);
  const where = ie ? (ixIndex[ie.index] ?? `ix ${ie.index}`) : "tx";
  const detail = ie?.custom != null ? `Custom(${ie.custom})` : JSON.stringify(ie ? (err as { InstructionError: unknown[] }).InstructionError[1] : err);
  const hint = /MissingRequiredSignature/.test(JSON.stringify(err))
    ? " — needs the owner's signature (force-close delay not elapsed, or NFT-escrowed)"
    : "";
  const log = (logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-1).join("");
  return `${where} ${detail}${hint}${log ? ` (${log.slice(0, 80)})` : ""}`;
}

/**
 * One cleanup pass for a Resolved market. Never throws. dryRun simulates only.
 */
export async function cleanupResolvedPortfolios(
  conn: CleanupConnection,
  keeper: Keypair,
  market: PublicKey,
  collateralMint: PublicKey,
  dryRun: boolean,
  cfg: CleanupConfig,
  st: CleanupState,
): Promise<CleanupResult> {
  const out: CleanupResult = { support: "unknown", closed: 0, progressed: 0, remaining: [] };
  let pfs: Pf[];
  try {
    const accs = await conn.getProgramAccounts(cfg.wrapperProgramId, {
      filters: [
        { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 16, bytes: market.toBase58() } },
      ],
    });
    pfs = accs.map((a) => {
      const p = parsePortfolioV17(new Uint8Array(a.account.data));
      return { pubkey: a.pubkey, owner: p.owner, portfolioId: p.portfolioId, matcherSequence: p.matcherSequence, positionEpoch: p.matcherPositionEpoch };
    });
  } catch (err) {
    out.remaining.push({ portfolio: "*", reason: `portfolio discovery failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` });
    return out;
  }
  if (pfs.length === 0) {
    out.support = st.support?.value ?? "unknown";
    return out;
  }

  const closeIx = (p: Pf) =>
    buildClosePortfolioIx({
      wrapperProgramId: cfg.wrapperProgramId, closer: keeper.publicKey, market, portfolio: p.pubkey, owner: p.owner,
      portfolioId: p.portfolioId, expectedSequence: p.matcherSequence, positionEpoch: p.positionEpoch,
    });
  const resolvedIx = (p: Pf) =>
    buildCloseResolvedIx({ wrapperProgramId: cfg.wrapperProgramId, owner: p.owner, market, portfolio: p.pubkey, collateralMint });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const mk = (ixs: TransactionInstruction[]): Transaction => {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    for (const ix of ixs) tx.add(ix);
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    return tx;
  };
  const sim = async (tx: Transaction) => {
    const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
    return { err: r.value.err, logs: r.value.logs ?? null };
  };

  // Gate (cached).
  const now = (cfg.now ?? Date.now)();
  if (!st.support || st.support.value === "unknown" || now - st.support.at >= cfg.probeTtlMs) {
    let value: CleanupSupport = "unknown";
    try {
      // Probe with a portfolio we would actually close (never a PDA-owned one).
      const target = pfs.find((q) => pdaOwnerSkipReason(q.owner, market, cfg) === null) ?? pfs[0];
      const r = await sim(mk([closeIx(target)]));
      value = classifyCleanupProbe(r.err, !r.err);
    } catch {
      value = "unknown";
    }
    st.support = { value, at: now };
  }
  out.support = st.support.value;
  if (out.support !== "supported") {
    for (const p of pfs) {
      out.remaining.push({
        portfolio: p.pubkey.toBase58(),
        reason: out.support === "unsupported"
          ? "deployed wrapper has no permissionless resolved ClosePortfolio (6377376a answers Custom(8)); needs P3 b2b2559e"
          : "cleanup support unknown this cycle (probe failed)",
      });
    }
    return out;
  }

  // Which owner token accounts exist (payout destinations)?
  const atas = pfs.map((p) => ownerAta(p.owner, collateralMint));
  let ataExists: boolean[];
  try {
    const infos = await conn.getMultipleAccountsInfo(atas, "confirmed");
    ataExists = infos.map((i) => i !== null);
  } catch {
    ataExists = atas.map(() => false);
  }

  let ataCreates = 0;
  const send = async (tx: Transaction): Promise<boolean> => {
    if (dryRun) return true;
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm);
    return c.status === "landed";
  };

  for (let i = 0; i < pfs.length; i++) {
    const p = pfs[i];
    const skip = pdaOwnerSkipReason(p.owner, market, cfg);
    if (skip) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: skip });
      continue;
    }
    if (i >= cfg.maxPerCycle) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `over the ${cfg.maxPerCycle}-per-cycle bound; next cycle` });
      continue;
    }
    try {
      const pre: TransactionInstruction[] = [];
      if (!ataExists[i]) {
        if (ataCreates >= cfg.maxAtaCreatesPerCycle) {
          out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "owner token account missing; ATA-create budget for this cycle used" });
          continue;
        }
        pre.push(buildCreateAtaIdempotentIx(keeper.publicKey, p.owner, collateralMint));
      }
      const idx = (n: number): Record<number, string> =>
        n === 2 ? { [pre.length + 1]: "CloseResolved", [pre.length + 2]: "ClosePortfolio" } : { [pre.length + 1]: n === 1 ? "CloseResolved" : "ClosePortfolio" };

      // (a) CloseResolved + ClosePortfolio.
      const a = mk([...pre, resolvedIx(p), closeIx(p)]);
      const ra = await sim(a);
      if (!ra.err) {
        if (await send(a)) {
          out.closed++;
          if (pre.length) ataCreates++;
        } else out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "close tx did not land; retry next cycle" });
        continue;
      }
      // (b) Already resolved-closed: ClosePortfolio alone.
      const b = mk([closeIx(p)]);
      const rb = await sim(b);
      if (!rb.err) {
        if (await send(b)) out.closed++;
        else out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "close tx did not land; retry next cycle" });
        continue;
      }
      // (c) Progress-only CloseResolved (the close needs more calls).
      const c = mk([...pre, resolvedIx(p)]);
      const rc = await sim(c);
      if (!rc.err) {
        if (await send(c)) {
          out.progressed++;
          if (pre.length) ataCreates++;
        }
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "CloseResolved made progress; not yet closable" });
        continue;
      }
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: why(ra.err, ra.logs, idx(2)) });
    } catch (err) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
  }
  return out;
}
