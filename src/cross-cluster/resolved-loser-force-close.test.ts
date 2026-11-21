/**
 * SEC-RC §S16AC Info I-S1 (S1-6 a/c, engine e59aa6a6): after a Resolved market's force-close delay the keeper closes the
 * claimants that are not waiting (the loss side) so a winner refused with EngineLockActive (21) is released.
 *
 * Fixtures:
 *   - the real Resolved v2.2 CODEC market DJM81s8h… (resolved_slot 509,455,455, force_close_delay_slots 216,000) and
 *     its 3 portfolios (devnet 2026-10-12; shared with k10-resolved-cleanup-v22.test.ts). 5sx1tsw1 is the vault LP
 *     (registry-owned), 5vYAD3RK plays the LOSER and 6UW2ecEZ the WINNER in the fake engine below;
 *   - the first 4096 ELF bytes of the canonical builds (RC-S16AC.md §2/§8.1, RC.md): rc-s16ac ddd5a2fa,
 *     rollback-s16ac bae71e12 (both engine e59aa6a6), and as negative controls the RC 357fc23f and its rollback fac4d19c.
 *
 * The fake chain models the wrapper's gate (src/v16_program.rs:29094-29099: an unsigned owner before the delay gets
 * ExpectedSigner = Custom 6) and the engine wait (e59aa6a6 src/v16.rs:24542: a winner whose loss side still holds a
 * claim gets LockActive = Custom 21) ONLY when the deployed ELF is an S1-6 a/c build. The keeper has no LiteSVM harness;
 * the engine-exact behaviour is the engine suite's (RC-S16AC §8.2), this pins the keeper's decisions.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/resolved-loser-force-close.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import {
  forceCloseResolvedLosers,
  forceCloseWindow,
  LoserForceCloseState,
  makeResolvedLoserForceCloseJob,
  loserForceCloseConfigFromEnv,
  type LoserForceCloseConfig,
} from "./resolved-loser-force-close.ts";
import { classifyS16acElfPrefix, S16acGateState, s16acEngineDeployed } from "./s16ac-engine-gate.ts";
import { pdaOwnerKind } from "./resolved-portfolio-cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const NFT = new PublicKey("27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1");
const CODEC = new PublicKey("DJM81s8hi5KnozZrgL5MzdJ8sN1mnxBzAY17VBTVkxwU");
const MARKET = new Uint8Array(fx("v22-codec-market-v19-resolved"));
const RESOLVED_SLOT = 509_455_455n;
const DELAY = 216_000n;
const VAULT_LP = new PublicKey("5sx1tsw1uBRh743GtFr1UeeAfAxHUR3mECGGe9dWronA");
const LOSER = new PublicKey("5vYAD3RKNjMm8GsV6rLQowDaJZnjt1z5z4tLYLtYowSV");
const WINNER = new PublicKey("6UW2ecEZiVR9iVNx8f2gMXrT9QcNP5WhVYto39pFZiaK");
const ELF = {
  s16ac: fx("wrapper-elf4096-rc-s16ac-ddd5a2fa"),
  s16acRollback: fx("wrapper-elf4096-rollback-s16ac-bae71e12"),
  rc: fx("wrapper-elf4096-rc-357fc23f"),
  rcRollback: fx("wrapper-elf4096-rollback-fac4d19c"),
  // RC2 (RC2.md §3): the build that will ship. Its S1-6 a/c pair must read ON, plain RC2 / rollback2 OFF.
  rc2s16ac: fx("wrapper-elf4096-rc2-s16ac-4fe8fd53"),
  rc2s16acRollback: fx("wrapper-elf4096-rollback2-s16ac-b6aec357"),
  rc2: fx("wrapper-elf4096-rc2-cc720a0e"),
  rc2Rollback: fx("wrapper-elf4096-rollback2-8b57d488"),
  // RC2.2 (Option B, 2026-10-22): canonical = the S1-6 a/c twin; the plain twins must read OFF.
  rc22s16ac: fx("wrapper-elf4096-rc22-s16ac-776d2491"),
  rc22s16acRollback: fx("wrapper-elf4096-rollback4b-s16ac-3958c36b"),
  rc22: fx("wrapper-elf4096-rc22-9b630735"),
  rc22Rollback: fx("wrapper-elf4096-rollback4b-71a891b9"),
};
const PROGRAMDATA = PublicKey.unique();

const CFG = (over: Partial<LoserForceCloseConfig> = {}): LoserForceCloseConfig => ({
  wrapperProgramId: WRAPPER,
  nftProgramId: NFT,
  maxScanPerCycle: 32,
  maxClosesPerCycle: 8,
  maxChunkCallsPerPortfolio: 16,
  maxAtaCreatesPerCycle: 4,
  gateTtlMs: 600_000,
  confirm: { statusRetries: 0, statusRetryDelayMs: 0 },
  log: () => {},
  ...over,
});

/** The offset of a portfolio's u128 `capital` (found by value, asserted unique and confirmed by the SDK parser). */
function capitalOffset(d: Uint8Array): number {
  const cap = parsePortfolioV17(d).capital;
  const want = Buffer.alloc(16);
  want.writeBigUInt64LE(cap & ((1n << 64n) - 1n), 0);
  want.writeBigUInt64LE(cap >> 64n, 8);
  const hits: number[] = [];
  for (let i = 0; i + 16 <= d.length; i++) if (Buffer.from(d.subarray(i, i + 16)).equals(want)) hits.push(i);
  for (const h of hits) {
    const z = new Uint8Array(d);
    z.fill(0, h, h + 16);
    if (parsePortfolioV17(z).capital === 0n) return h;
  }
  throw new Error("capital offset not found");
}

/**
 * A tiny fake chain. `chunks` = CloseResolved calls the loser needs (one progress chunk, then the final one that empties
 * it). The winner waits (21) while the loser holds a claim, but only under an S1-6 a/c ELF.
 */
function world(o: { elf: Buffer | null; nowSlot: bigint; chunks?: number; loserEscrowedPayout?: boolean }) {
  const state = new Map<string, Uint8Array>();
  for (const [k, n] of [[VAULT_LP, "v22-codec-pf-5sx1tsw1"], [LOSER, "v22-codec-pf-5vYAD3RK"], [WINNER, "v22-codec-pf-6UW2ecEZ"]] as const) {
    state.set(k.toBase58(), new Uint8Array(fx(n)));
  }
  let loserChunksLeft = o.chunks ?? 2;
  const log = { sims: 0, sends: 0, simTargets: [] as string[], sendTargets: [] as string[], programReads: 0 };
  const s16ac = o.elf !== null && classifyS16acElfPrefix(new Uint8Array(o.elf)) === "s16ac";
  const holdsClaim = (d: Uint8Array): boolean => {
    const p = parsePortfolioV17(d);
    return p.capital !== 0n || p.pnl !== 0n || p.reservedPnl !== 0n || p.legs.some((l) => l.active);
  };
  /** Apply (or preview) one CloseResolved on `pf`: { err, post }. */
  const closeResolved = (pf: string, ownerSigned: boolean, ixIndex: number, apply: boolean): { err: unknown; post: Uint8Array | null } => {
    const cur = state.get(pf)!;
    if (o.nowSlot - RESOLVED_SLOT < DELAY && !ownerSigned) return { err: { InstructionError: [ixIndex, { Custom: 6 }] }, post: null };
    if (pf === VAULT_LP.toBase58()) return { err: { InstructionError: [ixIndex, { Custom: 107 }] }, post: null };
    if (!holdsClaim(cur)) return { err: null, post: cur }; // nothing left: a no-op
    if (pf === WINNER.toBase58()) {
      if (s16ac && holdsClaim(state.get(LOSER.toBase58())!)) return { err: { InstructionError: [ixIndex, { Custom: 21 }] }, post: null };
      const next = new Uint8Array(cur);
      next.fill(0, capitalOffset(cur), capitalOffset(cur) + 16);
      if (apply) state.set(pf, next);
      return { err: null, post: next };
    }
    if (o.loserEscrowedPayout) return { err: { InstructionError: [ixIndex, { Custom: 6 }] }, post: null };
    const next = new Uint8Array(cur);
    if (loserChunksLeft > 1) next[next.length - 1] ^= 0xff; // a progress chunk
    else next.fill(0, capitalOffset(cur), capitalOffset(cur) + 16); // the final chunk empties it
    if (apply) {
      loserChunksLeft--;
      state.set(pf, next);
    }
    return { err: null, post: next };
  };
  const wrapperIxs = (keys: PublicKey[], ixs: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>, isSigner: (i: number) => boolean) =>
    ixs
      .map((ix, i) => ({ ix, i }))
      .filter(({ ix }) => keys[ix.programIdIndex].equals(WRAPPER) && ix.data[0] === 30)
      .map(({ ix, i }) => ({ pf: keys[ix.accountKeyIndexes[2]].toBase58(), signed: isSigner(ix.accountKeyIndexes[0]), i }));
  const conn = {
    async getAccountInfo(k: PublicKey, _o?: unknown) {
      if (k.equals(WRAPPER)) {
        log.programReads++;
        const d = Buffer.alloc(36);
        d.writeUInt32LE(2, 0);
        PROGRAMDATA.toBuffer().copy(d, 4);
        return { data: d, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), lamports: 1, executable: true };
      }
      if (k.equals(PROGRAMDATA)) return o.elf ? { data: o.elf, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), lamports: 1, executable: false } : null;
      if (k.equals(CODEC)) return { data: Buffer.from(MARKET), owner: WRAPPER, lamports: 1, executable: false };
      return null;
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      // Owner token accounts all exist; the market is read by the job wrapper.
      return keys.map((k) => (k.equals(CODEC) ? { data: Buffer.from(MARKET), owner: WRAPPER, lamports: 1, executable: false } : { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false }));
    },
    async getProgramAccounts(program: PublicKey, q: { filters: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }> }) {
      if (!program.equals(WRAPPER)) return [];
      const size = q.filters.find((f) => f.dataSize !== undefined)?.dataSize;
      const mkt = q.filters.find((f) => f.memcmp?.offset === 16)?.memcmp?.bytes;
      return [...state.entries()]
        .filter(([, d]) => (size === undefined || d.length === size) && (!mkt || new PublicKey(d.subarray(16, 48)).toBase58() === mkt))
        .map(([k, d]) => ({ pubkey: new PublicKey(k), account: { data: Buffer.from(d), owner: WRAPPER, lamports: 1, executable: false } }));
    },
    async getLatestBlockhash() {
      return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 };
    },
    async getSlot() {
      return Number(o.nowSlot);
    },
    async simulateTransaction(tx: VersionedTransaction, opts: { accounts?: { addresses: string[] } }) {
      log.sims++;
      const m = tx.message;
      const calls = wrapperIxs(m.staticAccountKeys, m.compiledInstructions, (i) => m.isAccountSigner(i));
      let err: unknown = null;
      let post: Uint8Array | null = null;
      for (const c of calls) {
        log.simTargets.push(c.pf);
        const r = closeResolved(c.pf, c.signed, c.i, false);
        if (r.err) {
          err = r.err;
          break;
        }
        post = r.post;
      }
      const watch = opts.accounts?.addresses?.[0];
      const data = watch ? (post ?? state.get(watch) ?? null) : null;
      return { context: { slot: 1 }, value: { err, logs: [], accounts: watch && !err && data ? [{ data: [Buffer.from(data).toString("base64"), "base64"] }] : null } };
    },
    async sendRawTransaction(raw: Buffer) {
      log.sends++;
      const tx = Transaction.from(raw);
      const m = tx.compileMessage();
      for (const c of wrapperIxs(m.accountKeys, m.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accountKeyIndexes: ix.accounts, data: Buffer.from(require58(ix.data)) })), (i) => m.isAccountSigner(i))) {
        log.sendTargets.push(c.pf);
        const r = closeResolved(c.pf, c.signed, c.i, true);
        if (r.err) throw new Error(`send would fail: ${JSON.stringify(r.err)}`);
      }
      return PublicKey.unique().toBase58();
    },
    async getSignatureStatuses() {
      return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] };
    },
  };
  return { conn, log, state, holdsClaim };
}

/** Legacy `Message.instructions[].data` is base58. */
function require58(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const AFTER = RESOLVED_SLOT + DELAY + 10n;
const BEFORE = RESOLVED_SLOT + DELAY - 1n;
const run = (w: ReturnType<typeof world>, nowSlot: bigint, st = new LoserForceCloseState(), cfg = CFG(), dryRun = false) =>
  forceCloseResolvedLosers(w.conn as never, Keypair.generate(), CODEC, MARKET, nowSlot, dryRun, cfg, st);

describe("I-S1: the S1-6 a/c engine gate (deployed wrapper ELF fingerprint)", () => {
  it("the variant and its same-engine rollback are S1-6 a/c; the RC and its rollback are not", () => {
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.s16ac)), "s16ac");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.s16acRollback)), "s16ac");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc)), "other");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rcRollback)), "other");
  });
  it("RC2 (the shipping build): rc2-s16ac 4fe8fd53 and rollback2-s16ac b6aec357 are S1-6 a/c; plain RC2 cc720a0e and rollback2 8b57d488 are not", () => {
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc2s16ac)), "s16ac");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc2s16acRollback)), "s16ac");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc2)), "other");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc2Rollback)), "other");
  });
  it("RC2.2 (canonical, Option B): rc22-s16ac 776d2491 and rollback4b-s16ac 3958c36b are S1-6 a/c; plain rc22 9b630735 and rollback4b 71a891b9 are not", () => {
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc22s16ac)), "s16ac");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc22s16acRollback)), "s16ac");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc22)), "other");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(ELF.rc22Rollback)), "other");
  });
  it("unreadable / short / zeroed bytes are unknown (gate off), and unknown is re-read rather than cached", async () => {
    assert.equal(classifyS16acElfPrefix(null), "unknown");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(100)), "unknown");
    assert.equal(classifyS16acElfPrefix(new Uint8Array(4096)), "unknown");
    const w = world({ elf: null, nowSlot: AFTER });
    const st = new S16acGateState();
    assert.deepEqual(await s16acEngineDeployed(w.conn as never, WRAPPER, st, 600_000), { on: false, state: "unknown" });
    await s16acEngineDeployed(w.conn as never, WRAPPER, st, 600_000);
    assert.equal(w.log.programReads, 2);
  });
  it("a known answer is cached for the TTL", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const st = new S16acGateState();
    let t = 0;
    for (let i = 0; i < 3; i++) assert.equal((await s16acEngineDeployed(w.conn as never, WRAPPER, st, 1_000, () => t)).on, true);
    t = 1_000;
    await s16acEngineDeployed(w.conn as never, WRAPPER, st, 1_000, () => t);
    assert.equal(w.log.programReads, 2);
  });
});

describe("I-S1: force-close window = the wrapper's predicate (:29094-29099)", () => {
  it("opens exactly at resolved_slot + force_close_delay_slots (read from the CODEC config: 216,000)", () => {
    assert.deepEqual(
      [forceCloseWindow(DELAY, RESOLVED_SLOT, BEFORE).open, forceCloseWindow(DELAY, RESOLVED_SLOT, RESOLVED_SLOT + DELAY).open],
      [false, true],
    );
    assert.equal(forceCloseWindow(DELAY, RESOLVED_SLOT, BEFORE).slotsLeft, 1n);
    assert.equal(forceCloseWindow(0n, RESOLVED_SLOT, RESOLVED_SLOT).open, true);
    assert.equal(forceCloseWindow(DELAY, RESOLVED_SLOT, 0n).open, false, "an unknown cluster slot never opens it");
  });
  it("the fixture's vault LP is registry-owned (excluded: tag 30 refuses it)", () => {
    const owner = parsePortfolioV17(new Uint8Array(fx("v22-codec-pf-5sx1tsw1"))).owner;
    assert.equal(pdaOwnerKind(owner, CODEC, { wrapperProgramId: WRAPPER, nftProgramId: NFT }), "lp-registry");
  });
});

describe("I-S1: resolved loser force-close (S1-6 a/c deployed)", () => {
  it("BEFORE the delay it does nothing: no program read, no simulation, no send", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: BEFORE });
    const r = await run(w, BEFORE);
    assert.equal(r.outcome, "before-delay");
    assert.equal(r.window?.slotsLeft, 1n);
    assert.deepEqual([w.log.programReads, w.log.sims, w.log.sends], [0, 0, 0]);
    assert.ok(w.holdsClaim(w.state.get(LOSER.toBase58())!));
  });

  it("AFTER the delay it detects the waiting winner (21), closes the loser in bounded chunks, and the winner is released", async () => {
    const lines: string[] = [];
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER, chunks: 2 });
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ log: (l) => lines.push(l) }));
    assert.equal(r.outcome, "closed");
    assert.deepEqual(r.waiting, [WINNER.toBase58()]);
    assert.deepEqual(r.closed, [LOSER.toBase58()]);
    assert.equal(r.calls, 2);
    assert.deepEqual(r.released, [WINNER.toBase58()]);
    assert.ok(!w.holdsClaim(w.state.get(LOSER.toBase58())!), "the loser is emptied");
    assert.ok(w.holdsClaim(w.state.get(WINNER.toBase58())!), "the winner is NOT closed by the keeper (it closes itself)");
    assert.deepEqual(new Set(w.log.sendTargets), new Set([LOSER.toBase58()]), "only the loser was ever sent");
    assert.ok(!w.log.simTargets.includes(VAULT_LP.toBase58()), "the vault LP is never simulated");
    // Structured events.
    const evs = lines.map((l) => JSON.parse(l.replace(/^\[resolved-loser-force-close\] /, "")) as { event: string; market: string });
    assert.deepEqual(evs.map((e) => e.event), ["wait_detected", "loser_force_closed", "winners_released"]);
    assert.ok(evs.every((e) => e.market === CODEC.toBase58()));
  });

  it("IDEMPOTENT: a retry after the close sends nothing (no claimant waits any more)", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const st = new LoserForceCloseState();
    assert.equal((await run(w, AFTER, st)).outcome, "closed");
    const sendsAfterFirst = w.log.sends;
    const r2 = await run(w, AFTER, st);
    assert.equal(r2.outcome, "no-wait");
    assert.deepEqual([r2.closed, r2.waiting, r2.calls], [[], [], 0]);
    assert.equal(w.log.sends, sendsAfterFirst);
    const r3 = await run(w, AFTER, st);
    assert.equal(r3.outcome, "no-wait");
    assert.equal(w.log.sends, sendsAfterFirst);
  });

  it("a chunk cap leaves the rest for the next cycle, which finishes it (never re-sends a no-progress call)", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER, chunks: 3 });
    const st = new LoserForceCloseState();
    const r1 = await run(w, AFTER, st, CFG({ maxChunkCallsPerPortfolio: 2 }));
    assert.deepEqual([r1.outcome, r1.calls, r1.released], ["closed", 2, []], "still waiting after 2 of 3 chunks");
    const r2 = await run(w, AFTER, st, CFG({ maxChunkCallsPerPortfolio: 2 }));
    assert.deepEqual([r2.outcome, r2.calls, r2.released], ["closed", 1, [WINNER.toBase58()]]);
    assert.equal(w.log.sends, 3);
  });

  it("dry-run simulates only", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG(), true);
    assert.equal(w.log.sends, 0);
    assert.deepEqual(r.waiting, [WINNER.toBase58()]);
    assert.ok(w.holdsClaim(w.state.get(LOSER.toBase58())!));
  });

  it("a loser the keeper cannot close (escrowed payout needs the holder) is reported, nothing sent", async () => {
    const lines: string[] = [];
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER, loserEscrowedPayout: true });
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ log: (l) => lines.push(l) }));
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /Custom\(6\)/);
    assert.ok(lines.some((l) => l.includes('"event":"wait_unresolved"')));
  });

  for (const [name, elf] of [["RC2 S1-6 a/c 4fe8fd53", ELF.rc2s16ac], ["RC2 S1-6 a/c rollback2 b6aec357", ELF.rc2s16acRollback], ["RC2.2 S1-6 a/c 776d2491", ELF.rc22s16ac], ["RC2.2 S1-6 a/c rollback4b 3958c36b", ELF.rc22s16acRollback]] as const) {
    it(`deployed ${name}: after the delay the loser is force-closed`, async () => {
      const w = world({ elf, nowSlot: AFTER });
      assert.equal((await run(w, AFTER)).outcome, "closed");
    });
  }

  it("the S1-6 a/c ROLLBACK (bae71e12, same engine) keeps the job on", async () => {
    const w = world({ elf: ELF.s16acRollback, nowSlot: AFTER });
    assert.equal((await run(w, AFTER)).outcome, "closed");
  });

  it("the fee job reads the market + slot and maps 'closed' to done; before the delay to nothing", async () => {
    const job = makeResolvedLoserForceCloseJob(CFG());
    const ctx = (nowSlot: bigint) => ({ conn: world({ elf: ELF.s16ac, nowSlot }).conn as never, keeper: Keypair.generate(), dryRun: false });
    assert.equal((await job.run(ctx(BEFORE), { marketAddress: CODEC.toBase58(), label: "CODEC" })).kind, "nothing");
    assert.equal((await job.run(ctx(AFTER), { marketAddress: CODEC.toBase58(), label: "CODEC" })).kind, "done");
  });
});

describe("I-S1 NEGATIVE CONTROLS: behaviour before the upgrade is unchanged", () => {
  for (const [name, elf] of [["RC 357fc23f", ELF.rc], ["RC rollback fac4d19c", ELF.rcRollback], ["RC2 cc720a0e", ELF.rc2], ["RC2 rollback2 8b57d488", ELF.rc2Rollback], ["RC2.2 plain 9b630735", ELF.rc22], ["RC2.2 plain rollback4b 71a891b9", ELF.rc22Rollback]] as const) {
    it(`deployed ${name}: after the delay the job is inert (one gate read, no simulation, no send)`, async () => {
      const w = world({ elf, nowSlot: AFTER });
      const r = await run(w, AFTER);
      assert.equal(r.outcome, "engine-gate-off");
      assert.deepEqual([w.log.sims, w.log.sends], [0, 0]);
      assert.ok(w.holdsClaim(w.state.get(LOSER.toBase58())!));
    });
  }

  it("CONTROL of the control: with the gate forced past (an S1-6 ELF) but NO waiting claimant (pre-upgrade engine semantics), nothing is sent", async () => {
    // The fake engine only produces 21 for an S1-6 ELF; give the gate an S1-6 ELF but make the winner payable by having
    // the loser already settled: no claimant waits, so the job must not touch the remaining (payable) winner.
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const loser = w.state.get(LOSER.toBase58())!;
    const off = capitalOffset(loser);
    const settled = new Uint8Array(loser);
    settled.fill(0, off, off + 16);
    w.state.set(LOSER.toBase58(), settled);
    const r = await run(w, AFTER);
    assert.equal(r.outcome, "no-wait");
    assert.equal(w.log.sends, 0);
    assert.ok(w.holdsClaim(w.state.get(WINNER.toBase58())!));
  });
});

// ---- K-COV4: branch coverage for the paths the main suite does not reach ----
type Sim = (tx: VersionedTransaction, opts: { accounts?: { addresses: string[] } }) => Promise<{ context: unknown; value: { err: unknown; logs: unknown[]; accounts: unknown } }>;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const hasAtaIx = (tx: VersionedTransaction): boolean => tx.message.staticAccountKeys.some((k) => k.toBase58() === ATA_PROGRAM);
const simAddr = (o: { accounts?: { addresses: string[] } }): string | undefined => o.accounts?.addresses?.[0];
const wrapSim = (w: ReturnType<typeof world>, f: (orig: Sim) => Sim): void => {
  const orig = w.conn.simulateTransaction.bind(w.conn) as unknown as Sim;
  (w.conn as { simulateTransaction: Sim }).simulateTransaction = f(orig);
};
const b64 = (d: Uint8Array) => [Buffer.from(d).toString("base64"), "base64"];

describe("K-COV4: config from env", () => {
  it("RESOLVED_LOSER_FORCE_CLOSE_ENABLED=false disables; otherwise the bounded defaults", () => {
    assert.equal(loserForceCloseConfigFromEnv({ RESOLVED_LOSER_FORCE_CLOSE_ENABLED: "false" }), null);
    const c = loserForceCloseConfigFromEnv({});
    assert.ok(c);
    assert.deepEqual([c.maxScanPerCycle, c.maxClosesPerCycle, c.maxChunkCallsPerPortfolio, c.maxAtaCreatesPerCycle, c.gateTtlMs], [32, 8, 16, 4, 600_000]);
    assert.ok(c.wrapperProgramId && c.nftProgramId);
  });
});

describe("K-COV4: early exits and failure", () => {
  it("a market that is not Resolved (zeroed data) does nothing and clears waitingSeen", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const st = new LoserForceCloseState();
    st.waitingSeen.add(CODEC.toBase58());
    const r = await forceCloseResolvedLosers(w.conn as never, Keypair.generate(), CODEC, new Uint8Array(MARKET.length), AFTER, false, CFG(), st);
    assert.equal(r.outcome, "not-resolved");
    assert.ok(!st.waitingSeen.has(CODEC.toBase58()));
    assert.deepEqual([w.log.sims, w.log.sends], [0, 0]);
  });

  it("no portfolio with a claim left -> no-candidates, nothing sent", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    for (const k of [LOSER, WINNER]) {
      const d = w.state.get(k.toBase58())!;
      const z = new Uint8Array(d);
      z.fill(0, capitalOffset(d), capitalOffset(d) + 16);
      w.state.set(k.toBase58(), z);
    }
    const st = new LoserForceCloseState();
    st.waitingSeen.add(CODEC.toBase58());
    const r = await run(w, AFTER, st);
    assert.equal(r.outcome, "no-candidates");
    assert.ok(!st.waitingSeen.has(CODEC.toBase58()));
    assert.deepEqual([w.log.sims, w.log.sends], [0, 0]);
  });

  it("an unexpected RPC error returns outcome failed (never throws) and logs it", async () => {
    const lines: string[] = [];
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    (w.conn as { getProgramAccounts: unknown }).getProgramAccounts = async () => {
      throw new Error("rpc down");
    };
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ log: (l) => lines.push(l) }));
    assert.equal(r.outcome, "failed");
    assert.equal(r.detail, "rpc down");
    assert.ok(lines.some((l) => l.includes('"event":"failed"')));
    // a non-Error throw is stringified
    (w.conn as { getProgramAccounts: unknown }).getProgramAccounts = async () => {
      throw "boom";
    };
    assert.equal((await run(w, AFTER)).detail, "boom");
  });
});

describe("K-COV4: rotating scan window when candidates exceed maxScanPerCycle", () => {
  it("scans one portfolio per pass; a waiter seen on a truncated pass keeps the next pass closing the loser", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER, chunks: 1 });
    const st = new LoserForceCloseState();
    const cfg = CFG({ maxScanPerCycle: 1 });
    // sorted: LOSER (5vYA…) < WINNER (6UW2…). Pass 1 sees only the loser: closable, but no waiter seen yet -> nothing sent.
    const r1 = await run(w, AFTER, st, cfg);
    assert.equal(r1.outcome, "no-wait");
    assert.equal(w.log.sends, 0);
    assert.equal(st.cursor.get(CODEC.toBase58()), WINNER.toBase58());
    // Pass 2 sees only the winner: waiting (21), nothing closable in this window.
    const r2 = await run(w, AFTER, st, cfg);
    assert.equal(r2.outcome, "nothing-closable");
    assert.deepEqual(r2.waiting, [WINNER.toBase58()]);
    assert.ok(st.waitingSeen.has(CODEC.toBase58()));
    assert.equal(w.log.sends, 0);
    // Pass 3 wraps to the loser: no waiter in window, but one was seen while truncated -> closes the loser.
    const r3 = await run(w, AFTER, st, cfg);
    assert.equal(r3.outcome, "closed");
    assert.deepEqual(r3.closed, [LOSER.toBase58()]);
    assert.deepEqual(new Set(w.log.sendTargets), new Set([LOSER.toBase58()]));
  });
});

describe("K-COV4: per-pass bounds and refusals", () => {
  it("maxClosesPerCycle=0 skips the loser as over the bound and sends nothing", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ maxClosesPerCycle: 0 }));
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /0-per-cycle bound/);
  });

  it("maxChunkCallsPerPortfolio=0 stops on the per-cycle cap without sending", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ maxChunkCallsPerPortfolio: 0 }));
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /per-cycle cap of 0 chunk calls/);
  });

  it("a CloseResolved that simulates OK but changes nothing is skipped as no-progress, never sent", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    wrapSim(w, (orig) => async (tx, o) => {
      const r = await orig(tx, o);
      const a = simAddr(o);
      if (!r.value.err && a === LOSER.toBase58()) return { ...r, value: { ...r.value, accounts: [{ data: b64(w.state.get(a)!) }] } };
      return r;
    });
    const r = await run(w, AFTER);
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /no progress/);
  });

  it("a simulation that returns no post-state account is also treated as no progress", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    wrapSim(w, (orig) => async (tx, o) => {
      const r = await orig(tx, o);
      if (!r.value.err && simAddr(o) === LOSER.toBase58()) return { ...r, value: { ...r.value, accounts: null } };
      return r;
    });
    const r = await run(w, AFTER);
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
  });

  it("a non-custom refusal is reported as JSON text", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    wrapSim(w, (orig) => async (tx, o) => {
      const r = await orig(tx, o);
      if (!r.value.err && simAddr(o) === LOSER.toBase58()) return { ...r, value: { ...r.value, err: "AccountNotFound", accounts: null } };
      return r;
    });
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ maxAtaCreatesPerCycle: 0 }));
    assert.equal(r.outcome, "nothing-closable");
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /refused: "AccountNotFound"/);
  });

  it("a tx that does not land stops that portfolio and is not counted as closed", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    (w.conn as { getSignatureStatuses: unknown }).getSignatureStatuses = async () => ({ value: [null] });
    (w.conn as unknown as { getBlockHeight: unknown }).getBlockHeight = async () => 10;
    const r = await run(w, AFTER);
    assert.equal(r.outcome, "nothing-closable");
    assert.deepEqual(r.closed, []);
    assert.equal(r.calls, 0);
    assert.equal(w.log.sends, 1);
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /tx did not land/);
  });
});

describe("K-COV4: owner token account (ATA) creation for a payout", () => {
  // The loser's close is refused until the owner's token account exists; with the idempotent-ATA ix prepended it works.
  const ataWorld = (ataExists: boolean) => {
    const ataSends = { count: 0 };
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER, loserEscrowedPayout: true });
    (w.conn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = async (keys: PublicKey[]) =>
      keys.map(() => (ataExists ? { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false } : null));
    wrapSim(w, (orig) => async (tx, o) => {
      const r = await orig(tx, o);
      const a = simAddr(o);
      if (hasAtaIx(tx) && a === LOSER.toBase58()) {
        const next = new Uint8Array(w.state.get(a)!);
        next[next.length - 1] ^= 0xff;
        return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: b64(next) }] } };
      }
      return r;
    });
    const origSend = w.conn.sendRawTransaction.bind(w.conn);
    (w.conn as { sendRawTransaction: unknown }).sendRawTransaction = async (raw: Buffer) => {
      if (Transaction.from(raw).compileMessage().accountKeys.some((k) => k.toBase58() === ATA_PROGRAM)) {
        w.log.sends++;
        ataSends.count++;
        return PublicKey.unique().toBase58();
      }
      return origSend(raw);
    };
    return Object.assign(w, { ataSends });
  };

  it("a missing owner token account is created (prepended to the first chunk only) and the loser closes", async () => {
    const w = ataWorld(false);
    const r = await run(w, AFTER);
    assert.equal(r.outcome, "closed");
    assert.deepEqual(r.closed, [LOSER.toBase58()]);
    assert.equal(r.calls, 1, "the follow-up chunk has no ATA ix and is refused again -> stop");
    assert.equal(w.ataSends.count, 1, "exactly one sent tx carried the ATA ix");
    assert.equal(w.log.sends, 1, "no second chunk was sent");
    assert.deepEqual(r.released, [], "the winner still waits");
  });

  it("a close refused AFTER progress (calls>0) is labelled 'refused after progress: <err>', not 'done'", async () => {
    const w = ataWorld(false);
    const lines: string[] = [];
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ log: (l) => lines.push(l) }));
    assert.equal(r.calls, 1);
    const ev = lines
      .map((l) => JSON.parse(l.replace(/^\[resolved-loser-force-close\] /, "")) as { event: string; stop?: string })
      .find((e) => e.event === "loser_force_closed");
    assert.match(ev?.stop ?? "", /^refused after progress: /);
  });

  it("with the ATA budget at 0 the keeper does not create it and reports the refusal", async () => {
    const w = ataWorld(false);
    const r = await run(w, AFTER, new LoserForceCloseState(), CFG({ maxAtaCreatesPerCycle: 0 }));
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
    assert.match(r.skipped.find((s) => s.portfolio === LOSER.toBase58())?.reason ?? "", /Custom\(6\)/);
  });

  it("an existing owner token account is not re-created: the refusal stands", async () => {
    const w = ataWorld(true);
    const r = await run(w, AFTER);
    assert.equal(r.outcome, "nothing-closable");
    assert.equal(w.log.sends, 0);
  });
});

describe("K-COV4: the fee-job wrapper", () => {
  const item = (marketAddress: string) => ({ marketAddress, label: "X" });
  const jobCtx = (w: ReturnType<typeof world>) => ({ conn: w.conn as never, keeper: Keypair.generate(), dryRun: false });

  it("an unparseable market address fails with a clear error", async () => {
    const job = makeResolvedLoserForceCloseJob(CFG());
    const r = await job.run(jobCtx(world({ elf: ELF.s16ac, nowSlot: AFTER })), item("not-a-pubkey"));
    assert.deepEqual(r, { kind: "failed", error: "unparseable market address" });
  });

  it("a market not owned by the configured wrapper (or missing) is skipped", async () => {
    const job = makeResolvedLoserForceCloseJob(CFG());
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    (w.conn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = async () => [{ data: Buffer.from(MARKET), owner: PublicKey.unique(), lamports: 1, executable: false }];
    assert.equal((await job.run(jobCtx(w), item(CODEC.toBase58()))).kind, "skipped");
    (w.conn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = async () => [null];
    assert.equal((await job.run(jobCtx(w), item(CODEC.toBase58()))).kind, "skipped");
  });

  it("a market that is not Resolved is nothing (no slot read, no simulation)", async () => {
    const job = makeResolvedLoserForceCloseJob(CFG());
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    (w.conn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = async () => [{ data: Buffer.alloc(MARKET.length), owner: WRAPPER, lamports: 1, executable: false }];
    assert.equal((await job.run(jobCtx(w), item(CODEC.toBase58()))).kind, "nothing");
    assert.equal(w.log.sims, 0);
  });

  it("a read failure is reported as failed (Error and non-Error)", async () => {
    const job = makeResolvedLoserForceCloseJob(CFG());
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    (w.conn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = async () => {
      throw new Error("rpc 503");
    };
    assert.deepEqual(await job.run(jobCtx(w), item(CODEC.toBase58())), { kind: "failed", error: "read failed: rpc 503" });
    (w.conn as { getMultipleAccountsInfo: unknown }).getMultipleAccountsInfo = async () => {
      throw "nope";
    };
    assert.deepEqual(await job.run(jobCtx(w), item(CODEC.toBase58())), { kind: "failed", error: "read failed: nope" });
  });

  it("maps a failed pass to failed and nothing-closable to waiting", async () => {
    const job = makeResolvedLoserForceCloseJob(CFG());
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const good = w.conn.getProgramAccounts.bind(w.conn);
    (w.conn as { getProgramAccounts: unknown }).getProgramAccounts = async () => {
      throw new Error("gpa failed");
    };
    assert.deepEqual(await job.run(jobCtx(w), item(CODEC.toBase58())), { kind: "failed", error: "gpa failed" });
    (w.conn as { getProgramAccounts: unknown }).getProgramAccounts = good;
    const stuck = world({ elf: ELF.s16ac, nowSlot: AFTER, loserEscrowedPayout: true });
    const r = await job.run(jobCtx(stuck), item(CODEC.toBase58()));
    assert.equal(r.kind, "waiting");
  });
});

describe("K-BUG cursor: scan cursor survives list shrink and is cleaned up", () => {
  const addClones = (w: ReturnType<typeof world>, n: number): PublicKey[] => {
    const ks: PublicKey[] = [];
    for (let i = 0; i < n; i++) {
      const k = PublicKey.unique();
      w.state.set(k.toBase58(), new Uint8Array(w.state.get(LOSER.toBase58())!));
      ks.push(k);
    }
    return ks;
  };
  const zero = (w: ReturnType<typeof world>, k: string): void => {
    const d = w.state.get(k)!;
    const z = new Uint8Array(d);
    z.fill(0, capitalOffset(d), capitalOffset(d) + 16);
    w.state.set(k, z);
  };

  it("when closed portfolios leave the list, the next window starts at the first unscanned one (no skip)", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    addClones(w, 3);
    const order = [...w.state.keys()].filter((k) => k !== VAULT_LP.toBase58()).sort((a, b) => a.localeCompare(b));
    assert.equal(order.length, 5);
    const st = new LoserForceCloseState();
    const cfg = CFG({ maxScanPerCycle: 2 });
    await run(w, AFTER, st, cfg);
    zero(w, order[0]);
    zero(w, order[1]);
    w.log.simTargets.length = 0;
    await run(w, AFTER, st, cfg);
    assert.equal(w.log.simTargets[0], order[2], "must resume at the first portfolio not yet scanned");
  });

  it("drops the cursor once the scan is no longer truncated", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const st = new LoserForceCloseState();
    await run(w, AFTER, st, CFG({ maxScanPerCycle: 1 }));
    assert.ok(st.cursor.has(CODEC.toBase58()));
    await run(w, AFTER, st, CFG({ maxScanPerCycle: 32 }));
    assert.ok(!st.cursor.has(CODEC.toBase58()));
  });

  it("drops the cursor for a market that is no longer Resolved / has no candidates", async () => {
    const w = world({ elf: ELF.s16ac, nowSlot: AFTER });
    const st = new LoserForceCloseState();
    st.cursor.set(CODEC.toBase58(), "x");
    await forceCloseResolvedLosers(w.conn as never, Keypair.generate(), CODEC, new Uint8Array(MARKET.length), AFTER, false, CFG(), st);
    assert.ok(!st.cursor.has(CODEC.toBase58()));
    st.cursor.set(CODEC.toBase58(), "x");
    for (const k of [LOSER, WINNER]) zero(w, k.toBase58());
    await run(w, AFTER, st);
    assert.ok(!st.cursor.has(CODEC.toBase58()));
  });
});
