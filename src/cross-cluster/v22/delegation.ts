/**
 * cross-cluster/v22/delegation.ts
 *
 * Tiny shared switchboard so the legacy cranker / fee job / vault-LP cranker can step aside for the v2.2 layer
 * WITHOUT importing it (and without behaviour change when nothing is installed). All fields default to "do
 * nothing": with the v2.2 flags off nobody installs a delegate and every legacy path is byte-for-byte unchanged.
 */
import type { Connection, Keypair } from "@solana/web3.js";

export interface SweepDelegateArgs {
  conn: Connection;
  keeper: Keypair;
  entry: { marketAddress: string; label: string; lpPortfolio?: string };
  marketData: Uint8Array;
  slot: number;
  dryRun: boolean;
}

/** Returns true when the v2.2 layer handled the market this cycle (the legacy per-market cycle then returns). */
export type SweepDelegate = (a: SweepDelegateArgs) => Promise<boolean>;

const state = {
  sweep: null as SweepDelegate | null,
  bondFeeDelegated: false,
  suppressLoneLpCrank: null as ((marketAddress: string) => boolean) | null,
};

export function setSweepDelegate(d: SweepDelegate | null): void {
  state.sweep = d;
}
export function getSweepDelegate(): SweepDelegate | null {
  return state.sweep;
}
/** True once the v2.2 fee job owns tag 78 on bond-flagged markets (the legacy lp-fee job then skips them). */
export function setBondFeeDelegated(v: boolean): void {
  state.bondFeeDelegated = v;
}
export function bondFeeDelegated(): boolean {
  return state.bondFeeDelegated;
}
export function setLoneLpCrankSuppressor(f: ((marketAddress: string) => boolean) | null): void {
  state.suppressLoneLpCrank = f;
}
export function loneLpCrankSuppressedFor(marketAddress: string): boolean {
  return state.suppressLoneLpCrank ? state.suppressLoneLpCrank(marketAddress) : false;
}
