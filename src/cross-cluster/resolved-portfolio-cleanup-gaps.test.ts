/**
 * Coverage for the failure / edge branches of resolved-portfolio-cleanup.ts that the main suites
 * (resolved-portfolio-cleanup, k10, a61, late-finalize, position-nft-v3) leave untaken: discovery
 * failure, unknown support, ATA budget, vault-LP binding / failure paths, NFT-escrow close failures,
 * path (a)/(b) did-not-land, the receipt-revisit refusals, and closeFinalizedReceiptPortfolios.
 * Every test asserts an outcome (what is sent, what is reported), not only that a line ran.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, parsePortfolioV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  CleanupState,
  cleanupResolvedPortfolios,
  closeFinalizedReceiptPortfolios,
  decodeVaultLpState,
  deriveVaultLpState,
  nftEscrowAuthority,
  positionNftFor,
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
const ESCROW = nftEscrowAuthority(NFT);
const REGISTRY = deriveLpVaultRegistry(WRAPPER, SOL)[0];
const GRACE = 216_000n;
const RESOLVED_AT = 500_000_000n;
const IN_GRACE = { nowSlot: RESOLVED_AT + GRACE - 1n, resolvedSlot: RESOLVED_AT };
const AFTER_GRACE = { nowSlot: RESOLVED_AT + GRACE, resolvedSlot: RESOLVED_AT };
const CFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: GRACE, probeTtlMs: 3_600_000, confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0 };
const E = (custom: number, ix = 1) => ({ InstructionError: [ix, { Custom: custom }] });
const PF = () => Keypair.generate().publicKey;

function withOwner(owner: PublicKey): Buffer {
  const b = Buffer.from(fx("sol-trader-portfolio-v18"));
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  return b;
}
/** Empty claim (cate flat portfolio, capital zeroed), owner set. */
function emptyPortfolio(owner: PublicKey): Buffer {
  const b = Buffer.from(fx("cate-flat-portfolio-v18"));
  b.fill(0, 148, 164);
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  return b;
}
function openReceipt(b: Buffer): Buffer {
  b[RESOLVED_RECEIPT_OFF + 64] = 1;
  b[RESOLVED_RECEIPT_OFF + 65] = 0;
  return b;
}
function vaultLpStateBuf(registry: PublicKey, lp: PublicKey, junior: PublicKey): Buffer {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
  SOL.toBuffer().copy(b, 16); registry.toBuffer().copy(b, 16 + 32); lp.toBuffer().copy(b, 16 + 64); junior.toBuffer().copy(b, 16 + 96);
  b[16 + 214] = 1;
  return b;
}
function registryBuf(): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 5;
  return b;
}

type Sim = { err: unknown; logs?: string[] };
interface Opts {
  ataExists?: boolean;
  vaultLp?: { state: Buffer; registry: Buffer | null };
  /** getAccountInfo(market) answer: undefined = null account, Error = throws, Buffer = data. */
  marketData?: Buffer | Error | null;
  gpaThrow?: unknown;
  /** getMultipleAccountsInfo throws for these key sets. */
  gmaiThrow?: (keys: PublicKey[]) => boolean;
  simThrow?: (tags: number[], n: number) => boolean;
  /** signature status: an on-chain error => the tx is "failed", never "landed". */
  sigErr?: unknown;
  blockhashThrow?: boolean;
  /** simWatch returns no post-state accounts (RPC gave none). */
  noPost?: boolean;
  chunks?: number;
  nftThrow?: boolean;
  nftRecords?: Array<{ pubkey: PublicKey; data: Buffer }>;
}
function mkConn(portfolios: Array<{ pubkey: PublicKey; data: Buffer }>, reply: (tags: number[], n: number) => Sim, o: Opts = {}) {
  const calls = { sims: [] as number[][], sent: [] as number[][], filters: [] as unknown[], chunkSends: 0, gpaWrapper: 0 };
  const total = o.chunks ?? 1;
  const isChunk = (t: number[]) => (t.includes(30) && !t.includes(8)) || t.includes(101);
  const tagsOf = (tx: VersionedTransaction): number[] =>
    nonComputeBudgetCompiled(tx.message.compiledInstructions, tx.message.staticAccountKeys).map((ix) => {
      const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
      if (pid === WRAPPER.toBase58()) return ix.data[0] === 101 ? (ix.data[1] === 1 ? 1011 : 101) : ix.data[0];
      return pid.startsWith("ATok") ? -1 : -2;
    });
  const vaultKey = deriveVaultLpState(WRAPPER, SOL);
  const conn = {
    async getProgramAccounts(program: PublicKey, cfg?: { filters?: unknown[] }) {
      if (program.equals(NFT)) {
        if (o.nftThrow) throw new Error("nft rpc down");
        return (o.nftRecords ?? []).map((r) => ({ pubkey: r.pubkey, account: { data: r.data, owner: NFT, lamports: 1, executable: false } }));
      }
      calls.gpaWrapper++;
      calls.filters.push(cfg?.filters);
      if (o.gpaThrow !== undefined) throw o.gpaThrow;
      return portfolios.map((p) => ({ pubkey: p.pubkey, account: { data: p.data, owner: WRAPPER, lamports: 67_000_000, executable: false } }));
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      if (o.gmaiThrow?.(keys)) throw new Error("gmai down");
      return keys.map((k) => {
        const pf = portfolios.find((p) => p.pubkey.equals(k));
        if (pf) return { data: pf.data, owner: WRAPPER, lamports: 67_000_000, executable: false };
        if (k.equals(vaultKey)) return o.vaultLp ? { data: o.vaultLp.state, owner: WRAPPER, lamports: 1, executable: false } : null;
        return o.ataExists === false ? null : { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false };
      });
    },
    async getAccountInfo(k: PublicKey) {
      if (k.equals(SOL)) {
        if (o.marketData instanceof Error) throw o.marketData;
        return o.marketData ? { data: o.marketData, owner: WRAPPER, lamports: 1, executable: false } : null;
      }
      return o.vaultLp?.registry ? { data: o.vaultLp.registry, owner: WRAPPER, lamports: 1, executable: false } : null;
    },
    async getLatestBlockhash() {
      if (o.blockhashThrow) throw new Error("blockhash rpc down");
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 };
    },
    async simulateTransaction(tx: VersionedTransaction, so?: { accounts?: { addresses: string[] } }) {
      const t = tagsOf(tx);
      const n = calls.sims.length;
      calls.sims.push(t);
      if (o.simThrow?.(t, n)) throw new Error(`sim rpc down at ${t.join(",")}`);
      const r = reply(t, n);
      const accounts = so?.accounts && !o.noPost
        ? so.accounts.addresses.map(() => ({ data: [Buffer.alloc(64, Math.min(calls.chunkSends + 1, total)).toString("base64"), "base64"] }))
        : undefined;
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [], accounts } };
    },
    async sendRawTransaction(raw: Buffer) {
      const tx = VersionedTransaction.deserialize(raw);
      calls.sent.push(tagsOf(tx));
      if (isChunk(tagsOf(tx))) calls.chunkSends++;
      return "5ig1111111111111111111111111111111111111111111111111111111111111";
    },
    async getSignatureStatuses() {
      return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: o.sigErr ?? null, confirmationStatus: "confirmed" }] };
    },
    async getBlockHeight() { return 1; },
  };
  return { conn: conn as unknown as CleanupConnection, calls };
}
/** The first sim is the probe: Custom(61) = past auth = "supported". */
const p3 = (rest: (tags: number[], n: number) => Sim) => (t: number[], n: number): Sim => (n === 0 ? { err: E(61) } : rest(t, n));
const run = (c: ReturnType<typeof mkConn>, o: { dry?: boolean; cfg?: Partial<CleanupConfig>; clock?: { nowSlot: bigint; resolvedSlot: bigint | null }; st?: CleanupState } = {}) =>
  cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, o.dry ?? false, { ...CFG, ...o.cfg }, o.st ?? new CleanupState(), o.clock);

describe("discovery and gate edge cases", () => {
  it("getProgramAccounts throwing an Error: reported as 'portfolio discovery failed', nothing simulated or sent", async () => {
    const c = mkConn([], () => ({ err: null }), { gpaThrow: new Error("rpc 503") });
    const r = await run(c);
    assert.deepEqual(r.remaining, [{ portfolio: "*", reason: "portfolio discovery failed: rpc 503" }]);
    assert.equal(r.support, "unknown");
    assert.equal(c.calls.sims.length + c.calls.sent.length, 0);
  });
  it("a non-Error throw is stringified into the same report", async () => {
    const r = await run(mkConn([], () => ({ err: null }), { gpaThrow: "plain string" }));
    assert.equal(r.remaining[0].reason, "portfolio discovery failed: plain string");
  });
  it("an unreadable market account: the scan falls back to the v2.1 portfolio length (9,563) and the next cycle retries", async () => {
    const c = mkConn([], () => ({ err: null }), { marketData: new Error("getAccountInfo down") });
    await run(c);
    assert.equal((c.calls.filters[0] as Array<{ dataSize?: number }>)[0].dataSize, 9_563);
  });
  it("a market account shorter than its header also keeps the v2.1 length", async () => {
    const c = mkConn([], () => ({ err: null }), { marketData: Buffer.alloc(4) });
    await run(c);
    assert.equal((c.calls.filters[0] as Array<{ dataSize?: number }>)[0].dataSize, 9_563);
  });
  it("a market VERSION the SDK has no layout for: discovery is reported failed, nothing is scanned at a guessed size", async () => {
    const d = Buffer.alloc(16);
    d.writeUInt16LE(60_000, 8);
    const c = mkConn([], () => ({ err: null }), { marketData: d });
    const r = await run(c);
    assert.match(r.remaining[0].reason, /portfolio discovery failed: market VERSION 60000 has no portfolio layout/);
    assert.equal(c.calls.gpaWrapper, 0);
  });
  it("no portfolios: reports the cached support verdict (or unknown when never probed) and sends nothing", async () => {
    const st = new CleanupState();
    assert.equal((await run(mkConn([], () => ({ err: null })), { st })).support, "unknown");
    st.support = { value: "supported", at: 0 };
    const c = mkConn([], () => ({ err: null }));
    const r = await run(c, { st });
    assert.equal(r.support, "supported");
    assert.equal(c.calls.sims.length, 0);
  });
  it("probe simulation throws: support unknown, every portfolio reported, nothing sent", async () => {
    const c = mkConn([{ pubkey: PF(), data: withOwner(Keypair.generate().publicKey) }], () => ({ err: null }), { simThrow: () => true });
    const r = await run(c);
    assert.equal(r.support, "unknown");
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /cleanup support unknown this cycle/);
  });
  it("a probe error that is not an InstructionError at tx index 1 is 'unknown', not 'unsupported'", async () => {
    const c = mkConn([{ pubkey: PF(), data: withOwner(Keypair.generate().publicKey) }], () => ({ err: "BlockhashNotFound" }));
    const r = await run(c);
    assert.equal(r.support, "unknown");
    assert.match(r.remaining[0].reason, /support unknown/);
  });
});

describe("owner token-account handling", () => {
  it("a failed token-account read is treated as 'absent' (unknown): the idempotent create is sent first", async () => {
    const owner = Keypair.generate().publicKey;
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(owner) }], p3(() => ({ err: null })), { gmaiThrow: (keys) => !keys.some((k) => k.equals(pf)) });
    const r = await run(c);
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[-1, 30, 8]]);
  });
  it("ATA-create budget: with a budget of 1, a second owner whose token account is missing is deferred, not failed", async () => {
    const a = PF(), b = PF();
    const c = mkConn([{ pubkey: a, data: withOwner(Keypair.generate().publicKey) }, { pubkey: b, data: withOwner(Keypair.generate().publicKey) }], p3(() => ({ err: null })), { ataExists: false });
    const r = await run(c, { cfg: { maxAtaCreatesPerCycle: 1 } });
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[-1, 30, 8]]);
    assert.deepEqual(r.remaining, [{ portfolio: b.toBase58(), reason: "owner token account missing; ATA-create budget for this cycle used" }]);
  });
});

describe("error attribution (why)", () => {
  it("Custom(6) names the NFT-holder-signature GH#496 cause and the last 'Error|failed' log line is appended (capped at 80 chars)", async () => {
    const long = "Program log: Error: " + "x".repeat(200);
    const c = mkConn([{ pubkey: PF(), data: withOwner(Keypair.generate().publicKey) }], p3(() => ({ err: E(6), logs: ["Program log: Error: first", long] })));
    const r = await run(c);
    assert.equal(r.closed, 0);
    const reason = r.remaining[0].reason;
    assert.match(reason, /^CloseResolved Custom\(6\) — NFT-escrowed payout needs the NFT holder's signature \(GH#496\)/);
    assert.ok(reason.endsWith(`(${long.slice(0, 80)})`), reason);
    assert.ok(!reason.includes("first"), "only the LAST matching log line");
  });
  it("a non-instruction error is attributed to 'tx' with its JSON, no hint", async () => {
    const c = mkConn([{ pubkey: PF(), data: withOwner(Keypair.generate().publicKey) }], p3(() => ({ err: "AccountInUse" })));
    const r = await run(c);
    assert.equal(r.remaining[0].reason, 'tx "AccountInUse"');
  });
  it("an InstructionError with a non-Custom detail prints that detail; an index outside the map prints 'ix N'", async () => {
    const c = mkConn([{ pubkey: PF(), data: withOwner(Keypair.generate().publicKey) }], p3(() => ({ err: { InstructionError: [9, "InvalidAccountData"] } })));
    const r = await run(c);
    assert.equal(r.remaining[0].reason, 'ix 9 "InvalidAccountData"');
  });
});

describe("paths (a) and (b): a tx that did not land", () => {
  it("(a) CloseResolved+ClosePortfolio simulates OK but does not land: reported, not counted closed", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], p3(() => ({ err: null })), { sigErr: E(1) });
    const r = await run(c);
    assert.equal(r.closed, 0);
    assert.deepEqual(c.calls.sent, [[30, 8]]);
    assert.deepEqual(r.remaining, [{ portfolio: pf.toBase58(), reason: "close tx did not land; retry next cycle" }]);
  });
  it("(b) ClosePortfolio alone simulates OK but does not land: reported, not counted closed", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], p3((t) => (t.includes(30) ? { err: E(61) } : { err: null })), { sigErr: E(1) });
    const r = await run(c);
    assert.equal(r.closed, 0);
    assert.deepEqual(c.calls.sent, [[8]]);
    assert.deepEqual(r.remaining, [{ portfolio: pf.toBase58(), reason: "close tx did not land; retry next cycle" }]);
  });
  it("an RPC that throws mid-portfolio is isolated to that portfolio's report (no exception escapes)", async () => {
    const a = PF(), b = PF();
    const c = mkConn([{ pubkey: a, data: withOwner(Keypair.generate().publicKey) }, { pubkey: b, data: withOwner(Keypair.generate().publicKey) }],
      p3(() => ({ err: null })), { simThrow: (_t, n) => n === 1 });
    const r = await run(c);
    assert.equal(r.closed, 1, "the second portfolio still closes");
    assert.deepEqual(r.remaining, [{ portfolio: a.toBase58(), reason: "sim rpc down at 30,8" }]);
  });
});

describe("path (c): chunked CloseResolved", () => {
  const chunkReply = p3((t) => (t.includes(8) ? { err: E(61, t.indexOf(8) + 1) } : { err: null }));
  it("a first chunk the RPC returns no post-state for is never sent: 'would make no progress'", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], chunkReply, { noPost: true });
    const r = await run(c);
    assert.deepEqual(c.calls.sent, []);
    assert.deepEqual(r.remaining, [{ portfolio: pf.toBase58(), reason: "CloseResolved: CloseResolved would make no progress" }]);
  });
  it("a chunk simulation error stops the loop with its attributed cause", async () => {
    const pf = PF();
    // probe 61, (a) 61, (b) 61, probe chunk ok, then runChunks' own chunk sim refuses with 21
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], p3((t, n) => (n === 4 ? { err: E(21) } : t.length === 1 && t[0] === 30 ? { err: null } : { err: E(61, t.indexOf(8) + 1) })));
    const r = await run(c);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /^CloseResolved: CloseResolved Custom\(21\)/);
  });
  it("a chunk that simulates with progress but does not land: stops, reported, not counted as progress", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], chunkReply, { sigErr: E(1) });
    const r = await run(c);
    assert.equal(r.progressed, 0);
    assert.deepEqual(c.calls.sent, [[30]], "the chunk was sent, then failed to land");
    assert.equal(r.remaining[0].reason, "CloseResolved: CloseResolved chunk tx did not land");
  });
  it("chunks create the missing token account once: the create is charged against the budget after progress", async () => {
    const a = PF(), b = PF();
    const c = mkConn([{ pubkey: a, data: withOwner(Keypair.generate().publicKey) }, { pubkey: b, data: withOwner(Keypair.generate().publicKey) }], chunkReply, { ataExists: false });
    const r = await run(c, { cfg: { maxAtaCreatesPerCycle: 1 } });
    assert.deepEqual(c.calls.sent, [[-1, 30]], "the first portfolio's first chunk carries the create");
    assert.equal(r.progressed, 1);
    assert.match(r.remaining.find((x) => x.portfolio === a.toBase58())!.reason, /CloseResolved made progress \(1 chunk call\(s\)\), not done/);
    assert.equal(r.remaining.find((x) => x.portfolio === b.toBase58())!.reason, "owner token account missing; ATA-create budget for this cycle used");
  });
});

describe("NFT-escrowed portfolios", () => {
  it("WITH a claim and no NFT record: reported waiting with a null holder/mint and '?' placeholders, nothing sent", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(ESCROW) }], p3(() => ({ err: null })));
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.equal(r.waitingOnHolder.length, 1);
    assert.equal(r.waitingOnHolder[0].nftMint, null);
    assert.equal(r.waitingOnHolder[0].holder, null);
    assert.match(r.remaining[0].reason, /waiting on NFT holder \? \(mint \?\)/);
  });
  it("AFTER grace, tag 8 refused: the close is not sent and the cause is attributed", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: emptyPortfolio(ESCROW) }], p3(() => ({ err: E(21) })));
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.deepEqual(r.pdaClosed, []);
    assert.equal(r.remaining[0].reason, "EMPTY NFT-escrowed after grace: tag 8 ClosePortfolio Custom(21)");
  });
  it("AFTER grace, tag 8 simulates OK but does not land: 'did not land', not counted closed", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: emptyPortfolio(ESCROW) }], p3(() => ({ err: null })), { sigErr: E(1) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(r.closed, 0);
    assert.deepEqual(r.pdaClosed, []);
    assert.equal(r.remaining[0].reason, "EMPTY NFT-escrowed after grace: tag 8 did not land");
  });
  it("AFTER grace, an RPC exception on the close is isolated to the report", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: emptyPortfolio(ESCROW) }], p3(() => ({ err: null })), { simThrow: (_t, n) => n === 1 });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.equal(r.closed, 0);
    assert.match(r.remaining[0].reason, /^sim rpc down at 8/);
  });
  it("positionNftFor: a legacy-only record is the holder; a throwing RPC / no records is null", async () => {
    const rec = fx("escrowed-position-nft-record");
    const portfolio = new PublicKey(rec.subarray(10, 42));
    const live = { marketGroup: SOL, portfolioId: 1n };
    const c = mkConn([], () => ({ err: null }), { nftRecords: [{ pubkey: PF(), data: rec }] });
    const got = await positionNftFor(c.conn, NFT, portfolio, live);
    assert.equal(got?.nftMint, new PublicKey(rec.subarray(42, 74)).toBase58());
    assert.equal(got?.holder, new PublicKey(rec.subarray(167, 199)).toBase58());
    assert.equal(await positionNftFor(mkConn([], () => ({ err: null })).conn, NFT, portfolio, live), null);
    assert.equal(await positionNftFor(mkConn([], () => ({ err: null }), { nftThrow: true }).conn, NFT, portfolio, live), null);
  });
});

describe("vault LP binding and failure paths", () => {
  const lpPf = PF();
  const lpData = () => withOwner(REGISTRY);
  it("decodeVaultLpState rejects a short buffer, a wrong kind and a wrong version", () => {
    const ok = vaultLpStateBuf(REGISTRY, lpPf, PF());
    assert.ok(decodeVaultLpState(new Uint8Array(ok)));
    assert.equal(decodeVaultLpState(new Uint8Array(ok.subarray(0, 100))), null);
    const wrongKind = Buffer.from(ok); wrongKind[10] = 8;
    assert.equal(decodeVaultLpState(new Uint8Array(wrongKind)), null);
    const wrongVer = Buffer.from(ok); wrongVer[16 + 214] = 2;
    assert.equal(decodeVaultLpState(new Uint8Array(wrongVer)), null);
  });
  it("the vault-LP state read throwing: the registry-owned portfolio is reported as unbound, nothing sent", async () => {
    const vaultKey = deriveVaultLpState(WRAPPER, SOL);
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3(() => ({ err: null })), {
      vaultLp: { state: vaultLpStateBuf(REGISTRY, lpPf, PF()), registry: registryBuf() },
      gmaiThrow: (keys) => keys.length === 1 && keys[0].equals(vaultKey),
    });
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });
  it("the registry account missing: unbound, nothing sent", async () => {
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3(() => ({ err: null })), { vaultLp: { state: vaultLpStateBuf(REGISTRY, lpPf, PF()), registry: null } });
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });
  it("a vault-LP state naming a DIFFERENT lp portfolio does not bind this one", async () => {
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3(() => ({ err: null })), { vaultLp: { state: vaultLpStateBuf(REGISTRY, PF(), PF()), registry: registryBuf() } });
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });
  const vaultLp = () => ({ state: vaultLpStateBuf(REGISTRY, lpPf, PF()), registry: registryBuf() });
  it("101 refused on the first chunk and the close refused: 'not closable this cycle' with the cause, nothing sent", async () => {
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3(() => ({ err: E(21) })), { vaultLp: vaultLp() });
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(r.closed, 0);
    assert.equal(r.vaultLpSettled, 0);
    assert.deepEqual(r.vaultLpClosed, []);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /^vault LP: not closable this cycle \(.*Custom\(21\)/);
  });
  it("101 makes progress but the close stays refused: 'made progress … continues next cycle', settled counted", async () => {
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3((t) => (t.includes(101) ? { err: null } : { err: E(21) })), { vaultLp: vaultLp() });
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(r.closed, 0);
    assert.equal(r.vaultLpSettled, 1);
    assert.deepEqual(r.vaultLpClosed, []);
    assert.match(r.remaining[0].reason, /^vault LP: tag 101 made progress \(1 chunk call\(s\)\), not done — continues next cycle/);
  });
  it("an RPC exception while settling the vault LP is isolated to its report", async () => {
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3(() => ({ err: null })), { vaultLp: vaultLp(), simThrow: (_t, n) => n === 1 });
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(r.closed, 0);
    assert.match(r.remaining[0].reason, /^sim rpc down at/);
  });
  it("p3_senior_draw log lines from a landed 101 chunk are surfaced for the caller to alert on", async () => {
    const c = mkConn([{ pubkey: lpPf, data: lpData() }], p3((t) => (t.includes(101) ? { err: null, logs: ["Program log: p3_senior_draw booked 5", "other"] } : t.includes(1011) ? { err: E(21) } : { err: null })), { vaultLp: vaultLp() });
    const r = await run(c, { clock: IN_GRACE });
    assert.deepEqual(r.seniorDrawLogs, ["Program log: p3_senior_draw booked 5"]);
  });
});

describe("resolved-receipt revisit refusals", () => {
  const refuseAll = p3(() => ({ err: E(21) }));
  it("an NFT-escrowed portfolio with an open receipt is reported as needing the holder's tag 46, never swept", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: openReceipt(emptyPortfolio(ESCROW)) }], refuseAll);
    const r = await run(c, { clock: IN_GRACE });
    assert.equal(c.calls.sent.length, 0);
    assert.deepEqual(r.topupSwept, []);
    assert.ok(r.remaining.some((x) => x.portfolio === pf.toBase58() && /holder must sign tag 46/.test(x.reason)));
  });
  it("tag 46 and the repeat CloseResolved both refused: both causes are reported for next cycle, nothing swept", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: openReceipt(withOwner(Keypair.generate().publicKey)) }], refuseAll);
    const r = await run(c, { clock: AFTER_GRACE });
    assert.deepEqual(r.topupSwept, []);
    const rev = r.remaining.find((x) => /open resolved receipt: tag 46/.test(x.reason));
    assert.ok(rev, JSON.stringify(r.remaining));
    assert.match(rev!.reason, /ClaimResolvedPayoutTopup Custom\(21\); repeat CloseResolved CloseResolved Custom\(21\) — revisit next cycle/);
  });
  it("a tag 46 that simulates OK but does not land is reported with its kind and not counted swept", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: openReceipt(withOwner(Keypair.generate().publicKey)) }], p3((t) => (t.length === 1 && t[0] === 46 ? { err: null } : { err: E(21) })), { sigErr: E(1) });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.deepEqual(c.calls.sent, [[46]]);
    assert.deepEqual(r.topupSwept, []);
    assert.ok(r.remaining.some((x) => x.reason === "receipt revisit (46) tx did not land; retry next cycle"));
  });
  it("an RPC exception on the revisit is isolated to that portfolio's report", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: openReceipt(withOwner(Keypair.generate().publicKey)) }], refuseAll, { simThrow: (t) => t.length === 1 && t[0] === 46 });
    const r = await run(c, { clock: AFTER_GRACE });
    assert.ok(r.remaining.some((x) => x.reason === "sim rpc down at 46"));
  });
  /** Tag 8 is refused until a tag 46 has simulated (an open receipt blocks the close on-chain). */
  const sweepable = () => {
    let swept = false;
    return p3((t) => {
      if (t.length === 1 && t[0] === 46) { swept = true; return { err: null }; }
      if (t.length === 1 && t[0] === 8 && swept) return { err: null };
      return { err: E(21) };
    });
  };
  it("the sweep is bounded per cycle: past the bound an open receipt is deferred, the earlier one is swept and closed once", async () => {
    const a = PF(), b = PF();
    const c = mkConn(
      [{ pubkey: a, data: openReceipt(withOwner(Keypair.generate().publicKey)) }, { pubkey: b, data: openReceipt(withOwner(Keypair.generate().publicKey)) }],
      sweepable(),
    );
    const r = await run(c, { cfg: { maxPerCycle: 1 }, clock: AFTER_GRACE });
    assert.deepEqual(r.topupSwept, [a.toBase58()]);
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[46], [8]]);
    assert.ok(r.remaining.some((x) => x.portfolio === b.toBase58() && /tag-46 sweep over the 1-per-cycle bound/.test(x.reason)));
  });
  it("the receipt read failing leaves the receipts unseen: no 46 is even simulated (control: it IS when the read works)", async () => {
    const data = () => openReceipt(withOwner(Keypair.generate().publicKey));
    const pf = PF();
    // The ATA read (first gmai) succeeds; the receipt re-read (second) fails.
    let calls = 0;
    const bad = mkConn([{ pubkey: pf, data: data() }], sweepable(), { gmaiThrow: () => ++calls > 1 });
    const r = await run(bad, { clock: AFTER_GRACE });
    assert.deepEqual(r.topupSwept, []);
    assert.ok(!bad.calls.sims.some((x) => x.includes(46)));
    const good = mkConn([{ pubkey: pf, data: data() }], sweepable());
    const g = await run(good, { clock: AFTER_GRACE });
    assert.deepEqual(g.topupSwept, [pf.toBase58()]);
    assert.ok(good.calls.sims.some((x) => x.includes(46)));
  });
});

describe("closeFinalizedReceiptPortfolios (receipt-only close)", () => {
  /** A closable receipt-only portfolio: the trader fixture with its capital/pnl zeroed and a finalized receipt. */
  const finalized = (owner: PublicKey): Buffer => {
    const b = emptyPortfolio(owner);
    b[RESOLVED_RECEIPT_OFF + 64] = 1;
    b[RESOLVED_RECEIPT_OFF + 65] = 1;
    assert.equal(parsePortfolioV17(new Uint8Array(b)).capital, 0n);
    return b;
  };
  const call = (c: ReturnType<typeof mkConn>, dry = false, cfg: Partial<CleanupConfig> = {}) => closeFinalizedReceiptPortfolios(c.conn, KEEPER, SOL, dry, { ...CFG, ...cfg });
  it("closes a finalized receipt-only portfolio with tag 8 alone", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: finalized(Keypair.generate().publicKey) }], () => ({ err: null }));
    const r = await call(c);
    assert.deepEqual(r, { closed: [pf.toBase58()], failed: [] });
    assert.deepEqual(c.calls.sent, [[8]]);
  });
  it("skips portfolios that are not receipt-only (open receipt, claim) and the registry-owned vault LP", async () => {
    const c = mkConn([
      { pubkey: PF(), data: openReceipt(emptyPortfolio(Keypair.generate().publicKey)) },
      { pubkey: PF(), data: withOwner(Keypair.generate().publicKey) },
      { pubkey: PF(), data: finalized(REGISTRY) },
    ], () => ({ err: null }));
    const r = await call(c);
    assert.deepEqual(r, { closed: [], failed: [] });
    assert.equal(c.calls.sims.length + c.calls.sent.length, 0);
  });
  it("discovery failure is reported with portfolio '*'", async () => {
    const r = await call(mkConn([], () => ({ err: null }), { gpaThrow: new Error("down") }));
    assert.deepEqual(r.failed, [{ portfolio: "*", reason: "portfolio discovery failed: down" }]);
  });
  it("a blockhash failure is reported and nothing is simulated", async () => {
    const c = mkConn([{ pubkey: PF(), data: finalized(Keypair.generate().publicKey) }], () => ({ err: null }), { blockhashThrow: true });
    const r = await call(c);
    assert.deepEqual(r.failed, [{ portfolio: "*", reason: "blockhash: blockhash rpc down" }]);
    assert.equal(c.calls.sims.length, 0);
  });
  it("a refused simulation is attributed and nothing is sent", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: finalized(Keypair.generate().publicKey) }], () => ({ err: E(21) }));
    const r = await call(c);
    assert.deepEqual(r.failed, [{ portfolio: pf.toBase58(), reason: "tag 8 ClosePortfolio Custom(21)" }]);
    assert.equal(c.calls.sent.length, 0);
  });
  it("a tx that does not land is reported, not counted closed", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: finalized(Keypair.generate().publicKey) }], () => ({ err: null }), { sigErr: E(1) });
    const r = await call(c);
    assert.deepEqual(r, { closed: [], failed: [{ portfolio: pf.toBase58(), reason: "tag 8 did not land; retry next cycle" }] });
  });
  it("dry-run simulates and counts closed but sends nothing", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: finalized(Keypair.generate().publicKey) }], () => ({ err: null }));
    const r = await call(c, true);
    assert.deepEqual(r.closed, [pf.toBase58()]);
    assert.equal(c.calls.sent.length, 0);
  });
  it("bounded per cycle: the overflow is reported, the rest closed; an RPC exception is isolated per portfolio", async () => {
    const [a, b, d] = [PF(), PF(), PF()];
    const c = mkConn(
      [a, b, d].map((pubkey) => ({ pubkey, data: finalized(Keypair.generate().publicKey) })),
      () => ({ err: null }),
      { simThrow: (_t, n) => n === 0 },
    );
    const r = await call(c, false, { maxPerCycle: 2 });
    assert.deepEqual(r.closed, [b.toBase58()]);
    assert.equal(r.failed.length, 2);
    assert.equal(r.failed[0].portfolio, a.toBase58());
    assert.match(r.failed[0].reason, /^sim rpc down at 8/);
    assert.deepEqual(r.failed[1], { portfolio: d.toBase58(), reason: "over the 2-per-cycle bound; next cycle" });
  });
});

describe("review leads: liveness and error attribution", () => {
  it("lead 1: a blockhash RPC failure is handled, the pass never throws (documented 'Never throws')", async () => {
    const pf = PF();
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], p3(() => ({ err: null })), { blockhashThrow: true });
    const r = await run(c);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /blockhash/);
  });
  it("lead 2: a chunk error on the CloseResolved ix is labelled CloseResolved even when an ATA create precedes it", async () => {
    const pf = PF();
    // sims: 0 probe, 1 (a), 2 (b), 3 probe chunk (ok), 4 runChunks' chunk sim: Custom(21) on ix 2 (ix 0 budget, 1 ATA, 2 CloseResolved)
    const c = mkConn([{ pubkey: pf, data: withOwner(Keypair.generate().publicKey) }], p3((t, n) => (n === 4 ? { err: E(21, 2) } : t.length === 2 && t[1] === 30 ? { err: null } : { err: E(61, t.indexOf(8) + 1) })), { ataExists: false });
    const r = await run(c);
    assert.equal(c.calls.sent.length, 0);
    assert.equal(r.remaining[0].reason, "CloseResolved: CloseResolved Custom(21)");
  });
});
