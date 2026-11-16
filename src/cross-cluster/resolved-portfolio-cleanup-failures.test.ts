/**
 * Failure / partial-batch coverage for resolved-portfolio-cleanup.ts (the path that closes
 * portfolios on a Resolved market and returns rent to the owner).
 *
 * Targets: discovery RPC errors, probe errors, one close failing mid-batch while the rest
 * still close, txs that do not land, thrown sends, ATA-budget exhaustion, a failed ATA read,
 * rent-destination ([3] = recorded owner) on the sent close, NFT-escrow close failures,
 * receipt-revisit failures, positionNftFor legacy / stale / error branches.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  cleanupResolvedPortfolios,
  CleanupState,
  nftEscrowAuthority,
  portfolioLenForMarketData,
  positionNftFor,
  RESOLVED_RECEIPT_OFF,
  ownerAta,
  decodePositionNft,
  POSITION_NFT_LEN,
  POSITION_NFT_LEN_LEGACY,
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
const CFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: 216_000n, probeTtlMs: 3_600_000, confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0 };
const AFTER_GRACE = { nowSlot: 900_000_000n, resolvedSlot: 500_000_000n };
const OK = { InstructionError: [1, { Custom: 61 }] };
const E = (c: number) => ({ InstructionError: [1, { Custom: c }] });

const withOwner = (owner: PublicKey): Buffer => {
  const b = Buffer.from(fx("sol-trader-portfolio-v18"));
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  return b;
};
const withOpenReceipt = (owner: PublicKey): Buffer => {
  const b = withOwner(owner);
  b[RESOLVED_RECEIPT_OFF + 64] = 1; b[RESOLVED_RECEIPT_OFF + 65] = 0;
  return b;
};
const emptyEscrowed = (): Buffer => {
  const b = Buffer.from(fx("cate-flat-portfolio-v18"));
  b.fill(0, 148, 164);
  ESCROW.toBuffer().copy(b, 80);
  ESCROW.toBuffer().copy(b, 116);
  return b;
};

interface Tx { tags: number[]; keys: string[]; ixAccounts: string[][]; }
interface Opts {
  gpa?: () => Promise<never>;
  multi?: () => Promise<never>;
  accountInfo?: () => Promise<never>;
  blockhash?: () => Promise<never>;
  ataExists?: boolean;
  /** Simulation verdict. Throw to model an RPC error. */
  sim: (tx: Tx, n: number) => { err: unknown; logs?: string[] } | "throw";
  /** Send verdict: "throw" rejects; "fail" lands as failed. */
  send?: (tx: Tx, n: number) => "ok" | "throw" | "fail";
}
function conn(portfolios: Array<{ pubkey: PublicKey; data: Buffer }>, o: Opts) {
  const sims: Tx[] = [];
  const sent: Tx[] = [];
  const failing = new Set<string>();
  const parse = (tx: VersionedTransaction): Tx => ({
    tags: nonComputeBudgetCompiled(tx.message.compiledInstructions, tx.message.staticAccountKeys).map((ix) => {
      const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
      return pid === WRAPPER.toBase58() ? ix.data[0] : pid.startsWith("ATok") ? -1 : -2;
    }),
    keys: tx.message.staticAccountKeys.map((k) => k.toBase58()),
    ixAccounts: nonComputeBudgetCompiled(tx.message.compiledInstructions, tx.message.staticAccountKeys).map((ix) => ix.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i].toBase58())),
  });
  const c = {
    async getProgramAccounts() {
      if (o.gpa) return o.gpa();
      return portfolios.map((p) => ({ pubkey: p.pubkey, account: { data: p.data, owner: WRAPPER, lamports: 67_000_000, executable: false } }));
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      if (o.multi) return o.multi();
      return keys.map((k) => {
        const pf = portfolios.find((p) => p.pubkey.equals(k));
        if (pf) return { data: pf.data, owner: WRAPPER, lamports: 67_000_000, executable: false };
        return o.ataExists === false ? null : { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false };
      });
    },
    async getAccountInfo() { if (o.accountInfo) return o.accountInfo(); return null; },
    async getLatestBlockhash() { if (o.blockhash) return o.blockhash(); return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      const t = parse(tx); sims.push(t);
      const r = o.sim(t, sims.length - 1);
      if (r === "throw") throw new Error("simulate RPC 503");
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [], accounts: undefined } };
    },
    async sendRawTransaction(raw: Buffer) {
      const t = parse(VersionedTransaction.deserialize(raw)); sent.push(t);
      const v = o.send ? o.send(t, sent.length - 1) : "ok";
      if (v === "throw") throw new Error("send RPC timeout");
      const sig = `sig${sent.length}`.padEnd(64, "1");
      if (v === "fail") failing.add(sig);
      return sig;
    },
    async getSignatureStatuses(sigs: string[]) {
      return { context: { slot: 2 }, value: sigs.map((s) => ({ slot: 2, confirmations: 1, err: failing.has(s) ? { InstructionError: [1, { Custom: 1 }] } : null, confirmationStatus: "confirmed" })) };
    },
    async getBlockHeight() { return 1; },
  };
  return { conn: c as unknown as CleanupConnection, sims, sent };
}
const pf = () => Keypair.generate().publicKey;
const owner = () => Keypair.generate().publicKey;
/** First sim is the capability probe (Custom 61 = engine error past auth = supported). */
const afterProbe = (rest: Opts["sim"]): Opts["sim"] => (t, n) => (n === 0 ? { err: OK } : rest(t, n));
const names = (t: Tx) => t.keys;

describe("resolved cleanup: read / probe RPC failures", () => {
  it("portfolio discovery RPC error: reported once as '*', nothing sent, never throws", async () => {
    const c = conn([], { gpa: async () => { throw new Error("gPA 429 too many requests"); }, sim: () => ({ err: null }) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.equal(c.sent.length, 0);
    assert.equal(r.remaining.length, 1);
    assert.equal(r.remaining[0].portfolio, "*");
    assert.match(r.remaining[0].reason, /portfolio discovery failed: gPA 429/);
  });
  it("no portfolios: empty result, support stays unknown (and keeps a cached verdict)", async () => {
    const c = conn([], { sim: () => ({ err: null }) });
    const st = new CleanupState();
    assert.equal((await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, st)).support, "unknown");
    st.support = { value: "supported", at: 0 };
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, st);
    assert.equal(r.support, "supported");
    assert.deepEqual(r.remaining, []);
    assert.equal(c.sims.length, 0);
  });
  it("the market account read failing falls back to the v2.1 length and the scan still runs", async () => {
    const filters: unknown[] = [];
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { accountInfo: async () => { throw new Error("getAccountInfo 500"); }, sim: afterProbe(() => ({ err: null })) });
    const orig = (c.conn as unknown as { getProgramAccounts: (...a: unknown[]) => Promise<unknown> }).getProgramAccounts;
    (c.conn as unknown as { getProgramAccounts: (...a: unknown[]) => Promise<unknown> }).getProgramAccounts = (...a) => { filters.push((a[1] as { filters: unknown[] }).filters[0]); return orig(...a); };
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(filters, [{ dataSize: portfolioLenForMarketData(null) }]);
  });
  it("portfolioLenForMarketData: unreadable/short -> v2.1 length; an unknown VERSION throws (nothing scanned at a guess)", () => {
    const v21 = portfolioLenForMarketData(null);
    assert.equal(portfolioLenForMarketData(undefined), v21);
    assert.equal(portfolioLenForMarketData(new Uint8Array(4)), v21);
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setUint16(8, 9999, true);
    assert.throws(() => portfolioLenForMarketData(bad), /market VERSION 9999 has no portfolio layout/);
  });
  it("unknown market VERSION: discovery fails closed, reported, nothing sent", async () => {
    const bad = Buffer.alloc(32);
    bad.writeUInt16LE(9999, 8);
    const base = conn([{ pubkey: pf(), data: withOwner(owner()) }], { sim: () => ({ err: null }) });
    (base.conn as unknown as { getAccountInfo: () => Promise<unknown> }).getAccountInfo = async () => ({ data: bad, owner: WRAPPER, lamports: 1, executable: false });
    const r = await cleanupResolvedPortfolios(base.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.match(r.remaining[0].reason, /portfolio discovery failed: market VERSION 9999/);
    assert.equal(base.sent.length, 0);
  });
  it("capability probe throws (RPC down): support unknown, every portfolio reported, nothing sent", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }, { pubkey: pf(), data: withOwner(owner()) }], { sim: () => "throw" });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.support, "unknown");
    assert.equal(r.remaining.length, 2);
    assert.ok(r.remaining.every((x) => /support unknown this cycle/.test(x.reason)));
    assert.equal(c.sent.length, 0);
  });
  it("a cached 'unknown' verdict is re-probed next cycle, not trusted", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { sim: afterProbe(() => ({ err: null })) });
    const st = new CleanupState();
    st.support = { value: "unknown", at: 0 };
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, st);
    assert.equal(r.support, "supported");
    assert.equal(r.closed, 1);
  });
  it("the ATA existence read failing is treated as 'absent': an idempotent create is prepended (payout destination safe)", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { multi: async () => { throw new Error("gMA 502"); }, sim: afterProbe(() => ({ err: null })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(c.sent.map((t) => t.tags), [[-1, 30, 8]]);
  });
});

describe("resolved cleanup: never throws", () => {
  it("getLatestBlockhash rejecting is reported, not thrown (doc: 'Never throws'; terminal-insurance does not wrap the call)", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { blockhash: async () => { throw new Error("blockhash 503"); }, sim: afterProbe(() => ({ err: null })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(c.sent.length, 0);
    assert.match(r.remaining[0].reason, /blockhash: blockhash 503/);
  });
});

describe("resolved cleanup: partial batch", () => {
  it("one close fails mid-batch: the others still close, the failure is reported with its portfolio and reason", async () => {
    const a = pf(), b = pf(), d = pf();
    const c = conn([a, b, d].map((k) => ({ pubkey: k, data: withOwner(owner()) })), {
      // portfolio b fails every shape (CloseResolved+8, 8 alone, chunk probe) with an owner-signature error
      sim: afterProbe((t) => (t.keys.includes(b.toBase58()) ? { err: { InstructionError: [1, "MissingRequiredSignature"] } } : { err: null })),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 2);
    assert.deepEqual(c.sent.map((t) => t.keys.includes(b.toBase58())), [false, false]);
    assert.equal(r.remaining.length, 1);
    assert.equal(r.remaining[0].portfolio, b.toBase58());
    assert.match(r.remaining[0].reason, /needs the owner's signature/);
  });
  it("a send that THROWS for one portfolio is contained: the error is reported and the next portfolio is still closed", async () => {
    const a = pf(), b = pf();
    const c = conn([a, b].map((k) => ({ pubkey: k, data: withOwner(owner()) })), {
      sim: afterProbe(() => ({ err: null })),
      send: (t) => (t.keys.includes(a.toBase58()) ? "throw" : "ok"),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.equal(r.remaining[0].portfolio, a.toBase58());
    assert.match(r.remaining[0].reason, /send RPC timeout/);
  });
  it("(a) CloseResolved+ClosePortfolio sent but did not land: not counted closed, retry next cycle", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { sim: afterProbe(() => ({ err: null })), send: () => "fail" });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.match(r.remaining[0].reason, /close tx did not land; retry next cycle/);
  });
  it("(b) ClosePortfolio-alone sent but did not land: not counted closed", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { sim: afterProbe((t) => (t.tags.includes(30) ? { err: E(61) } : { err: null })), send: () => "fail" });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.deepEqual(c.sent.map((t) => t.tags), [[8]]);
    assert.match(r.remaining[0].reason, /close tx did not land/);
  });
  it("a simulate RPC error mid-batch is contained per portfolio", async () => {
    const a = pf(), b = pf();
    const c = conn([a, b].map((k) => ({ pubkey: k, data: withOwner(owner()) })), {
      sim: (t, n) => (n === 0 ? { err: OK } : t.keys.includes(a.toBase58()) ? "throw" : { err: null }),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.match(r.remaining[0].reason, /simulate RPC 503/);
  });
  it("all three shapes fail with a program error: reported with the instruction name (not retried blindly)", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { sim: afterProbe(() => ({ err: E(21), logs: ["Program log: Error: EngineLockActive"] })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.equal(c.sent.length, 0);
    assert.match(r.remaining[0].reason, /CloseResolved Custom\(21\)/);
    assert.match(r.remaining[0].reason, /EngineLockActive/);
  });
  it("NFT-escrowed payout refusal (Custom 6) names the holder-signature requirement", async () => {
    const c = conn([{ pubkey: pf(), data: withOwner(owner()) }], { sim: afterProbe(() => ({ err: E(6) })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.match(r.remaining[0].reason, /NFT holder's signature \(GH#496\)/);
  });
  it("ATA-create budget: the portfolio past the budget is left for next cycle, not closed against a missing token account", async () => {
    const a = pf(), b = pf();
    const c = conn([a, b].map((k) => ({ pubkey: k, data: withOwner(owner()) })), { ataExists: false, sim: afterProbe(() => ({ err: null })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, { ...CFG, maxAtaCreatesPerCycle: 1 }, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(c.sent.map((t) => t.tags), [[-1, 30, 8]]);
    assert.match(r.remaining[0].reason, /ATA-create budget for this cycle used/);
  });
  it("rent destination: ClosePortfolio [3] is the recorded owner; CloseResolved pays the owner's ATA", async () => {
    const w = owner();
    const c = conn([{ pubkey: pf(), data: withOwner(w) }], { sim: afterProbe(() => ({ err: null })) });
    await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.deepEqual(c.sent[0].tags, [30, 8]);
    assert.equal(c.sent[0].ixAccounts[1][3], w.toBase58(), "ClosePortfolio rent destination [3] = owner");
    assert.equal(c.sent[0].ixAccounts[0][3], ownerAta(w, MINT).toBase58(), "CloseResolved payout [3] = owner ATA");
    assert.equal(c.sent[0].ixAccounts[1][0], KEEPER.publicKey.toBase58(), "keeper is the closer [0]");
  });
  it("per-cycle bound applies per index: bound reached leaves the tail reported, tail never simulated", async () => {
    const all = [pf(), pf(), pf()];
    const c = conn(all.map((k) => ({ pubkey: k, data: withOwner(owner()) })), { sim: afterProbe(() => ({ err: null })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, { ...CFG, maxPerCycle: 1 }, new CleanupState());
    assert.equal(r.closed, 1);
    assert.equal(r.remaining.length, 2);
    assert.ok(c.sims.slice(1).every((t) => t.keys.includes(all[0].toBase58()) || !all.slice(1).some((k) => t.keys.includes(k.toBase58()))));
  });
  it("a portfolio whose first CloseResolved chunk is refused is reported; the next portfolio still closes", async () => {
    const a = pf(), b = pf();
    const c = conn([a, b].map((k) => ({ pubkey: k, data: withOwner(owner()) })), {
      sim: afterProbe((t) => (t.keys.includes(a.toBase58()) ? (t.tags.includes(30) && t.tags.length === 1 ? { err: E(21) } : { err: E(61) }) : { err: null })),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.ok(r.remaining.some((x) => x.portfolio === a.toBase58()));
  });
});

describe("resolved cleanup: NFT-escrow and vault-LP failure branches", () => {
  it("EMPTY escrowed after grace: tag 8 refused -> reported with reason, nothing sent, not in pdaClosed", async () => {
    const p = pf();
    const c = conn([{ pubkey: p, data: emptyEscrowed() }], { sim: afterProbe(() => ({ err: E(21) })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.equal(c.sent.length, 0);
    assert.deepEqual(r.pdaClosed, []);
    assert.match(r.remaining[0].reason, /EMPTY NFT-escrowed after grace: tag 8 ClosePortfolio Custom\(21\)/);
  });
  it("EMPTY escrowed after grace: tag 8 sent but did not land -> 'did not land', rent not claimed closed", async () => {
    const c = conn([{ pubkey: pf(), data: emptyEscrowed() }], { sim: afterProbe(() => ({ err: null })), send: () => "fail" });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.equal(r.closed, 0);
    assert.deepEqual(r.pdaClosed, []);
    assert.match(r.remaining[0].reason, /tag 8 did not land/);
  });
  it("EMPTY escrowed after grace: a thrown send is contained", async () => {
    const c = conn([{ pubkey: pf(), data: emptyEscrowed() }], { sim: afterProbe(() => ({ err: null })), send: () => "throw" });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.match(r.remaining[0].reason, /send RPC timeout/);
  });
  it("registry-owned portfolio with an unreadable/undecodable vault-LP state is reported as unbound, nothing sent", async () => {
    const real = deriveLpVaultRegistry(WRAPPER, SOL)[0];
    const c = conn([{ pubkey: pf(), data: withOwner(real) }], { multi: async () => { throw new Error("gMA 502"); }, sim: afterProbe(() => ({ err: null })) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.equal(c.sent.length, 0);
    assert.ok(r.remaining.some((x) => /no bound vault-LP state/.test(x.reason)));
  });
});

describe("resolved cleanup: receipt-revisit failure branches", () => {
  // The portfolio is first attempted (a)/(b)/(c); we make those refuse so the sweep is what runs.
  const refuseCloses = (extra: (t: Tx) => { err: unknown } | null): Opts["sim"] => afterProbe((t) => {
    const x = extra(t);
    if (x) return x;
    return { err: E(21) };
  });
  it("46 and the repeat CloseResolved both refused: reported with both reasons, nothing sent", async () => {
    const p = pf();
    const c = conn([{ pubkey: p, data: withOpenReceipt(owner()) }], { sim: refuseCloses(() => null) });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.equal(c.sent.length, 0);
    assert.deepEqual(r.topupSwept, []);
    const x = r.remaining.find((y) => /open resolved receipt: tag 46/.test(y.reason));
    assert.ok(x, `got: ${JSON.stringify(r.remaining)}`);
    assert.match(x.reason, /repeat CloseResolved/);
  });
  it("46 sim ok but the tx did not land: 'did not land', not counted swept", async () => {
    const c = conn([{ pubkey: pf(), data: withOpenReceipt(owner()) }], {
      sim: refuseCloses((t) => (t.tags.length === 1 && t.tags[0] === 46 ? { err: null } : null)),
      send: (t) => (t.tags[0] === 46 ? "fail" : "ok"),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.deepEqual(r.topupSwept, []);
    assert.ok(r.remaining.some((x) => /receipt revisit \(46\) tx did not land/.test(x.reason)));
  });
  it("46 lands but tag 8 is still refused: swept, not closed, revisited next cycle", async () => {
    const c = conn([{ pubkey: pf(), data: withOpenReceipt(owner()) }], {
      sim: refuseCloses((t) => (t.tags.length === 1 && t.tags[0] === 46 ? { err: null } : null)),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.equal(r.topupSwept.length, 1);
    assert.equal(r.closed, 0);
    assert.ok(r.remaining.some((x) => /receipt revisited \(46\), not yet finalised/.test(x.reason)));
  });
  it("a thrown send in the sweep is contained", async () => {
    const c = conn([{ pubkey: pf(), data: withOpenReceipt(owner()) }], {
      sim: refuseCloses((t) => (t.tags.length === 1 && t.tags[0] === 46 ? { err: null } : null)),
      send: () => "throw",
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.ok(r.remaining.some((x) => /send RPC timeout/.test(x.reason)));
  });
  it("sweep bound: receipts past maxPerCycle are deferred, the first is still swept", async () => {
    const ps = [pf(), pf()];
    const c = conn(ps.map((k) => ({ pubkey: k, data: withOpenReceipt(owner()) })), {
      sim: refuseCloses((t) => (t.tags.length === 1 && t.tags[0] === 46 ? { err: null } : null)),
    });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, { ...CFG, maxPerCycle: 1 }, new CleanupState(), AFTER_GRACE);
    assert.equal(r.topupSwept.length, 1);
    assert.ok(r.remaining.some((x) => /tag-46 sweep over the 1-per-cycle bound/.test(x.reason)));
  });
  it("the receipt re-read failing skips the sweep (no 46 is sent blind, even though it would simulate OK)", async () => {
    let calls = 0;
    const base = conn([{ pubkey: pf(), data: withOpenReceipt(owner()) }], { sim: refuseCloses((t) => (t.tags.length === 1 && t.tags[0] === 46 ? { err: null } : null)) });
    const orig = (base.conn as unknown as { getMultipleAccountsInfo: (k: PublicKey[]) => Promise<unknown> }).getMultipleAccountsInfo;
    (base.conn as unknown as { getMultipleAccountsInfo: (k: PublicKey[]) => Promise<unknown> }).getMultipleAccountsInfo = async (k) => {
      if (++calls >= 2) throw new Error("gMA 502");
      return orig(k);
    };
    const r = await cleanupResolvedPortfolios(base.conn, KEEPER, SOL, MINT, false, CFG, new CleanupState(), AFTER_GRACE);
    assert.deepEqual(r.topupSwept, []);
    assert.ok(!base.sent.some((t) => t.tags.includes(46)));
  });
});

describe("positionNftFor / decodePositionNft: error and stale-record branches", () => {
  const portfolio = pf();
  const group = pf();
  it("getProgramAccounts throwing -> null (never throws)", async () => {
    const r = await positionNftFor({ getProgramAccounts: (async () => { throw new Error("gPA down"); }) as never }, NFT, portfolio, { marketGroup: group, portfolioId: 1n });
    assert.equal(r, null);
  });
  it("no records -> null", async () => {
    const r = await positionNftFor({ getProgramAccounts: (async () => []) as never }, NFT, portfolio, { marketGroup: group, portfolioId: 1n });
    assert.equal(r, null);
  });
  it("decodePositionNft rejects a wrong-length buffer", () => {
    assert.equal(decodePositionNft(new Uint8Array(10)), null);
    assert.equal(decodePositionNft(new Uint8Array(POSITION_NFT_LEN_LEGACY - 1)), null);
  });
  it("v3 incarnation binding, stale skip, and legacy fallback rules (v3 built from the real legacy record)", async () => {
    const legacy = Buffer.from(fx("escrowed-position-nft-record"));
    assert.equal(legacy.length, POSITION_NFT_LEN_LEGACY);
    const d = decodePositionNft(new Uint8Array(legacy))!;
    assert.equal(d.marketGroup, null);
    assert.equal(d.portfolioIdAtMint, null);
    const v3 = Buffer.alloc(POSITION_NFT_LEN);
    legacy.copy(v3, 0);
    group.toBuffer().copy(v3, 199);
    v3.writeBigUInt64LE(7n, 231);
    const mk = (rows: Buffer[]) => ({ getProgramAccounts: (async (_p: PublicKey, o: { filters: Array<{ dataSize?: number }> }) => {
      const size = o.filters[0].dataSize;
      return rows.filter((r) => r.length === size).map((r) => ({ pubkey: pf(), account: { data: r, owner: NFT, lamports: 1, executable: false } }));
    }) as never });
    const live = { marketGroup: group, portfolioId: 7n };
    assert.equal((await positionNftFor(mk([v3]), NFT, d.portfolio, live))?.holder, d.holder.toBase58());
    assert.equal(await positionNftFor(mk([v3]), NFT, d.portfolio, { ...live, portfolioId: 8n }), null, "stale incarnation");
    assert.equal(await positionNftFor(mk([v3]), NFT, d.portfolio, { ...live, portfolioId: 0n }), null, "id 0 never matches");
    assert.equal(await positionNftFor(mk([v3]), NFT, d.portfolio, { ...live, marketGroup: pf() }), null, "other group");
    assert.equal((await positionNftFor(mk([legacy]), NFT, d.portfolio, live))?.holder, d.holder.toBase58(), "legacy used when no v3 exists");
    assert.equal(await positionNftFor(mk([v3, legacy]), NFT, d.portfolio, { ...live, portfolioId: 8n }), null, "legacy is dead once a v3 names the portfolio");
    assert.equal(await positionNftFor(mk([legacy]), NFT, pf(), live), null, "legacy for another portfolio ignored");
  });
});
