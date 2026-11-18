/**
 * startFeeJobLoop outer catch: anything thrown outside the isolated sink calls (here, console.log
 * while reporting a moved fee) costs one job sweep, never the loop. Mocked clock, no RPC.
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { startFeeJobLoop } from "./fee-jobs.ts";
import type { FeeJob } from "./fee-jobs.ts";

const ctx = { conn: {} as never, keeper: Keypair.generate(), dryRun: false };
const registry = { markets: [{ marketAddress: "MA", label: "AAA/USDC" }] } as never;
let errors: string[];
let sigint: Function[];
let sigterm: Function[];

beforeEach(() => {
  errors = [];
  mock.method(console, "error", (...a: unknown[]) => { errors.push(a.join(" ")); });
  mock.timers.enable({ apis: ["setTimeout"] });
  sigint = process.listeners("SIGINT");
  sigterm = process.listeners("SIGTERM");
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.removeListener("SIGINT", l as never);
  for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l)) process.removeListener("SIGTERM", l as never);
});

async function drive(p: Promise<void>): Promise<void> {
  let done = false;
  void p.then(() => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(1000);
  }
  assert.ok(done, "loop stopped");
}

describe("startFeeJobLoop outer catch", () => {
  for (const [label, thrown, expected] of [
    ["an Error reports its message", new Error("log boom"), /\[lp-fee\] sweep error — log boom$/],
    ["a non-Error is stringified", "plain log", /\[lp-fee\] sweep error — plain log$/],
  ] as const) {
    it(`a throw outside the sinks costs one sweep, not the loop: ${label}`, async () => {
      mock.method(console, "log", (...a: unknown[]) => {
        if (/^\[lp-fee\] AAA/.test(String(a[0]))) throw thrown;
      });
      let runs = 0;
      const job: FeeJob = {
        name: "lp-fee",
        async run() { if (++runs >= 2) process.emit("SIGTERM"); return { kind: "done", detail: "moved 1" }; },
      };
      let reconciled = 0;
      const sink = { health() {}, async reconcile() { reconciled++; }, async fire() {} };
      await drive(startFeeJobLoop([job], ctx, registry, { intervalMs: 1000 }, sink as never));
      assert.equal(errors.length, 2, "both cycles threw in the log line, the loop kept going");
      assert.match(errors[0], expected);
      assert.match(errors[1], expected);
      assert.equal(reconciled, 0, "the throw precedes the sink calls");
    });
  }
});
