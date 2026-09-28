/**
 * SIMULATION ONLY (never sends): build the cranker's per-market transaction
 * against live devnet, simulate it, and report whether the market ends
 * loss-stale. Then simulate a risk-increasing TradeNoCpi behind the same
 * cranks (and, as a control, behind the accrual crank alone).
 *
 *   npx tsx scripts/sim-crank-refresh.ts <market> [<market> ...]
 *
 * RPC: $DEVNET_RPC_URL or https://api.devnet.solana.com.
 * Fee payer / crank owner: $CRANK_OWNER (pubkey only; sigVerify is off).
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ACCOUNTS_TRADE_NOCPI,
  PROGRAM_IDS_V17,
  V17_PORTFOLIO_ACCOUNT_LEN,
  buildAccountMetas,
  encodeTradeNoCpi,
  parsePortfolioV17,
} from "@percolatorct/sdk";
import {
  catchupCrankCount,
  decodeMarketRefreshState,
  isAssetLossStale,
  marketHasPositions,
  planCrankTx,
  selectPositionedPortfolios,
} from "../src/cross-cluster/positioned-refresh.ts";
import type { CrankPlan, MarketRefreshState } from "../src/cross-cluster/positioned-refresh.ts";
import { resolveCrankPlan } from "../src/cross-cluster/recovery-cranker.ts";
import type { SimOutcome } from "../src/cross-cluster/recovery-cranker.ts";

const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const OWNER = new PublicKey(process.env.CRANK_OWNER ?? "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");
const WRAPPER = new PublicKey(PROGRAM_IDS_V17.percolator);
const ASSET0 = 592 + 758 + 1024;
const TRADE_SIZE_Q = BigInt(process.env.TRADE_SIZE_Q ?? "1000000");

const fmt = (s: MarketRefreshState | null): string =>
  s
    ? `loss_stale_active=${Number(s.lossStaleActive)} predicate=${isAssetLossStale(s)} stale=${s.staleLong}L/${s.staleShort}S ` +
      `stored=${s.storedPosLong}L/${s.storedPosShort}S slot_last=${s.slotLast} current_slot=${s.currentSlot}`
    : "(no post-state)";

async function simulate(conn: Connection, market: PublicKey, ixs: TransactionInstruction[], cu: number): Promise<SimOutcome & { units?: number }> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = OWNER;
  tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
  const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
    accounts: { encoding: "base64", addresses: [market.toBase58()] },
  });
  const acc = r.value.accounts?.[0];
  return {
    err: r.value.err,
    logs: r.value.logs ?? null,
    marketData: acc ? Buffer.from(acc.data[0], "base64") : null,
    units: r.value.unitsConsumed,
  };
}

async function run(conn: Connection, market: PublicKey): Promise<void> {
  const acct = await conn.getAccountInfoAndContext(market, "processed");
  if (!acct.value) throw new Error("market not found");
  const pre = decodeMarketRefreshState(acct.value.data);
  const gap = BigInt(acct.context.slot) - pre.slotLast;
  const catchup = catchupCrankCount(gap, pre.maxAccrualDtSlots);
  console.log(`\n=== ${market.toBase58()}  read@${acct.context.slot} gap=${gap} max_accrual_dt=${pre.maxAccrualDtSlots} catchup=${catchup}`);
  console.log(`pre : ${fmt(pre)}`);

  const accounts = await conn.getProgramAccounts(WRAPPER, {
    filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }, { memcmp: { offset: 16, bytes: market.toBase58() } }],
  });
  const parsed = accounts.map((a) => ({ pubkey: a.pubkey, data: a.account.data, p: parsePortfolioV17(a.account.data) }));
  const lp = parsed.find((x) => x.p.matcherEnabled);
  if (!lp) throw new Error("no LP portfolio");
  const positioned = marketHasPositions(pre) ? selectPositionedPortfolios(parsed) : [];
  console.log(`LP ${lp.pubkey.toBase58()}  positioned: ${positioned.map((p) => `${p.pubkey.toBase58()}${p.isLp ? "(LP)" : ""}`).join(", ") || "none"}`);

  const build = (t: Parameters<typeof planCrankTx>[0]["refreshTargets"]): CrankPlan =>
    planCrankTx({ owner: OWNER, market, lpPortfolio: lp.pubkey, catchup, refreshTargets: t });
  const resolved = await resolveCrankPlan(build, positioned, (plan) =>
    simulate(conn, market, plan.cranks.map((c) => c.ix), plan.computeUnits),
  );
  const post = resolved.sim.marketData ? decodeMarketRefreshState(resolved.sim.marketData) : null;
  console.log(
    `plan: ${resolved.plan.cranks.map((c) => `${c.kind}:${c.portfolio.toBase58().slice(0, 8)}`).join(" -> ")}` +
      `  pruned=[${resolved.pruned.map((p) => `${p.pubkey.toBase58().slice(0, 8)}:${p.code}`).join(",")}]`,
  );
  console.log(`crank sim err=${JSON.stringify(resolved.sim.err)}`);
  console.log(`post: ${fmt(post)}`);

  // Risk-increasing trade by a funded portfolio that holds NO position (a new
  // user opening), against the LP. A stale portfolio trading for itself is
  // refreshed by the trade and is not the failing case; an unrelated taker is.
  // TRADER=<pubkey> overrides.
  const trader = process.env.TRADER
    ? parsed.find((x) => x.pubkey.toBase58() === process.env.TRADER)
    : parsed.find((x) => !x.p.matcherEnabled && x.p.capital > 0n && !x.p.legs.some((l) => l.active)) ??
      parsed.find((x) => !x.p.matcherEnabled && x.p.capital > 0n);
  if (!resolved.plan.cranks.some((c) => c.kind === "accrue")) {
    console.log("trade: skipped (catch-up-only cycle; the market is still behind)");
    return;
  }
  if (!trader || !resolved.sim.marketData) {
    console.log("trade: skipped (no funded trader or no post-state)");
    return;
  }
  const leg = trader.p.legs.find((l) => l.active && l.assetIndex === 0);
  const sizeQ = leg && leg.side === 1 ? -TRADE_SIZE_Q : TRADE_SIZE_Q;
  const md = resolved.sim.marketData;
  const dv = new DataView(md.buffer, md.byteOffset, md.byteLength);
  const tradeIx = new TransactionInstruction({
    programId: WRAPPER,
    keys: buildAccountMetas(ACCOUNTS_TRADE_NOCPI, {
      signerA: trader.p.owner, signerB: lp.p.owner, market, accountA: trader.pubkey, accountB: lp.pubkey,
    }),
    data: Buffer.from(encodeTradeNoCpi({
      accountAPortfolioId: trader.p.portfolioId,
      accountAPositionEpoch: trader.p.matcherPositionEpoch,
      accountBPortfolioId: lp.p.portfolioId,
      accountBPositionEpoch: lp.p.matcherPositionEpoch,
      assetIndex: 0,
      marketId: dv.getBigUint64(ASSET0, true),
      sizeQ,
      execPrice: dv.getBigUint64(ASSET0 + 25, true), // post-accrual effective price
      feeBps: dv.getBigUint64(16 + 128, true),
      backingFeeCapBps: 10_000,
    })),
  });
  const withRefresh = await simulate(conn, market, [...resolved.plan.cranks.map((c) => c.ix), tradeIx], 1_400_000);
  console.log(`trade after accrue+refresh (trader ${trader.pubkey.toBase58().slice(0, 8)} sizeQ=${sizeQ}): err=${JSON.stringify(withRefresh.err)} cu=${withRefresh.units}`);
  const accrueOnly = resolved.plan.cranks.filter((c) => c.kind !== "refresh").map((c) => c.ix);
  const accrueOnlyState = await simulate(conn, market, accrueOnly, 1_400_000);
  const aPost = accrueOnlyState.marketData ? decodeMarketRefreshState(accrueOnlyState.marketData) : null;
  console.log(`CONTROL accrue only (old keeper) -> ${fmt(aPost)} kf_epoch=${aPost?.kfEpochLong}/${aPost?.kfEpochShort} (pre ${pre.kfEpochLong}/${pre.kfEpochShort})`);
  const control = await simulate(conn, market, [...accrueOnly, tradeIx], 1_400_000);
  console.log(`CONTROL trade after accrue only (old keeper): err=${JSON.stringify(control.err)}`);
}

const conn = new Connection(RPC, "processed");
for (const m of process.argv.slice(2)) {
  try {
    await run(conn, new PublicKey(m));
  } catch (err) {
    console.log(`=== ${m}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
