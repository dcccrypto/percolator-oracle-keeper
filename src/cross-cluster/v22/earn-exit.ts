/**
 * cross-cluster/v22/earn-exit.ts   (KEEPER_V22_EARN_EXIT)
 *
 * Keeper-executed Earn exits: tag 77 on requests that were created with `keeper_ok = 1` (tag 76 v2.2 trailer),
 * unsigned by the redeemer (the payout goes to the recorded redeemer's token account, the floor is the stored
 * `min_payout`). The program loss-gates an unsigned execution ONLY on Live NON-bound markets (118 when the book is not
 * loss-current). On a BOUND market (the common case) the exit is permissionless by design and the program applies no
 * loss-current gate, so the keeper's own gate below is BEST-EFFORT there (a processed-commitment snapshot; no
 * same-slot sweep is verified) layered on top of the user's floor, which always binds. The keeper only tries when
 * the book reads loss-current after the sweep:
 *
 *   gate: single-asset market, no stale cohort, asset accrued to the market clock, `loss_stale_active` clear.
 *
 * NEVER SENT WITHOUT SIMULATING: `simulateAndSend` simulates first and sends only a clean simulation; 117 (floor not
 * met: the price moved against the request) and 118 (not loss-current) are expected refusals, not failures.
 * No inline refresh is attempted (n_refresh = 0): this path exists for a book the sweep already made current.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  ACCOUNT_KIND,
  buildExecuteRedemptionIxV22,
  decodeLpRedemptionV22,
  deriveLpVaultRegistry,
  deriveMarketVaultAccounts,
  getAtaSync,
  parseWrapperConfigV17,
  redemptionDataSizesV22,
} from "@percolatorct/sdk";
import type { LpRedemptionV22 } from "@percolatorct/sdk";
import { isAssetLossStale } from "../positioned-refresh.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";

export const EARN_EXIT_UNITS = 400_000;
/** A request that was refused / failed is not retried for this many slots (head-of-line blocking, review F-7). */
export const EARN_EXIT_COOLDOWN_SLOTS = 450n;

export interface EarnExitState {
  /** redemption base58 -> slot until which it is not simulated again. */
  cooldownUntil: Map<string, bigint>;
}
export const freshEarnExitState = (): EarnExitState => ({ cooldownUntil: new Map() });
/** 117 floor not met, 118 not loss-current: expected, retried at the next tick. */
export const EARN_EXIT_EXPECTED: ReadonlySet<number> = new Set([117, 118]);

/** True when the book is loss-current at the read (the program's gate, mirrored). Pure. */
export function bookIsLossCurrent(ctx: Pick<V22MarketCtx, "refresh" | "slots">): { ok: boolean; reason: string | null } {
  const s = ctx.refresh;
  if (ctx.slots !== 1) return { ok: false, reason: `multi-asset market (${ctx.slots} slots): an unsigned exit needs EVERY asset loss-current` };
  if (s.lossStaleActive) return { ok: false, reason: "loss_stale_active" };
  if (s.staleLong !== 0n || s.staleShort !== 0n) return { ok: false, reason: `stale cohort ${s.staleLong}L/${s.staleShort}S` };
  if (isAssetLossStale(s)) return { ok: false, reason: "asset not accrued to the market clock" };
  return { ok: true, reason: null };
}

/** The keeper_ok requests of this market's registry, decoded (floor > 0 only: A4). */
export function selectKeeperRequests(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  registry: PublicKey,
  skip: (pubkey: PublicKey) => boolean = () => false,
): Array<{ pubkey: PublicKey; req: LpRedemptionV22 }> {
  const out: Array<{ pubkey: PublicKey; req: LpRedemptionV22 }> = [];
  for (const { pubkey, data } of accounts) {
    if (skip(pubkey)) continue;
    let req: LpRedemptionV22;
    try {
      req = decodeLpRedemptionV22(data);
    } catch {
      continue;
    }
    if (!req.extended || !req.keeperOk || req.minPayoutAtoms <= 0n || !req.registry.equals(registry)) continue;
    out.push({ pubkey, req });
  }
  return out.sort((a, b) => (a.req.requestSlot < b.req.requestSlot ? -1 : a.req.requestSlot > b.req.requestSlot ? 1 : 0));
}

export async function fetchRedemptionRequests(conn: Pick<Connection, "getProgramAccounts">, ctx: V22MarketCtx) {
  const [, extended] = redemptionDataSizesV22();
  const [registry] = deriveLpVaultRegistry(ctx.programId, ctx.market);
  // Filtered by THIS market's registry on the node (the registry key is the first body field, right after the 16 B header).
  const accts = await conn.getProgramAccounts(ctx.programId, {
    filters: [
      { dataSize: extended },
      { memcmp: { offset: 10, bytes: Buffer.from([ACCOUNT_KIND.LpRedemption]).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 16, bytes: registry.toBase58() } },
    ],
  });
  return accts.map((a) => ({ pubkey: a.pubkey, data: new Uint8Array(a.account.data) }));
}

export async function executeKeeperExits(
  exec: ExecContext,
  ctx: V22MarketCtx,
  requests: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  maxPerTick = 2,
  st: EarnExitState = freshEarnExitState(),
): Promise<{ gate: { ok: boolean; reason: string | null }; outcomes: Array<{ redemption: string; outcome: ExecOutcome }> }> {
  const gate = bookIsLossCurrent(ctx);
  if (!gate.ok) return { gate, outcomes: [] };
  const [registry] = deriveLpVaultRegistry(ctx.programId, ctx.market);
  const now = BigInt(ctx.readSlot);
  const todo = selectKeeperRequests(requests, registry, (pk) => (st.cooldownUntil.get(pk.toBase58()) ?? 0n) > now).slice(0, maxPerTick);
  const mint = parseWrapperConfigV17(ctx.data).collateralMint;
  const vaultToken = deriveMarketVaultAccounts(ctx.programId, ctx.market, mint).vaultToken;
  const outcomes: Array<{ redemption: string; outcome: ExecOutcome }> = [];
  for (const { pubkey, req } of todo) {
    const dest = getAtaSync(req.redeemer, mint, true);
    const ix = buildExecuteRedemptionIxV22(ctx.sdk, exec.keeper.publicKey, req.redeemer, dest, vaultToken, ctx.registryDomain, {
      minPayoutAtoms: req.minPayoutAtoms,
      redeemerSigns: false,
      ...(ctx.bound && ctx.lpPortfolio ? { boundLpPortfolio: ctx.lpPortfolio } : {}),
    });
    const outcome = await simulateAndSend(exec, [ix], { job: "earn-exit-77", label: `${ctx.label} ${pubkey.toBase58().slice(0, 6)}`, units: EARN_EXIT_UNITS, expected: EARN_EXIT_EXPECTED });
    outcomes.push({ redemption: pubkey.toBase58(), outcome });
    // Rotate past a request the program refused (117 floor unreachable, 118, anything else) instead of re-trying it every tick.
    if (outcome.kind !== "sent" && outcome.kind !== "dry-run") st.cooldownUntil.set(pubkey.toBase58(), now + EARN_EXIT_COOLDOWN_SLOTS);
  }
  return { gate, outcomes };
}
