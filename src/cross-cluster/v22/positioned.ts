/**
 * cross-cluster/v22/positioned.ts
 *
 * Positioned-portfolio discovery for a v2.2 market (10,603 B portfolios, parsed by the SDK's VERSION-keyed
 * `parsePortfolioV17`): the positioned set with leg counts (for the 3 + legs weight), the LP, the smallest leg per
 * portfolio (dust candidates), and an optional FLAT anchor portfolio (accrue-only crank target).
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { fetchMarketPortfolios } from "../recovery-cranker.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { V22MarketCtx } from "./market.ts";

export interface V22Positioned {
  /** Every positioned portfolio of the asset (LP included, flagged `isLp`). */
  all: PositionedPortfolio[];
  /** Non-LP positioned portfolios. */
  counterparties: PositionedPortfolio[];
  lp: PositionedPortfolio | null;
  /** Smallest |basis_pos_q| among a portfolio's active legs on the asset, by base58 key. */
  minLegAbs: Map<string, bigint>;
  /** A zero-leg, non-LP portfolio of the market (accrue-only target), or null. */
  flatAnchor: PublicKey | null;
  /** Accounts that did not decode (counted, never guessed). */
  undecodable: number;
}

export function analysePortfolios(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  p: { assetIndex?: number; lpPortfolio: PublicKey | null; portfolioLen: number },
): V22Positioned {
  const assetIndex = p.assetIndex ?? 0;
  const all: PositionedPortfolio[] = [];
  const minLegAbs = new Map<string, bigint>();
  let flatAnchor: PublicKey | null = null;
  let undecodable = 0;
  for (const { pubkey, data } of accounts) {
    if (data.length !== p.portfolioLen) continue;
    let parsed;
    try {
      parsed = parsePortfolioV17(data);
    } catch {
      undecodable++;
      continue;
    }
    const isLp = (p.lpPortfolio !== null && pubkey.equals(p.lpPortfolio)) || parsed.matcherEnabled === true;
    let longLegs = 0;
    let shortLegs = 0;
    let lossWeight = 0n;
    let kfLong: bigint | null = null;
    let kfShort: bigint | null = null;
    let anyActive = false;
    let minAbs: bigint | null = null;
    for (const leg of parsed.legs) {
      if (!leg.active) continue;
      anyActive = true;
      if (leg.assetIndex !== assetIndex) continue;
      lossWeight += leg.lossWeight;
      const abs = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
      if (minAbs === null || abs < minAbs) minAbs = abs;
      if (leg.side === 0) {
        longLegs++;
        kfLong = kfLong === null || leg.kfEpochSnap < kfLong ? leg.kfEpochSnap : kfLong;
      } else {
        shortLegs++;
        kfShort = kfShort === null || leg.kfEpochSnap < kfShort ? leg.kfEpochSnap : kfShort;
      }
    }
    if (!anyActive && !isLp && flatAnchor === null) flatAnchor = pubkey;
    if (longLegs + shortLegs === 0) continue;
    all.push({ pubkey, longLegs, shortLegs, isLp, lossWeight, kfEpochSnapLong: kfLong, kfEpochSnapShort: kfShort });
    if (minAbs !== null) minLegAbs.set(pubkey.toBase58(), minAbs);
  }
  const lp = all.find((x) => x.isLp) ?? null;
  return { all, counterparties: all.filter((x) => !x.isLp), lp, minLegAbs, flatAnchor, undecodable };
}

/** One read: every portfolio of the market at the layout's length. Never throws (returns null). */
export async function loadV22Positioned(
  conn: Connection,
  ctx: V22MarketCtx,
  anchorOverride: PublicKey | null = null,
): Promise<V22Positioned | null> {
  try {
    const accts = await fetchMarketPortfolios(conn, ctx.market, ctx.layout.portfolioAccountLen);
    const r = analysePortfolios(
      accts.map((a) => ({ pubkey: a.pubkey, data: a.account.data })),
      { lpPortfolio: ctx.lpPortfolio, portfolioLen: ctx.layout.portfolioAccountLen },
    );
    if (anchorOverride) r.flatAnchor = anchorOverride;
    return r;
  } catch (err) {
    console.warn(`[v22] ${ctx.label}: positioned-portfolio discovery failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    return null;
  }
}

/** KEEPER_V22_ACCRUE_ANCHORS="market:portfolio,market:portfolio". Malformed pairs are ignored. */
export function parseAccrueAnchors(raw: string | undefined): Map<string, PublicKey> {
  const out = new Map<string, PublicKey>();
  for (const part of (raw ?? "").split(",")) {
    const [m, a] = part.trim().split(":");
    if (!m || !a) continue;
    try {
      out.set(new PublicKey(m).toBase58(), new PublicKey(a));
    } catch {
      // ignore
    }
  }
  return out;
}
