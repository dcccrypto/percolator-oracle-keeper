/**
 * Branch coverage for resolved-portfolio-cleanup.ts: the error / skip / retry paths the main test file
 * does not drive (discovery failure, probe failure + TTL cache, ATA budget, tx-not-landed on every send
 * site, vault-LP stop reasons, NFT record selection, receipt-revisit refusals, closeFinalizedReceiptPortfolios).
 * Every test asserts the real outcome: which txs were sent, the counters, and the reported reasons.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, parseWrapperConfigV17, V17_PORTFOLIO_ACCOUNT_LEN, LAYOUTS_BY_VERSION } from "@percolatorct/sdk";
import {
  buildCreateAtaIdempotentIx,
  classifyCleanupProbe,
  cleanupResolvedPortfolios,
  CleanupState,
  closeFinalizedReceiptPortfolios,
  decodePositionNft,
  decodeVaultLpState,
  deriveVaultLpState,
  nftEscrowAuthority,
  ownerAta,
  pdaGraceLeft,
  portfolioLenForMarketData,
  positionNftFor,
  receiptOpen,
  RESOLVED_RECEIPT_OFF,
} from "./resolved-portfolio-cleanup.ts";
import type { CleanupConfig, CleanupConnection } from "./resolved-portfolio-cleanup.ts";
import { nonComputeBudgetCompiled } from "./test-ix.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const NFT = new PublicKey("CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3");
const SOL = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const KEEPER = Keypair.generate();
const MINT = parseWrapperConfigV17(new Uint8Array(fx("sol-market-v18-fees"))).collateralMint;
const WALLET = Keypair.generate().publicKey;
const REGISTRY = deriveLpVaultRegistry(WRAPPER, SOL)[0];
const ESCROW = nftEscrowAuthority(NFT);
const GRACE = 216_000n;
const AFTER_GRACE = { nowSlot: 500_000_000n + GRACE, resolvedSlot: 500_000_000n };
const CFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: GRACE, probeTtlMs: 1000, confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0 };
const ERR = (code: number, ix = 1) => ({ InstructionError: [ix, { Custom: code }] });
const PF = () => Keypair.generate().publicKey;

function withOwner(owner: PublicKey): Buffer {
  const b = Buffer.from(fx("sol-trader-portfolio-v18"));
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  return b;
}
/** Empty-claim portfolio (capital zeroed) for `owner`, optional receipt flags. */
function emptyPf(owner: PublicKey, receipt?: { present: boolean; finalized: boolean }): Buffer {
  const b = Buffer.from(fx("cate-flat-portfolio-v18"));
  b.fill(0, 148, 164);
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  if (receipt) { b[RESOLVED_RECEIPT_OFF + 64] = receipt.present ? 1 : 0; b[RESOLVED_RECEIPT_OFF + 65] = receipt.finalized ? 1 : 0; }
  return b;
}
function vaultLpStateBuf(lp: PublicKey): Buffer {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
  SOL.toBuffer().copy(b, 16); REGISTRY.toBuffer().copy(b, 16 + 32); lp.toBuffer().copy(b, 16 + 64); WALLET.toBuffer().copy(b, 16 + 96);
  b[16 + 214] = 1;
  return b;
}
function registryBuf(): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 5;
  return b;
}

/** Tag of each non-ComputeBudget ix: wrapper tag, 101/1011 (topup 0/1), -1 ATA create. */
const tagsOf = (tx: VersionedTransaction): number[] =>
  nonComputeBudgetCompiled(tx.message.compiledInstructions, tx.message.staticAccountKeys).map((ix) => {
    const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
    if (pid === WRAPPER.toBase58()) return ix.data[0] === 101 ? (ix.data[1] === 1 ? 1011 : 101) : ix.data[0];
    return -1;
  });

interface Opts {
  pfs?: Array<{ pubkey: PublicKey; data: Buffer }>;
  /** Called per simulation with (tags, 0-based sim index, whether it is a watch (chunk) sim). */
  sim?: (tags: number[], n: number, watch: boolean) => { err: unknown; logs?: string[]; post?: number | null };
  /** sendRawTransaction behaviour; default returns a signature. Tags passed. */
  send?: (tags: number[]) => string;
  /** Confirm verdict for sends: "landed" (default) or "dropped". */
  landed?: (tags: number[], n: number) => boolean;
  gpa?: () => unknown;
  marketInfo?: () => { data: Buffer } | null;
  multi?: (keys: PublicKey[]) => Array<{ data: Buffer } | null>;
  vaultLp?: { state: Buffer; registry: Buffer };
  vaultLpThrows?: boolean;
  nftRecords?: Array<{ pubkey: PublicKey; data: Buffer }>;
  blockhashThrows?: boolean;
}
function mkConn(o: Opts) {
  const calls = { sims: [] as number[][], sent: [] as number[][], gpaFilters: [] as unknown[], multiCalls: 0 };
  let sentSigs = 0;
  const lastTags: number[][] = [];
  const conn = {
    async getProgramAccounts(program: PublicKey, cfg?: { filters?: unknown[] }) {
      if (program.equals(NFT)) {
        if (o.gpa) return o.gpa();
        return (o.nftRecords ?? []).map((r) => ({ pubkey: r.pubkey, account: { data: r.data, owner: NFT, lamports: 1, executable: false } }));
      }
      calls.gpaFilters.push(cfg?.filters);
      if (o.gpa) return o.gpa();
      return (o.pfs ?? []).map((p) => ({ pubkey: p.pubkey, account: { data: p.data, owner: WRAPPER, lamports: 5_000, executable: false } }));
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.multiCalls++;
      if (o.multi) return o.multi(keys);
      return keys.map((k) => {
        const pf = (o.pfs ?? []).find((p) => p.pubkey.equals(k));
        if (pf) return { data: pf.data, owner: WRAPPER, lamports: 1, executable: false };
        if (k.equals(deriveVaultLpState(WRAPPER, SOL))) {
          if (o.vaultLpThrows) throw new Error("rpc down");
          return o.vaultLp ? { data: o.vaultLp.state, owner: WRAPPER, lamports: 1, executable: false } : null;
        }
        return { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false };
      });
    },
    async getAccountInfo(k: PublicKey) {
      if (k.equals(SOL)) return o.marketInfo ? o.marketInfo() : null;
      return o.vaultLp ? { data: o.vaultLp.registry, owner: WRAPPER, lamports: 1, executable: false } : null;
    },
    async getLatestBlockhash() {
      if (o.blockhashThrows) throw new Error("no blockhash");
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 };
    },
    async simulateTransaction(tx: VersionedTransaction, so?: { accounts?: { addresses: string[] } }) {
      const t = tagsOf(tx);
      const n = calls.sims.length;
      calls.sims.push(t);
      const r = (o.sim ?? (() => ({ err: null })))(t, n, !!so?.accounts);
      const post = r.post === undefined ? n + 1 : r.post;
      const accounts = so?.accounts && post !== null ? [{ data: [Buffer.alloc(32, post).toString("base64"), "base64"] }] : undefined;
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [], accounts } };
    },
    async sendRawTransaction(raw: Buffer) {
      const t = tagsOf(VersionedTransaction.deserialize(raw));
      calls.sent.push(t);
      lastTags.push(t);
      sentSigs++;
      return o.send ? o.send(t) : "5ig1111111111111111111111111111111111111111111111111111111111111";
    },
    async getBlockHeight() { return 1_000_000; },
    async getSignatureStatuses() {
      const t = lastTags[lastTags.length - 1] ?? [];
      const ok = o.landed ? o.landed(t, sentSigs - 1) : true;
      return { context: { slot: 2 }, value: [ok ? { slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null] };
    },
  };
  return { conn: conn as unknown as CleanupConnection, calls };
}
/** First sim (the probe) answers an engine error (= supported); the rest go to `rest`. */
const supported = (rest: (t: number[], n: number, w: boolean) => { err: unknown; logs?: string[]; post?: number | null }) =>
  (t: number[], n: number, w: boolean) => (n === 0 ? { err: ERR(61) } : rest(t, n, w));
const run = (c: ReturnType<typeof mkConn>, opts: { dryRun?: boolean; cfg?: Partial<CleanupConfig>; st?: CleanupState; clock?: { nowSlot: bigint; resolvedSlot: bigint | null } } = {}) =>
  cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, opts.dryRun ?? false, { ...CFG, ...opts.cfg }, opts.st ?? new CleanupState(), opts.clock);

describe("pure helpers", () => {
  it("buildCreateAtaIdempotentIx: payer signs, ATA derived from owner+mint, data [1] (CreateIdempotent)", () => {
    const ix = buildCreateAtaIdempotentIx(KEEPER.publicKey, WALLET, MINT);
    assert.equal(ix.keys.length, 6);
    assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, true], [false, false], [false, false], [false, false], [false, false]]);
    assert.ok(ix.keys[0].pubkey.equals(KEEPER.publicKey) && ix.keys[1].pubkey.equals(ownerAta(WALLET, MINT)) && ix.keys[2].pubkey.equals(WALLET) && ix.keys[3].pubkey.equals(MINT));
    assert.deepEqual([...ix.data], [1]);
  });
  it("receiptOpen: data too short for a receipt is not open", () => {
    assert.equal(receiptOpen(new Uint8Array(100)), false);
  });
  it("decodeVaultLpState: null on short data, wrong kind, wrong version; decodes a valid record", () => {
    const lp = PF();
    const good = vaultLpStateBuf(lp);
    assert.ok(decodeVaultLpState(new Uint8Array(good))!.lpPortfolio.equals(lp));
    assert.equal(decodeVaultLpState(new Uint8Array(good.subarray(0, 100))), null);
    const wrongKind = Buffer.from(good); wrongKind[10] = 8;
    assert.equal(decodeVaultLpState(new Uint8Array(wrongKind)), null);
    const wrongVer = Buffer.from(good); wrongVer[16 + 214] = 2;
    assert.equal(decodeVaultLpState(new Uint8Array(wrongVer)), null);
  });
  it("decodeVaultLpState: senior-draw u128 fields read little-endian across the 64-bit boundary", () => {
    const b = vaultLpStateBuf(PF());
    b.writeBigUInt64LE(5n, 16 + 224); b.writeBigUInt64LE(1n, 16 + 224 + 8);
    b.writeBigUInt64LE(7n, 16 + 240);
    const s = decodeVaultLpState(new Uint8Array(b))!;
    assert.equal(s.seniorDrawnAtoms, (1n << 64n) | 5n);
    assert.equal(s.seniorDrawOutstandingAtoms, 7n);
  });
  it("classifyCleanupProbe: error not at ix 1 / unparseable = unknown; Custom(8) at ix 1 = unsupported; non-custom error at ix 1 = supported", () => {
    assert.equal(classifyCleanupProbe({ InstructionError: [0, { Custom: 8 }] }, false), "unknown");
    assert.equal(classifyCleanupProbe(null, false), "unknown");
    assert.equal(classifyCleanupProbe({ InstructionError: [1, "InvalidAccountData"] }, false), "supported");
    assert.equal(classifyCleanupProbe({ InstructionError: [1, { Custom: 8 }] }, false), "unsupported");
  });
  it("pdaGraceLeft: clock behind the resolve slot = full grace; resolvedSlot 0 = full grace; mid-grace = remainder", () => {
    assert.equal(pdaGraceLeft(10n, 100n, GRACE), GRACE);
    assert.equal(pdaGraceLeft(10n, 0n, GRACE), GRACE);
    assert.equal(pdaGraceLeft(150n, 100n, GRACE), GRACE - 50n);
  });
  it("decodePositionNft: only 239 B (v3) and 199 B (legacy) records decode", () => {
    assert.equal(decodePositionNft(new Uint8Array(100)), null);
    assert.equal(decodePositionNft(new Uint8Array(200)), null);
    assert.equal(decodePositionNft(new Uint8Array(239))!.portfolioIdAtMint, 0n);
    const legacy = decodePositionNft(new Uint8Array(199))!;
    assert.equal(legacy.marketGroup, null);
    assert.equal(legacy.portfolioIdAtMint, null);
  });
  it("portfolioLenForMarketData: absent/short = v2.1 length; v18 header = its table; unknown VERSION throws", () => {
    assert.equal(portfolioLenForMarketData(null), V17_PORTFOLIO_ACCOUNT_LEN);
    assert.equal(portfolioLenForMarketData(undefined), V17_PORTFOLIO_ACCOUNT_LEN);
    assert.equal(portfolioLenForMarketData(new Uint8Array(9)), V17_PORTFOLIO_ACCOUNT_LEN);
    const hdr = (v: number) => { const b = new Uint8Array(16); new DataView(b.buffer).setUint16(8, v, true); return b; };
    const [known, table] = [...LAYOUTS_BY_VERSION.entries()][0];
    assert.equal(portfolioLenForMarketData(hdr(known)), table.portfolio.accountLen);
    assert.throws(() => portfolioLenForMarketData(hdr(0xfffe)), /has no portfolio layout/);
  });
});

describe("positionNftFor: record selection", () => {
  const pf = PF();
  const mint = PF();
  const holder = PF();
  const rec = (len: 239 | 199, p: PublicKey, o: { group?: PublicKey; id?: bigint } = {}): { pubkey: PublicKey; data: Buffer } => {
    const b = Buffer.alloc(len);
    p.toBuffer().copy(b, 10); mint.toBuffer().copy(b, 42); holder.toBuffer().copy(b, 167);
    if (len === 239) { (o.group ?? SOL).toBuffer().copy(b, 199); b.writeBigUInt64LE(o.id ?? 4n, 231); }
    return { pubkey: PF(), data: b };
  };
  const connOf = (records: Array<{ pubkey: PublicKey; data: Buffer }>) => ({
    async getProgramAccounts(_p: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) {
      const size = cfg.filters[0].dataSize;
      return records.filter((r) => r.data.length === size).map((r) => ({ pubkey: r.pubkey, account: { data: r.data, owner: NFT, lamports: 1, executable: false } }));
    },
  });
  const live = { marketGroup: SOL, portfolioId: 4n };
  it("matching v3 record: mint + holder returned", async () => {
    assert.deepEqual(await positionNftFor(connOf([rec(239, pf)]), NFT, pf, live), { nftMint: mint.toBase58(), holder: holder.toBase58() });
  });
  it("stale v3 (other portfolio id) and a legacy record: holder unknown (null), the legacy last_holder is NOT named", async () => {
    assert.equal(await positionNftFor(connOf([rec(239, pf, { id: 3n }), rec(199, pf)]), NFT, pf, live), null);
  });
  it("v3 record for a different market group is skipped, then null", async () => {
    assert.equal(await positionNftFor(connOf([rec(239, pf, { group: PF() })]), NFT, pf, live), null);
  });
  it("live portfolioId 0 never matches a v3 record, even with id 0 at mint", async () => {
    assert.equal(await positionNftFor(connOf([rec(239, pf, { id: 0n })]), NFT, pf, { marketGroup: SOL, portfolioId: 0n }), null);
  });
  it("no v3 record at all: the legacy 199 B record is used", async () => {
    assert.deepEqual(await positionNftFor(connOf([rec(199, pf)]), NFT, pf, live), { nftMint: mint.toBase58(), holder: holder.toBase58() });
  });
  it("a v3 record naming a different portfolio does not poison the legacy lookup; a legacy record for another portfolio is ignored", async () => {
    assert.deepEqual(await positionNftFor(connOf([rec(239, PF()), rec(199, PF()), rec(199, pf)]), NFT, pf, live), { nftMint: mint.toBase58(), holder: holder.toBase58() });
    assert.equal(await positionNftFor(connOf([rec(199, PF())]), NFT, pf, live), null);
  });
  it("RPC failure: null, never throws", async () => {
    const bad = { async getProgramAccounts() { throw new Error("429"); } };
    assert.equal(await positionNftFor(bad, NFT, pf, live), null);
  });
});

describe("discovery and gate", () => {
  it("getProgramAccounts throws: reported as a discovery failure, nothing simulated or sent", async () => {
    const c = mkConn({ gpa: () => { throw new Error("rpc boom"); } });
    const r = await run(c);
    assert.deepEqual(r.remaining, [{ portfolio: "*", reason: "portfolio discovery failed: rpc boom" }]);
    assert.equal(c.calls.sims.length + c.calls.sent.length, 0);
  });
  it("non-Error rejection is stringified into the discovery-failure reason", async () => {
    const c = mkConn({ gpa: () => { throw "plain string"; } });
    assert.equal((await run(c)).remaining[0].reason, "portfolio discovery failed: plain string");
  });
  it("market with an unknown program VERSION: scan refused (no guessed size), reported", async () => {
    const hdr = Buffer.alloc(16); hdr.writeUInt16LE(0xfffe, 8);
    const c = mkConn({ marketInfo: () => ({ data: hdr }), pfs: [{ pubkey: PF(), data: withOwner(WALLET) }] });
    const r = await run(c);
    assert.match(r.remaining[0].reason, /portfolio discovery failed: market VERSION 65534 has no portfolio layout/);
    assert.equal(c.calls.gpaFilters.length, 0, "no scan at a guessed size");
  });
  it("unreadable market account (getAccountInfo throws): falls back to the v2.1 portfolio length and still scans", async () => {
    const c = mkConn({ marketInfo: () => { throw new Error("rpc"); }, pfs: [] });
    const r = await run(c);
    assert.equal((c.calls.gpaFilters[0] as Array<{ dataSize?: number }>)[0].dataSize, V17_PORTFOLIO_ACCOUNT_LEN);
    assert.equal(r.support, "unknown");
    assert.deepEqual(r.remaining, []);
  });
  it("no portfolios: returns the cached support verdict without probing", async () => {
    const st = new CleanupState();
    st.support = { value: "supported", at: 0 };
    const c = mkConn({ pfs: [] });
    const r = await run(c, { st });
    assert.equal(r.support, "supported");
    assert.equal(c.calls.sims.length, 0);
  });
  it("probe simulation throws: support unknown, every portfolio reported 'probe failed', nothing sent", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: () => { throw new Error("sim down"); } });
    const st = new CleanupState();
    const r = await run(c, { st });
    assert.equal(r.support, "unknown");
    assert.match(r.remaining[0].reason, /cleanup support unknown this cycle \(probe failed\)/);
    assert.equal(c.calls.sent.length, 0);
    assert.equal(st.support?.value, "unknown");
  });
  it("probe prefers a non-PDA portfolio as its target (an NFT-escrowed one listed first is not probed)", async () => {
    const esc = PF(), plain = PF();
    const c = mkConn({ pfs: [{ pubkey: esc, data: emptyPf(ESCROW) }, { pubkey: plain, data: withOwner(WALLET) }], sim: () => ({ err: ERR(8) }) });
    const r = await run(c);
    assert.equal(r.support, "unsupported");
    assert.equal(r.remaining.length, 2);
  });
  it("support verdict is cached within the TTL (one probe across two cycles) and re-probed after it", async () => {
    const st = new CleanupState();
    let t = 0;
    const cfg = { now: () => t, probeTtlMs: 1000 };
    const mk = (probe: boolean) => mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: probe ? supported(() => ({ err: null })) : () => ({ err: null }) });
    const c1 = mk(true); await run(c1, { st, cfg });
    assert.equal(c1.calls.sims[0].join(), "8", "first cycle probes with a lone tag 8");
    t = 500;
    const c2 = mk(false); await run(c2, { st, cfg });
    assert.deepEqual(c2.calls.sims[0], [30, 8], "within TTL: first sim is the close itself, no lone tag-8 probe");
    t = 1500;
    const c3 = mk(true); await run(c3, { st, cfg });
    assert.equal(c3.calls.sims[0].join(), "8", "past TTL: probed again");
  });
});

describe("ordinary portfolios: skip / retry paths", () => {
  it("getMultipleAccountsInfo throws: every owner ATA treated as absent, so the ATA create is prepended", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], multi: () => { throw new Error("rpc"); }, sim: supported(() => ({ err: null })) });
    const r = await run(c);
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[-1, 30, 8]]);
  });
  it("ATA-create budget: the portfolio past the budget is skipped with a reason, no tx names it", async () => {
    const owners = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const c = mkConn({
      pfs: owners.map((o) => ({ pubkey: PF(), data: withOwner(o) })),
      multi: (keys) => keys.map(() => null),
      sim: supported(() => ({ err: null })),
    });
    const r = await run(c, { cfg: { maxAtaCreatesPerCycle: 1 } });
    assert.equal(r.closed, 1);
    assert.equal(c.calls.sent.length, 1);
    assert.equal(r.remaining.length, 1);
    assert.match(r.remaining[0].reason, /ATA-create budget for this cycle used/);
  });
  it("maxPerCycle: the portfolio past the bound is reported and not simulated", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }, { pubkey: PF(), data: withOwner(Keypair.generate().publicKey) }], sim: supported(() => ({ err: null })) });
    const r = await run(c, { cfg: { maxPerCycle: 1 } });
    assert.equal(r.closed, 1);
    assert.match(r.remaining[0].reason, /over the 1-per-cycle bound; next cycle/);
    assert.equal(c.calls.sent.length, 1);
  });
  it("(a) CloseResolved+8 sends but does not land: reported 'did not land', not counted closed", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported(() => ({ err: null })), landed: () => false });
    const r = await run(c);
    assert.equal(r.closed, 0);
    assert.deepEqual(c.calls.sent, [[30, 8]]);
    assert.match(r.remaining[0].reason, /close tx did not land; retry next cycle/);
  });
  it("(b) tag 8 alone sends but does not land: reported, not counted closed", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported((t) => (t.includes(30) ? { err: ERR(61) } : { err: null })), landed: () => false });
    const r = await run(c);
    assert.equal(r.closed, 0);
    assert.deepEqual(c.calls.sent, [[8]]);
    assert.match(r.remaining[0].reason, /close tx did not land/);
  });
  it("dry-run: nothing is sent, but the close is counted from the simulation", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported(() => ({ err: null })) });
    const r = await run(c, { dryRun: true });
    assert.equal(c.calls.sent.length, 0);
    assert.equal(r.closed, 1);
  });
  it("(c) every sim fails, including the lone CloseResolved: the (a) error is reported with its instruction name and log", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported((t) => ({ err: ERR(61, t.length), logs: ["Program log: Error: bad thing happened"] })) });
    const r = await run(c);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /ClosePortfolio Custom\(61\)/);
    assert.match(r.remaining[0].reason, /\(Program log: Error: bad thing happened\)/);
  });
  it("ExpectedSigner (Custom 6) carries the NFT-holder hint", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported((t) => ({ err: ERR(6, t.length) })) });
    const r = await run(c);
    assert.match(r.remaining[0].reason, /NFT-escrowed payout needs the NFT holder's signature \(GH#496\)/);
  });
  it("a non-instruction error is reported as 'tx' with the JSON of the error", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported(() => ({ err: "BlockhashNotFound" })) });
    const r = await run(c);
    assert.match(r.remaining[0].reason, /^tx "BlockhashNotFound"/);
  });
  it("an exception inside a portfolio's attempt is caught and reported (truncated), the next portfolio still runs", async () => {
    let n = 0;
    const good = PF();
    const c = mkConn({
      pfs: [{ pubkey: PF(), data: withOwner(WALLET) }, { pubkey: good, data: withOwner(Keypair.generate().publicKey) }],
      sim: supported(() => { if (n++ === 0) throw new Error("x".repeat(300)); return { err: null }; }),
    });
    const r = await run(c);
    assert.equal(r.remaining[0].reason.length, 120);
    assert.equal(r.closed, 1, "second portfolio closed despite the first one's exception");
  });
  it("chunk path: progress then tag 8 refused every time -> 'made progress, not done', ATA budget counted", async () => {
    const c = mkConn({
      pfs: [{ pubkey: PF(), data: withOwner(WALLET) }],
      multi: (keys) => keys.map(() => null),
      sim: supported((t, _n, watch) => (watch ? { err: null, post: t.includes(30) ? 1 : 1 } : { err: ERR(61, t.length) })),
    });
    const r = await run(c);
    assert.equal(r.closed, 0);
    assert.equal(r.progressed, 1);
    assert.match(r.remaining[0].reason, /CloseResolved made progress \(1 chunk call\(s\)\), not done/);
  });
  it("chunk path: the first chunk sim itself errors -> falls to the (a) error report (no chunk sent)", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }], sim: supported((t) => ({ err: ERR(61, t.length) })) });
    const r = await run(c);
    assert.equal(c.calls.sent.length, 0);
    assert.equal(r.progressed, 0);
  });
  it("chunk path: a chunk that would change nothing is never sent; reason 'would make no progress'", async () => {
    // sim post == baseline? the stub's post bytes (32 x n) never equal real portfolio data, so force an error-free
    // first probe then an identical post on the loop's sim.
    let watchN = 0;
    const c = mkConn({
      pfs: [{ pubkey: PF(), data: withOwner(WALLET) }],
      sim: supported((t, _n, watch) => {
        if (!watch) return { err: ERR(61, t.length) };
        return watchN++ === 0 ? { err: null, post: 7 } : { err: null, post: null };
      }),
    });
    const r = await run(c);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /CloseResolved: CloseResolved would make no progress/);
  });
  it("chunk path: chunk tx does not land -> stop reason says so, tag 8 not attempted", async () => {
    const c = mkConn({
      pfs: [{ pubkey: PF(), data: withOwner(WALLET) }],
      sim: supported((t, _n, watch) => (watch ? { err: null, post: 9 } : { err: ERR(61, t.length) })),
      landed: () => false,
    });
    const r = await run(c);
    assert.equal(r.progressed, 0);
    assert.deepEqual(c.calls.sent, [[30]]);
    assert.match(r.remaining[0].reason, /CloseResolved chunk tx did not land/);
  });
  it("chunk path: p3_senior_draw log lines from a landed chunk are surfaced", async () => {
    let w = 0;
    const c = mkConn({
      pfs: [{ pubkey: PF(), data: withOwner(WALLET) }],
      sim: supported((t, _n, watch) => (watch ? { err: null, post: ++w <= 2 ? 3 : null, logs: ["Program log: p3_senior_draw booked=5"] } : { err: ERR(61, t.length) })),
    });
    const r = await run(c);
    assert.deepEqual(r.seniorDrawLogs, ["Program log: p3_senior_draw booked=5"]);
    assert.equal(r.progressed, 1);
  });
});

describe("PDA-owned portfolios: error paths", () => {
  const pf = PF();
  it("NFT-escrowed EMPTY after grace, tag 8 simulation refused: reported with the instruction error, nothing sent", async () => {
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(ESCROW) }], sim: supported((t) => ({ err: ERR(21, t.length) })) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.deepEqual(r.pdaClosed, []);
    assert.match(r.remaining[0].reason, /EMPTY NFT-escrowed after grace: tag 8 ClosePortfolio Custom\(21\)/);
  });
  it("NFT-escrowed EMPTY after grace, tag 8 sent but not landed: 'did not land', not counted", async () => {
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(ESCROW) }], sim: supported(() => ({ err: null })), landed: () => false });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(r.closed, 0);
    assert.deepEqual(c.calls.sent, [[8]]);
    assert.match(r.remaining[0].reason, /tag 8 did not land/);
  });
  it("NFT-escrowed EMPTY after grace, simulate throws: caught, reported", async () => {
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(ESCROW) }], sim: supported(() => { throw new Error("sim exploded"); }) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(r.remaining[0].reason, "sim exploded");
  });
  it("NFT-escrowed WITH a claim and no NFT record: waiting-on-holder with nulls and '?' placeholders", async () => {
    const c = mkConn({ pfs: [{ pubkey: pf, data: withOwner(ESCROW) }], sim: supported(() => ({ err: null })) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.equal(r.waitingOnHolder.length, 1);
    assert.equal(r.waitingOnHolder[0].nftMint, null);
    assert.equal(r.waitingOnHolder[0].holder, null);
    assert.match(r.remaining[0].reason, /waiting on NFT holder \? \(mint \?\)/);
  });
  it("registry-owned portfolio whose vault-LP state binds a DIFFERENT portfolio is not guessed at", async () => {
    const c = mkConn({ pfs: [{ pubkey: pf, data: withOwner(REGISTRY) }], vaultLp: { state: vaultLpStateBuf(PF()), registry: registryBuf() }, sim: supported(() => ({ err: null })) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });
  it("vault-LP state lookup throws: treated as unbound, nothing sent", async () => {
    const c = mkConn({ pfs: [{ pubkey: pf, data: withOwner(REGISTRY) }], vaultLpThrows: true, sim: supported(() => ({ err: null })) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });
  it("vault-LP state present but its registry account is missing: unbound", async () => {
    const lp = PF();
    const c = mkConn({ pfs: [{ pubkey: lp, data: withOwner(REGISTRY) }], vaultLp: { state: vaultLpStateBuf(lp), registry: registryBuf() }, sim: supported(() => ({ err: null })) });
    // getAccountInfo(registry) returns the registry via vaultLp; null it by overriding
    (c.conn as unknown as { getAccountInfo: () => Promise<null> }).getAccountInfo = async () => null;
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });

  describe("vault LP settle loop stop reasons", () => {
    const lp = PF();
    const vaultLp = { state: vaultLpStateBuf(lp), registry: registryBuf() };
    it("101(0) simulation errors and nothing finishes: 'not closable this cycle' with the reason, nothing sent", async () => {
      const c = mkConn({ pfs: [{ pubkey: lp, data: withOwner(REGISTRY) }], vaultLp, sim: supported((t) => (t.includes(101) || t.includes(1011) || (t.length === 1 && t[0] === 8) ? { err: ERR(21, t.length) } : { err: null })) });
      const r = await run(c, { clock: AFTER_GRACE });
      assert.equal(c.calls.sent.length, 0);
      assert.equal(r.closed, 0);
      assert.equal(r.vaultLpSettled, 0);
      assert.match(r.remaining[0].reason, /vault LP: not closable this cycle \(ix 2 Custom\(21\)\)/);
    });
    it("101(0) lands one chunk then makes no progress and tag 8 stays refused: 'made progress, not done'", async () => {
      let w = 0;
      const c = mkConn({
        pfs: [{ pubkey: lp, data: withOwner(REGISTRY) }], vaultLp,
        sim: supported((t, _n, watch) => {
          if (watch) return { err: null, post: ++w === 1 ? 4 : null };
          if (t.includes(1011)) return { err: null };
          return { err: ERR(21, t.length) };
        }),
      });
      const r = await run(c, { clock: AFTER_GRACE });
      assert.equal(r.closed, 0);
      assert.equal(r.progressed, 1);
      assert.match(r.remaining[0].reason, /tag 101 made progress \(1 chunk call\(s\)\), not done — continues next cycle \(VaultLpSettleResolved\(0\) would make no progress\)/);
      assert.ok(r.vaultLpSettled >= 1);
      assert.ok(c.calls.sent.some((s) => s.includes(1011)), "101(1) top-up claims were sent");
    });
    it("101(0) chunk sent but not landed: stop reason says the chunk tx did not land", async () => {
      const c = mkConn({
        pfs: [{ pubkey: lp, data: withOwner(REGISTRY) }], vaultLp,
        sim: supported((t, _n, watch) => (watch ? { err: null, post: 5 } : t.length === 1 && t[0] === 8 ? { err: ERR(21, 1) } : { err: null })),
        landed: (t) => !t.includes(101),
      });
      const r = await run(c, { clock: AFTER_GRACE });
      assert.match(r.remaining[0].reason, /VaultLpSettleResolved\(0\) chunk tx did not land/);
    });
    it("cap: maxChunkCallsPerCycle=1 stops the loop with the cap reason", async () => {
      let w = 0;
      const c = mkConn({
        pfs: [{ pubkey: lp, data: withOwner(REGISTRY) }], vaultLp,
        sim: supported((t, _n, watch) => (watch ? { err: null, post: ++w + 10 } : t.length === 1 && t[0] === 8 ? { err: ERR(21, 1) } : { err: null })),
      });
      const r = await run(c, { clock: AFTER_GRACE, cfg: { maxChunkCallsPerCycle: 1 } });
      assert.match(r.remaining[0].reason, /per-cycle cap of 1 VaultLpSettleResolved\(0\) chunk calls reached/);
      assert.equal(r.progressed, 1);
    });
    it("an exception in the vault-LP path is caught and reported, with the receipt sweep still gated off", async () => {
      const c = mkConn({ pfs: [{ pubkey: lp, data: withOwner(REGISTRY) }], vaultLp, sim: supported(() => { throw new Error("vlp boom"); }) });
      const r = await run(c, { clock: AFTER_GRACE });
      assert.equal(r.remaining[0].reason, "vlp boom");
      assert.deepEqual(r.topupSwept, []);
    });
  });
});

describe("resolved-receipt revisit: refusal paths", () => {
  const open = { present: true, finalized: false };
  it("tag 46 AND the repeat CloseResolved are both refused: both errors reported, nothing sent", async () => {
    const pf = PF();
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(WALLET, open) }], sim: supported((t) => ({ err: ERR(t.includes(46) ? 21 : 61, t.length) })) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    const why = r.remaining.find((x) => /open resolved receipt: tag 46/.test(x.reason))!;
    assert.match(why.reason, /tag 46 ClaimResolvedPayoutTopup Custom\(21\); repeat CloseResolved CloseResolved Custom\(61\) — revisit next cycle/);
    assert.deepEqual(r.topupSwept, []);
  });
  it("revisit send does not land: 'receipt revisit (46) tx did not land', not swept", async () => {
    const pf = PF();
    const c = mkConn({
      pfs: [{ pubkey: pf, data: emptyPf(WALLET, open) }],
      sim: supported((t) => (t.includes(46) ? { err: null } : { err: ERR(21, t.length) })),
      landed: (t) => !t.includes(46),
    });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.deepEqual(r.topupSwept, []);
    assert.ok(r.remaining.some((x) => /receipt revisit \(46\) tx did not land; retry next cycle/.test(x.reason)));
  });
  it("46 lands and tag 8 then closes: counted closed and the earlier 'remaining' entry for it is removed", async () => {
    const pf = PF();
    let swept = false;
    const c = mkConn({
      pfs: [{ pubkey: pf, data: emptyPf(WALLET, open) }],
      sim: supported((t) => {
        if (t.includes(46)) { swept = true; return { err: null }; }
        if (!swept) return { err: ERR(21, t.length) };
        return { err: null };
      }),
    });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.deepEqual(r.topupSwept, [pf.toBase58()]);
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent.filter((s) => s.includes(46) || (s.length === 1 && s[0] === 8)), [[46], [8]]);
    assert.ok(!r.remaining.some((x) => x.portfolio === pf.toBase58()), "no stale remaining entry");
  });
  it("NFT-escrowed portfolio with an open receipt: reported as needing the holder to sign tag 46, no 46 sent", async () => {
    const pf = PF();
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(ESCROW, open) }], sim: supported(() => ({ err: null })) });
    const r = await run(c, { clock: { nowSlot: 1n, resolvedSlot: 1n } });
    assert.ok(r.remaining.some((x) => /holder must sign tag 46/.test(x.reason)));
    assert.ok(!c.calls.sent.some((s) => s.includes(46)));
  });
  it("sweep bound: with maxPerCycle=1 the second open-receipt portfolio is reported for next cycle", async () => {
    const a = PF(), b = PF();
    const c = mkConn({
      pfs: [{ pubkey: a, data: emptyPf(WALLET, open) }, { pubkey: b, data: emptyPf(Keypair.generate().publicKey, open) }],
      sim: supported((t) => (t.includes(46) ? { err: null } : { err: ERR(21, t.length) })),
    });
    const r = await run(c, { clock: AFTER_GRACE, cfg: { maxPerCycle: 1 } });
    assert.ok(r.remaining.some((x) => /tag-46 sweep over the 1-per-cycle bound; next cycle/.test(x.reason)));
    assert.equal(r.topupSwept.length, 1);
  });
  it("re-read of the portfolios fails: the sweep is skipped, nothing sent for receipts", async () => {
    const pf = PF();
    let calls = 0;
    const c = mkConn({
      pfs: [{ pubkey: pf, data: emptyPf(WALLET, open) }],
      multi: (keys) => { if (calls++ === 0) return keys.map(() => ({ data: Buffer.alloc(165) })); throw new Error("rpc"); },
      sim: supported((t) => ({ err: ERR(21, t.length) })),
    });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.ok(!c.calls.sent.some((s) => s.includes(46)));
    assert.deepEqual(r.topupSwept, []);
  });
  it("an exception in one sweep entry is caught and reported", async () => {
    const pf = PF();
    let n = 0;
    const c = mkConn({
      pfs: [{ pubkey: pf, data: emptyPf(WALLET, open) }],
      sim: supported((t) => { if (t.includes(46)) throw new Error("sweep boom"); return { err: ERR(21, t.length) }; }),
    });
    void n;
    const r = await run(c, { clock: AFTER_GRACE });
    assert.ok(r.remaining.some((x) => x.reason === "sweep boom"));
  });
});

describe("closeFinalizedReceiptPortfolios: error / skip paths", () => {
  const fin = { present: true, finalized: true };
  const runF = (c: ReturnType<typeof mkConn>, dryRun = false, cfg: Partial<CleanupConfig> = {}) => closeFinalizedReceiptPortfolios(c.conn, KEEPER, SOL, dryRun, { ...CFG, ...cfg });
  it("discovery failure: reported with '*', nothing sent", async () => {
    const c = mkConn({ gpa: () => { throw new Error("gpa down"); } });
    const r = await runF(c);
    assert.deepEqual(r, { closed: [], failed: [{ portfolio: "*", reason: "portfolio discovery failed: gpa down" }] });
  });
  it("non-Error discovery rejection is stringified", async () => {
    const c = mkConn({ gpa: () => { throw 42; } });
    assert.equal((await runF(c)).failed[0].reason, "portfolio discovery failed: 42");
  });
  it("no receipt-only targets: returns empty without even fetching a blockhash", async () => {
    let bh = 0;
    const c = mkConn({ pfs: [{ pubkey: PF(), data: withOwner(WALLET) }] });
    const orig = c.conn.getLatestBlockhash.bind(c.conn);
    (c.conn as unknown as { getLatestBlockhash: () => unknown }).getLatestBlockhash = () => { bh++; return orig(); };
    const r = await runF(c);
    assert.deepEqual(r, { closed: [], failed: [] });
    assert.equal(bh, 0);
  });
  it("the vault LP (registry-owned) receipt-only portfolio is excluded", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: emptyPf(REGISTRY, fin) }] });
    const r = await runF(c);
    assert.deepEqual(r, { closed: [], failed: [] });
    assert.equal(c.calls.sims.length, 0);
  });
  it("blockhash fetch fails: reported, nothing simulated", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: emptyPf(WALLET, fin) }], blockhashThrows: true });
    const r = await runF(c);
    assert.deepEqual(r.failed, [{ portfolio: "*", reason: "blockhash: no blockhash" }]);
    assert.equal(c.calls.sims.length, 0);
  });
  it("non-Error blockhash rejection is stringified", async () => {
    const c = mkConn({ pfs: [{ pubkey: PF(), data: emptyPf(WALLET, fin) }] });
    (c.conn as unknown as { getLatestBlockhash: () => Promise<never> }).getLatestBlockhash = () => Promise.reject("bh-str");
    assert.equal((await runF(c)).failed[0].reason, "blockhash: bh-str");
  });
  it("simulation refused: reported with the instruction error, nothing sent", async () => {
    const pf = PF();
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(WALLET, fin) }], sim: () => ({ err: ERR(21) }) });
    const r = await runF(c);
    assert.equal(c.calls.sent.length, 0);
    assert.deepEqual(r.failed, [{ portfolio: pf.toBase58(), reason: "tag 8 ClosePortfolio Custom(21)" }]);
  });
  it("sent but not landed: 'did not land', not counted closed", async () => {
    const pf = PF();
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(WALLET, fin) }], landed: () => false });
    const r = await runF(c);
    assert.deepEqual(c.calls.sent, [[8]]);
    assert.deepEqual(r.closed, []);
    assert.deepEqual(r.failed, [{ portfolio: pf.toBase58(), reason: "tag 8 did not land; retry next cycle" }]);
  });
  it("landed: closed; dry-run: closed from the simulation with nothing sent", async () => {
    const pf = PF();
    const c = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(WALLET, fin) }] });
    assert.deepEqual((await runF(c)).closed, [pf.toBase58()]);
    assert.deepEqual(c.calls.sent, [[8]]);
    const d = mkConn({ pfs: [{ pubkey: pf, data: emptyPf(WALLET, fin) }] });
    assert.deepEqual((await runF(d, true)).closed, [pf.toBase58()]);
    assert.equal(d.calls.sent.length, 0);
  });
  it("maxPerCycle: targets past the bound are reported; an exception in one entry does not stop the next", async () => {
    const [a, b, c3] = [PF(), PF(), PF()];
    let n = 0;
    const c = mkConn({
      pfs: [a, b, c3].map((k) => ({ pubkey: k, data: emptyPf(Keypair.generate().publicKey, fin) })),
      sim: () => { if (n++ === 0) throw new Error("e".repeat(200)); return { err: null }; },
    });
    const r = await runF(c, false, { maxPerCycle: 2 });
    assert.equal(r.failed[0].reason.length, 120);
    assert.deepEqual(r.closed, [b.toBase58()]);
    assert.match(r.failed[1].reason, /over the 2-per-cycle bound; next cycle/);
    assert.equal(r.failed[1].portfolio, c3.toBase58());
  });
});
