/**
 * Differential: the keyed-once candidate sort of forceCloseResolvedLosers must produce exactly the order, outcome,
 * waiting / skipped / closed lists, counters and log lines of the pre-perf code (frozen as .legacy.ts, 12b4d5a), on the same
 * synthetic inputs, including keys whose base58 string order differs from raw byte order (string order is kept).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/resolved-loser-force-close.sort-diff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { forceCloseResolvedLosers, LoserForceCloseState } from "./resolved-loser-force-close.ts";
import { forceCloseResolvedLosers as legacy } from "./resolved-loser-force-close.legacy.ts";
import { CODEC, MARKET, NOW_SLOT, cfg, syntheticKeys, syntheticWorld } from "./resolved-loser-force-close.synthetic.ts";

async function both(n: number, over: Parameters<typeof cfg>[0] = {}, passes = 1) {
  const keys = syntheticKeys(n);
  const run = async (fn: typeof forceCloseResolvedLosers) => {
    const w = syntheticWorld(keys);
    const lines: string[] = [];
    const st = new LoserForceCloseState();
    const results = [];
    for (let i = 0; i < passes; i++) results.push(await fn(w.conn as never, Keypair.generate(), CODEC, MARKET, NOW_SLOT, true, cfg({ ...over, log: (l) => lines.push(l) }), st));
    return { results, trace: w.trace, lines, cursor: [...st.cursor], waitingSeen: [...st.waitingSeen] };
  };
  return { old: await run(legacy), now: await run(forceCloseResolvedLosers), keys };
}

describe("sort once-keyed == legacy double-encode sort", () => {
  for (const n of [0, 1, 2, 3, 33, 256]) {
    it(`identical results, scan order, logs and cursor for ${n} candidates (truncated and rotating)`, async () => {
      const { old, now } = await both(n, {}, 3);
      assert.deepEqual(now.results, old.results);
      assert.deepEqual(now.trace, old.trace);
      assert.deepEqual(now.lines, old.lines);
      assert.deepEqual(now.cursor, old.cursor);
      assert.deepEqual(now.waitingSeen, old.waitingSeen);
    });
  }

  it("untruncated scan covers every key in base58 localeCompare order, which is not raw byte order", async () => {
    const n = 200;
    const { now, keys } = await both(n, { maxScanPerCycle: 1000, maxClosesPerCycle: 1000 });
    // Probe order = first simulation of each key (a refused key may be re-simulated right after with an ATA create).
    const sims = [...new Set(now.trace.filter((t) => t.startsWith("sim:")).map((t) => t.slice(4)))];
    const byString = keys.map((k) => k.toBase58()).sort((a, b) => a.localeCompare(b));
    const byBytes = [...keys].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer())).map((k) => k.toBase58());
    assert.notDeepEqual(byString, byBytes, "fixture must exercise keys whose string order differs from byte order");
    assert.deepEqual(sims.slice(0, n), byString);
  });

  it("outcome branches are all exercised (waiting, closed, skipped)", async () => {
    const { now } = await both(300, {}, 1);
    const r = now.results[0];
    assert.ok(r.waiting.length > 0 && r.closed.length > 0 && r.skipped.length > 0);
  });
});
