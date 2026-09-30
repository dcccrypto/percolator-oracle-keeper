/**
 * Keeper cadence footgun (runbook fresh-id-redeploy-plan §8): CC_INTERVAL_MS
 * 4–6 s with the default 15 s CC_MARK_WINDOW_MS never pushes. The verdicts of
 * markCadenceCheck are checked against the REAL smoother driven at that period.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { createMarkSmoother, markCadenceCheck } from "./mark-smoother.ts";

/** Does the real smoother ever publish when fed a constant price every `periodMs` for 20 min? */
function publishes(periodMs: number, windowMs: number): boolean {
  const s = createMarkSmoother({ windowMs });
  for (let t = 0; t < 20 * 60_000; t += periodMs) if (s.smooth("pool", 1_000_000n, Math.round(t)) !== null) return true;
  return false;
}

const CASES: Array<[number, number, "ok" | "fragile" | "never"]> = [
  [4_000, 15_000, "never"],
  [6_000, 15_000, "never"],
  [5_000, 15_000, "fragile"],
  [7_000, 15_000, "ok"], // the keeper default
  [1_500, 8_000, "ok"], // the live pair
  [13_000, 15_000, "never"], // span ok but only 2 samples
  [20_000, 15_000, "never"],
];

describe("markCadenceCheck agrees with the real smoother", () => {
  for (const [i, w, want] of CASES) {
    it(`${i} ms / ${w} ms window -> ${want}`, () => {
      const c = markCadenceCheck(i, w);
      assert.equal(c.verdict, want, c.detail);
      if (want === "never") assert.equal(publishes(i, w), false, "real smoother never publishes");
      if (want === "ok") {
        assert.equal(publishes(i, w), true);
        assert.equal(publishes(i * 1.02, w), true, "robust to 2% slower cycles");
      }
      if (want === "fragile") {
        assert.equal(publishes(i, w), true, "publishes at the exact period");
        assert.equal(publishes(i * 1.02, w), false, "but not 2% slower");
      }
    });
  }
});

describe("the live entry point refuses a never-pushing cadence", () => {
  it("an EMPTY CC_MARK_WINDOW_MS (Number(\"\") = 0: a zero window) is also a never-pushing cadence", () => {
    assert.equal(markCadenceCheck(7_000, Number("")).verdict, "never");
  });
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  it("CC_INTERVAL_MS=4000 with the default 15 s window: exit 1 with a [fatal] line", async () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CC_MARK_WINDOW_MS; // the DEFAULT 15 s window is what the runbook warns about
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx/esm", path.join(ROOT, "src", "cross-cluster.ts")], {
        cwd: ROOT,
        env: {
          ...env,
          MAINNET_RPC_URL: "https://127.0.0.1:1",
          DEVNET_RPC_URL: "https://127.0.0.1:1",
          KEEPER_KEYPAIR: JSON.stringify(Array.from(Keypair.generate().secretKey)),
          CC_INTERVAL_MS: "4000",
          DRY_RUN: "false",
          CC_HEALTH_PORT: "0",
          REGISTRY_PATH: path.join(ROOT, "__cadence_nonexistent_registry__.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    assert.equal(r.code, 1, r.out.slice(-400));
    assert.match(r.out, /\[fatal\] this cadence can never publish a mark/);
    assert.match(r.out, /CC_INTERVAL_MS=4000 with CC_MARK_WINDOW_MS=15000: max span 12000 ms/, "checked against the 15 s default");
  });
});
