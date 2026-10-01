/**
 * `bankrupt-close-expiring` (P3 FINAL 58e379f1 adopts upstream 13b3a8b2: an expired
 * bankrupt close with residual lets any crank move a Live market to Recovery ->
 * Resolved). Real bytes: the two live devnet portfolios with an active close ledger
 * (TEXTIT 5oYeGqkw…, Murphy EXgiHLfx…; both finalized, residual 0, captured
 * 2026-09-30). Pending cases are those accounts with finalized cleared and a residual set.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { CLOSE_PROGRESS_LEN, CLOSE_PROGRESS_OFF, decodeCloseProgress, hasPendingResidual, watchBankruptCloses } from "./bankrupt-close-watch.ts";
import { FeeJobFailureTracker } from "./fee-jobs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const TEXTIT = "DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG";
const PF_A = new PublicKey("5oYeGqkwRJTawiYN1Tszsg773BUKpNLgEpSE8h6jDQbe");
const CFG = { wrapperProgramId: WRAPPER, warnSlots: 3_000n };

const pending = (residual: bigint, extra: { canceled?: boolean } = {}): Buffer => {
  const b = Buffer.from(fx("finalized-close-portfolio-a-v18"));
  b[CLOSE_PROGRESS_OFF + 1] = 0; // not finalized
  if (extra.canceled) b[CLOSE_PROGRESS_OFF + 2] = 1;
  b.writeBigUInt64LE(residual & 0xffff_ffff_ffff_ffffn, CLOSE_PROGRESS_OFF + 168);
  b.writeBigUInt64LE(residual >> 64n, CLOSE_PROGRESS_OFF + 176);
  return b;
};
const marketBytes = (mode = 0) => { const b = Buffer.from(fx("textit-market-v18-fees")); b[592 + 626] = mode; return b; };
const MAX = 505_601_545n; // the real ledger's max_close_slot

function conn(portfolio: Buffer, nowSlot: bigint, mode = 0) {
  const seenFilters: unknown[] = [];
  return {
    seenFilters,
    conn: {
      async getMultipleAccountsInfo() { return [{ data: marketBytes(mode) }]; },
      async getSlot() { return Number(nowSlot); },
      async getProgramAccounts(_p: PublicKey, o: { dataSlice: { offset: number; length: number }; filters: unknown[] }) {
        seenFilters.push(o);
        const active = portfolio[CLOSE_PROGRESS_OFF] === 1;
        return active ? [{ pubkey: PF_A, account: { data: portfolio.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) } }] : [];
      },
    },
  };
}

describe("close-progress ledger decode (engine 35ddd692 offsets)", () => {
  it("REAL bytes: both live active ledgers decode as finalized close #1 with 0 residual and a plausible max_close_slot", () => {
    for (const [f, max] of [["finalized-close-portfolio-a-v18", 505_601_545n], ["finalized-close-portfolio-b-v18", 505_412_659n]] as const) {
      const c = decodeCloseProgress(new Uint8Array(fx(f)))!;
      assert.deepEqual([c.active, c.finalized, c.canceled, c.closeId, c.residualRemaining, c.maxCloseSlot], [true, true, false, 1n, 0n, max]);
      assert.equal(hasPendingResidual(c), false, "finalized, nothing pending: must never alert");
    }
  });
  it("slice decode == full-account decode (the 184-byte getProgramAccounts slice)", () => {
    const full = fx("finalized-close-portfolio-a-v18");
    assert.deepEqual(decodeCloseProgress(new Uint8Array(full.subarray(CLOSE_PROGRESS_OFF, CLOSE_PROGRESS_OFF + CLOSE_PROGRESS_LEN)), true), decodeCloseProgress(new Uint8Array(full)));
  });
  it("every other captured portfolio has an empty ledger", () => {
    for (const f of ["ansem-bankrupt-portfolio-v18", "sol-trader-portfolio-v18", "cate-trader-portfolio-v18", "paid-pf-22hRxRE6"]) {
      assert.equal(decodeCloseProgress(new Uint8Array(fx(f)))!.active, false, f);
    }
  });
});

describe("bankrupt-close-expiring", () => {
  it("the scan is filtered to this market's portfolios with active == 1, and sliced to the ledger", async () => {
    const c = conn(pending(5n), MAX - 10_000n);
    await watchBankruptCloses(c.conn as never, TEXTIT, CFG);
    const o = c.seenFilters[0] as { dataSlice: { offset: number; length: number }; filters: Array<{ memcmp?: { offset: number; bytes: string } }> };
    assert.deepEqual(o.dataSlice, { offset: 9185, length: 184 });
    assert.ok(o.filters.some((f) => f.memcmp?.offset === 16 && f.memcmp.bytes === TEXTIT));
    assert.ok(o.filters.some((f) => f.memcmp?.offset === 9185 && f.memcmp.bytes === "2"), "base58 '2' = [0x01]");
  });
  it("far from expiry: nothing", async () => {
    assert.equal((await watchBankruptCloses(conn(pending(5n), MAX - 10_000n).conn as never, TEXTIT, CFG)).kind, "nothing");
  });
  it("within N slots with residual: WARN naming market, portfolio and residual", async () => {
    const o = await watchBankruptCloses(conn(pending(1_635_213n), MAX - 100n).conn as never, TEXTIT, CFG) as { kind: string; severity?: string; alertKind?: string; reason: string };
    assert.equal(o.kind, "blocked");
    assert.equal(o.alertKind, "bankrupt-close-expiring");
    assert.equal(o.severity, "warn");
    assert.ok(o.reason.includes(TEXTIT) && o.reason.includes(PF_A.toBase58()) && o.reason.includes("residual 1635213") && o.reason.includes("100 slots left"), o.reason);
  });
  it("expired with residual: CRITICAL (any crank can now escalate to Recovery -> Resolved)", async () => {
    const o = await watchBankruptCloses(conn(pending(1_635_213n), MAX + 1n).conn as never, TEXTIT, CFG) as { severity?: string; reason: string };
    assert.equal(o.severity, "critical");
    assert.match(o.reason, /EXPIRED.*expired 1 slots ago/);
    const a = new FeeJobFailureTracker().alertsFor({ job: "bankrupt-close-watch", done: [], nothing: 0, skipped: [], failed: [], events: [], blocked: [{ market: TEXTIT, label: "TEXTIT", reason: o.reason, alertKind: "bankrupt-close-expiring", severity: "critical" }] });
    assert.deepEqual(a.map((x) => [x.kind, x.severity]), [["bankrupt-close-expiring", "critical"]]);
  });
  it("REAL finalized ledgers past max_close_slot: no alert (nothing pending)", async () => {
    assert.equal((await watchBankruptCloses(conn(fx("finalized-close-portfolio-a-v18"), MAX + 1_000n).conn as never, TEXTIT, CFG)).kind, "nothing");
  });
  it("canceled close: no alert", async () => {
    assert.equal((await watchBankruptCloses(conn(pending(5n, { canceled: true }), MAX + 1n).conn as never, TEXTIT, CFG)).kind, "nothing");
  });
  it("not Live (Recovery / Resolved): no alert — the valve is Live-only", async () => {
    assert.equal((await watchBankruptCloses(conn(pending(5n), MAX + 1n, 2).conn as never, TEXTIT, CFG)).kind, "nothing");
    assert.equal((await watchBankruptCloses(conn(pending(5n), MAX + 1n, 1).conn as never, TEXTIT, CFG)).kind, "nothing");
  });
});
