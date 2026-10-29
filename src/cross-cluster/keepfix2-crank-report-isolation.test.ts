/**
 * Ledger v22-keepfix-2026-10-29 §4: the recovery-crank loop crash-looped on growth 4458ecc.
 *
 * The v2.2 layer publishes its ADL state through `adlHealth()`, which formats `aLong`/`aShort` as decimal fractions of
 * ADL_ONE ("1.000000"). `v22CrankSample` did `BigInt("1.000000")`, which throws a SyntaxError. The throw left
 * `reportCrankHealth`, unwound `startRecoveryCrankLoop`, and the supervisor's backoff cut engine cranks from every 6 s
 * to about once a minute; crank-health alerts never ran. The GH#181 tests missed it because their fixtures used
 * integer strings, which is not what `adlHealth()` produces.
 *
 * Every record here is built by the REAL `adlHealth()`. Each test below fails on 4458ecc.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/keepfix2-crank-report-isolation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { AlertSink, DEFAULT_THRESHOLDS, freshStreaks } from "./alerting.ts";
import { ADL_ONE, adlFraction, adlHealth, parseAdlFraction } from "./adl-state.ts";
import { createCrankLiveness } from "./crank-liveness.ts";
import { reportCrankHealth, startRecoveryCrankLoop, v22CrankSample } from "./recovery-cranker.ts";
import { setCrankRefreshHealth, type CrankRefreshHealth } from "./refresh-coordination.ts";
import type { Registry } from "./registry.ts";

const T = DEFAULT_THRESHOLDS;
const NOW = Date.now();
const addr = () => Keypair.generate().publicKey.toBase58();

/** A healthy v2.2 record, as `publishHealth` in v22/loop.ts writes it. */
function record(over: Partial<CrankRefreshHealth> = {}): CrankRefreshHealth {
  return {
    staleLong: 0,
    staleShort: 0,
    postStaleLong: 0,
    postStaleShort: 0,
    positioned: 2,
    overflow: 0,
    overflowRefreshed: 0,
    overflowError: null,
    lossStaleCycles: 0,
    status: "ok",
    layout: { id: "v2.2-b", problem: null, kind: "ok", accountLen: 4059, provisional: false, hasPositions: true },
    updatedAt: Date.now(),
    chainSlot: 513_609_773n,
    engineSlot: 513_609_773n,
    adl: adlHealth({ reduceOnly: false, aLong: ADL_ONE, aShort: ADL_ONE, oiEffLong: 27_500_000n, oiEffShort: 27_500_000n }),
    ...over,
  };
}

const REDUCE_ONLY = adlHealth({ reduceOnly: true, aLong: ADL_ONE, aShort: 861_700_000_000_000n, oiEffLong: 27_500_000n, oiEffShort: 12n });

/** A v2.2-owned market as the cranker leaves it: no observation of its own. */
const v22OwnedState = () => ({ obs: null, totalCranks: 0, totalReverts: 0, consecutiveReverts: 0, lastRevertCode: null, streaks: freshStreaks() });

function sinkWithLines() {
  const lines: string[] = [];
  const sink = new AlertSink({ thresholds: T, log: (l) => lines.push(l), logError: (l) => lines.push(l) });
  return { sink, lines };
}

const registryOf = (...ms: Array<{ label: string; marketAddress: string }>) => ({ markets: ms }) as never;

describe("keepfix2: parseAdlFraction is the exact inverse of the published form", () => {
  it("parses the forms adlHealth() publishes, exactly", () => {
    assert.equal(parseAdlFraction("1.000000"), ADL_ONE);
    assert.equal(parseAdlFraction("0.861700"), 861_700_000_000_000n);
    assert.equal(parseAdlFraction("0.000000"), 0n);
    assert.equal(parseAdlFraction("0.000000000000001"), 1n, "15 fractional digits = one engine unit");
    assert.equal(parseAdlFraction("2"), 2n * ADL_ONE);
    for (const a of [0n, 1n, 999_999_999_999_999n, ADL_ONE, 861_700_000_000_000n, 123_456_789_012_345n]) {
      // adlFraction keeps 6 digits; parsing gives back exactly the value those 6 digits state.
      assert.equal(parseAdlFraction(adlFraction(a)), (a / 1_000_000_000n) * 1_000_000_000n, adlFraction(a));
    }
  });

  it("rejects anything that is not a plain decimal with at most 15 fractional digits -- null, never a rounded guess", () => {
    for (const bad of ["", "1.", ".5", "-1.000000", "+1.0", "1e15", " 1.000000", "1.000000 ", "1.0000000000000001", "NaN", "0x10", "1,000000"]) {
      assert.equal(parseAdlFraction(bad), null, JSON.stringify(bad));
    }
  });
});

describe("keepfix2: v22CrankSample on a REAL adlHealth() record", () => {
  it("does not throw on the decimal ADL strings and yields the exact bigints", () => {
    const s = v22CrankSample("L", addr(), record({ adl: REDUCE_ONLY }), NOW);
    assert.deepEqual(s?.adl, { reduceOnly: true, aLong: ADL_ONE, aShort: 861_700_000_000_000n, oiEffLong: 27_500_000n, oiEffShort: 12n });
  });

  it("an unparseable ADL field makes the ADL state unknown for that sample (no throw, no invented value)", () => {
    const s = v22CrankSample("L", addr(), record({ adl: { ...REDUCE_ONLY, aShort: "8.617e-1" } }), NOW);
    assert.ok(s, "the rest of the record is still evaluated");
    assert.equal(s.adl, null);
    const t = v22CrankSample("L", addr(), record({ adl: { ...REDUCE_ONLY, oiEffLong: "27500000.5" } }), NOW);
    assert.equal(t?.adl, null);
  });
});

describe("keepfix2: reportCrankHealth on real records", () => {
  it("a healthy v2.2 market reports with no alert (4458ecc threw SyntaxError here, every round)", async () => {
    const m = addr();
    setCrankRefreshHealth(m, record());
    const { sink } = sinkWithLines();
    const active = await reportCrankHealth(registryOf({ label: "SOL", marketAddress: m }), new Map([[m, v22OwnedState()]]) as never, 1, sink);
    assert.deepEqual(active, []);
  });

  it("a reduce-only v2.2 market fires adl-reduce-only carrying the exact a_short", async () => {
    const m = addr();
    setCrankRefreshHealth(m, record({ adl: REDUCE_ONLY }));
    const { sink } = sinkWithLines();
    const active = await reportCrankHealth(registryOf({ label: "SOL", marketAddress: m }), new Map([[m, v22OwnedState()]]) as never, 1, sink);
    const adl = active.find((a) => a.kind === "adl-reduce-only");
    assert.ok(adl, JSON.stringify(active.map((a) => a.kind)));
    assert.equal(adl.data?.aShort, "861700000000000");
    assert.equal(adl.data?.aLong, ADL_ONE.toString());
  });

  it("one market whose evaluation throws neither stops the other markets nor fakes a RESOLVED for its own alerts", async () => {
    const good = addr();
    const flaky = addr();
    const states = new Map([[good, v22OwnedState()], [flaky, v22OwnedState()]]);
    const reg = registryOf({ label: "GOOD", marketAddress: good }, { label: "FLAKY", marketAddress: flaky });
    const { sink, lines } = sinkWithLines();

    // Cycle 1: FLAKY is loss-stale and alerting.
    setCrankRefreshHealth(good, record());
    setCrankRefreshHealth(flaky, record({ lossStaleCycles: T.lossStaleCycles, staleLong: 2, status: "loss-stale" }));
    const first = await reportCrankHealth(reg, states as never, 1, sink);
    assert.deepEqual(first.map((a) => `${a.subject}:${a.kind}`), ["FLAKY:loss-stale"]);

    // Cycle 2: FLAKY's record now throws when read; GOOD turns reduce-only.
    const throwing = record();
    Object.defineProperty(throwing, "staleLong", { get: () => { throw new Error("record exploded"); } });
    setCrankRefreshHealth(flaky, throwing);
    setCrankRefreshHealth(good, record({ adl: REDUCE_ONLY }));
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    let second;
    try {
      second = await reportCrankHealth(reg, states as never, 2, sink);
    } finally {
      console.error = origError;
    }
    const got = second.map((a) => `${a.subject}:${a.kind}`).sort();
    assert.deepEqual(got, ["FLAKY:loss-stale", "GOOD:adl-reduce-only"], "GOOD evaluated; FLAKY keeps its last alert");
    assert.ok(!lines.some((l) => l.includes("ALERT-RESOLVED") && l.includes("FLAKY")), lines.join("\n"));
    assert.ok(errors.some((e) => e.includes("FLAKY") && e.includes("record exploded")), errors.join("\n"));
  });
});

describe("keepfix2: the crank loop survives a reporting failure", () => {
  it("keeps cycling at its own interval when the alert sink throws every cycle (4458ecc's loop threw out on the first)", async () => {
    const quiet = new Proxy({}, { get: () => () => Promise.resolve(null) }) as unknown as Connection;
    const reg: Registry = { version: 1, description: "t", markets: [] } as never;
    const sink = new AlertSink({ thresholds: T, log: () => undefined, logError: () => undefined });
    let calls = 0;
    sink.reconcile = async () => {
      calls++;
      if (calls >= 4) process.emit("SIGTERM");
      throw new Error("sink down");
    };
    const liveness = createCrankLiveness({ intervalMs: 20, intervals: 0 });
    const origError = console.error;
    console.error = () => undefined;
    let outcome: "resolved" | "rejected";
    try {
      outcome = await startRecoveryCrankLoop(quiet, Keypair.generate(), reg, { intervalMs: 20, dryRun: true }, sink, undefined, liveness).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
    } finally {
      console.error = origError;
    }
    assert.equal(outcome, "resolved", "the loop must not throw out on a reporting error");
    assert.ok(calls >= 4, `expected the loop to keep cycling; reconcile ran ${calls} time(s)`);
  });
});
