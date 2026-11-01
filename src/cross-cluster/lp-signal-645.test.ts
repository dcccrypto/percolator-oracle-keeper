/**
 * prog #645 (upstream 0c5d4f4f + 0b838425, rc23 2b5dce8a): any non-trade instruction that changes a portfolio's legs
 * bumps its position epoch and CLEARS the matcher capability (ENABLED bit + expiry) of a matcher that is not the
 * canonical position-synced one. The v18 LPs below use matcher 4seJWjv3…, which is not the rc23 canonical matcher
 * (AsHvEJ8z…), so on rc23 their ENABLED bit goes to 0 after e.g. the keeper's own refresh clears a side-reset leg.
 *
 * Before this fix the cranker read "is the LP" from that bit: a cleared LP was then ordered among the traders, and
 * when underwater it was flagged bankrupt and planned a liquidate crank (the LP is excluded from both on purpose), and
 * the `vault_lp` state check refused the PDA-named LP. These tests clear the bit on REAL LP bytes.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/lp-signal-645.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { isBankruptPortfolio, planCrankTx, portfolioIsLp, selectPositionedPortfolios } from "./positioned-refresh.ts";
import { findLpPortfolio, isMatcherConfiguredPortfolio, lpIdentityOf } from "./recovery-cranker.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { selectLegHolders } from "./p2b-wind-down.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");

const CATE = new PublicKey("CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE");
const CATE_LP = new PublicKey("JAbvCce1twNVzpeLGMkgzdE2TqbRPz2oHeod9kaMFsum");
const CATE_TRADER = new PublicKey("6c7hV3Km5hDkNSrqn3ievcShwkg8fB9agZy8PnVfHVFG");

/** `PortfolioMatcherConfigV16.control` sits 32 bytes before the end (control u64, then the 24-byte identity trailer). */
const controlOff = (d: Uint8Array): number => d.length - 32;
/** What #645's `invalidate_unsynchronized_matcher_capability` / epoch bump does: ENABLED bit off, expiry 0. */
function cleared(src: Buffer): Buffer {
  const b = Buffer.from(src);
  const c = b.readBigUInt64LE(controlOff(b));
  b.writeBigUInt64LE(c & ~1n, controlOff(b));
  b.writeBigUInt64LE(0n, b.length - 8); // matcher_expiry_slot
  return b;
}
/** An underwater portfolio that is an LP on a non-canonical matcher whose capability was cleared. */
function underwaterClearedLp(): Buffer {
  const b = Buffer.from(fixture("ansem-bankrupt-portfolio-v18"));
  const lp = fixture("ansem-lp-portfolio-v18");
  const cfg = lp.length - 128; // matcher program | context | delegate | control, then the trailer
  lp.copy(b, cfg, cfg, cfg + 96); // program + context + delegate from the real LP
  b.writeBigUInt64LE(lp.readBigUInt64LE(controlOff(lp)) & ~1n, controlOff(b)); // control, ENABLED cleared
  return b;
}

describe("fixture sanity", () => {
  it("cleared() really clears ENABLED and keeps the configured matcher", () => {
    const real = parsePortfolioV17(new Uint8Array(fixture("cate-lp-portfolio-v18")));
    const c = parsePortfolioV17(new Uint8Array(cleared(fixture("cate-lp-portfolio-v18"))));
    assert.equal(real.matcherEnabled, true);
    assert.equal(c.matcherEnabled, false);
    assert.equal(c.matcherProgram.toBase58(), real.matcherProgram.toBase58());
    assert.equal(c.matcherPositionEpoch, real.matcherPositionEpoch);
    assert.equal(c.matcherProgram.toBase58(), "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT");
    const u = parsePortfolioV17(new Uint8Array(underwaterClearedLp()));
    assert.equal(u.matcherEnabled, false);
    assert.ok(u.capital + u.pnl <= 0n && u.activeBitmap !== 0n);
  });
});

describe("#645: a cleared LP is still the LP", () => {
  const portfolios = () => [
    { pubkey: CATE_LP, data: cleared(fixture("cate-lp-portfolio-v18")) },
    { pubkey: CATE_TRADER, data: fixture("cate-trader-portfolio-v18") },
  ];
  it("selectPositionedPortfolios: by identity, and by the configured-matcher fallback", () => {
    for (const lpKey of [CATE_LP, undefined]) {
      const set = selectPositionedPortfolios(portfolios(), 0, lpKey);
      assert.deepEqual(set.map((p) => [p.pubkey.toBase58(), p.isLp]), [[CATE_LP.toBase58(), true], [CATE_TRADER.toBase58(), false]], String(lpKey));
    }
  });
  it("identity wins over the bit: a matcher-enabled stranger is not the LP when the LP key is known (F-4)", () => {
    const set = selectPositionedPortfolios([{ pubkey: CATE_TRADER, data: fixture("cate-lp-portfolio-v18") }], 0, CATE_LP);
    assert.equal(set[0].isLp, false);
  });
  it("planCrankTx keeps the LP last and never plans a liquidate crank on it", () => {
    const targets = selectPositionedPortfolios(portfolios(), 0, CATE_LP);
    const plan = planCrankTx({ owner: PublicKey.unique(), market: CATE, lpPortfolio: CATE_LP, catchup: 0, refreshTargets: targets, liquidateTargets: [CATE_LP] });
    assert.deepEqual(plan.cranks.map((c) => [c.kind, c.portfolio.toBase58()]), [
      ["accrue", CATE_LP.toBase58()], ["refresh", CATE_TRADER.toBase58()], ["refresh", CATE_LP.toBase58()],
    ]);
  });
  it("isBankruptPortfolio: an underwater cleared LP is not a liquidation target; the identity verdict decides when given", () => {
    const d = underwaterClearedLp();
    assert.equal(isBankruptPortfolio(d), false, "fallback: configured matcher = LP");
    assert.equal(isBankruptPortfolio(d, true), false);
    assert.equal(isBankruptPortfolio(d, false), true, "a known non-LP is judged on its equity");
    assert.equal(isBankruptPortfolio(fixture("ansem-bankrupt-portfolio-v18")), true, "the real bankrupt trader still is");
  });
  it("lpIdentityOf takes the verdict from the cycle's entries", () => {
    const entries = [{ pubkey: CATE_LP, isLp: true }, { pubkey: CATE_TRADER, isLp: false }];
    assert.equal(lpIdentityOf(entries, CATE_LP.toBase58()), true);
    assert.equal(lpIdentityOf(entries, CATE_TRADER.toBase58()), false);
    assert.equal(lpIdentityOf(entries, PublicKey.unique().toBase58()), undefined);
  });
  it("isMatcherConfiguredPortfolio accepts the cleared LP the vault_lp state names; not a plain trader", () => {
    assert.equal(isMatcherConfiguredPortfolio(cleared(fixture("cate-lp-portfolio-v18"))), true);
    assert.equal(isMatcherConfiguredPortfolio(fixture("cate-trader-portfolio-v18")), false);
    assert.equal(isMatcherConfiguredPortfolio(new Uint8Array(240)), false);
  });
  it("p2b wind-down holders (informational isLp) and portfolioIsLp", () => {
    const h = selectLegHolders([{ pubkey: CATE_LP, data: cleared(fixture("cate-lp-portfolio-v18")) }], 0);
    assert.equal(h[0].isLp, true);
    assert.equal(portfolioIsLp(CATE_TRADER, { matcherEnabled: false, matcherProgram: PublicKey.default }), false);
  });
});

describe("#645: findLpPortfolio trusts the vault_lp state's LP even with its ENABLED bit cleared", () => {
  const SOL = new PublicKey("BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5");
  const LP = new PublicKey("59N7KL3PPm5jxLqQ4WacLcsae1g5QPq31SZKDLWpxv78");
  const conn = (lpData: Buffer) => {
    const vls = deriveVaultLpState(WRAPPER_PROGRAM_ID, SOL);
    const scans: number[] = [];
    return {
      scans,
      c: {
        async getAccountInfo(pk: PublicKey) {
          if (pk.equals(vls)) return { owner: WRAPPER_PROGRAM_ID, data: fixture("v22-sol-vault-lp-state") };
          if (pk.equals(LP)) return { owner: WRAPPER_PROGRAM_ID, data: lpData };
          return null;
        },
        async getProgramAccounts(_p: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) {
          scans.push(cfg.filters.find((f) => f.dataSize !== undefined)!.dataSize!);
          return [];
        },
      },
    };
  };
  it("resolves the LP from the PDA, no scan (a cleared LP used to fall through to the scan and come back null)", async () => {
    const k = conn(cleared(fixture("v22-sol-lp-portfolio-v19")));
    assert.equal(parsePortfolioV17(new Uint8Array(cleared(fixture("v22-sol-lp-portfolio-v19")))).matcherEnabled, false);
    assert.equal((await findLpPortfolio(k.c as never, SOL))?.toBase58(), LP.toBase58());
    assert.deepEqual(k.scans, []);
  });
  it("NEGATIVE CONTROL: a PDA-named portfolio that is not this market's matcher portfolio is still refused", async () => {
    const k = conn(fixture("cate-trader-portfolio-v18"));
    assert.equal(await findLpPortfolio(k.c as never, SOL), null);
  });
});
