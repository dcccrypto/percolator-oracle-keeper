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
 * PDA owners (P3 ledger §0.7 "Wind-down", refs at b2b2559e; coordinator
 * 2026-09-30). A permissionless tag-8 close pays the rent to [3] = the owner:
 *   - VAULT LP (owner = LP-vault registry PDA): tag 101 does NOT dematerialize
 *     it (no deregister in handle_vault_lp_settle_resolved). Sequence, at once,
 *     no grace: 101 topup=0 -> 101 topup=1 (a 21 = nothing pending, harmless)
 *     -> tag 8 [closer s,w][market w][vault_lp portfolio w][registry w]. The
 *     registry is wrapper-owned and simply receives the rent: expected.
 *   - NFT-ESCROWED and EMPTY (owner = NFT program ["mint_authority"] PDA): left
 *     for the holder for `pdaGraceSlots` after resolve (default 216,000 ≈ 24 h),
 *     then tag 8 alone with [3] = the escrow PDA (the NFT program tolerates the
 *     closed account on a later Burn/EmergencyBurn, nft db4aa09 #131). Logged
 *     and alerted.
 *   - NFT-ESCROWED WITH A CLAIM: only the holder can settle it (GH#496:
 *     require_signer_for_escrowed_terminal_payout — paying the unsigned escrow
 *     PDA would burn the funds). Never attempted; reported as "insurance
 *     recovery waiting on NFT holder X" with the portfolio, NFT mint (from the
 *     NFT program's PositionNftV16 record: portfolio_account @10, nft_mint @42,
 *     last_holder @167, 199 B, nft db4aa09 state_v16.rs) and claim size. An
 *     accepted devnet limitation. (Devnet 2026-09-30: 6 such portfolios exist.)
 *
 * Tag 101 accounts (:26676): [caller s,w] [market w] [registry] [vault_lp state
 * w] [lp portfolio w] [own ledger w] [sibling ledger] [junior dest w = token
 * account of state.junior_owner] [vault token w] [vault authority] [token]
 * [system]; data [101][topup u8].
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
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  deriveMarketVaultAccounts,
  parseLpVaultRegistry,
  parsePortfolioV17,
  V17_PORTFOLIO_ACCOUNT_LEN,
} from "@percolatorct/sdk";
import { parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";

export const WRAPPER_TAG_CLOSE_PORTFOLIO = 8;
export const WRAPPER_TAG_CLOSE_RESOLVED = 30;
/** Wrapper `Unauthorized` (enum position 8, b2b2559e and 6377376a). */
export const WRAPPER_ERR_UNAUTHORIZED = 8;
/** Wrapper `ExpectedSigner` (enum position 6, b2b2559e): an escrowed terminal payout without the holder's signature. */
export const WRAPPER_ERR_EXPECTED_SIGNER = 6;

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
      // [7]: GH#496 proof that the owner is not NFT-escrowed, read by
      // require_signer_for_escrowed_terminal_payout whenever there is a payout.
      // (A lone account here is not the optional NFT-holder trio, which needs 3.)
      { pubkey: deriveNftRegistry(p.wrapperProgramId, p.market), isSigner: false, isWritable: false },
    ],
    data: encodeCloseResolved(),
  });
}

/** `["nft_registry", market_group]` under the wrapper (b2b2559e derive_nft_registry :5981). */
export function deriveNftRegistry(wrapperProgramId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("nft_registry"), market.toBuffer()], wrapperProgramId)[0];
}

/** `["vault_lp", market]` under the wrapper (VAULT_LP_STATE_SEED, derive_vault_lp_state :5632). */
export function deriveVaultLpState(wrapperProgramId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_lp"), market.toBuffer()], wrapperProgramId)[0];
}

export const WRAPPER_TAG_VAULT_LP_SETTLE_RESOLVED = 101;
const KIND_VAULT_LP_STATE = 9;
const VAULT_LP_STATE_VERSION = 1;

export interface VaultLpState {
  registry: PublicKey;
  lpPortfolio: PublicKey;
  juniorOwner: PublicKey;
}

/** VaultLpStateV18 at HEADER_LEN (b2b2559e :5647). null unless kind 9 / version 1 / long enough. */
export function decodeVaultLpState(d: Uint8Array): VaultLpState | null {
  const H = 16;
  if (d.length < H + 256 || d[10] !== KIND_VAULT_LP_STATE || d[H + 214] !== VAULT_LP_STATE_VERSION) return null;
  return {
    registry: new PublicKey(d.subarray(H + 32, H + 64)),
    lpPortfolio: new PublicKey(d.subarray(H + 64, H + 96)),
    juniorOwner: new PublicKey(d.subarray(H + 96, H + 128)),
  };
}

export function buildVaultLpSettleResolvedIx(p: {
  wrapperProgramId: PublicKey;
  caller: PublicKey;
  market: PublicKey;
  vaultLpState: PublicKey;
  state: VaultLpState;
  registryDomain: number;
  collateralMint: PublicKey;
  /** 0 = the CloseResolved step, 1 = claim a pending resolved top-up. */
  topup: 0 | 1;
}): TransactionInstruction {
  const v = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, p.collateralMint);
  const [own] = deriveLpBackingLedger(p.wrapperProgramId, p.market, p.registryDomain);
  const [sib] = deriveLpBackingLedger(p.wrapperProgramId, p.market, p.registryDomain ^ 1);
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: [
      { pubkey: p.caller, isSigner: true, isWritable: true },
      { pubkey: p.market, isSigner: false, isWritable: true },
      { pubkey: p.state.registry, isSigner: false, isWritable: false },
      { pubkey: p.vaultLpState, isSigner: false, isWritable: true },
      { pubkey: p.state.lpPortfolio, isSigner: false, isWritable: true },
      { pubkey: own, isSigner: false, isWritable: true },
      { pubkey: sib, isSigner: false, isWritable: false },
      { pubkey: ownerAta(p.state.juniorOwner, p.collateralMint), isSigner: false, isWritable: true },
      { pubkey: v.vaultToken, isSigner: false, isWritable: true },
      { pubkey: v.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: v.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([WRAPPER_TAG_VAULT_LP_SETTLE_RESOLVED, p.topup]),
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

export type PdaOwnerKind = "lp-registry" | "nft-escrow";

/** PositionNftV16 (nft db4aa09 state_v16.rs, 199 B): portfolio_account @10, nft_mint @42, last_holder @167. */
export const POSITION_NFT_LEN = 199;
export function decodePositionNft(d: Uint8Array): { portfolio: PublicKey; nftMint: PublicKey; holder: PublicKey } | null {
  if (d.length !== POSITION_NFT_LEN) return null;
  return {
    portfolio: new PublicKey(d.subarray(10, 42)),
    nftMint: new PublicKey(d.subarray(42, 74)),
    holder: new PublicKey(d.subarray(167, 199)),
  };
}

/** The escrowed portfolio's NFT record (mint + current holder). null if not found. Never throws. */
export async function positionNftFor(
  conn: Pick<Connection, "getProgramAccounts">,
  nftProgramId: PublicKey,
  portfolio: PublicKey,
): Promise<{ nftMint: string; holder: string } | null> {
  try {
    const recs = await conn.getProgramAccounts(nftProgramId, {
      filters: [{ dataSize: POSITION_NFT_LEN }, { memcmp: { offset: 10, bytes: portfolio.toBase58() } }],
    });
    for (const r of recs) {
      const d = decodePositionNft(new Uint8Array(r.account.data));
      if (d && d.portfolio.equals(portfolio)) return { nftMint: d.nftMint.toBase58(), holder: d.holder.toBase58() };
    }
    return null;
  } catch {
    return null;
  }
}

/** Which rent-stranding PDA (if any) owns this portfolio. */
export function pdaOwnerKind(owner: PublicKey, market: PublicKey, cfg: Pick<CleanupConfig, "wrapperProgramId" | "nftProgramId">): PdaOwnerKind | null {
  if (owner.equals(deriveLpVaultRegistry(cfg.wrapperProgramId, market)[0])) return "lp-registry";
  if (owner.equals(nftEscrowAuthority(cfg.nftProgramId))) return "nft-escrow";
  return null;
}

/** Slots of grace left after resolve, or 0 once it has passed (unknown resolve slot = full grace). */
export function pdaGraceLeft(nowSlot: bigint, resolvedSlot: bigint | null, graceSlots: bigint): bigint {
  if (resolvedSlot === null || resolvedSlot === 0n) return graceSlots;
  const elapsed = nowSlot > resolvedSlot ? nowSlot - resolvedSlot : 0n;
  return elapsed >= graceSlots ? 0n : graceSlots - elapsed;
}

export interface CleanupConfig {
  wrapperProgramId: PublicKey;
  nftProgramId: PublicKey;
  /** Portfolios attempted per market per cycle. */
  maxPerCycle: number;
  /** Owner token accounts the keeper may create (rent it pays) per market per cycle. */
  maxAtaCreatesPerCycle: number;
  /** Slots after resolve during which PDA-owned portfolios are left for their holders (default 216,000 ≈ 24 h). */
  pdaGraceSlots: bigint;
  probeTtlMs: number;
  confirm?: ConfirmOptions;
  now?: () => number;
}

export class CleanupState {
  support: { value: CleanupSupport; at: number } | null = null;
}

export type CleanupConnection = Pick<
  Connection,
  "getProgramAccounts" | "getMultipleAccountsInfo" | "getAccountInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses"
>;

export interface CleanupResult {
  support: CleanupSupport;
  closed: number;
  progressed: number;
  /** Portfolios that could not be closed this cycle, with why. */
  remaining: Array<{ portfolio: string; reason: string }>;
  /** Empty NFT-escrowed portfolios closed after the grace period (rent went to the escrow PDA) — logged + alerted. */
  pdaClosed: Array<{ portfolio: string; owner: string; kind: PdaOwnerKind; rentLamports: number }>;
  /** Vault-LP portfolios closed (tag 101 then tag 8; rent to the registry — expected). */
  vaultLpClosed: string[];
  /** NFT-escrowed portfolios WITH a claim: only the holder can settle them (GH#496). */
  waitingOnHolder: Array<{ portfolio: string; nftMint: string | null; holder: string | null; capital: bigint; pnl: bigint; reservedPnl: bigint; activeLegs: number }>;
  /** Vault-LP settles (tag 101) sent this pass. */
  vaultLpSettled: number;
}

interface Pf {
  pubkey: PublicKey;
  lamports: number;
  /** capital / pnl / reservedPnl / active legs / cancel-deposit escrow: anything the owner still has to claim. */
  claim: { capital: bigint; pnl: bigint; reservedPnl: bigint; activeLegs: number; cancelDepositEscrow: bigint };
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
    : ie?.custom === WRAPPER_ERR_EXPECTED_SIGNER
      ? " — NFT-escrowed payout needs the NFT holder's signature (GH#496): not closable by any keeper"
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
  /** Chain slot now, and the market's engine resolved_slot (grace clock for PDA owners). */
  clock: { nowSlot: bigint; resolvedSlot: bigint | null } = { nowSlot: 0n, resolvedSlot: null },
): Promise<CleanupResult> {
  const out: CleanupResult = { support: "unknown", closed: 0, progressed: 0, remaining: [], pdaClosed: [], vaultLpClosed: [], waitingOnHolder: [], vaultLpSettled: 0 };
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
      const claim = { capital: p.capital, pnl: p.pnl, reservedPnl: p.reservedPnl, activeLegs: p.legs.filter((l) => l.active).length, cancelDepositEscrow: p.cancelDepositEscrow };
      return { pubkey: a.pubkey, lamports: a.account.lamports, claim, owner: p.owner, portfolioId: p.portfolioId, matcherSequence: p.matcherSequence, positionEpoch: p.matcherPositionEpoch };
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
      const target = pfs.find((q) => pdaOwnerKind(q.owner, market, cfg) === null) ?? pfs[0];
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

  // Order (coordinator, P3 07a1d0eb): every other portfolio first (CloseResolved +
  // tag 8), THEN the vault LP (tag 101 settle, then its tag 8), so the senior-first
  // settle of the vault LP sees the other positions already settled.
  pfs.sort((x, y) => Number(pdaOwnerKind(x.owner, market, cfg) === "lp-registry") - Number(pdaOwnerKind(y.owner, market, cfg) === "lp-registry"));
  const graceLeft = pdaGraceLeft(clock.nowSlot, clock.resolvedSlot, cfg.pdaGraceSlots);
  // Vault LP (tag 101 first): its state names the LP portfolio and junior owner.
  let vaultLp: { key: PublicKey; state: VaultLpState; domain: number } | null = null;
  if (pfs.some((q) => pdaOwnerKind(q.owner, market, cfg) === "lp-registry")) {
    try {
      const key = deriveVaultLpState(cfg.wrapperProgramId, market);
      const [si] = await conn.getMultipleAccountsInfo([key], "confirmed");
      const state = si ? decodeVaultLpState(new Uint8Array(si.data)) : null;
      if (state) {
        const ri = await conn.getAccountInfo(state.registry, "confirmed");
        if (ri) vaultLp = { key, state, domain: Number(parseLpVaultRegistry(new Uint8Array(ri.data)).domain) };
      }
    } catch {
      vaultLp = null;
    }
  }
  const settleIx = (topup: 0 | 1): TransactionInstruction =>
    buildVaultLpSettleResolvedIx({
      wrapperProgramId: cfg.wrapperProgramId, caller: keeper.publicKey, market, vaultLpState: vaultLp!.key,
      state: vaultLp!.state, registryDomain: vaultLp!.domain, collateralMint, topup,
    });

  for (let i = 0; i < pfs.length; i++) {
    const p = pfs[i];
    const pdaKind = pdaOwnerKind(p.owner, market, cfg);
    if (i >= cfg.maxPerCycle) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `over the ${cfg.maxPerCycle}-per-cycle bound; next cycle` });
      continue;
    }
    if (pdaKind === "lp-registry") {
      // §0.7: 101 topup=0 -> 101 topup=1 (21 = nothing pending, harmless) -> tag 8, at once.
      if (!vaultLp || !vaultLp.state.lpPortfolio.equals(p.pubkey)) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "registry-PDA-owned portfolio with no bound vault-LP state (cannot run tag 101)" });
        continue;
      }
      try {
        const settle0 = mk([buildCreateAtaIdempotentIx(keeper.publicKey, vaultLp.state.juniorOwner, collateralMint), settleIx(0)]);
        const r0 = await sim(settle0);
        if (!r0.err && (await send(settle0))) out.vaultLpSettled++;
        const settle1 = mk([settleIx(1)]);
        const r1 = await sim(settle1);
        if (!r1.err && (await send(settle1))) out.vaultLpSettled++;
        const close = mk([closeIx(p)]);
        const rc = await sim(close);
        if (!rc.err && (await send(close))) {
          out.closed++;
          out.vaultLpClosed.push(p.pubkey.toBase58());
        } else {
          out.remaining.push({
            portfolio: p.pubkey.toBase58(),
            reason: `vault LP: tag 101(0) ${r0.err ? why(r0.err, r0.logs, { 2: "VaultLpSettleResolved(0)" }) : "ok"}; tag 8 ${rc.err ? why(rc.err, rc.logs, { 1: "ClosePortfolio" }) : "did not land"}`,
          });
        }
      } catch (err) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
      }
      continue;
    }
    if (pdaKind === "nft-escrow") {
      const c = p.claim;
      const hasClaim = c.capital !== 0n || c.pnl !== 0n || c.reservedPnl !== 0n || c.activeLegs > 0 || c.cancelDepositEscrow !== 0n;
      if (hasClaim) {
        // GH#496: never attempted — only the holder can settle an escrowed payout.
        const nft = await positionNftFor(conn, cfg.nftProgramId, p.pubkey);
        out.waitingOnHolder.push({ portfolio: p.pubkey.toBase58(), nftMint: nft?.nftMint ?? null, holder: nft?.holder ?? null, capital: c.capital, pnl: c.pnl, reservedPnl: c.reservedPnl, activeLegs: c.activeLegs });
        out.remaining.push({
          portfolio: p.pubkey.toBase58(),
          reason: `NFT-escrowed WITH a claim (capital ${c.capital}, pnl ${c.pnl}, reserved ${c.reservedPnl}, ${c.activeLegs} leg(s)): waiting on NFT holder ${nft?.holder ?? "?"} (mint ${nft?.nftMint ?? "?"}) — GH#496, holder-only`,
        });
        continue;
      }
      if (graceLeft > 0n) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `EMPTY NFT-escrowed portfolio: left for the holder to unwrap/burn and reclaim the rent — grace period, ${graceLeft} slots left` });
        continue;
      }
      try {
        const close = mk([closeIx(p)]);
        const rc = await sim(close);
        if (!rc.err && (await send(close))) {
          out.closed++;
          out.pdaClosed.push({ portfolio: p.pubkey.toBase58(), owner: p.owner.toBase58(), kind: pdaKind, rentLamports: p.lamports });
        } else {
          out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `EMPTY NFT-escrowed after grace: tag 8 ${rc.err ? why(rc.err, rc.logs, { 1: "ClosePortfolio" }) : "did not land"}` });
        }
      } catch (err) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
      }
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
        if (await send(b)) {
          out.closed++;
        }
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
