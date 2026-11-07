/**
 * Observe-only DLMM depth (bigtest 2026-11 Medium #6), behind KEEPER_DEPTH_OBSERVE_DLMM (default OFF).
 *
 * When ON, the keeper reads the needed bin arrays for meteora-dlmm markets (throttled) and exposes the +-2% depth in
 * /health as `dlmmDepthObserved`. It NEVER feeds resolvePushDepth or any PushAuthMark byte. When OFF nothing here runs:
 * no RPC call, no state, no /health key.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { parseFlag } from "./v22/flags.ts";
import { DLMM_PROGRAM_ID, binArrayAddress, computeDlmmDepth, planDlmmBinArrays } from "./dlmm-depth.ts";

export function dlmmDepthObserveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(env, "KEEPER_DEPTH_OBSERVE_DLMM", false);
}

export type DlmmDepthObservation =
  | { bidUsdE6: string; askUsdE6: string; minUsdE6: string; binArrays: number[]; at: number }
  | { error: string; at: number };

type Conn = Pick<Connection, "getMultipleAccountsInfo">;

/** One observation: 1 read for the pool, then 1 read of [pool, ...bin arrays] (the pool again so the arrays and the active bin share a slot). */
export async function observeDlmmDepth(
  conn: Conn,
  poolAddress: string,
  decimals: { base: number; quote: number } | undefined,
  solPriceE6: bigint | undefined,
  now: number,
): Promise<DlmmDepthObservation> {
  try {
    const pool = new PublicKey(poolAddress);
    const [first] = await conn.getMultipleAccountsInfo([pool]);
    if (!first || !first.owner.equals(DLMM_PROGRAM_ID)) return { error: "pool account missing or not owned by the DLMM program", at: now };
    const plan = planDlmmBinArrays(new Uint8Array(first.data));
    if (!plan.ok) return { error: plan.reason, at: now };
    const keys = plan.indexes.map((i) => binArrayAddress(pool, i));
    const infos = await conn.getMultipleAccountsInfo([pool, ...keys]);
    const again = infos[0];
    if (!again || !again.owner.equals(DLMM_PROGRAM_ID)) return { error: "pool account missing on the second read", at: now };
    const poolData = new Uint8Array(again.data);
    const plan2 = planDlmmBinArrays(poolData);
    if (!plan2.ok) return { error: plan2.reason, at: now };
    const bins = new Map<number, Uint8Array | null>();
    plan.indexes.forEach((idx, k) => {
      const a = infos[k + 1];
      bins.set(idx, a && a.owner.equals(DLMM_PROGRAM_ID) ? new Uint8Array(a.data) : null);
    });
    if (plan2.indexes.some((i) => !bins.has(i))) return { error: "active bin moved between reads; retry next interval", at: now };
    const r = computeDlmmDepth({ lbPair: pool, poolData, binArrays: bins, decimals, solPriceE6 });
    if (!r.ok) return { error: r.reason, at: now };
    const d = r.depth;
    return { bidUsdE6: d.bidUsdE6.toString(), askUsdE6: d.askUsdE6.toString(), minUsdE6: d.minUsdE6.toString(), binArrays: d.binArrays, at: now };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).slice(0, 160), at: now };
  }
}

export const DLMM_OBSERVE_INTERVAL_MS = 60_000;

/** Per-market observations, throttled per pool; fire-and-forget safe (never throws, one in flight per key). */
export class DlmmDepthObserver {
  private readonly obs = new Map<string, DlmmDepthObservation>();
  private readonly lastStart = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly intervalMs: number = DLMM_OBSERVE_INTERVAL_MS) {}

  get(key: string): DlmmDepthObservation | undefined {
    return this.obs.get(key);
  }

  async observe(
    conn: Conn,
    units: ReadonlyArray<{ key: string; dexType: string; source: string; poolAddress: string }>,
    decimalsOf: (pool: string) => { base: number; quote: number } | undefined,
    solPriceE6: bigint | undefined,
    now: number,
  ): Promise<void> {
    for (const u of units) {
      if (u.dexType !== "meteora-dlmm" || u.source !== "pool") continue;
      if (this.inFlight.has(u.key)) continue;
      const last = this.lastStart.get(u.key);
      if (last !== undefined && now - last < this.intervalMs) continue;
      this.lastStart.set(u.key, now);
      this.inFlight.add(u.key);
      try {
        this.obs.set(u.key, await observeDlmmDepth(conn, u.poolAddress, decimalsOf(u.poolAddress), solPriceE6, now));
      } finally {
        this.inFlight.delete(u.key);
      }
    }
  }
}

/** The process-wide observer. Only ever populated when the flag is ON. */
export const dlmmDepthObserver = new DlmmDepthObserver();

/**
 * The keeper-loop entry point. Flag OFF: returns before touching the connection (zero RPC, zero state). Flag ON: starts the
 * observation WITHOUT awaiting it (the push cycle's timing is untouched) and swallows every error.
 */
export function startDlmmDepthObservation(
  enabled: boolean,
  observer: DlmmDepthObserver,
  conn: Conn,
  units: ReadonlyArray<{ key: string; dexType: string; source: string; poolAddress: string }>,
  decimalsOf: (pool: string) => { base: number; quote: number } | undefined,
  solPriceE6: bigint | undefined,
  now: number,
): void {
  if (!enabled) return;
  observer.observe(conn, units, decimalsOf, solPriceE6, now).catch((err) => {
    console.warn(`[dlmm-depth] observe failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
  });
}
