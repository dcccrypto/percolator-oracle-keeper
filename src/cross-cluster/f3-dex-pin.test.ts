/**
 * v2.2 DEATH F-3 (percolator-prog #564, `fix/v22-f1-f3-wrapper` @ 4db44b69): while an asset's depth is pinned to its DEX pool
 * (growth byte 44 bit 6), the wrapper refuses a mode-1 (keeper-attested) PushAuthMark WHOLE with 129, mark included. The keeper
 * must never send one there, and must fall back to a non-mode-1 push in the same round if it ever gets that 129.
 *
 * Market bytes: the real v2.2 devnet capture `k6-2xhs-market-v22` with asset 0's growth record replaced by a record LiteSVM
 * produced on the canonical wrapper .so (death2-build1.so, sha256 7bdadf4a...; fixture copied from percolator-sdk).
 * Run with: node --import tsx/esm --test src/cross-cluster/f3-dex-pin.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assetGrowthAccountOffsetV19, LAYOUT_V22, V17_MAGIC, V17_EXPECTED_VERSION, V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN, V17_ASSET_ORACLE_WRAPPER_LEN, V17_ASSET_CONTROL_SEQUENCES_OFF } from "@percolatorct/sdk";
import { fx, fxJson } from "./p2b-test-helpers.ts";
import { deriveDepthSource } from "./depth-source.ts";
import type { DexDepthPin } from "./depth-source.ts";
import { pushAuthMarkBatch, readDexPinned, resetF3PinStateForTests, getQuarantinedMarkets, WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

type Rec = { accountOffset: number; byte44: string; hex: string };
const FX = fxJson<{ records: Record<string, Rec> }>("v22-f3-dex-pin-records.json");
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
const PUMP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const DEPTH = { depthE6: 9_852_457_023n, source: "pumpswap-cpmm" };
const k = () => Keypair.generate().publicKey;

/** The real v2.2 market with asset 0's growth record = a LiteSVM-produced record. */
function v22Market(record: keyof typeof FX.records | null): Uint8Array {
  const b = new Uint8Array(fx("k6-2xhs-market-v22"));
  if (record) {
    const r = FX.records[record]!;
    assert.equal(r.accountOffset, assetGrowthAccountOffsetV19(0, LAYOUT_V22), "LiteSVM offset == SDK v2.2 offset");
    b.set(Buffer.from(r.hex, "hex"), r.accountOffset);
  }
  return b;
}
/** A minimal account the generation parser accepts but the growth decoder cannot read (pin state UNKNOWN). */
function opaqueMarket(): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, 100n, true);
  return buf;
}

type Ix = { keys: Array<{ pubkey: PublicKey }>; data: Uint8Array };
const mode = (ix: Ix): number | null => (ix.data.length === 35 ? null : (ix.data[35] as number));
/**
 * Fake chain that applies the wrapper's F-3 guard: a mode-1 push on a market in `pinnedOnChain` is refused with 129 (whole push);
 * a mode-2 push on a market in `refuseMode2` is refused with 129 (pin mismatch). `data` = what the generation read returns.
 */
function chain(data: Map<string, Uint8Array>, pinnedOnChain: Set<string>, refuseMode2 = new Set<string>()) {
  const simulated: Ix[][] = [];
  const sent: Ix[][] = [];
  return {
    simulated, sent,
    conn: {
      async getMultipleAccountsInfo(pks: PublicKey[]) { return pks.map((p) => ({ data: data.get(p.toBase58()) ?? opaqueMarket() })); },
      async simulateTransaction(tx: { instructions: Ix[] }) {
        const ixs = tx.instructions.slice(1);
        simulated.push(ixs);
        for (let i = 0; i < ixs.length; i++) {
          const m = ixs[i]!.keys[1]!.pubkey.toBase58();
          const md = mode(ixs[i]!);
          if ((md === 1 && pinnedOnChain.has(m)) || (md === 2 && refuseMode2.has(m))) {
            return { value: { err: { InstructionError: [i + 1, { Custom: 129 }] } } };
          }
        }
        return { value: { err: null } };
      },
      async sendRawTransaction() { sent.push(simulated[simulated.length - 1]!); return `sig${sent.length}`; },
    },
  };
}
const pinFor = (market: string): DexDepthPin => ({
  depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, new PublicKey(market)), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 0, marketId: 1n,
});
const push = (m: string, extra: object = {}) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n, ...extra });
const ixOf = (txs: Ix[][], m: string): Ix[] => txs.flat().filter((ix) => ix.keys[1]!.pubkey.toBase58() === m);
async function quiet<T>(f: () => Promise<T>): Promise<{ r: T; warns: string[] }> {
  const warns: string[] = [];
  const [w, e] = [console.warn, console.error];
  console.warn = (x: unknown) => { warns.push(String(x)); };
  console.error = (x: unknown) => { warns.push(String(x)); };
  try { return { r: await f(), warns }; } finally { console.warn = w; console.error = e; }
}
const f3Events = (warns: string[]): Array<Record<string, unknown>> =>
  warns.filter((w) => w.startsWith("[push][F3] ")).map((w) => JSON.parse(w.slice("[push][F3] ".length)) as Record<string, unknown>);

beforeEach(() => resetF3PinStateForTests());

describe("readDexPinned (SDK isDexPinned on the live growth record)", () => {
  it("LiteSVM records: unpinned 0x01 -> false, tag 123 op 1 0x41 -> true, after mode 2 0xc6 -> true, after op 0 0x86 -> false", () => {
    assert.equal(readDexPinned(v22Market("unpinned_after_mode1"), 0), false);
    assert.equal(readDexPinned(v22Market("pinned_after_tag123_op1"), 0), true);
    assert.equal(readDexPinned(v22Market("pinned_after_mode2"), 0), true);
    assert.equal(readDexPinned(v22Market("cleared_after_tag123_op0"), 0), false);
  });
  it("growth off -> false; unreadable -> null (unknown), never throws", () => {
    assert.equal(readDexPinned(v22Market(null), 0), false);
    assert.equal(readDexPinned(opaqueMarket(), 0), null);
    assert.equal(readDexPinned(new Uint8Array(3), 0), null);
  });
});

describe("pusher: a DEX-pinned market never gets a mode-1 push", () => {
  it("pinned on chain, no usable pin in the cache, a depth this cycle -> 35 B (no mode 1 ever simulated), logged once structurally", async () => {
    const a = k().toBase58();
    const c = chain(new Map([[a, v22Market("pinned_after_tag123_op1")]]), new Set([a]));
    const { r, warns } = await quiet(async () => {
      const r1 = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH })], 100n, BLOCKHASH, false);
      await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH })], 101n, BLOCKHASH, false);
      return r1;
    });
    assert.equal(r.count, 1, "the price still goes out");
    assert.ok(ixOf(c.simulated, a).every((ix) => mode(ix) !== 1), "mode 1 is never even simulated");
    assert.ok(ixOf(c.sent, a).length === 2 && ixOf(c.sent, a).every((ix) => ix.data.length === 35 && ix.keys.length === 2));
    const ev = f3Events(warns);
    assert.equal(ev.length, 1, "logged once");
    assert.deepEqual([ev[0]!.event, ev[0]!.market, ev[0]!.depthSource], ["depth_mode1_suppressed_dex_pinned", a, "chain"]);
  });

  it("pinned on chain with a usable pin -> mode 2 (unchanged)", async () => {
    const a = k().toBase58();
    const c = chain(new Map([[a, v22Market("pinned_after_mode2")]]), new Set([a]));
    const { r } = await quiet(() => pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH })], 100n, BLOCKHASH, false));
    assert.deepEqual(r.dexPushedMarkets, [a]);
    assert.deepEqual(ixOf(c.sent, a).map(mode), [2]);
  });

  it("pinned + mode 2 refused (pin mismatch, 129) -> 35 B this round, NOT mode 1; no strike", async () => {
    const a = k().toBase58();
    const c = chain(new Map([[a, v22Market("pinned_after_mode2")]]), new Set([a]), new Set([a]));
    const { r, warns } = await quiet(() => pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH })], 100n, BLOCKHASH, false));
    assert.equal(r.count, 1);
    assert.deepEqual(r.dexRefusedMarkets, [a]);
    assert.ok(ixOf(c.simulated, a).every((ix) => mode(ix) !== 1), "the mode-2 fallback skips mode 1 on a pinned market");
    assert.deepEqual(ixOf(c.sent, a).map((ix) => ix.data.length), [35]);
    assert.ok(!getQuarantinedMarkets().includes(a));
    assert.ok(f3Events(warns).some((e) => e.event === "depth_mode2_refused_129_on_pinned"));
  });

  it("129 on a mode-1 push (pin unknown to the read): structured log, resent as 35 B in the SAME round, no strike; next cycle suppressed up front", async () => {
    const [a, b] = [k().toBase58(), k().toBase58()];
    const c = chain(new Map(), new Set([a])); // opaque accounts: pin state unknown to the read; the chain still enforces it
    const { r, warns } = await quiet(async () => {
      const r1 = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH }), push(b, { depth: DEPTH })], 100n, BLOCKHASH, false);
      const before = c.simulated.length;
      await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH })], 101n, BLOCKHASH, false);
      assert.ok(ixOf(c.simulated.slice(before), a).every((ix) => mode(ix) !== 1), "learned: no mode 1 on the next cycle");
      return r1;
    });
    assert.equal(r.count, 2, "neither market loses its price");
    assert.deepEqual(new Set(r.pushedMarkets), new Set([a, b]));
    const sentA = ixOf(c.sent, a);
    assert.equal(sentA[0]!.data.length, 35, "fell back to 35 B in the same round");
    assert.deepEqual(ixOf(c.sent, b).map(mode), [1], "the unpinned market keeps its attested depth");
    const ev = f3Events(warns).filter((e) => e.event === "depth_mode1_refused_129_dex_pinned");
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]!.code, ev[0]!.market, ev[0]!.assetIndex], [129, a, 0]);
    assert.ok(!getQuarantinedMarkets().includes(a));
    assert.ok(!warns.some((w) => w.includes("QUARANTINE")));
  });

  it("a learned pin is forgotten once the live read says unpinned (tag 123 op 0)", async () => {
    const a = k().toBase58();
    const data = new Map<string, Uint8Array>();
    const pinned = new Set([a]);
    const c = chain(data, pinned);
    await quiet(() => pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH })], 100n, BLOCKHASH, false));
    pinned.delete(a);
    data.set(a, v22Market("cleared_after_tag123_op0"));
    const before = c.sent.length;
    await quiet(() => pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH })], 101n, BLOCKHASH, false));
    assert.deepEqual(ixOf(c.sent.slice(before), a).map(mode), [1], "mode 1 resumes after the clear");
  });
});

describe("pusher: unpinned markets are unchanged", () => {
  it("unpinned growth record -> mode 1 with the depth, no F-3 log", async () => {
    const a = k().toBase58();
    const c = chain(new Map([[a, v22Market("unpinned_after_mode1")]]), new Set());
    const { r, warns } = await quiet(() => pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { depth: DEPTH })], 100n, BLOCKHASH, false));
    assert.equal(r.count, 1);
    const ix = ixOf(c.sent, a)[0]!;
    assert.equal(mode(ix), 1);
    assert.equal(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(36, true), DEPTH.depthE6);
    assert.equal(f3Events(warns).length, 0);
  });
  it("growth off / no depth -> byte-identical 35 B", async () => {
    const a = k().toBase58();
    const c = chain(new Map([[a, v22Market(null)]]), new Set());
    await quiet(() => pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a)], 100n, BLOCKHASH, false));
    assert.deepEqual(ixOf(c.sent, a).map((ix) => [ix.data.length, ix.keys.length]), [[35, 2]]);
  });
});
