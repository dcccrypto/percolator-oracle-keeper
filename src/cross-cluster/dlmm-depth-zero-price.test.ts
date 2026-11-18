/**
 * Regression: planDlmmBinArrays looped forever when the active bin price floors to 0 (Q64.64 underflow).
 * Run: node --import tsx/esm --test src/cross-cluster/dlmm-depth-zero-price.test.ts
 * Repro found by keeper#405 (it.skip there; whichever of the two merges second removes that skip).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { spawnSync } from "node:child_process";
import { planDlmmBinArrays, priceQ64 } from "./dlmm-depth.ts";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const disc = (n: string) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8);

function poolBytes(o: { activeId: number; binStep: number }): Buffer {
  const b = Buffer.alloc(904);
  disc("LbPair").copy(b, 0);
  b.writeInt32LE(o.activeId, 76);
  b.writeUInt16LE(o.binStep, 80);
  Keypair.generate().publicKey.toBuffer().copy(b, 88);
  USDC.toBuffer().copy(b, 120);
  return b;
}

// A synchronous infinite loop cannot be interrupted by node:test { timeout } (the event loop never yields), so the
// hang check runs in a child process that spawnSync kills after 5s; a hang then FAILS instead of blocking the run.
if (process.env.DLMM_ZERO_PRICE_CHILD === "1") {
  const plan = planDlmmBinArrays(poolBytes({ activeId: -3000, binStep: 10_000 }));
  process.stdout.write(JSON.stringify({ ok: plan.ok }));
  process.exit(0);
}

describe("planDlmmBinArrays zero price", () => {
  it("the repro really underflows to a zero price", () => {
    assert.equal(priceQ64(-3000, 10_000), 0n);
  });

  it("refuses a pool whose active price underflows to 0 instead of looping forever", { timeout: 20_000 }, () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", new URL(import.meta.url).pathname], {
      env: { ...process.env, DLMM_ZERO_PRICE_CHILD: "1" },
      timeout: 5000,
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
    assert.notEqual(r.error?.message.includes("ETIMEDOUT") ? "hang" : "", "hang", "planDlmmBinArrays hung (killed after 5s)");
    assert.equal(r.status, 0, `child failed: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false });
  });
});
