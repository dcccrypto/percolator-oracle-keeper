/**
 * cross-cluster/v22/create-anchor.ts
 *
 * Helper to create the KEEPER'S OWN flat "anchor" portfolio on a v2.2 market: the accrue-only crank target of
 * SETTLE_PAIRING (settle-pairing.ts). It is NEVER run by the keeper itself: nothing in cross-cluster.ts imports it. The
 * operator runs `src/v22-create-anchor.ts` by hand, and it is gated twice:
 *
 *   KEEPER_V22_CREATE_ANCHOR=on          required (default off: the script refuses to do anything)
 *   KEEPER_V22_CREATE_ANCHOR_DRY_RUN     default ON: simulate and print; real send only with an explicit "off"
 *
 * The tx is a TOP-LEVEL `SystemProgram.createAccount` of EXACTLY the layout's portfolio length (10,603 B on variant B; the
 * wrapper cannot realloc past 10,240 B, so any other length fails) followed by InitPortfolio (tag 1) with the keeper as
 * owner. The new account's keypair signs. It costs about 0.074 SOL of refundable rent. UNVERIFIED without a live v2.2
 * market: that InitPortfolio takes exactly [owner, market, portfolio] on the v2.2 program. The keeper discovers the
 * anchor afterwards by OWNER (no configuration needed): it only ever uses a keeper-owned, flat portfolio.
 */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { ACCOUNTS_INIT_USER, ACCOUNT_KIND, UnknownLayoutError, buildAccountMetas, buildCreatePortfolioAccountIxV22, encodeInitUser, LAYOUT_V22, resolveLayout } from "@percolatorct/sdk";
import type { LayoutTable } from "@percolatorct/sdk";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";

export function buildCreateAnchorIxs(p: { keeper: PublicKey; anchor: PublicKey; market: PublicKey; programId: PublicKey; lamports: number; layout?: LayoutTable }): TransactionInstruction[] {
  const create = buildCreatePortfolioAccountIxV22(p.keeper, p.anchor, p.lamports, p.programId, p.layout ?? LAYOUT_V22);
  const init = new TransactionInstruction({
    programId: p.programId,
    keys: buildAccountMetas(ACCOUNTS_INIT_USER, { owner: p.keeper, market: p.market, portfolio: p.anchor }),
    data: Buffer.from(encodeInitUser()),
  });
  return [create, init];
}

/**
 * Refuse (return the reason) unless the market account exists, is owned by the CONFIGURED wrapper program and carries a VERSION
 * the SDK knows (and the layout we create portfolios for). Runs before anything is simulated or sent.
 */
export function checkMarketForAnchor(
  info: { owner: PublicKey; data: Uint8Array } | null,
  programId: PublicKey,
  layout: LayoutTable = LAYOUT_V22,
): string | null {
  if (!info) return "the market account does not exist";
  if (!info.owner.equals(programId)) return `the market is owned by ${info.owner.toBase58()}, not the configured wrapper ${programId.toBase58()} (check WRAPPER_PROGRAM_ID)`;
  try {
    const t = resolveLayout(new Uint8Array(info.data), { parser: "v22-create-anchor", kind: ACCOUNT_KIND.Market });
    if (t.version !== layout.version) return `the market is wrapper VERSION ${t.version}; this helper creates VERSION ${layout.version} (${layout.portfolio.accountLen} B) portfolios`;
  } catch (e) {
    return e instanceof UnknownLayoutError ? `unsupported market account: ${e.code}` : `unreadable market account: ${(e as Error).message}`;
  }
  return null;
}

export async function createKeeperAnchor(
  exec: ExecContext,
  conn: Pick<Connection, "getMinimumBalanceForRentExemption" | "getAccountInfo">,
  p: { market: PublicKey; programId: PublicKey; dryRun: boolean; layout?: LayoutTable; anchorKeypair?: Keypair },
): Promise<{ anchor: PublicKey; lamports: number; outcome: ExecOutcome }> {
  const layout = p.layout ?? LAYOUT_V22;
  const kp = p.anchorKeypair ?? Keypair.generate();
  const info = await conn.getAccountInfo(p.market, "confirmed");
  const refusal = checkMarketForAnchor(info ? { owner: info.owner, data: info.data } : null, p.programId, layout);
  if (refusal) return { anchor: kp.publicKey, lamports: 0, outcome: { kind: "failed", error: `refused: ${refusal}` } };
  const lamports = await conn.getMinimumBalanceForRentExemption(layout.portfolio.accountLen);
  const ixs = buildCreateAnchorIxs({ keeper: exec.keeper.publicKey, anchor: kp.publicKey, market: p.market, programId: p.programId, lamports, layout });
  const outcome = await simulateAndSend({ ...exec, extraSigners: [kp] }, ixs, { job: "create-anchor", label: p.market.toBase58().slice(0, 8), units: 400_000, dryRun: p.dryRun, expected: new Set() });
  return { anchor: kp.publicKey, lamports, outcome };
}
