/**
 * v1 wind-down: retire at OI = 0 and freeze-intake.
 *
 * Negative controls (each guard mutated once, confirmed caught, reverted) are listed in the PR.
 * Run with: node --import tsx/esm --test src/cross-cluster/retire-freeze.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, type Server } from "node:http";
import { PublicKey } from "@solana/web3.js";
import { fileURLToPath } from "url";
import {
  decideRetire,
  mintDecimals,
  newRetireState,
  readMarketEconomics,
  runRetirePass,
  RetiredSet,
  retireConfigFromEnv,
  type MarketEconomics,
  type RetireConfig,
} from "./retire.ts";
import { pollOnce } from "./register-poll.ts";
import { reloadRegistryOnce } from "./registry-reload.ts";
import { saveRegistry, type MarketEntry, type Registry } from "./registry.ts";
import { V17_MARKET_GROUP_OFF, deriveLpBackingLedger, deriveLpVaultRegistry } from "@percolatorct/sdk";

const CFG: RetireConfig = {
  thresholdMicroUnits: 1_000_000n,
  hardRetireAtMs: null,
  hardConfirmed: false,
  confirmReads: 3,
  minAgeMs: 0,
  nowMs: 1_000,
};
const EMPTY: MarketEconomics = { openInterest: 0n, capitalAtoms: 0n, earnPrincipalAtoms: 0n, decimals: 6 };
const A = "9efj3hdgb2qQvkHKYP9DjZYJQZqC1XiY5XgCiZkvss7u";
const B = "FEvg9DDJ3AKepzEyddZdE9Geyn4wcjsDdsejmPXJdfmt";
const POOL = "So11111111111111111111111111111111111111112";

const entry = (addr: string, registeredAt?: number): MarketEntry =>
  ({ label: `m-${addr.slice(0, 4)}`, marketAddress: addr, poolAddress: POOL, dexType: "pumpswap", assetIndex: 0, registeredAt }) as MarketEntry;
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "retire-"));

describe("decideRetire (single read)", () => {
  it("retires an empty market", () => assert.equal(decideRetire(EMPTY, CFG).retire, true));
  it("does NOT retire with open interest", () => {
    assert.equal(decideRetire({ ...EMPTY, openInterest: 1n }, CFG).retire, false);
  });
  it("does NOT retire when capital is still inside", () => {
    assert.equal(decideRetire({ ...EMPTY, capitalAtoms: 1_000_000n }, CFG).retire, false);
  });
  it("does NOT retire when Earn principal is still inside", () => {
    assert.equal(decideRetire({ ...EMPTY, earnPrincipalAtoms: 5_000_000n }, CFG).retire, false);
  });
  it("sums capital and Earn against the threshold", () => {
    assert.equal(decideRetire({ ...EMPTY, capitalAtoms: 600_000n, earnPrincipalAtoms: 600_000n }, CFG).retire, false);
    assert.equal(decideRetire({ ...EMPTY, capitalAtoms: 400_000n, earnPrincipalAtoms: 400_000n }, CFG).retire, true);
  });
  it("does NOT retire on a read failure (fail-safe)", () => {
    assert.equal(decideRetire(null, CFG).retire, false);
  });
});

describe("M-1: hard date respects the fail-safe and needs an explicit confirm for a non-empty market", () => {
  const HARD = { ...CFG, hardRetireAtMs: 2_000, nowMs: 2_000 };
  const FULL = { ...EMPTY, openInterest: 9n, capitalAtoms: 50_000_000n };
  it("past the hard date, a market with OI or funds is KEPT without the confirm", () => {
    const d = decideRetire(FULL, HARD);
    assert.equal(d.retire, false);
    assert.match(d.reason, /KEEPER_RETIRE_HARD_CONFIRM/);
  });
  it("past the hard date with the confirm, a non-empty market retires, flagged as an override", () => {
    const d = decideRetire(FULL, { ...HARD, hardConfirmed: true });
    assert.equal(d.retire, true);
    assert.equal(d.override, true);
  });
  it("before the hard date the confirm does nothing", () => {
    assert.equal(decideRetire(FULL, { ...HARD, nowMs: 1_999, hardConfirmed: true }).retire, false);
  });
  it("a failed read is KEPT even past a confirmed hard date", () => {
    assert.equal(decideRetire(null, { ...HARD, hardConfirmed: true }).retire, false);
  });
  it("the confirm must repeat the hard date verbatim", () => {
    const date = "2026-11-01T00:00:00Z";
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_HARD_DATE: date, KEEPER_RETIRE_HARD_CONFIRM: date }, 0).hardConfirmed, true);
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_HARD_DATE: date, KEEPER_RETIRE_HARD_CONFIRM: "1" }, 0).hardConfirmed, false);
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_HARD_DATE: date }, 0).hardConfirmed, false);
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_HARD_CONFIRM: date }, 0).hardConfirmed, false);
  });
  it("an unparseable hard date means no hard date, and bad numbers fall back to defaults", () => {
    const c = retireConfigFromEnv({ KEEPER_RETIRE_HARD_DATE: "soon", KEEPER_RETIRE_THRESHOLD_UNITS: "abc", KEEPER_RETIRE_CONFIRM_READS: "1" }, 5);
    assert.equal(c.hardRetireAtMs, null);
    assert.equal(c.thresholdMicroUnits, 1_000_000n);
    assert.equal(c.confirmReads, 3);
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_THRESHOLD_UNITS: "0.5" }, 5).thresholdMicroUnits, 500_000n);
  });
});

describe("L-3: threshold follows the collateral decimals", () => {
  it("1 token is 1e6 atoms at 6 dp and 1e9 atoms at 9 dp", () => {
    const halfAt9 = { ...EMPTY, capitalAtoms: 500_000_000n };
    assert.equal(decideRetire({ ...halfAt9, decimals: 9 }, CFG).retire, true);
    assert.equal(decideRetire({ ...halfAt9, decimals: 6 }, CFG).retire, false);
  });
  it("mintDecimals reads an SPL mint and refuses anything else", () => {
    const tok = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const d = Buffer.alloc(82);
    d[44] = 9;
    d[45] = 1;
    assert.equal(mintDecimals({ owner: tok, data: d }), 9);
    assert.equal(mintDecimals({ owner: new PublicKey(B), data: d }), null);
    const uninit = Buffer.from(d);
    uninit[45] = 0;
    assert.equal(mintDecimals({ owner: tok, data: uninit }), null);
    assert.equal(mintDecimals({ owner: tok, data: d.subarray(0, 50) }), null);
    assert.equal(mintDecimals(null), null);
  });
});

describe("runRetirePass", () => {
  const setup = (apply: boolean, read: (a: string) => Promise<MarketEconomics | null>, cfg: Partial<RetireConfig> = {}, markets = [entry(A), entry(B)]) => {
    const dir = tmp();
    const registryPath = path.join(dir, "registry.json");
    const registry: Registry = { version: 1, description: "t", markets };
    saveRegistry(registry, registryPath);
    const retired = new RetiredSet(path.join(dir, "registry.json.retired.json"));
    const state = newRetireState();
    const deps = { read, cfg: { ...CFG, ...cfg }, apply, registryPath, retired, state };
    return { registry, registryPath, retired, state, deps };
  };
  const passes = async (t: ReturnType<typeof setup>, n: number, bootFirst = true) => {
    let out: string[] = [];
    for (let i = 0; i < n; i++) out = await runRetirePass(t.registry, t.deps, { boot: bootFirst && i === 0 });
    return out;
  };

  it("dry-run (the default) names the market after confirmation but removes nothing", async () => {
    const t = setup(false, async () => EMPTY);
    const out = await passes(t, 3);
    assert.equal(out.length, 2);
    assert.equal(t.registry.markets.length, 2);
    assert.equal(t.retired.has(A), false);
  });
  it("L-1: one empty read never retires; it takes 3 consecutive passes", async () => {
    const t = setup(true, async (a) => (a === A ? EMPTY : { ...EMPTY, openInterest: 3n }));
    await runRetirePass(t.registry, t.deps, { boot: false });
    await runRetirePass(t.registry, t.deps, { boot: false });
    assert.equal(t.registry.markets.length, 2, "retired before the 3rd read");
    await runRetirePass(t.registry, t.deps, { boot: false });
    assert.deepEqual(t.registry.markets.map((m) => m.marketAddress), [B]);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.registryPath, "utf8")).markets.map((m: MarketEntry) => m.marketAddress), [B]);
    assert.equal(new RetiredSet(path.join(path.dirname(t.registryPath), "registry.json.retired.json")).has(A), true);
  });
  it("L-1: the boot pass never retires, even with the minimum confirm count", async () => {
    const t = setup(true, async () => EMPTY, { confirmReads: 1 });
    await runRetirePass(t.registry, t.deps, { boot: true });
    assert.equal(t.registry.markets.length, 2);
    await runRetirePass(t.registry, t.deps, { boot: false });
    assert.equal(t.registry.markets.length, 0, "confirmReads below 2 is clamped to 2: boot + 1");
  });
  it("L-1: confirmReads below 2 is clamped: a single non-boot read never retires", async () => {
    const t = setup(true, async () => EMPTY, { confirmReads: 1 });
    await runRetirePass(t.registry, t.deps, { boot: false });
    assert.equal(t.registry.markets.length, 2);
  });
  it("L-1: a boot pass retires nothing even when a streak is already complete", async () => {
    const t = setup(true, async () => EMPTY);
    t.state.streaks.set(A, 10);
    t.state.streaks.set(B, 10);
    await runRetirePass(t.registry, t.deps, { boot: true });
    assert.equal(t.registry.markets.length, 2);
  });
  it("L-1: a failed or non-empty read in between resets the count", async () => {
    let i = 0;
    const seq = [EMPTY, EMPTY, null, EMPTY, EMPTY, { ...EMPTY, capitalAtoms: 9_000_000n }, EMPTY, EMPTY];
    const t = setup(true, async () => (i < seq.length ? seq[i] : EMPTY), {}, [entry(A)]);
    for (; i < seq.length; i++) await runRetirePass(t.registry, t.deps, { boot: false });
    assert.equal(t.registry.markets.length, 1);
    await runRetirePass(t.registry, t.deps, { boot: false });
    assert.equal(t.registry.markets.length, 0);
  });
  it("a read that throws or returns null keeps every market", async () => {
    const t = setup(true, async (a) => {
      if (a === A) throw new Error("rpc 429");
      return null;
    });
    await passes(t, 5);
    assert.equal(t.registry.markets.length, 2);
  });
  it("does not retire a market with open interest", async () => {
    const t = setup(true, async () => ({ ...EMPTY, openInterest: 1n }));
    await passes(t, 5);
    assert.equal(t.registry.markets.length, 2);
  });
  it("M-1: past the hard date, a non-empty market without the confirm survives every pass", async () => {
    const t = setup(true, async () => ({ ...EMPTY, openInterest: 4n }), { hardRetireAtMs: 0 });
    await passes(t, 5);
    assert.equal(t.registry.markets.length, 2);
  });
  it("M-1: with the confirm it still needs the consecutive reads and never the boot pass", async () => {
    const t = setup(true, async () => ({ ...EMPTY, openInterest: 4n }), { hardRetireAtMs: 0, hardConfirmed: true });
    await passes(t, 2);
    assert.equal(t.registry.markets.length, 2);
    await passes(t, 1, false);
    assert.equal(t.registry.markets.length, 0);
  });
  it("L-3: a market younger than the minimum age is kept (registeredAt)", async () => {
    const t = setup(true, async () => EMPTY, { minAgeMs: 1_000, nowMs: 10_000 }, [entry(A, 9_500), entry(B, 1_000)]);
    await passes(t, 3);
    assert.deepEqual(t.registry.markets.map((m) => m.marketAddress), [A]);
  });
  it("L-3: without registeredAt the age counts from the first time this process saw it", async () => {
    const t = setup(true, async () => EMPTY, { minAgeMs: 1_000, nowMs: 10_000 }, [entry(A)]);
    await passes(t, 3);
    assert.equal(t.registry.markets.length, 1, "first seen now: too young");
    t.deps.cfg = { ...t.deps.cfg, nowMs: 11_000 };
    await passes(t, 3, false);
    assert.equal(t.registry.markets.length, 0);
  });
});

// ── readMarketEconomics against real devnet accounts ─────────────────────────
// Captured read-only 2026-10-05 from v1 wrapper ETDLAdi: market 5iGg1DPy ("www": OI 0, no trader capital;
// c_tot 1,905.570827 is the Earn vault's own LP portfolio,
// Earn vault with 4e9 shares and 2,000.427314 sim-USDC of backing principal), its LP vault registry
// (domain 0), its domain-0 backing ledger and the sim-USDC mint DJ54k4wH (6 dp).
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer => Buffer.from(fs.readFileSync(path.join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WWW = new PublicKey("5iGg1DPyoyWEzFCvbd26CVgPG2X9FgKaJrHaaGUWJyLr");
const SIM_USDC = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const REG = deriveLpVaultRegistry(WRAPPER, WWW)[0];
const LEDGER0 = deriveLpBackingLedger(WRAPPER, WWW, 0)[0];
type Acc = { owner: PublicKey; data: Buffer; lamports: number; executable: boolean };
const acc = (owner: PublicKey, data: Buffer): Acc => ({ owner, data, lamports: 1, executable: false });
const realAccounts = (): Map<string, Acc | null> =>
  new Map([
    [WWW.toBase58(), acc(WRAPPER, fx("retire-www-market-v18"))],
    [REG.toBase58(), acc(WRAPPER, fx("retire-www-lp-registry-v18"))],
    [LEDGER0.toBase58(), acc(WRAPPER, fx("retire-www-backing-ledger-v18"))],
    [SIM_USDC.toBase58(), acc(TOKEN, fx("retire-simusdc-mint"))],
  ]);
const connOver = (m: Map<string, Acc | null>) => ({
  getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => m.get(k.toBase58()) ?? null) as never,
});

describe("readMarketEconomics (real v1 fixtures)", () => {
  it("happy path: decodes OI, capital, Earn principal and decimals exactly", async () => {
    const e = await readMarketEconomics(connOver(realAccounts()), WWW.toBase58(), WRAPPER);
    assert.deepEqual(e, { openInterest: 0n, capitalAtoms: 1_905_570_827n, earnPrincipalAtoms: 2_000_427_314n, decimals: 6 });
    assert.equal(decideRetire(e, CFG).retire, false, "Earn principal and LP capital keep it");
  });
  it("happy path, emptied: the same market with a zero ledger and zero c_tot reads as retirable", async () => {
    const m = realAccounts();
    const led = Buffer.from(m.get(LEDGER0.toBase58())!.data);
    led.fill(0, 80, 96);
    m.set(LEDGER0.toBase58(), acc(WRAPPER, led));
    const mk = Buffer.from(m.get(WWW.toBase58())!.data);
    mk.fill(0, V17_MARKET_GROUP_OFF + 317, V17_MARKET_GROUP_OFF + 333);
    m.set(WWW.toBase58(), acc(WRAPPER, mk));
    const e = await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER);
    assert.deepEqual(e, { openInterest: 0n, capitalAtoms: 0n, earnPrincipalAtoms: 0n, decimals: 6 });
    assert.equal(decideRetire(e, CFG).retire, true);
    // and a real market with open interest decodes as non-zero OI (cate fixture: 1 long, 1 short)
    const cate = fx("cate-market-v18");
    m.set(WWW.toBase58(), acc(WRAPPER, cate));
    assert.ok((await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER))!.openInterest > 0n);
  });
  it("capital is read from c_tot", async () => {
    const m = realAccounts();
    const mk = Buffer.from(m.get(WWW.toBase58())!.data);
    mk.fill(0, V17_MARKET_GROUP_OFF + 317, V17_MARKET_GROUP_OFF + 333);
    mk.writeBigUInt64LE(7_000_000n, V17_MARKET_GROUP_OFF + 317);
    m.set(WWW.toBase58(), acc(WRAPPER, mk));
    assert.equal((await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER))?.capitalAtoms, 7_000_000n);
  });
  it("L-2: a market account not owned by the configured wrapper is unknown", async () => {
    const m = realAccounts();
    m.set(WWW.toBase58(), acc(new PublicKey(B), m.get(WWW.toBase58())!.data));
    assert.equal(await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER), null);
  });
  it("L-2: the same accounts read against another wrapper id are unknown", async () => {
    assert.equal(await readMarketEconomics(connOver(realAccounts()), WWW.toBase58(), new PublicKey(B)), null);
  });
  it("L-2: an Earn registry whose backing ledger is missing is unknown, not empty", async () => {
    const m = realAccounts();
    m.set(LEDGER0.toBase58(), null);
    assert.equal(await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER), null);
  });
  it("L-2: a ledger or registry owned by someone else is unknown", async () => {
    const m = realAccounts();
    m.set(LEDGER0.toBase58(), acc(new PublicKey(B), m.get(LEDGER0.toBase58())!.data));
    assert.equal(await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER), null);
    const m2 = realAccounts();
    m2.set(REG.toBase58(), acc(new PublicKey(B), m2.get(REG.toBase58())!.data));
    assert.equal(await readMarketEconomics(connOver(m2), WWW.toBase58(), WRAPPER), null);
  });
  it("no Earn registry at all: Earn is 0 (the market never had a vault)", async () => {
    const m = realAccounts();
    m.set(REG.toBase58(), null);
    m.set(LEDGER0.toBase58(), null);
    assert.equal((await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER))?.earnPrincipalAtoms, 0n);
  });
  it("L-3: a missing or undecodable collateral mint is unknown; a 9-dp mint is read as 9", async () => {
    const m = realAccounts();
    m.set(SIM_USDC.toBase58(), null);
    assert.equal(await readMarketEconomics(connOver(m), WWW.toBase58(), WRAPPER), null);
    const m9 = realAccounts();
    const mint = Buffer.from(m9.get(SIM_USDC.toBase58())!.data);
    mint[44] = 9;
    m9.set(SIM_USDC.toBase58(), acc(TOKEN, mint));
    assert.equal((await readMarketEconomics(connOver(m9), WWW.toBase58(), WRAPPER))?.decimals, 9);
  });
});

describe("freeze intake and the retired set at the register poll", () => {
  const state = { requests: 0 };
  let server: Server;
  let baseUrl = "";
  before(async () => {
    server = createServer((_req, res) => {
      state.requests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ slab_address: B, dex_pool_address: POOL, symbol: "NEW", mint_address: "m", mainnet_ca: null }]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const cfg = (extra: object) =>
    ({
      registryPath: path.join(tmp(), "registry.json"),
      db: { supabaseUrl: baseUrl, supabaseAnonKey: "t", network: "devnet", mainnetConn: { getMultipleAccountsInfo: async () => [] }, dexCache: new Map([[POOL, "pumpswap"]]) },
      ...extra,
    }) as never;

  it("flag off: the poll queries and admits the new market (control: proves the test reaches admission)", async () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A)] };
    state.requests = 0;
    await pollOnce(registry, cfg({}));
    assert.ok(state.requests > 0);
    assert.ok(registry.markets.some((m) => m.marketAddress === B));
  });
  it("freeze: admits nothing, prunes nothing, does not even query", async () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A)] };
    state.requests = 0;
    await pollOnce(registry, cfg({ freezeIntake: true }));
    assert.equal(state.requests, 0);
    assert.deepEqual(registry.markets.map((m) => m.marketAddress), [A]);
  });
  it("a retired market is never re-admitted by the poll", async () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A)] };
    await pollOnce(registry, cfg({ isRetired: (a: string) => a === B }));
    assert.equal(registry.markets.some((m) => m.marketAddress === B), false);
  });
});

describe("freeze intake at registry hot-reload", () => {
  const disk = (markets: MarketEntry[]): string => {
    const p = path.join(tmp(), "registry.json");
    saveRegistry({ version: 1, description: "t", markets }, p);
    return p;
  };
  it("flag off: an added market on disk is picked up (control)", () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A)] };
    reloadRegistryOnce(registry, disk([entry(A), entry(B)]));
    assert.equal(registry.markets.length, 2);
  });
  it("freeze: an added market on disk is ignored", () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A)] };
    reloadRegistryOnce(registry, disk([entry(A), entry(B)]), { freezeIntake: true });
    assert.deepEqual(registry.markets.map((m) => m.marketAddress), [A]);
  });
  it("freeze: a removal on disk still applies (so retiring by hand keeps working)", () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A), entry(B)] };
    reloadRegistryOnce(registry, disk([entry(A)]), { freezeIntake: true });
    assert.deepEqual(registry.markets.map((m) => m.marketAddress), [A]);
  });
  it("freeze: existing markets are still tracked, so cranking is unaffected", () => {
    const registry: Registry = { version: 1, description: "t", markets: [entry(A), entry(B)] };
    reloadRegistryOnce(registry, disk([entry(A), entry(B)]), { freezeIntake: true });
    assert.equal(registry.markets.length, 2);
  });
});

describe("readMarketEconomics fail-safe", () => {
  it("returns null when the RPC throws, the account is missing, or it does not decode", async () => {
    const prog = new PublicKey(B);
    assert.equal(await readMarketEconomics({ getMultipleAccountsInfo: async () => { throw new Error("429"); } }, A, prog), null);
    assert.equal(await readMarketEconomics({ getMultipleAccountsInfo: async () => [null, null] }, A, prog), null);
    const junk = { data: Buffer.alloc(64), owner: prog, lamports: 1, executable: false };
    assert.equal(await readMarketEconomics({ getMultipleAccountsInfo: async () => [junk, null] as never }, A, prog), null);
  });
});
