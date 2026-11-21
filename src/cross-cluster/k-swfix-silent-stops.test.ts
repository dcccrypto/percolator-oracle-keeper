/**
 * K-SWFIX: the four silent-stop paths K-SWALLOW confirmed must now be loud (and must not falsely resolve alerts).
 *  1. a failed snapshot chunk is logged + counted (p2b-markets) and the gap is alerted (snapshotGapAlert)
 *  2. a read error does not RESOLVE a live alert (AlertSink.reconcile hold; hedged-lockout reports `errored`)
 *  3. undecodable portfolios are surfaced (analysePortfolios)
 *  4. a decode throw in isBankruptPortfolio is logged (result unchanged: false)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { readVaultMarketSnapshots } from "./p2b-markets.ts";
import { AlertSink, DEFAULT_THRESHOLDS, snapshotGapAlert } from "./alerting.ts";
import { evaluateHedgedLockouts, DEFAULT_HEDGED_LOCKOUT_THRESHOLDS } from "./p2b-hedged-lockout.ts";
import { analysePortfolios } from "./v22/positioned.ts";
import { isBankruptPortfolio } from "./positioned-refresh.ts";

function captureWarn<T>(fn: () => Promise<T> | T): Promise<{ r: T; warns: string[] }> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  return Promise.resolve()
    .then(fn)
    .then((r) => ({ r, warns }))
    .finally(() => { console.warn = orig; });
}

describe("K-SWFIX finding 1: dropped snapshot chunks are logged, counted and alerted", () => {
  it("40 markets, first chunk read fails: warn logged, stats counted, only the second chunk's 7 snapshots remain", async () => {
    const markets = Array.from({ length: 40 }, (_, i) => ({ marketAddress: Keypair.generate().publicKey.toBase58(), label: `M${i}`, assetIndex: 0 }));
    let calls = 0;
    const conn = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        if (calls++ === 0) throw new Error("rpc 429");
        return { context: { slot: 5 }, value: keys.map(() => null) };
      },
    };
    const stats = { droppedChunks: 0, droppedMarkets: 0 };
    const { r, warns } = await captureWarn(() => readVaultMarketSnapshots(conn as never, Keypair.generate().publicKey, markets, stats));
    assert.equal(r.size, 7);
    assert.deepEqual(stats, { droppedChunks: 1, droppedMarkets: 33 });
    assert.equal(warns.length, 1);
    assert.match(warns[0], /33 markets dropped/);
    assert.match(warns[0], /rpc 429/);
  });
  it("snapshotGapAlert carries the snapshots-vs-markets gap", () => {
    const a = snapshotGapAlert(40, 7, 1);
    assert.equal(a.kind, "p2b-snapshot-gap");
    assert.deepEqual([a.data?.markets, a.data?.snapshots, a.data?.droppedChunks], [40, 7, 1]);
  });
});

describe("K-SWFIX finding 2: a read error does not resolve a live alert", () => {
  function sink() {
    const lines: string[] = [];
    let now = 1_000_000;
    const s = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, now: () => now, log: (l: string) => lines.push(l), logError: (l: string) => lines.push(l) } as never);
    return { s, lines };
  }
  const A = { kind: "hedged-lockout" as const, severity: "warn" as const, subject: "CATE", message: "locked" };
  it("held subject: no RESOLVED, and the alert is still tracked; once readable and clear it resolves", async () => {
    const { s, lines } = sink();
    await s.reconcile("p2b:hedged-lockout", [A]);
    await s.reconcile("p2b:hedged-lockout", [], new Set(["CATE"]));
    assert.equal(lines.filter((l) => l.startsWith("[ALERT-RESOLVED]")).length, 0, "read error is not 'condition cleared'");
    await s.reconcile("p2b:hedged-lockout", []);
    assert.equal(lines.filter((l) => l.startsWith("[ALERT-RESOLVED]")).length, 1, "a good read that is clear still resolves");
  });
  it("evaluateHedgedLockouts reports a market whose read threw as errored", async () => {
    const bad = {
      ref: { label: "CATE", marketAddress: "x", assetIndex: 0 },
      get bound(): boolean { throw new Error("boom"); },
    };
    const { r } = await captureWarn(() => evaluateHedgedLockouts({} as never, [bad as never], DEFAULT_HEDGED_LOCKOUT_THRESHOLDS));
    assert.deepEqual(r.errored, ["CATE"]);
    assert.equal(r.alerts.length, 0);
  });
});

describe("K-SWFIX finding 3: undecodable portfolios are surfaced", () => {
  it("a right-length account that fails to decode is skipped with a warning", async () => {
    const data = new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN); // zeroed: no magic, parse throws
    const { r, warns } = await captureWarn(() => analysePortfolios([{ pubkey: Keypair.generate().publicKey, data }], { lpPortfolio: null, portfolioLen: V17_PORTFOLIO_ACCOUNT_LEN }));
    assert.equal(r.undecodable, 1);
    assert.equal(r.all.length, 0);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /1 portfolio account\(s\).*failed to decode/);
  });
});

describe("K-SWFIX finding 4: isBankruptPortfolio decode failure is logged", () => {
  it("returns false (unchanged) but warns", async () => {
    const { r, warns } = await captureWarn(() => isBankruptPortfolio(new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN)));
    assert.equal(r, false);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /decode failed/);
  });
});
