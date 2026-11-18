/**
 * Regression: planDlmmBinArrays looped forever when the active bin price floors to 0 (Q64.64 underflow).
 * Run: node --import tsx/esm --test src/cross-cluster/dlmm-depth-zero-price.test.ts
 * Repro found by keeper#405 (it.skip there; whichever of the two merges second removes that skip).
 *
 * A synchronous infinite loop cannot be interrupted by node:test { timeout } (the event loop never yields), so the call runs
 * in a child process in its own process group. The child prints READY just before the call; this test then allows 5s for a
 * RESULT line and SIGKILLs the whole group if it does not come. A hang FAILS the test, and no spinning orphan is left behind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { priceQ64 } from "./dlmm-depth.ts";

const CHILD = fileURLToPath(new URL("./dlmm-depth-zero-price-child.ts", import.meta.url));

type ChildRun = { hung: boolean; result: { ok: boolean } | null; out: string };

function runChild(env: Record<string, string>, callBudgetMs: number): Promise<ChildRun> {
  return new Promise((resolve) => {
    const inherited = { ...process.env };
    delete inherited.NODE_TEST_CONTEXT;
    const c = spawn(process.execPath, ["--import", "tsx/esm", CHILD], {
      env: { ...inherited, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let hung = false;
    let callTimer: NodeJS.Timeout | undefined;
    const killGroup = () => {
      try {
        process.kill(-c.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    // Outer guard for start-up itself (tsx cold start), separate from the 5s budget for the call under test.
    const startTimer = setTimeout(killGroup, 90_000);
    c.stdout.on("data", (d) => {
      out += d;
      if (!callTimer && out.includes("READY")) {
        callTimer = setTimeout(() => {
          hung = true;
          killGroup();
        }, callBudgetMs);
      }
    });
    c.stderr.on("data", (d) => (out += d));
    c.once("close", () => {
      clearTimeout(startTimer);
      if (callTimer) clearTimeout(callTimer);
      const m = /RESULT (\{.*\})/.exec(out);
      resolve({ hung, result: m ? JSON.parse(m[1]) : null, out });
    });
  });
}

describe("planDlmmBinArrays zero price", () => {
  it("the repro really underflows to a zero price", () => {
    assert.equal(priceQ64(-3000, 10_000), 0n);
  });

  it("refuses a pool whose active price underflows to 0 instead of looping forever", { timeout: 120_000 }, async () => {
    const r = await runChild({ ZP_ACTIVE_ID: "-3000", ZP_BIN_STEP: "10000" }, 5000);
    assert.equal(r.hung, false, "planDlmmBinArrays hung (child killed 5s after READY)");
    assert.deepEqual(r.result, { ok: false }, r.out);
  });

  it("harness control: a normal pool returns promptly, so the 5s budget does not misfire", { timeout: 120_000 }, async () => {
    const r = await runChild({ ZP_ACTIVE_ID: "0", ZP_BIN_STEP: "25" }, 5000);
    assert.equal(r.hung, false);
    assert.deepEqual(r.result, { ok: true }, r.out);
  });
});
