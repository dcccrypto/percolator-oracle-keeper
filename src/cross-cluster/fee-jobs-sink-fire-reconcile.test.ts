/**
 * startFeeJobLoop: (1) if sink.fire throws on one event, the other events still go out;
 * (2) if sink.health throws, sink.reconcile still runs.
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

const ev = (message: string) => ({ kind: "fee-leg-blocked", severity: "warn", subject: "", message }) as Alert;

const job: FeeJob = {
  name: "lp-fee",
  async run(): Promise<FeeJobOutcome> {
    return { kind: "done", detail: "moved", events: [ev("first"), ev("second")] };
  },
};

describe("startFeeJobLoop: sink failures", () => {
  it("sink.fire throwing on the first event does not lose the second", async () => {
    const fired: string[] = [];
    const sink = {
      health() {},
      async reconcile() {},
      async fire(_k: string, a: Alert) {
        if (a.message === "first") { process.emit("SIGTERM"); throw new Error("fire boom"); }
        fired.push(a.message);
      },
    };
    await drive(startFeeJobLoop([job], ctx, registry, cfg, sink as never));
    assert.deepEqual(fired, ["second"]);
    assert.ok(errors.some((e) => e.includes("fire boom")), "error logged");
  });

  it("sink.health throwing does not skip sink.reconcile", async () => {
    let reconciles = 0;
    const sink = {
      health() { process.emit("SIGTERM"); throw new Error("health boom"); },
      async reconcile() { reconciles++; },
      async fire() {},
    };
    await drive(startFeeJobLoop([job], ctx, registry, cfg, sink as never));
    assert.equal(reconciles, 1);
    assert.ok(errors.some((e) => e.includes("health boom")), "error logged");
  });
});
