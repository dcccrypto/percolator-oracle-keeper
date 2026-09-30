/**
 * B12 cleanup on the P3 FINAL wrapper b2b2559e: permissionless CloseResolved
 * + ClosePortfolio(owner at [3]) for every materialized portfolio on a
 * Resolved market, before stake tag 29. Gated so it is a no-op on 6377376a
 * (Custom(8) Unauthorized). PDA owners (NFT escrow, LP-vault registry) are
 * skipped so their rent is not stranded (security B12 review).
 *
 * Real bytes: SOL market (resolved by patching the mode byte) and a real SOL
 * trader portfolio (id 4, sequence 5, epoch 0, owner HbCNkGon…).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, deriveMarketVaultAccounts, deriveStakePool, parsePortfolioV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  buildClosePortfolioIx,
  buildCloseResolvedIx,
  classifyCleanupProbe,
  cleanupResolvedPortfolios,
  CleanupState,
  encodeClosePortfolio,
  encodeCloseResolved,
  nftEscrowAuthority,
  ownerAta,
  pdaOwnerSkipReason,
} from "./resolved-portfolio-cleanup.ts";
import type { CleanupConfig, CleanupConnection } from "./resolved-portfolio-cleanup.ts";
import { TerminalInsuranceState, windDownOnce } from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const NFT = new PublicKey("CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const SOL = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const KEEPER = Keypair.generate();
const MINT = parseWrapperConfigV17(new Uint8Array(fx("sol-market-v18-fees"))).collateralMint;
const TRADER = parsePortfolioV17(new Uint8Array(fx("sol-trader-portfolio-v18")));
/** A wallet (on-curve) owner for the ordinary closable case. The raw SOL trader fixture is NFT-escrowed. */
const WALLET = Keypair.generate().publicKey;
const CUCFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, probeTtlMs: 3_600_000, confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0 };

/** The trader portfolio with its owner (both copies, @80 and @116) replaced. */
function withOwner(owner: PublicKey): Buffer {
  const b = Buffer.from(fx("sol-trader-portfolio-v18"));
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  return b;
}

type Sim = { err: unknown; logs?: string[] };
function cconn(portfolios: Array<{ pubkey: PublicKey; data: Buffer }>, reply: (tags: number[]) => Sim, opts: { ataExists?: boolean } = {}) {
  const calls = { sims: [] as number[][], sent: [] as number[][], simKeys: [] as string[][], sentTag8: [] as Buffer[] };
  const tagsOf = (tx: VersionedTransaction): number[] =>
    tx.message.compiledInstructions.slice(1).map((ix) => {
      const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
      return pid === WRAPPER.toBase58() ? ix.data[0] : pid.startsWith("ATok") ? -1 : -2;
    });
  const conn = {
    async getProgramAccounts() { return portfolios.map((p) => ({ pubkey: p.pubkey, account: { data: p.data, owner: WRAPPER, lamports: 1, executable: false } })); },
    async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map(() => (opts.ataExists === false ? null : { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false })); },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      const t = tagsOf(tx); calls.sims.push(t);
      calls.simKeys.push(tx.message.staticAccountKeys.map((k) => k.toBase58()));
      const r = reply(t);
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [] } };
    },
    async sendRawTransaction(raw: Buffer) {
      const tx = VersionedTransaction.deserialize(raw);
      calls.sent.push(tagsOf(tx));
      for (const ix of tx.message.compiledInstructions) if (ix.data[0] === 8 && ix.data.length === 25) calls.sentTag8.push(Buffer.from(ix.data));
      return "5ig1111111111111111111111111111111111111111111111111111111111111"; },
    async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
    async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
  };
  return { conn: conn as unknown as CleanupConnection, calls };
}
const PF = (k?: PublicKey) => k ?? Keypair.generate().publicKey;
/** Probe = a lone tag 8 (first sim). P3 answers it with an engine error on a non-empty portfolio. */
const p3 = (rest: (tags: number[]) => Sim) => {
  let n = 0;
  return (t: number[]): Sim => (n++ === 0 ? { err: { InstructionError: [1, { Custom: 61 }] } } : rest(t));
};

describe("wire and accounts, checked against b2b2559e", () => {
  it("ClosePortfolio = [8][portfolio_id][expected_sequence][position_epoch] (25 B, u64 LE)", () => {
    const b = encodeClosePortfolio(4n, 5n, 7n);
    assert.equal(b.length, 25);
    assert.equal(b[0], 8);
    assert.deepEqual([b.readBigUInt64LE(1), b.readBigUInt64LE(9), b.readBigUInt64LE(17)], [4n, 5n, 7n]);
  });
  it("CloseResolved = [30][fee_rate_per_slot u128 = 0] (17 B)", () => {
    const b = encodeCloseResolved();
    assert.equal(b.length, 17);
    assert.equal(b[0], 30);
    assert.ok(b.subarray(1).every((x) => x === 0));
  });
  it("ClosePortfolio accounts: [closer s,w] [market w] [portfolio w] [owner w] (rent -> owner)", () => {
    const pf = PF();
    const ix = buildClosePortfolioIx({ wrapperProgramId: WRAPPER, closer: KEEPER.publicKey, market: SOL, portfolio: pf, owner: TRADER.owner, portfolioId: 4n, expectedSequence: 5n, positionEpoch: 0n });
    assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
      [KEEPER.publicKey.toBase58(), true, true], [SOL.toBase58(), false, true], [pf.toBase58(), false, true], [TRADER.owner.toBase58(), false, true],
    ]);
  });
  it("CloseResolved accounts: [owner unsigned] [market w] [portfolio w] [owner ATA w] [wrapper vault w] [vault auth] [token]", () => {
    const pf = PF();
    const ix = buildCloseResolvedIx({ wrapperProgramId: WRAPPER, owner: TRADER.owner, market: SOL, portfolio: pf, collateralMint: MINT });
    const v = deriveMarketVaultAccounts(WRAPPER, SOL, MINT);
    assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
      [TRADER.owner.toBase58(), false, false], [SOL.toBase58(), false, true], [pf.toBase58(), false, true],
      [ownerAta(TRADER.owner, MINT).toBase58(), false, true], [v.vaultToken.toBase58(), false, true],
      [v.vaultAuthority.toBase58(), false, false], [v.tokenProgram.toBase58(), false, false],
    ]);
  });
});

describe("gate: a no-op on 6377376a", () => {
  it("classifyCleanupProbe: Custom(8) at ClosePortfolio = unsupported; anything past auth = supported", () => {
    assert.equal(classifyCleanupProbe({ InstructionError: [1, { Custom: 8 }] }, false), "unsupported");
    assert.equal(classifyCleanupProbe({ InstructionError: [1, { Custom: 61 }] }, false), "supported");
    assert.equal(classifyCleanupProbe(null, true), "supported");
    assert.equal(classifyCleanupProbe("BlockhashNotFound", false), "unknown");
  });
  it("6377376a (probe -> Custom(8)): nothing is sent, every portfolio reported as needing P3", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], () => ({ err: { InstructionError: [1, { Custom: 8 }] } }));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.support, "unsupported");
    assert.equal(c.calls.sent.length, 0);
    assert.equal(c.calls.sims.length, 1, "only the probe");
    assert.match(r.remaining[0].reason, /needs P3 b2b2559e/);
  });
});

describe("cleanup on P3", () => {
  it("sends [CloseResolved, ClosePortfolio] bound to the portfolio's LIVE id/sequence/epoch", async () => {
    const pf = PF();
    const c = cconn([{ pubkey: pf, data: withOwner(WALLET) }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[30, 8]]);
    const d = c.calls.sentTag8[0];
    assert.deepEqual([d.readBigUInt64LE(1), d.readBigUInt64LE(9), d.readBigUInt64LE(17)], [TRADER.portfolioId, TRADER.matcherSequence, TRADER.matcherPositionEpoch]);
    assert.deepEqual([TRADER.portfolioId, TRADER.matcherSequence, TRADER.matcherPositionEpoch], [4n, 5n, 0n], "the real fixture's live binding");
  });
  it("creates the owner's token account first when it is missing (payout destination)", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: null })), { ataExists: false });
    await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.deepEqual(c.calls.sent, [[-1, 30, 8]]);
  });
  it("already resolved-closed: falls back to ClosePortfolio alone", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3((t) => (t.includes(30) ? { err: { InstructionError: [1, { Custom: 61 }] } } : { err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[8]]);
  });
  it("progress-only CloseResolved is sent, and the portfolio is reported as not yet closable", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3((t) => (t.includes(8) ? { err: { InstructionError: [t.indexOf(8) + 1, { Custom: 61 }] } } : { err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.equal(r.progressed, 1);
    assert.deepEqual(c.calls.sent, [[30]]);
  });
  it("an owner-signature requirement (NFT escrow / force-close delay) is reported, not retried blindly", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: { InstructionError: [1, "MissingRequiredSignature"] } })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /needs the owner's signature/);
  });
  it("bounded per cycle", async () => {
    const many = Array.from({ length: 10 }, () => ({ pubkey: PF(), data: withOwner(WALLET) }));
    const c = cconn(many, p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, { ...CUCFG, maxPerCycle: 3 }, new CleanupState());
    assert.equal(r.closed, 3);
    assert.equal(r.remaining.filter((x) => /per-cycle bound/.test(x.reason)).length, 7);
  });
  it("dry-run simulates only", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: null })));
    await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, true, CUCFG, new CleanupState());
    assert.equal(c.calls.sent.length, 0);
  });
});

describe("security B12 review: PDA-owned portfolios are never closed (rent would be stranded)", () => {
  const escrow = nftEscrowAuthority(NFT);
  const registry = deriveLpVaultRegistry(WRAPPER, SOL)[0];
  it("the NFT escrow PDA is find_program_address([\"mint_authority\"], nft) (wrapper derive_nft_mint_authority)", () => {
    assert.ok(escrow.equals(PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], NFT)[0]));
    assert.ok(!PublicKey.isOnCurve(escrow.toBytes()));
  });
  for (const [name, owner] of [["NFT escrow PDA", escrow], ["LP-vault registry PDA", registry]] as const) {
    it(`${name}: skipped before ANY close is simulated or sent`, async () => {
      const pf = PF();
      const c = cconn([{ pubkey: pf, data: withOwner(owner) }, { pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: null })));
      const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
      assert.equal(r.closed, 1, "only the wallet-owned portfolio");
      assert.ok(!c.calls.simKeys.slice(1).some((ks) => ks.includes(pf.toBase58())), "no close tx ever names the PDA-owned portfolio");
      assert.match(r.remaining.find((x) => x.portfolio === pf.toBase58())!.reason, /rent would be stranded/);
    });
  }
  it("a wallet owner is closable", () => {
    assert.equal(pdaOwnerSkipReason(WALLET, SOL, CUCFG), null);
  });
  it("REAL bytes: the live SOL trader portfolio is NFT-escrowed (owner = mint_authority PDA HbCNkGon…) and is skipped as-is", async () => {
    assert.ok(TRADER.owner.equals(escrow), "fixture owner is the escrow PDA");
    const pf = PF();
    const c = cconn([{ pubkey: pf, data: fx("sol-trader-portfolio-v18") }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /NFT escrow PDA/);
  });
});

describe("wind-down: cleanup runs before stake tag 29", () => {
  const MODE_ABS = 592 + 626;
  const COUNT_ABS = 592 + 517;
  const resolvedTextit = (count: bigint): Buffer => {
    const b = Buffer.from(fx("textit-market-v18-fees"));
    b[MODE_ABS] = 1;
    b.writeBigUInt64LE(count, COUNT_ABS);
    return b;
  };
  const TEXTIT = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
  const TCFG: TerminalInsuranceConfig = { wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000, confirm: CUCFG.confirm, now: () => 0, cleanup: CUCFG };

  function wconn(afterCleanupCount: bigint, cleanupProbe: Sim, budgetCallAnswers21 = false) {
    let marketReads = 0;
    let reReads = 0;
    const order: string[] = [];
    let n = 0;
    const conn = {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        if (keys.length === 2 && keys[1].equals(deriveStakePool(TEXTIT, STAKE)[0])) {
          marketReads++;
          return [{ data: resolvedTextit(1n), owner: WRAPPER, lamports: 1, executable: false }, { data: fx("textit-stake-pool-v18"), owner: STAKE, lamports: 1, executable: false }];
        }
        if (keys.length === 1 && keys[0].equals(TEXTIT)) reReads++;
        if (keys.length === 1 && keys[0].equals(TEXTIT)) return [{ data: resolvedTextit(afterCleanupCount), owner: WRAPPER, lamports: 1, executable: false }];
        return keys.map(() => ({ data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false }));
      },
      async getProgramAccounts() { return [{ pubkey: PF(), account: { data: withOwner(WALLET), owner: WRAPPER, lamports: 1, executable: false } }]; },
      async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: [] }; },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
      async simulateTransaction(tx: VersionedTransaction) {
        const ix = tx.message.compiledInstructions[1];
        const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
        const kind = pid === STAKE.toBase58() ? `stake29(${Buffer.from(ix.data).readBigUInt64LE(1)})` : `wrapper${ix.data[0]}`;
        order.push(kind);
        if (budgetCallAnswers21 && pid === STAKE.toBase58() && Buffer.from(ix.data).readBigUInt64LE(1) > 0n) {
          return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 21 }] }, logs: [] } };
        }
        if (n++ === 0) return { context: { slot: 1 }, value: { err: cleanupProbe.err, logs: [] } };
        if (kind.startsWith("stake29") && order.filter((o) => o.startsWith("stake29")).length === 1) return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 30 }] }, logs: [] } }; // tag-29 probe
        return { context: { slot: 1 }, value: { err: null, logs: [] } };
      },
      async sendRawTransaction() { order.push("SEND"); return "5ig1111111111111111111111111111111111111111111111111111111111111"; },
      async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
      async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    };
    return { conn: conn as unknown as TerminalConnection, order, reads: () => marketReads, reReads: () => reReads };
  }

  it("P3: portfolios closed first, the market re-read (count 0), then tag 29 recovers the budget", async () => {
    const w = wconn(0n, { err: { InstructionError: [1, { Custom: 61 }] } });
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    const firstStakeSim = w.order.findIndex((o) => o.startsWith("stake29"));
    const firstClose = w.order.findIndex((o) => o === "wrapper30");
    assert.ok(firstClose >= 0 && firstClose < firstStakeSim, `cleanup before tag 29: ${w.order.join(" ")}`);
    assert.equal(w.reReads(), 1, "market re-read after the cleanup closed something");
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
  });

  it("6377376a: cleanup is a no-op and the B12 alert names the count and the reason", async () => {
    // tag 29(budget) on a market that still has a portfolio answers 21
    const w = wconn(1n, { err: { InstructionError: [1, { Custom: 8 }] } }, true);
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "blocked");
    const reason = (r.outcome as { reason: string }).reason;
    assert.match(reason, /1 materialized portfolio\(s\) remain/);
    assert.match(reason, /Cleanup: support=unsupported, closed 0/);
    assert.ok(!w.order.includes("SEND"), "nothing sent on 6377376a");
  });
});
