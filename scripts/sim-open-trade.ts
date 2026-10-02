/**
 * SIMULATION ONLY (never sends): simulate a risk-increasing TradeNoCpi against
 * the CURRENT chain state of each market (no cranks prepended), i.e. what a
 * user opening right now would hit. Custom(21) = loss-stale lock; Custom(49) =
 * below min initial margin (raise the size).
 *
 *   npx tsx scripts/sim-open-trade.ts <market> [<market> ...]
 *
 * Signatures are not verified; the fee payer is a fresh throwaway key unless
 * FEE_PAYER=<pubkey> is set. TRADER=<portfolio> picks the taker.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { ACCOUNTS_TRADE_NOCPI, V17_PORTFOLIO_ACCOUNT_LEN, buildAccountMetas, encodeTradeNoCpi, parsePortfolioV17 } from "@percolatorct/sdk";
import { decodeMarketRefreshState } from "../src/cross-cluster/positioned-refresh.ts";
import { WRAPPER_PROGRAM_ID } from "../src/program-ids.ts";

const conn = new Connection(process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com", "processed");
const ASSET0 = 592 + 758 + 1024;
const payer = process.env.FEE_PAYER ? new PublicKey(process.env.FEE_PAYER) : Keypair.generate().publicKey;
const SIZES = (process.env.TRADE_SIZES_Q ?? "1000000,10000000,100000000,1000000000,10000000000").split(",").map((s) => BigInt(s));

for (const arg of process.argv.slice(2)) {
  const market = new PublicKey(arg);
  const acct = await conn.getAccountInfoAndContext(market, "processed");
  if (!acct.value) { console.log(`${arg}: not found`); continue; }
  const md = acct.value.data;
  const s = decodeMarketRefreshState(md);
  const pfs = (await conn.getProgramAccounts(WRAPPER_PROGRAM_ID, {
    filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }, { memcmp: { offset: 16, bytes: market.toBase58() } }],
  })).map((a) => ({ pubkey: a.pubkey, p: parsePortfolioV17(a.account.data) }));
  const lp = pfs.find((x) => x.p.matcherEnabled);
  const trader = process.env.TRADER
    ? pfs.find((x) => x.pubkey.toBase58() === process.env.TRADER)
    : pfs.filter((x) => !x.p.matcherEnabled && x.p.capital > 0n).sort((a, b) => Number(b.p.capital - a.p.capital))[0];
  if (!lp || !trader) { console.log(`${arg}: no LP or no funded trader`); continue; }
  const leg = trader.p.legs.find((l) => l.active && l.assetIndex === 0);
  const dir = leg && leg.side === 1 ? -1n : 1n;
  const dv = new DataView(md.buffer, md.byteOffset, md.byteLength);
  console.log(`${arg.slice(0, 8)} read@${acct.context.slot} stale=${s.staleLong}L/${s.staleShort}S stored=${s.storedPosLong}L/${s.storedPosShort}S ` +
    `trader=${trader.pubkey.toBase58().slice(0, 8)} capital=${trader.p.capital} leg=${leg ? (leg.side === 1 ? "short" : "long") : "none"} payer=${payer.toBase58().slice(0, 8)}`);
  for (const size of SIZES) {
    const sizeQ = dir * size;
    const ix = new TransactionInstruction({
      programId: WRAPPER_PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_TRADE_NOCPI, { signerA: trader.p.owner, signerB: lp.p.owner, market, accountA: trader.pubkey, accountB: lp.pubkey }),
      data: Buffer.from(encodeTradeNoCpi({
        accountAPortfolioId: trader.p.portfolioId, accountAPositionEpoch: trader.p.matcherPositionEpoch,
        accountBPortfolioId: lp.p.portfolioId, accountBPositionEpoch: lp.p.matcherPositionEpoch,
        assetIndex: 0, marketId: dv.getBigUint64(ASSET0, true), sizeQ,
        execPrice: dv.getBigUint64(ASSET0 + 25, true), feeBps: dv.getBigUint64(16 + 128, true), backingFeeCapBps: 10_000,
      })),
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })).add(ix);
    tx.feePayer = payer;
    tx.recentBlockhash = PublicKey.default.toBase58();
    const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
    const lockLog = (r.value.logs ?? []).filter((l) => /lock|stale|Custom|error/i.test(l)).slice(-2).join(" | ");
    console.log(`  sizeQ=${sizeQ} err=${JSON.stringify(r.value.err)} cu=${r.value.unitsConsumed ?? "?"}${lockLog ? ` logs: ${lockLog.slice(0, 200)}` : ""}`);
    if (!r.value.err || JSON.stringify(r.value.err).includes('"Custom":21')) break;
  }
}
