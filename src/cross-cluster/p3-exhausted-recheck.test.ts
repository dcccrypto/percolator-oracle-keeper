/** Lead: a market marked exhausted must be re-verified, else a refilled market is starved of mark pushes. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ExhaustedRegistry, makeExhaustedResolveJob } from "./p3-exhausted-resolve.ts";
import { CFG_LAST_GOOD_ORACLE_SLOT, CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS, CONFIG_OFF } from "./market-state.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const KEEPER = Keypair.generate();
const LAST_GOOD = 505_231_142n;
const SHORT = "Program log: p3_senior_draw deficit=9000 moved=4000 unfunded=5000 even=4000 odd=0";
const FUNDED = "Program log: p3_senior_draw deficit=9000 moved=9000 unfunded=0 even=9000 odd=0";

function conn(o: { logs: string[]; err?: unknown }) {
  const b = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18.b64"), "utf8").trim(), "base64");
  b.writeBigUInt64LE(1_000n, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
  b.writeBigUInt64LE(LAST_GOOD, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  return {
    async getMultipleAccountsInfo() { return [{ data: b }]; },
    async getSlot() { return Number(LAST_GOOD + 10n); },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
    async simulateTransaction() { return { value: { err: o.err ?? null, logs: o.logs } }; },
  };
}
const run = (reg: ExhaustedRegistry, c: ReturnType<typeof conn>) =>
  makeExhaustedResolveJob({ wrapperProgramId: WRAPPER_PROGRAM_ID, registry: reg, vaultLpFor: async () => Keypair.generate().publicKey, withholdPushes: true })
    .run({ conn: c as never, keeper: KEEPER, dryRun: true }, { marketAddress: SOL, label: "SOL" });

describe("p3-exhausted re-verification", () => {
  it("pots refilled (second observation sim unfunded=0): entry cleared, pushes resume", async () => {
    const reg = new ExhaustedRegistry();
    assert.equal((await run(reg, conn({ logs: [SHORT] }))).kind, "blocked");
    assert.equal(reg.shouldWithholdPush(SOL, true), true);
    const o = await run(reg, conn({ logs: [FUNDED] }));
    assert.equal(reg.has(SOL), false);
    assert.equal(reg.shouldWithholdPush(SOL, true), false);
    assert.equal(o.kind, "done");
  });
  it("still exhausted: entry kept", async () => {
    const reg = new ExhaustedRegistry();
    await run(reg, conn({ logs: [SHORT] }));
    assert.equal((await run(reg, conn({ logs: [SHORT] }))).kind, "blocked");
    assert.equal(reg.has(SOL), true);
  });
  it("observation sim errors (e.g. stale oracle): entry kept, not cleared on uncertainty", async () => {
    const reg = new ExhaustedRegistry();
    await run(reg, conn({ logs: [SHORT] }));
    await run(reg, conn({ logs: [], err: { InstructionError: [1, { Custom: 5 }] } }));
    assert.equal(reg.has(SOL), true);
  });
});
