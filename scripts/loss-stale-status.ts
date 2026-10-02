/**
 * Read-only: print each registry market's loss-stale state and positioned counts.
 *   tsx scripts/loss-stale-status.ts <registry.json>
 * Needs DEVNET_RPC_URL (and WRAPPER_PROGRAM_ID, as the keeper does).
 */
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { decodeMarketRefreshState, isAssetLossStale, selectPositionedPortfolios } from "../src/cross-cluster/positioned-refresh.ts";
import { isTerminalMarket } from "../src/cross-cluster/market-state.ts";
import { WRAPPER_PROGRAM_ID } from "../src/program-ids.ts";

const reg = JSON.parse(readFileSync(process.argv[2] ?? "registry.relaunch.json", "utf8")) as { markets: { label: string; marketAddress: string }[] };
const conn = new Connection(process.env.DEVNET_RPC_URL!, "processed");
const slot = await conn.getSlot("processed");
console.log(`chain slot ${slot}`);
for (const m of reg.markets) {
  const pk = new PublicKey(m.marketAddress);
  const ai = await conn.getAccountInfo(pk, "processed");
  if (!ai) { console.log(`${m.label.padEnd(34)} MISSING`); continue; }
  if (isTerminalMarket(ai.data)) { console.log(`${m.label.padEnd(34)} ${m.marketAddress.slice(0, 8)} terminal`); continue; }
  try {
    const s = decodeMarketRefreshState(ai.data);
    const pf = await conn.getProgramAccounts(WRAPPER_PROGRAM_ID, { filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }, { memcmp: { offset: 16, bytes: pk.toBase58() } }] });
    const pos = selectPositionedPortfolios(pf.map((a) => ({ pubkey: a.pubkey, data: a.account.data })));
    console.log(
      `${m.label.padEnd(34)} ${m.marketAddress.slice(0, 8)} loss_stale_flag=${Number(s.lossStaleActive)} pred=${Number(isAssetLossStale(s))} ` +
        `stale=${s.staleLong}L/${s.staleShort}S stored=${s.storedPosLong}L/${s.storedPosShort}S positionedPf=${pos.length} ` +
        `engLag=${BigInt(slot) - s.currentSlot} slotLastLag=${BigInt(slot) - s.slotLast}`,
    );
  } catch (e) {
    console.log(`${m.label.padEnd(34)} decode failed ${(e as Error).message}`);
  }
}
