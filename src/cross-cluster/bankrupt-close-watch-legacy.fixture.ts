// Frozen copy of makeSharedCloseScan BEFORE the raw-bytes bucketing change. Used only by the
// differential test and scripts/bench-close-scan.ts as the reference implementation.
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { CLOSE_LAYOUT_V21, CLOSE_PROGRESS_LEN } from "./bankrupt-close-watch.ts";
import type { ClosePortfolioLayout } from "./bankrupt-close-watch.ts";

const PORTFOLIO_MARKET_OFF = 16;

export function makeLegacySharedCloseScan(ttlMs = 90_000, now: () => number = Date.now) {
  type Snapshot = { at: number; byMarket: Map<string, Array<{ pubkey: PublicKey; data: Uint8Array }>> };
  const cachedBy = new Map<number, Snapshot>();
  return {
    async forMarket(
      conn: Pick<Connection, "getProgramAccounts">,
      programId: PublicKey,
      market: PublicKey,
      layout: ClosePortfolioLayout = CLOSE_LAYOUT_V21,
    ): Promise<Array<{ pubkey: PublicKey; account: { data: Uint8Array } }>> {
      const sliceLen = layout.closeOff + CLOSE_PROGRESS_LEN - PORTFOLIO_MARKET_OFF;
      const cachedNow = cachedBy.get(layout.accountLen);
      if (!cachedNow || now() - cachedNow.at > ttlMs) {
        const accs = await conn.getProgramAccounts(programId, {
          dataSlice: { offset: PORTFOLIO_MARKET_OFF, length: sliceLen },
          filters: [{ dataSize: layout.accountLen }, { memcmp: { offset: layout.closeOff, bytes: "2" } }],
        });
        const byMarket = new Map<string, Array<{ pubkey: PublicKey; data: Uint8Array }>>();
        for (const a of accs) {
          const d = new Uint8Array(a.account.data);
          const key = new PublicKey(d.subarray(0, 32)).toBase58();
          const list = byMarket.get(key) ?? [];
          list.push({ pubkey: a.pubkey, data: d.subarray(layout.closeOff - PORTFOLIO_MARKET_OFF) });
          byMarket.set(key, list);
        }
        cachedBy.set(layout.accountLen, { at: now(), byMarket });
      }
      return (cachedBy.get(layout.accountLen)?.byMarket.get(market.toBase58()) ?? []).map((x) => ({ pubkey: x.pubkey, account: { data: x.data } }));
    },
  };
}
