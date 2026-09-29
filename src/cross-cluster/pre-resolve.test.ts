/** F4: crank 78/87 before ResolveMarket, and refuse while a Live-only leg is owed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { drainFeeLegsBeforeResolve } from "./pre-resolve.ts";
import type { PreResolveConnection, PreResolveDeps } from "./pre-resolve.ts";
import { readFeeLegs } from "./fee-legs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const CFG = {
  wrapperProgramId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
  stakeProgramId: new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3"),
  minRealShares: 0n,
  maxDeadShareBps: 100n,
  minPushAtoms: 1n,
};

/** Rewrite the four fee counters so a "drained" after-state can be served. */
function drained(src: Buffer, legs: { lp: boolean; stake: boolean }): Buffer {
  // Accrued/withdrawn are u128 pairs in the wrapper config (SDK parseWrapperConfigV17:
  // lp @ b+496/512, insurance @ b+528/544, b = V17_HEADER_LEN 16). Copy accrued -> withdrawn.
  const b = Buffer.from(src);
  const B = 16;
  if (legs.lp) b.copy(b, B + 512, B + 496, B + 512);
  if (legs.stake) b.copy(b, B + 544, B + 528, B + 544);
  return b;
}

function conn(first: Buffer, after: Buffer): { c: PreResolveConnection; reads: () => number } {
  let reads = 0;
  const c = {
    async getAccountInfo() {
      reads++;
      return { data: reads === 1 ? first : after, owner: CFG.wrapperProgramId, lamports: 1, executable: false };
    },
  };
  return { c: c as unknown as PreResolveConnection, reads: () => reads };
}

describe("drainFeeLegsBeforeResolve (SOL real bytes: lp 13,690,922 / stake 4,563,668 owed)", () => {
  const sol = fx("sol-market-v18-fees");
  const legs = readFeeLegs(new Uint8Array(sol));

  it("fixture sanity: the drained() helper really zeroes the owed legs", () => {
    assert.equal(legs.lpOwed, 13_690_922n);
    assert.equal(legs.stakeOwed, 4_563_668n);
    const d = readFeeLegs(new Uint8Array(drained(sol, { lp: true, stake: true })));
    assert.equal(d.lpOwed, 0n);
    assert.equal(d.stakeOwed, 0n);
    assert.equal(d.protocolOwed, legs.protocolOwed, "protocol untouched");
  });

  it("cranks BOTH legs, and is safe once both are drained (protocol/creator only warn)", async () => {
    const calls: string[] = [];
    const deps: PreResolveDeps = {
      crankLp: async () => { calls.push("78"); return "cranked"; },
      pushStake: async () => { calls.push("87+12"); return { kind: "done", detail: "ok" }; },
    };
    const k = conn(sol, drained(sol, { lp: true, stake: true }));
    const r = await drainFeeLegsBeforeResolve(k.c, Keypair.generate(), SOL, false, CFG, undefined, deps);
    assert.deepEqual(calls, ["78", "87+12"]);
    assert.equal(r.safeToResolve, true, JSON.stringify(r.blockers));
    assert.equal(r.warnings.length, 2, "protocol + creator must be claimed before CloseSlab");
  });

  it("NOT safe while the staker leg is still owed — e.g. SOL today (Custom(56), unbound)", async () => {
    const deps: PreResolveDeps = {
      crankLp: async () => "cranked",
      pushStake: async () => ({ kind: "blocked", reason: "Custom(56) StakePoolAuthorityMismatch" }),
    };
    const k = conn(sol, drained(sol, { lp: true, stake: false }));
    const r = await drainFeeLegsBeforeResolve(k.c, Keypair.generate(), SOL, false, CFG, undefined, deps);
    assert.equal(r.safeToResolve, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0], /staker leg 4563668 atoms.*Custom\(56\)/);
  });

  it("NOT safe while the LP leg is owed (no LP vault on curated markets, F1)", async () => {
    const deps: PreResolveDeps = {
      crankLp: async () => "skipped",
      pushStake: async () => ({ kind: "done", detail: "ok" }),
    };
    const k = conn(sol, drained(sol, { lp: false, stake: true }));
    const r = await drainFeeLegsBeforeResolve(k.c, Keypair.generate(), SOL, false, CFG, undefined, deps);
    assert.equal(r.safeToResolve, false);
    assert.match(r.blockers[0], /LP leg 13690922 atoms.*skipped/);
  });

  it("nothing owed -> no cranks at all, safe", async () => {
    const empty = drained(sol, { lp: true, stake: true });
    const calls: string[] = [];
    const deps: PreResolveDeps = {
      crankLp: async () => { calls.push("78"); return "cranked"; },
      pushStake: async () => { calls.push("87"); return { kind: "done", detail: "" }; },
    };
    const r = await drainFeeLegsBeforeResolve(conn(empty, empty).c, Keypair.generate(), SOL, false, CFG, undefined, deps);
    assert.deepEqual(calls, []);
    assert.equal(r.safeToResolve, true);
  });

  it("dry-run judges on the pre-state (nothing was sent), so owed legs stay blockers", async () => {
    const deps: PreResolveDeps = { crankLp: async () => "skipped", pushStake: async () => ({ kind: "skipped", reason: "DRY-RUN" }) };
    const k = conn(sol, sol);
    const r = await drainFeeLegsBeforeResolve(k.c, Keypair.generate(), SOL, true, CFG, undefined, deps);
    assert.equal(k.reads(), 1, "no after-read in dry-run");
    assert.equal(r.safeToResolve, false);
  });
});
