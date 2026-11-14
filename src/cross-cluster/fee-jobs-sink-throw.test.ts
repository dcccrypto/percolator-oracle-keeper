/**
 * startFeeJobLoop: when sink.health or sink.reconcile throws, the sweep's one-shot events must
 * still be fired, the error logged, and the loop must keep running.
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { startFeeJobLoop } from "./fee-jobs.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import type { Alert } from "./alerting.ts";

const ctx = { conn: {} as never, keeper: Keypair.generate(), dryRun: true };
const registry = { markets: [{ marketAddress: "MA", label: "AAA/USDC" }] } as never;
const cfg = { intervalMs: 1000 };

let errors: string[];
let sigintBefore: Function[];
let sigtermBefore: Function[];

beforeEach(() => {
  errors = [];
  mock.method(console, "log", () => {});
  mock.method(console, "error", (...a: unknown[]) => { errors.push(a.join(" ")); });
  mock.timers.enable({ apis: ["setTimeout"] });
  sigintBefore = process.listeners("SIGINT");
  sigtermBefore = process.listeners("SIGTERM");
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const before = sig === "SIGINT" ? sigintBefore : sigtermBefore;
    for (const l of process.listeners(sig)) if (!before.includes(l)) process.removeListener(sig, l as never);
  }
});

async function drive(p: Promise<void>): Promise<void> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(1000);
  }
  assert.ok(done, "loop stopped");
  await p;
}

const job: FeeJob = {
  name: "lp-fee",
  async run(): Promise<FeeJobOutcome> {
    return {
      kind: "done",
      detail: "moved 5 lamports",
      events: [{ kind: "fee-leg-blocked", severity: "warn", subject: "", message: "pda portfolio closed" } as Alert],
    };
  },
};

function makeSink(throwIn: "health" | "reconcile", stopAfterSweeps: number) {
  const fired: Array<{ key: string; alert: Alert }> = [];
  let sweeps = 0;
  const sink = {
    health() {
      if (throwIn === "health") { sweeps++; if (sweeps >= stopAfterSweeps) process.emit("SIGTERM"); throw new Error("health boom"); }
    },
    async reconcile() {
      if (throwIn === "reconcile") { sweeps++; if (sweeps >= stopAfterSweeps) process.emit("SIGTERM"); throw new Error("reconcile boom"); }
    },
    async fire(key: string, alert: Alert) { fired.push({ key, alert }); },
  };
  return { sink: sink as never, fired };
}

for (const throwIn of ["health", "reconcile"] as const) {
  describe(`startFeeJobLoop: sink.${throwIn} throws`, () => {
    it("still fires the sweep events every cycle, logs the error, and keeps looping", async () => {
      const t = makeSink(throwIn, 2);
      await drive(startFeeJobLoop([job], ctx, registry, cfg, t.sink));
      assert.equal(t.fired.length, 2, "one event per cycle for two cycles");
      assert.equal(t.fired[0].key, "fee-jobs:lp-fee:events");
      assert.equal(t.fired[0].alert.subject, "AAA/USDC");
      assert.ok(errors.some((e) => e.includes(`${throwIn} boom`)), "error logged");
    });
  });
}
