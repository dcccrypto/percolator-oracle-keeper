import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_V22 } from "@percolatorct/sdk";
import { analysePortfolios, parseAccrueAnchors } from "./positioned.ts";
import { key, portfolioBytes } from "./test-helpers.ts";
import { portfolioWeight } from "./settle-pairing.ts";

const LEN = LAYOUT_V22.portfolio.accountLen;
const keeper = key(500);
const base = { portfolioLen: LEN, lpPortfolio: null };

test("lead 1: wrong-length account is skipped, NOT counted undecodable (unreachable: RPC filters dataSize)", () => {
  const r = analysePortfolios([{ pubkey: key(1), data: new Uint8Array(LEN - 1) }], base);
  assert.equal(r.undecodable, 0);
  assert.equal(r.all.length, 0);
  // right length but garbage: counted
  const g = analysePortfolios([{ pubkey: key(2), data: new Uint8Array(LEN) }], base);
  assert.equal(g.undecodable, 1);
});

test("lead 2: LP with legs only on other assets keeps activeLegs / risk and is heavy (solo)", () => {
  const lpKey = key(901);
  const data = portfolioBytes({ owner: key(9), capital: 5n, legs: [1, 2, 3].map((a) => ({ side: 0 as const, basis: 10n, assetIndex: a })) });
  const r = analysePortfolios([{ pubkey: lpKey, data }], { ...base, lpPortfolio: lpKey, assetIndex: 0 });
  assert.equal(r.all.length, 0);
  assert.ok(r.lp);
  assert.equal(r.lp!.activeLegs, 3);
  assert.equal(r.lp!.risk?.legs.length, 3);
  assert.equal(r.lp!.longLegs + r.lp!.shortLegs, 0);
  assert.ok(portfolioWeight(r.lp!) > 100, "3-leg LP must weigh as solo");
});

test("lead 2b: LP absent from the scan stays a bare synthetic LP", () => {
  const r = analysePortfolios([], { ...base, lpPortfolio: key(901) });
  assert.equal(r.lp?.activeLegs, undefined);
});

test("lead 3: override on a keeper-flat portfolio wins; non-flat / absent overrides are rejected with a reason", () => {
  const flat = key(10);
  const flatData = portfolioBytes({ owner: keeper });
  const ok = analysePortfolios([{ pubkey: flat, data: flatData }], { ...base, keeperOwner: keeper, anchorOverride: flat });
  assert.ok(ok.flatAnchor?.equals(flat));
  assert.equal(ok.anchorOverrideRejected, null);

  const busy = key(11);
  const busyData = portfolioBytes({ owner: keeper, legs: [{ side: 0, basis: 1n }] });
  const bad = analysePortfolios([{ pubkey: busy, data: busyData }, { pubkey: flat, data: flatData }], { ...base, keeperOwner: keeper, anchorOverride: busy });
  assert.match(bad.anchorOverrideRejected!, /not flat/);
  assert.ok(bad.flatAnchor?.equals(flat), "discovery survives a rejected override");

  const notOwned = analysePortfolios([{ pubkey: flat, data: portfolioBytes({ owner: key(77) }) }], { ...base, keeperOwner: keeper, anchorOverride: flat });
  assert.match(notOwned.anchorOverrideRejected!, /not owned by the keeper/);

  // an override naming a portfolio of another market is absent from the market-filtered scan: message is accurate
  const other = analysePortfolios([{ pubkey: flat, data: flatData }], { ...base, keeperOwner: keeper, anchorOverride: key(12) });
  assert.match(other.anchorOverrideRejected!, /not a decodable portfolio of this market/);
});

test("lead 4: parseAccrueAnchors ignores 'm:a:extra'; duplicate market: last wins", () => {
  const m = key(1).toBase58();
  const a = key(2).toBase58();
  const b = key(3).toBase58();
  assert.equal(parseAccrueAnchors(`${m}:${a}:extra`).size, 0);
  assert.equal(parseAccrueAnchors(`${m}:${a}`).get(m)?.toBase58(), a);
  assert.equal(parseAccrueAnchors(`${m}:${a}, ${m}:${b}`).get(m)?.toBase58(), b);
  assert.equal(parseAccrueAnchors("garbage,:,x:y").size, 0);
  assert.equal(parseAccrueAnchors(undefined).size, 0);
});

test("loadV22Positioned: decodes via getProgramAccounts, warns on rejected override, returns null on RPC failure", async () => {
  const { loadV22Positioned } = await import("./positioned.ts");
  const m = key(300);
  const ctx = { market: m, marketAddress: m.toBase58(), label: "T", lpPortfolio: null, layout: { portfolioAccountLen: LEN } } as never;
  const good = { getProgramAccounts: async () => [{ pubkey: key(1), account: { data: Buffer.from(portfolioBytes({ owner: key(2), legs: [{ side: 1, basis: -5n }] })) } }] } as never;
  const warn = console.warn;
  const msgs: string[] = [];
  console.warn = (s: string) => void msgs.push(s);
  try {
    const r = await loadV22Positioned(good, ctx, key(99), keeper);
    assert.equal(r?.all.length, 1);
    assert.equal(r?.all[0].shortLegs, 1);
    assert.ok(msgs.some((s) => /ignored/.test(s)));
    const bad = await loadV22Positioned({ getProgramAccounts: async () => { throw new Error("rpc down"); } } as never, ctx);
    assert.equal(bad, null);
    assert.ok(msgs.some((s) => /discovery failed/.test(s)));
  } finally {
    console.warn = warn;
  }
});

test("assetIndices: a leg on any observed asset positions the portfolio; minLegAbs and kf tracked", () => {
  const data = portfolioBytes({ owner: key(2), legs: [{ side: 0, basis: 7n, assetIndex: 1 }, { side: 1, basis: -3n, assetIndex: 2 }, { side: 0, basis: 9n, assetIndex: 5 }] });
  const r = analysePortfolios([{ pubkey: key(4), data }], { ...base, assetIndices: [1, 2] });
  assert.equal(r.all[0].longLegs, 1);
  assert.equal(r.all[0].shortLegs, 1);
  assert.equal(r.all[0].activeLegs, 3);
  assert.equal(r.minLegAbs.get(key(4).toBase58()), 3n);
});
