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
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  ACCOUNT_KIND,
  buildExecuteRedemptionIxV22,
  decodeLpRedemptionV22,
  encodeExecuteRedemptionV22,
  deriveLpRedemption,
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

/**
 * Per-market derivation memo. The registry PDA, the vault token and the collateral mint are fixed per (program, market);
 * re-deriving them (findProgramAddressSync bump search) every tick dominated the tick. The mint is cached together with the
 * first 80 bytes of the market account (16 B header + marketauth + collateral mint) and re-parsed if those bytes ever change.
 */
interface MarketDerivation {
  programId: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  registryB58: string;
  prefix: Uint8Array | null;
  mint: PublicKey | null;
  vaultToken: PublicKey | null;
  /** redeemer base58 -> its destination ATA and its redemption PDA (both pure functions of (registry, redeemer, mint)). */
  perRedeemer: Map<string, { dest: PublicKey; redemption: PublicKey }>;
  /** The SDK-built instruction skeleton: only the redemption / redeemerDest / redeemer keys and the min-payout bytes vary per request. */
  tmpl: { keeper: PublicKey; domain: number; lp: PublicKey | null; ix: TransactionInstruction } | null;
}
const CONFIG_PREFIX_LEN = 80;
const WRAPPER_MIN_LEN = 16 + 576;
export const EARN_EXIT_MEMO_MARKETS = 256;
export const EARN_EXIT_MEMO_REDEEMERS = 1024;
const derivations = new Map<string, MarketDerivation>();

function marketDerivation(ctx: Pick<V22MarketCtx, "programId" | "market" | "marketAddress">): MarketDerivation {
  let d = derivations.get(ctx.marketAddress);
  if (d && d.market.equals(ctx.market) && d.programId.equals(ctx.programId)) {
    derivations.delete(ctx.marketAddress);
    derivations.set(ctx.marketAddress, d); // LRU touch
    return d;
  }
  const [registry] = deriveLpVaultRegistry(ctx.programId, ctx.market);
  d = { programId: ctx.programId, market: ctx.market, registry, registryB58: registry.toBase58(), prefix: null, mint: null, vaultToken: null, perRedeemer: new Map(), tmpl: null };
  derivations.delete(ctx.marketAddress);
  derivations.set(ctx.marketAddress, d);
  if (derivations.size > EARN_EXIT_MEMO_MARKETS) derivations.delete(derivations.keys().next().value as string);
  return d;
}

function marketVault(d: MarketDerivation, data: Uint8Array): { mint: PublicKey; vaultToken: PublicKey } {
  if (d.mint && d.vaultToken && d.prefix && data.length >= WRAPPER_MIN_LEN && Buffer.compare(d.prefix, data.subarray(0, CONFIG_PREFIX_LEN)) === 0) {
    return { mint: d.mint, vaultToken: d.vaultToken };
  }
  const mint = parseWrapperConfigV17(data).collateralMint;
  const vaultToken = deriveMarketVaultAccounts(d.programId, d.market, mint).vaultToken;
  d.prefix = data.slice(0, CONFIG_PREFIX_LEN);
  d.mint = mint;
  d.vaultToken = vaultToken;
  d.perRedeemer.clear();
  d.tmpl = null;
  return { mint, vaultToken };
}

function redeemerAccounts(d: MarketDerivation, redeemer: PublicKey, redeemerB58: string, mint: PublicKey): { dest: PublicKey; redemption: PublicKey } {
  let r = d.perRedeemer.get(redeemerB58);
  if (!r) {
    r = { dest: getAtaSync(redeemer, mint, true), redemption: deriveLpRedemption(d.programId, d.registry, redeemer)[0] };
    if (d.perRedeemer.size >= EARN_EXIT_MEMO_REDEEMERS) d.perRedeemer.delete(d.perRedeemer.keys().next().value as string);
    d.perRedeemer.set(redeemerB58, r);
  }
  return r;
}

// Account order of ACCOUNTS_EXECUTE_REDEMPTION_V22: the per-request keys.
const IX_REDEMPTION = 3;
const IX_REDEEMER_DEST = 9;
const IX_REDEEMER = 12;

/** The tag-77 instruction for one request: identical (keys + data) to `buildExecuteRedemptionIxV22`, without the per-call PDA derivations. */
function buildExit(
  d: MarketDerivation,
  ctx: V22MarketCtx,
  keeper: PublicKey,
  req: LpRedemptionV22,
  acc: { dest: PublicKey; redemption: PublicKey },
  vaultToken: PublicKey,
): TransactionInstruction {
  const lp = ctx.bound && ctx.lpPortfolio ? ctx.lpPortfolio : null;
  let t = d.tmpl;
  if (!t || t.domain !== ctx.registryDomain || !t.keeper.equals(keeper) || (t.lp === null) !== (lp === null) || (lp !== null && !t.lp!.equals(lp))) {
    const ix = buildExecuteRedemptionIxV22(ctx.sdk, keeper, req.redeemer, acc.dest, vaultToken, ctx.registryDomain, {
      minPayoutAtoms: req.minPayoutAtoms,
      redeemerSigns: false,
      ...(lp ? { boundLpPortfolio: lp } : {}),
    });
    d.tmpl = { keeper, domain: ctx.registryDomain, lp, ix };
    return ix;
  }
  const keys = t.ix.keys.map((k) => ({ ...k }));
  keys[IX_REDEMPTION] = { ...keys[IX_REDEMPTION], pubkey: acc.redemption };
  keys[IX_REDEEMER_DEST] = { ...keys[IX_REDEEMER_DEST], pubkey: acc.dest };
  keys[IX_REDEEMER] = { ...keys[IX_REDEEMER], pubkey: req.redeemer };
  const data = Buffer.from(encodeExecuteRedemptionV22({ domain: ctx.registryDomain, minPayoutAtoms: req.minPayoutAtoms, nRefresh: 0 }));
  return new TransactionInstruction({ programId: t.ix.programId, keys, data });
}

/** Test hook. */
export const _clearEarnExitMemo = (): void => derivations.clear();

export async function fetchRedemptionRequests(conn: Pick<Connection, "getProgramAccounts">, ctx: V22MarketCtx) {
  const [, extended] = redemptionDataSizesV22();
  const registry = marketDerivation(ctx).registry;
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
  const d = marketDerivation(ctx);
  const registry = d.registry;
  const now = BigInt(ctx.readSlot);
  const seen = new Map<PublicKey, string>();
  const b58Of = (pk: PublicKey): string => {
    let v = seen.get(pk);
    if (v === undefined) seen.set(pk, (v = pk.toBase58()));
    return v;
  };
  const todo = selectKeeperRequests(requests, registry, (pk) => (st.cooldownUntil.get(b58Of(pk)) ?? 0n) > now).slice(0, maxPerTick);
  const { mint, vaultToken } = marketVault(d, ctx.data);
  const outcomes: Array<{ redemption: string; outcome: ExecOutcome }> = [];
  for (const { pubkey, req } of todo) {
    const b58 = b58Of(pubkey);
    const acc = redeemerAccounts(d, req.redeemer, req.redeemer.toBase58(), mint);
    const ix = buildExit(d, ctx, exec.keeper.publicKey, req, acc, vaultToken);
    const outcome = await simulateAndSend(exec, [ix], { job: "earn-exit-77", label: `${ctx.label} ${b58.slice(0, 6)}`, units: EARN_EXIT_UNITS, expected: EARN_EXIT_EXPECTED });
    outcomes.push({ redemption: b58, outcome });
    // Rotate past a request the program refused (117 floor unreachable, 118, anything else) instead of re-trying it every tick.
    if (outcome.kind !== "sent" && outcome.kind !== "dry-run") st.cooldownUntil.set(b58, now + EARN_EXIT_COOLDOWN_SLOTS);
  }
  return { gate, outcomes };
}
