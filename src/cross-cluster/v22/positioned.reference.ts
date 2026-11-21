/**
 * FROZEN pre-optimisation copy of analysePortfolios / parseAccrueAnchors (feat/v22-keeper-growth 12b4d5a).
 * Used only by positioned.diff.test.ts as the oracle. Do not edit.
 */
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { riskSnapOf } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { V22Positioned } from "./positioned.ts";

export function analysePortfoliosRef(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  p: {
    assetIndex?: number;
    assetIndices?: ReadonlyArray<number>;
    lpPortfolio: PublicKey | null;
    portfolioLen: number;
    keeperOwner?: PublicKey | null;
    anchorOverride?: PublicKey | null;
  },
): V22Positioned {
  const assetIndex = p.assetIndex ?? 0;
  const onAsset: (a: number) => boolean = p.assetIndices && p.assetIndices.length > 0 ? (a) => p.assetIndices!.includes(a) : (a) => a === assetIndex;
  const all: PositionedPortfolio[] = [];
  const minLegAbs = new Map<string, bigint>();
  let flatAnchor: PublicKey | null = null;
  let overrideAnchor: PublicKey | null = null;
  let overrideSeen = false;
  let overrideWhy: string | null = null;
  let lpData: Uint8Array | null = null;
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
    const isLp = p.lpPortfolio !== null && pubkey.equals(p.lpPortfolio);
    if (isLp) lpData = data;
    let longLegs = 0;
    let shortLegs = 0;
    let lossWeight = 0n;
    let kfLong: bigint | null = null;
    let kfShort: bigint | null = null;
    let anyActive = false;
    let activeLegs = 0;
    let minAbs: bigint | null = null;
    for (const leg of parsed.legs) {
      if (!leg.active) continue;
      anyActive = true;
      activeLegs++;
      if (!onAsset(leg.assetIndex)) continue;
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
    const keeperFlat = !anyActive && !isLp && !parsed.matcherEnabled && !!p.keeperOwner && parsed.owner.equals(p.keeperOwner);
    if (keeperFlat && flatAnchor === null) flatAnchor = pubkey;
    if (p.anchorOverride && pubkey.equals(p.anchorOverride)) {
      overrideSeen = true;
      if (keeperFlat) overrideAnchor = pubkey;
      else overrideWhy = `override ${pubkey.toBase58()} is ${isLp ? "the vault LP" : anyActive ? "not flat" : parsed.matcherEnabled ? "a matcher portfolio" : "not owned by the keeper"}`;
    }
    if (longLegs + shortLegs === 0) continue;
    all.push({ pubkey, longLegs, shortLegs, isLp, activeLegs, lossWeight, kfEpochSnapLong: kfLong, kfEpochSnapShort: kfShort, risk: riskSnapOf(parsed) });
    if (minAbs !== null) minLegAbs.set(pubkey.toBase58(), minAbs);
  }
  let lp: PositionedPortfolio | null = all.find((x) => x.isLp) ?? null;
  if (!lp && p.lpPortfolio) lp = { pubkey: p.lpPortfolio, longLegs: 0, shortLegs: 0, isLp: true, lossWeight: 0n };
  if (p.anchorOverride && !overrideSeen) overrideWhy = `override ${p.anchorOverride.toBase58()} is not a decodable portfolio of this market`;
  return { all, counterparties: all.filter((x) => !x.isLp), lp, minLegAbs, flatAnchor: overrideAnchor ?? flatAnchor, lpData, anchorOverrideRejected: overrideWhy, undecodable };
}

export function parseAccrueAnchorsRef(raw: string | undefined): Map<string, PublicKey> {
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
