/**
 * cross-cluster/creator-fee-payee.ts
 *
 * prog #587 (merged as prog #644 into rc23 2b5dce8a): the creator fee of an asset whose `asset_admin` was burned is
 * no longer lost. Before the burn the admin records a payee (tag 125, PDA `["creator_fee_payee", market, idx u16 LE]`,
 * kind 19) and profile `p4_flags` bit 3 is set. After the burn, tag 90 (`WithdrawCreatorFee`) for that asset is
 * PERMISSIONLESS: any signer may send it, it pays ONLY the payee's canonical associated token account for the vault
 * mint (classic SPL Token; no delegate, no close authority), and it takes the payee record as account [6]. CloseSlab
 * no longer re-books such a pot to the protocol leg: it refuses (71 CloseSlabFeesOutstanding) until the pot is paid.
 *
 * This keeper pays that pot from the pre-resolve drain (before ResolveMarket and before CloseSlab). Everything here
 * is read from the program source at 2b5dce8a (`src/creator_fee_payee_v22.rs`, `handle_withdraw_creator_fee`,
 * `read_bound_creator_fee_payee`, `canonical_vault_address`); the PDA / ATA values are pinned in the test against
 * vectors generated from the real crate (percolator-sdk scripts/creator-fee-payee-parity). The pinned SDK
 * (9aff57d) predates #587, so the few constants live here; swap them for the SDK's `creator-fee-payee-v22` exports
 * when this keeper is re-pinned to an SDK that has them.
 *
 * Only asset 0 is handled (the drain reads asset 0's creator leg, like fee-legs.ts). Asset 0's claimable pot is its
 * profile counter plus the legacy market-wide `WrapperConfig.creator_fee_claimable_atoms`.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  ACCOUNTS_WITHDRAW_CREATOR_FEE,
  V17_ASSET_ORACLE_PROFILE_LEN,
  buildAccountMetas,
  deriveMarketVaultAccounts,
  encodeWithdrawCreatorFee,
  parseAssetControlSequencesV17,
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import { describeProgramError } from "./fee-error.ts";
import { addKeeperPriorityFee } from "./priority-fee.ts";
import { buildCreateAtaIdempotentIx, ownerAta } from "./resolved-portfolio-cleanup.ts";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** `creator_fee_payee_v22::CREATOR_FEE_PAYEE_SEED`. */
export const CREATOR_FEE_PAYEE_SEED = "creator_fee_payee";
/** Profile `p4_flags` bit 3 (`P4_FLAG_CREATOR_FEE_PAYEE`), profile byte +20. */
export const P4_FLAG_CREATOR_FEE_PAYEE = 1 << 3;
/** `p4_flags` byte inside the oracle profile (`_padding0[PROFILE_P4_FLAGS_IDX]` = profile offset 20). */
export const PROFILE_P4_FLAGS_OFF = 20;
/** Header kind of the payee record (`KIND_CREATOR_FEE_PAYEE`). */
export const KIND_CREATOR_FEE_PAYEE = 19;
/** Payee record account length: 16-byte header + 72-byte body. */
export const CREATOR_FEE_PAYEE_ACCOUNT_LEN = 88;
/** Error code `CreatorFeePayeeInvalid`. */
export const CREATOR_FEE_PAYEE_INVALID = 136;
/** Same CU limit as the other single-instruction fee jobs (tag 90 + an idempotent ATA create). */
const COMPUTE_UNIT_LIMIT = 200_000;

/** How tag 90 authorises a claim on one asset (`claim_route`). */
export type CreatorRoute = "AdminSigned" | "Payee" | "Refused";

/** Asset 0's creator-fee state as tag 90 and CloseSlab see it. */
export interface CreatorFeeState {
  route: CreatorRoute;
  /** Asset 0 profile counter + the legacy market-wide counter (what tag 90 can pay). */
  owed: bigint;
  /** Asset 0's current `authority_epoch` (tag 90 checks it, does not advance it). */
  authorityEpoch: bigint;
  collateralMint: PublicKey;
}

/** `claim_route`: live admin signs; burned admin + bit 3 = payee route; burned without it = refused (re-booked at CloseSlab). */
export function creatorRoute(assetAdmin: Uint8Array, p4Flags: number): CreatorRoute {
  if (assetAdmin.some((b) => b !== 0)) return "AdminSigned";
  return (p4Flags & P4_FLAG_CREATOR_FEE_PAYEE) !== 0 ? "Payee" : "Refused";
}

/** Read asset 0's creator-fee route / pot / epoch from market bytes; null when the VERSION is unknown. */
export function readCreatorFeeState(data: Uint8Array): CreatorFeeState | null {
  const g = selectMarketGroupOffset(data);
  if (!g.ok) return null;
  const slot = assetSlotOffset(g, 0);
  if (data.length < slot + V17_ASSET_ORACLE_PROFILE_LEN) return null;
  const profile = parseAssetOracleProfileV17(data, slot);
  const cfg = parseWrapperConfigV17(data);
  return {
    route: creatorRoute(profile.assetAdmin.toBytes(), data[slot + PROFILE_P4_FLAGS_OFF]),
    owed: profile.creatorFeeClaimableAtoms + cfg.creatorFeeClaimableAtoms,
    authorityEpoch: parseAssetControlSequencesV17(data, slot).authorityEpoch,
    collateralMint: cfg.collateralMint,
  };
}

/** Payee record PDA `["creator_fee_payee", market, asset_index u16 LE]`. */
export function deriveCreatorFeePayee(programId: PublicKey, market: PublicKey, assetIndex: number): [PublicKey, number] {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(assetIndex);
  return PublicKey.findProgramAddressSync([Buffer.from(CREATOR_FEE_PAYEE_SEED), market.toBuffer(), idx], programId);
}

/** The only destination tag 90 accepts on the payee route: `canonical_vault_address(payee, mint)` (classic SPL ATA). */
export function payeeDestination(payee: PublicKey, mint: PublicKey): PublicKey {
  return ownerAta(payee, mint);
}

/** The payee wallet from a payee record (the wrapper's validity rules); null if the record would be refused (136). */
export function decodePayeeRecord(data: Uint8Array, market: PublicKey, assetIndex: number): PublicKey | null {
  if (data.length !== CREATOR_FEE_PAYEE_ACCOUNT_LEN || data[10] !== KIND_CREATOR_FEE_PAYEE) return null;
  const b = 16;
  const marketBytes = data.subarray(b, b + 32);
  const payee = data.subarray(b + 32, b + 64);
  const idx = data[b + 64] | (data[b + 65] << 8);
  const version = data[b + 66];
  const reserved = data.subarray(b + 68, b + 72);
  if (version !== 1 || reserved.some((x) => x !== 0) || payee.every((x) => x === 0)) return null;
  if (!Buffer.from(marketBytes).equals(market.toBuffer()) || idx !== assetIndex) return null;
  return new PublicKey(payee.slice());
}

/** [idempotent payee-ATA create, tag 90 (7 accounts)] for asset `assetIndex`, paid by `caller`. */
export function buildPayeeClaimIxs(p: {
  programId: PublicKey;
  market: PublicKey;
  caller: PublicKey;
  assetIndex: number;
  payee: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  authorityEpoch: bigint;
}): TransactionInstruction[] {
  const v = deriveMarketVaultAccounts(p.programId, p.market, p.collateralMint);
  const dest = payeeDestination(p.payee, p.collateralMint);
  const [record] = deriveCreatorFeePayee(p.programId, p.market, p.assetIndex);
  const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_CREATOR_FEE, {
    authority: p.caller,
    market: p.market,
    destToken: dest,
    vaultToken: v.vaultToken,
    vaultAuthority: v.vaultAuthority,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  keys.push({ pubkey: record, isSigner: false, isWritable: false });
  return [
    buildCreateAtaIdempotentIx(p.caller, p.payee, p.collateralMint),
    new TransactionInstruction({
      programId: p.programId,
      keys,
      data: Buffer.from(encodeWithdrawCreatorFee({ amount: p.amount, assetIndex: p.assetIndex, authorityEpoch: p.authorityEpoch })),
    }),
  ];
}

export type PayeeClaimOutcome =
  | "paid"
  | "not-needed"
  | "skipped"
  | { error: string };

export type PayeeClaimConnection = Pick<
  Connection,
  "getAccountInfo" | "getLatestBlockhash" | "sendRawTransaction" | "simulateTransaction" | "getSignatureStatuses" | "getBlockHeight"
>;

/**
 * Pay asset 0's creator pot to its recorded payee (permissionless tag 90) when the route is "Payee" and the pot is
 * non-zero. `dryRun` builds and simulates only. Never throws.
 */
export async function payCreatorFeeToPayeeOnce(
  conn: PayeeClaimConnection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
  confirmOpts?: ConfirmOptions,
  programId: PublicKey = WRAPPER_PROGRAM_ID,
): Promise<PayeeClaimOutcome> {
  try {
    const market = new PublicKey(marketAddress);
    const info = await conn.getAccountInfo(market, "confirmed");
    if (!info) return { error: "market not found" };
    const s = readCreatorFeeState(new Uint8Array(info.data));
    if (!s) return "skipped";
    if (s.route !== "Payee" || s.owed === 0n) return "not-needed";
    const [record] = deriveCreatorFeePayee(programId, market, 0);
    const rec = await conn.getAccountInfo(record, "confirmed");
    if (!rec || !rec.owner.equals(programId)) return { error: `payee record ${record.toBase58()} missing although p4 bit 3 is set` };
    const payee = decodePayeeRecord(new Uint8Array(rec.data), market, 0);
    if (!payee) return { error: `payee record ${record.toBase58()} does not decode (the program would refuse it with ${CREATOR_FEE_PAYEE_INVALID})` };
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    for (const ix of buildPayeeClaimIxs({
      programId, market, caller: keeper.publicKey, assetIndex: 0, payee, collateralMint: s.collateralMint,
      amount: s.owed, authorityEpoch: s.authorityEpoch,
    })) tx.add(ix);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    addKeeperPriorityFee(tx);
    tx.sign(keeper);
    if (dryRun) {
      const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
      if (sim.value.err) return { error: describeProgramError("tag 90 (payee) simulation", sim.value.err) };
      console.log(`[creator-payee] [DRY-RUN] tag 90 ${s.owed} atoms -> ${payee.toBase58()} (${marketAddress.slice(0, 8)}…)`);
      return "skipped";
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 2 });
    const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, confirmOpts);
    if (c.status === "failed") return { error: `${describeProgramError("tag 90 (payee) landed but failed on chain:", c.err)} sig=${sig.slice(0, 16)}…` };
    if (c.status === "not-landed") return { error: `not landed (retry): ${c.reason} sig=${sig.slice(0, 16)}…` };
    console.log(`[creator-payee] paid ${s.owed} atoms -> ${payee.toBase58()} (${marketAddress.slice(0, 8)}…) sig=${sig.slice(0, 16)}…`);
    return "paid";
  } catch (err) {
    return { error: describeProgramError("tag 90 (payee)", err, 120) };
  }
}
