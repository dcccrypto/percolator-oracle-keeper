/**
 * Ops-track alerting: thresholds, streaks, cooldown/resolve, webhook safety,
 * and the recovery cranker's wiring into it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AlertSink,
  DEFAULT_THRESHOLDS,
  evaluateCrankHealth,
  evaluatePushCycle,
  freshStreaks,
  slotLag,
  thresholdsFromEnv,
  validateWebhookUrl,
} from "./alerting.ts";
import type { CrankHealthSample } from "./alerting.ts";
import { reportCrankHealth } from "./recovery-cranker.ts";

const T = DEFAULT_THRESHOLDS;

function sample(p: Partial<CrankHealthSample> = {}): CrankHealthSample {
  return {
    label: "SOL",
    market: "Azagguvr",
    chainSlot: 1_000_000n,
    engineSlot: 1_000_000n - 40n,
    crankOk: true,
    crankReverted: false,
    totalOk: 10,
    totalReverts: 0,
    consecutiveReverts: 0,
    lastRevertCode: null,
    lapsedBuckets: 0,
    bankruptFound: 0,
    bankruptLiquidated: 0,
    ...p,
  };
}

describe("evaluateCrankHealth", () => {
  it("a healthy market (lag 40 slots, cranks clean) raises nothing", () => {
    assert.deepEqual(evaluateCrankHealth(sample(), freshStreaks(), T).active, []);
  });

  it("the 2026-09-25 freeze: pushes landing, engine clock 3.5 days behind -> critical slot-lag", () => {
    const s = sample({ engineSlot: 1_000_000n - 756_000n, crankOk: false, crankReverted: true, consecutiveReverts: 9000, lastRevertCode: null });
    const kinds = evaluateCrankHealth(s, freshStreaks(), T).active.map((a) => `${a.kind}:${a.severity}`);
    assert.ok(kinds.includes("slot-lag:critical"), kinds.join());
    assert.ok(kinds.includes("crank-reverts:critical"), kinds.join());
  });

  it("slot lag: warn between the two thresholds, critical at/after the second", () => {
    const warn = evaluateCrankHealth(sample({ engineSlot: 1_000_000n - BigInt(T.slotLagWarn) }), freshStreaks(), T).active;
    assert.equal(warn[0]?.severity, "warn");
    const crit = evaluateCrankHealth(sample({ engineSlot: 1_000_000n - BigInt(T.slotLagCritical) }), freshStreaks(), T).active;
    assert.equal(crit[0]?.severity, "critical");
    assert.deepEqual(evaluateCrankHealth(sample({ engineSlot: 1_000_000n - BigInt(T.slotLagWarn - 1) }), freshStreaks(), T).active, []);
  });

  it("an undecodable header does not invent a lag", () => {
    assert.equal(slotLag({ chainSlot: 5n, engineSlot: null }), null);
    assert.deepEqual(evaluateCrankHealth(sample({ engineSlot: null }), freshStreaks(), T).active, []);
  });

  it("crank reverts alert only once consecutive >= threshold", () => {
    assert.deepEqual(evaluateCrankHealth(sample({ consecutiveReverts: T.crankConsecutiveReverts - 1 }), freshStreaks(), T).active, []);
    assert.equal(evaluateCrankHealth(sample({ consecutiveReverts: T.crankConsecutiveReverts }), freshStreaks(), T).active[0].kind, "crank-reverts");
  });

  it("a lapsed bucket alerts only when it PERSISTS (the repair should clear it in one cycle)", () => {
    let st = freshStreaks();
    for (let i = 1; i < T.lapsedBucketCycles; i++) {
      const r = evaluateCrankHealth(sample({ lapsedBuckets: 1 }), st, T);
      assert.deepEqual(r.active, [], `cycle ${i}`);
      st = r.streaks;
    }
    const r = evaluateCrankHealth(sample({ lapsedBuckets: 1 }), st, T);
    assert.equal(r.active[0].kind, "lapsed-bucket");
    assert.equal(evaluateCrankHealth(sample({ lapsedBuckets: 0 }), r.streaks, T).streaks.lapsedCycles, 0, "streak resets");
  });

  it("bankrupt: liquidated in the same cycle is fine; un-liquidated for N cycles is critical", () => {
    let st = freshStreaks();
    for (let i = 0; i < 5; i++) {
      const r = evaluateCrankHealth(sample({ bankruptFound: 1, bankruptLiquidated: 1 }), st, T);
      assert.deepEqual(r.active, []);
      st = r.streaks;
    }
    let r = evaluateCrankHealth(sample({ bankruptFound: 2, bankruptLiquidated: 0 }), st, T);
    r = evaluateCrankHealth(sample({ bankruptFound: 2, bankruptLiquidated: 0 }), r.streaks, T);
    assert.equal(r.active[0]?.kind, "bankrupt-unliquidated");
    assert.equal(r.active[0]?.severity, "critical");
  });
});

describe("evaluatePushCycle", () => {
  it("zero landed pushes for N consecutive cycles is critical; any push resets", () => {
    let z = 0;
    for (let i = 1; i < T.zeroPushCycles; i++) {
      const r = evaluatePushCycle({ cycle: i, registered: 19, attempted: 19, pushed: 0 }, z, T);
      assert.deepEqual(r.active, []);
      z = r.zeroStreak;
    }
    const r = evaluatePushCycle({ cycle: 99, registered: 19, attempted: 19, pushed: 0 }, z, T);
    assert.equal(r.active[0].kind, "zero-pushes");
    assert.equal(evaluatePushCycle({ cycle: 100, registered: 19, attempted: 19, pushed: 1 }, r.zeroStreak, T).zeroStreak, 0);
  });
  it("an empty board is not an outage", () => {
    assert.equal(evaluatePushCycle({ cycle: 1, registered: 0, attempted: 0, pushed: 0 }, 50, T).zeroStreak, 0);
  });
});

function capture() {
  const lines: string[] = [];
  const posts: Array<{ url: string; body: string }> = [];
  let now = 1_000_000;
  const sink = new AlertSink({
    thresholds: { ...T, cooldownMs: 60_000 },
    webhookUrl: "https://hooks.example.com/services/SECRET-TOKEN",
    post: async (url, body) => { posts.push({ url, body }); },
    now: () => now,
    log: (l) => lines.push(l),
    logError: (l) => lines.push(l),
  });
  return { sink, lines, posts, advance: (ms: number) => { now += ms; } };
}

const LAG = { kind: "slot-lag" as const, severity: "critical" as const, subject: "SOL", message: "behind" };

describe("AlertSink", () => {
  it("fires once, suppresses repeats inside the cooldown, re-fires after it, then resolves once", async () => {
    const c = capture();
    assert.equal((await c.sink.reconcile("crank", [LAG])).length, 1);
    assert.equal((await c.sink.reconcile("crank", [LAG])).length, 0, "suppressed inside cooldown");
    c.advance(60_000);
    assert.equal((await c.sink.reconcile("crank", [LAG])).length, 1, "re-fires after cooldown");
    await c.sink.reconcile("crank", []);
    await c.sink.reconcile("crank", []);
    const resolved = c.lines.filter((l) => l.startsWith("[ALERT-RESOLVED]"));
    assert.equal(resolved.length, 1);
    assert.equal(JSON.parse(resolved[0].replace(/^\[ALERT-RESOLVED\] /, "")).severity, "critical", "resolve echoes the alert's severity");
    assert.equal(c.lines.filter((l) => l.startsWith("[ALERT] ")).length, 2);
    assert.equal(c.posts.length, 3, "2 alerts + 1 resolve delivered");
    assert.match(JSON.parse(c.posts[0].body).text, /\[CRITICAL\] percolator-keeper slot-lag SOL/);
  });

  it("scopes are independent: resolving 'push' never resolves a 'crank' alert", async () => {
    const c = capture();
    await c.sink.reconcile("crank", [LAG]);
    await c.sink.reconcile("push", []);
    assert.equal(c.lines.filter((l) => l.startsWith("[ALERT-RESOLVED]")).length, 0);
  });

  it("a failing webhook never throws and never echoes the URL (it is a credential)", async () => {
    const lines: string[] = [];
    const sink = new AlertSink({
      thresholds: T,
      webhookUrl: "https://hooks.example.com/services/SECRET-TOKEN",
      post: async () => { throw new Error("HTTP 500"); },
      log: (l) => lines.push(l),
      logError: (l) => lines.push(l),
    });
    await sink.reconcile("crank", [LAG]);
    assert.ok(lines.some((l) => /webhook delivery failed: HTTP 500/.test(l)));
    assert.ok(!lines.some((l) => l.includes("SECRET-TOKEN")));
  });

  it("health lines are single-line JSON with bigint support", () => {
    const c = capture();
    c.sink.health("crank", { big: 5n, markets: [{ m: "SOL", lag: 3 }] });
    assert.equal(c.lines.length, 1);
    const j = JSON.parse(c.lines[0].replace(/^\[health\] /, ""));
    assert.equal(j.scope, "crank");
    assert.equal(j.big, "5");
  });
});

describe("config validation", () => {
  it("webhook must be https; http and garbage are refused without echoing the value", () => {
    assert.equal(validateWebhookUrl(undefined), undefined);
    assert.equal(validateWebhookUrl(""), undefined);
    assert.throws(() => validateWebhookUrl("http://hooks.example.com/x"), /must use https/);
    assert.throws(() => validateWebhookUrl("not a url SECRET"), (e: Error) => !e.message.includes("SECRET"));
  });
  it("thresholds: defaults, overrides, and rejection of garbage", () => {
    assert.deepEqual(thresholdsFromEnv({}), T);
    assert.equal(thresholdsFromEnv({ ALERT_SLOT_LAG_WARN: "100" }).slotLagWarn, 100);
    assert.throws(() => thresholdsFromEnv({ ALERT_CRANK_REVERTS: "-1" }), /positive integer/);
    assert.throws(() => thresholdsFromEnv({ ALERT_SLOT_LAG_WARN: "500", ALERT_SLOT_LAG_CRITICAL: "400" }), />=/);
  });
});

describe("recovery cranker -> alerting wiring (reportCrankHealth)", () => {
  it("turns each market's latest observation into health records and alerts, then consumes it", async () => {
    const c = capture();
    const registry = { markets: [{ label: "SOL", marketAddress: "A" }, { label: "PENGU", marketAddress: "B" }, { label: "NEW", marketAddress: "C" }] };
    const st = (obs: CrankHealthSample | null, cons = 0) => ({
      obs: obs && {
        chainSlot: obs.chainSlot, engineSlot: obs.engineSlot, crankOk: obs.crankOk, crankReverted: obs.crankReverted,
        lapsedBuckets: obs.lapsedBuckets, bankruptFound: obs.bankruptFound, bankruptLiquidated: obs.bankruptLiquidated,
      },
      totalCranks: 4, totalReverts: cons, consecutiveReverts: cons, lastRevertCode: cons ? 19 : null, streaks: freshStreaks(),
    });
    const states = new Map<string, ReturnType<typeof st>>([
      ["A", st(sample({ engineSlot: 1_000_000n - 900n }), 5)],
      ["B", st(sample())],
      ["C", st(null)],
    ]);
    const active = await reportCrankHealth(registry as never, states as never, 3, c.sink);
    assert.deepEqual(active.map((a) => `${a.subject}:${a.kind}`).sort(), ["SOL:crank-reverts", "SOL:slot-lag"]);
    const health = c.lines.find((l) => l.startsWith("[health]"));
    assert.ok(health, "a [health] line on cycle % 3 == 0");
    const j = JSON.parse(health!.replace(/^\[health\] /, ""));
    assert.deepEqual(j.markets.map((m: { m: string; lag: number }) => [m.m, m.lag]), [["SOL", 900], ["PENGU", 40]]);
    assert.equal(states.get("A")!.obs, null, "observation consumed");
  });
});
