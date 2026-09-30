/**
 * cross-cluster/market-state.ts
 *
 * Terminal-state decode for a wrapper market account, shared by the push loop,
 * the cranker, the fee jobs and the wind-down (split out of terminal-insurance.ts
 * to keep those modules free of import cycles). Offsets are computed from engine
 * 35ddd692 `MarketGroupV16HeaderAccount` source; see terminal-insurance.ts.
 */
import { V17_MARKET_GROUP_LEN, V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";

const WRAPPER_MAGIC = 0x5045_5243_5631_3600n;
const KIND_MARKET = 1;
const KIND_CLOSED_MARKET = 8;
const H_MODE = 626;
const H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL = 461;
/** `materialized_portfolio_count` u64 @ group+517 (engine 35ddd692 source). Wrapper tag 41 on a Resolved market requires it to be 0. */
const H_MATERIALIZED_PORTFOLIO_COUNT = 517;
/** `resolved_slot` u64 @ group+627 (engine 35ddd692 source): the PDA grace clock. */
const H_RESOLVED_SLOT = 627;
/** `c_tot` u128 @ group+317 (engine 35ddd692 source). Terminal-flat = materialized == 0 && c_tot == 0. */
const H_C_TOT = 317;

/**
 * P3 07a1d0eb: on a BOUND vault, tag 78 also runs on a Resolved market that is
 * TERMINAL-FLAT — materialized_portfolio_count == 0 and c_tot == 0 — and the
 * harvested LP fee leg goes to the senior claim (Earn redeem-lock fix). Pure.
 */
export function isTerminalFlat(s: TerminalState | null): boolean {
  return s !== null && s.kind === "resolved" && s.materializedPortfolios === 0n && s.cTot === 0n;
}
const MODE_RESOLVED = 1;


export type TerminalState =
  | { kind: "live"; budget: bigint; materializedPortfolios: bigint }
  | { kind: "resolved"; budget: bigint; materializedPortfolios: bigint; resolvedSlot: bigint; cTot: bigint }
  | { kind: "closed" };

/** True for a market the engine no longer runs: Resolved, or a CloseSlab tombstone. */
export function isTerminalMarket(d: Uint8Array): boolean {
  const s = decodeTerminalState(d);
  return s !== null && s.kind !== "live";
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}

/** null: not a VERSION-18 wrapper account of kind 1/8, or too short. Never a guess. */
export function decodeTerminalState(d: Uint8Array): TerminalState | null {
  if (d.length < 16) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (v.getBigUint64(0, true) !== WRAPPER_MAGIC || v.getUint16(8, true) !== 18) return null;
  const kind = d[10];
  if (kind === KIND_CLOSED_MARKET) return { kind: "closed" };
  if (kind !== KIND_MARKET) return null;
  const g = V17_MARKET_GROUP_OFF;
  if (d.length < g + V17_MARKET_GROUP_LEN) return null;
  const off = g + H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL;
  const budget = u64(d, off) | (u64(d, off + 8) << 64n);
  const materializedPortfolios = u64(d, g + H_MATERIALIZED_PORTFOLIO_COUNT);
  return d[g + H_MODE] === MODE_RESOLVED
    ? {
        kind: "resolved",
        budget,
        materializedPortfolios,
        resolvedSlot: u64(d, g + H_RESOLVED_SLOT),
        cTot: u64(d, g + H_C_TOT) | (u64(d, g + H_C_TOT + 8) << 64n),
      }
    : { kind: "live", budget, materializedPortfolios };
}


/** Engine market mode byte (0 Live, 1 Resolved, 2 Recovery) of a VERSION-18 kind-1 market; null otherwise. */
export function marketMode(d: Uint8Array): number | null {
  if (d.length < V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (v.getBigUint64(0, true) !== WRAPPER_MAGIC || v.getUint16(8, true) !== 18 || d[10] !== KIND_MARKET) return null;
  return d[V17_MARKET_GROUP_OFF + H_MODE];
}

/**
 * True only for a LIVE market. Recovery (mode 2) is not Live: PushAuthMark and the
 * Live-only fee legs (78 unbound, 87) are refused there with EngineLockActive. The
 * expired-bankrupt-close valve (P3 FINAL 58e379f1, upstream 13b3a8b2) moves a Live
 * market to Recovery on ANY crank, and Recovery's own bounded crank step reaches
 * Resolved — so the crank loop keeps cranking Recovery, everything else skips it.
 * An undecodable account is not reported as Live.
 */
export function isLiveMarket(d: Uint8Array): boolean {
  return marketMode(d) === 0;
}

/**
 * Permissionless stale-resolve window (tag 39, ResolveStalePermissionless). The program
 * (d119eebd `oracle_v16::permissionless_stale_matured`) resolves a LIVE market only when
 *   permissionless_resolve_stale_slots != 0
 *   && now_slot - last_good_oracle_slot >= permissionless_resolve_stale_slots
 * (and now_slot >= the engine clock). `last_good_oracle_slot` is advanced by every
 * accepted mark push (handle_push_ewma_mark), so the window only runs while nobody pushes.
 * WrapperConfigV16 sits at abs 16 (check_header, then read_wrapper_config_from_bytes):
 * permissionless_resolve_stale_slots @16+136, last_good_oracle_slot @16+152 — verified on
 * the live SOL/JUP/PENGU v18 bytes (collateral mint @16+32 = DJ54k4wH…, trade fee 30 bps
 * @16+128, last_good_oracle_slot within ~3k slots of the engine clock).
 */
export const CONFIG_OFF = 16;
export const CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS = 136;
export const CFG_LAST_GOOD_ORACLE_SLOT = 152;

export type StaleResolveWindow =
  | { enabled: false; lastGoodOracleSlot: bigint }
  | { enabled: true; staleSlots: bigint; lastGoodOracleSlot: bigint; remaining: bigint; matured: boolean };

/** Where a v18 LIVE market stands against tag 39 at `chainSlot`; null when not a Live v18 market. */
export function staleResolveWindow(d: Uint8Array, chainSlot: bigint): StaleResolveWindow | null {
  if (!isLiveMarket(d)) return null;
  const staleSlots = u64(d, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
  const lastGoodOracleSlot = u64(d, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  if (staleSlots === 0n) return { enabled: false, lastGoodOracleSlot };
  const elapsed = chainSlot > lastGoodOracleSlot ? chainSlot - lastGoodOracleSlot : 0n;
  const remaining = elapsed >= staleSlots ? 0n : staleSlots - elapsed;
  return { enabled: true, staleSlots, lastGoodOracleSlot, remaining, matured: remaining === 0n };
}
