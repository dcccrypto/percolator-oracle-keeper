/**
 * B7 (E2E 2026-09-30): a Custom(22) EngineNonProgress on every boot, from the
 * loop's first cycle re-cranking the slot the boot crank already covered.
 * Fixed twice: (1) the boot crank's state is handed to the loop and a market
 * already cranked at that slot is not cranked again; (2) a Custom(22) on the
 * accrual crank while the engine clock is current is classified benign (not a
 * revert). Real SOL market bytes (current_slot @ group+613 patched).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { crankAllOnce, crankOneMarket, freshCrankMarketState, isBenignNoProgress } from "./recovery-cranker.ts";
import { buildObservationCrankIx, decodeMarketRefreshState } from "./positioned-refresh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SOL = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const KEEPER = Keypair.generate();
const LP = Keypair.generate().publicKey;
const BYTES = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
const ENGINE_SLOT = decodeMarketRefreshState(new Uint8Array(BYTES)).currentSlot;
const OBS_DATA = Buffer.from(buildObservationCrankIx(KEEPER.publicKey, SOL, LP).data);

/** readSlot = the slot the market is read (and simulated) at. */
function conn(readSlot: bigint, simCode: number | null) {
  const calls = { sims: 0, sends: 0 };
  const c = {
    async getAccountInfoAndContext() { return { context: { slot: Number(readSlot) }, value: { data: BYTES, owner: SOL, lamports: 1, executable: false } }; },
    async getProgramAccounts() { return []; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      calls.sims++;
      if (simCode === null) return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [] } };
      const idx = tx.message.compiledInstructions.findIndex((ix) => Buffer.from(ix.data).equals(OBS_DATA));
      return { context: { slot: 1 }, value: { err: { InstructionError: [idx, { Custom: simCode }] }, logs: [], accounts: [] } };
    },
    async sendRawTransaction() { calls.sends++; return "sig"; },
  };
  return { conn: c, calls };
}
const entry = { marketAddress: SOL.toBase58(), label: "SOL", lpPortfolio: LP.toBase58() };

describe("B7: benign no-progress classification", () => {
  const plan = { cranks: [{ kind: "accrue" as const, portfolio: LP, ix: buildObservationCrankIx(KEEPER.publicKey, SOL, LP) }] };
  it("22 on the accrual crank with the engine clock current: benign", () => {
    assert.equal(isBenignNoProgress({ InstructionError: [1, { Custom: 22 }] }, plan, { currentSlot: 100n }, 101n), true);
  });
  it("22 with the clock BEHIND, another code, or a non-accrual instruction: a real revert", () => {
    assert.equal(isBenignNoProgress({ InstructionError: [1, { Custom: 22 }] }, plan, { currentSlot: 100n }, 200n), false);
    assert.equal(isBenignNoProgress({ InstructionError: [1, { Custom: 19 }] }, plan, { currentSlot: 100n }, 100n), false);
    const repairPlan = { cranks: [{ kind: "repair" as const, portfolio: SOL, ix: plan.cranks[0].ix }] };
    assert.equal(isBenignNoProgress({ InstructionError: [1, { Custom: 22 }] }, repairPlan, { currentSlot: 100n }, 100n), false);
    assert.equal(isBenignNoProgress({ InstructionError: [1, { Custom: 22 }] }, plan, null, 100n), false);
  });
});

describe("B7: crankOneMarket on real SOL bytes", () => {
  it("engine clock current + 22 on accrual: not counted as a revert, nothing sent", async () => {
    const c = conn(ENGINE_SLOT + 1n, 22);
    const st = freshCrankMarketState();
    await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
    assert.equal(st.totalReverts, 0);
    assert.equal(st.consecutiveReverts, 0);
    assert.equal(st.benignNoProgress, 1);
    assert.equal(c.calls.sends, 0);
  });
  it("engine clock BEHIND + 22: still a real revert (control)", async () => {
    const c = conn(ENGINE_SLOT + 200n, 22);
    const st = freshCrankMarketState();
    await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
    assert.equal(st.totalReverts, 1);
    assert.equal(st.benignNoProgress, 0);
  });
  it("dedupe: a market already cranked at this slot is not simulated again", async () => {
    const c = conn(ENGINE_SLOT, null);
    const st = freshCrankMarketState();
    st.lastCrankSlot = ENGINE_SLOT;
    await crankOneMarket(c.conn as never, KEEPER, entry, st, false);
    assert.equal(c.calls.sims, 0);
    assert.equal(st.totalReverts, 0);
  });
  it("boot -> loop: crankAllOnce returns each market's state with the landed crank's slot, for the loop to reuse", async () => {
    const c = conn(ENGINE_SLOT + 1n, null);
    const states = await crankAllOnce(c.conn as never, KEEPER, { markets: [entry] } as never, false);
    const st = states.get(SOL.toBase58());
    assert.ok(st, "boot state handed out");
    assert.equal(st!.lastCrankSlot, ENGINE_SLOT + 1n);
    // the loop's first cycle, same slot: no second crank
    const again = conn(ENGINE_SLOT + 1n, 22);
    await crankOneMarket(again.conn as never, KEEPER, entry, st!, false);
    assert.equal(again.calls.sims, 0);
    assert.equal(st!.totalReverts, 0);
  });
});
void Transaction;
