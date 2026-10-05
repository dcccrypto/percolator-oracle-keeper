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
import { decideRetire, runRetirePass, RetiredSet, retireConfigFromEnv, type MarketEconomics, type RetireConfig } from "./retire.ts";
import { pollOnce } from "./register-poll.ts";
import { reloadRegistryOnce } from "./registry-reload.ts";
import { saveRegistry, type MarketEntry, type Registry } from "./registry.ts";

const CFG: RetireConfig = { thresholdAtoms: 1_000_000n, hardRetireAtMs: null, nowMs: 1_000 };
const EMPTY: MarketEconomics = { openInterest: 0n, capitalAtoms: 0n, earnPrincipalAtoms: 0n };
const A = "9efj3hdgb2qQvkHKYP9DjZYJQZqC1XiY5XgCiZkvss7u";
const B = "FEvg9DDJ3AKepzEyddZdE9Geyn4wcjsDdsejmPXJdfmt";
const POOL = "So11111111111111111111111111111111111111112";

const entry = (addr: string): MarketEntry =>
  ({ label: `m-${addr.slice(0, 4)}`, marketAddress: addr, poolAddress: POOL, dexType: "pumpswap", assetIndex: 0 }) as MarketEntry;
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "retire-"));

describe("decideRetire", () => {
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
  it("hard date retires even with OI, but not before the date", () => {
    const hard = { ...CFG, hardRetireAtMs: 2_000 };
    assert.equal(decideRetire({ ...EMPTY, openInterest: 9n }, { ...hard, nowMs: 1_999 }).retire, false);
    assert.equal(decideRetire({ ...EMPTY, openInterest: 9n }, { ...hard, nowMs: 2_000 }).retire, true);
  });
  it("an unparseable hard date means no hard date", () => {
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_HARD_DATE: "soon" }, 5).hardRetireAtMs, null);
    assert.equal(retireConfigFromEnv({ KEEPER_RETIRE_THRESHOLD_ATOMS: "abc" }, 5).thresholdAtoms, 1_000_000n);
  });
});

describe("runRetirePass", () => {
  const setup = (apply: boolean, read: (a: string) => Promise<MarketEconomics | null>) => {
    const dir = tmp();
    const registryPath = path.join(dir, "registry.json");
    const registry: Registry = { version: 1, description: "t", markets: [entry(A), entry(B)] };
    saveRegistry(registry, registryPath);
    const retired = new RetiredSet(path.join(dir, "registry.json.retired.json"));
    return { registry, registryPath, retired, deps: { read, cfg: CFG, apply, registryPath, retired } };
  };

  it("dry-run (the default) names the market but removes nothing", async () => {
    const t = setup(false, async () => EMPTY);
    const out = await runRetirePass(t.registry, t.deps);
    assert.equal(out.length, 2);
    assert.equal(t.registry.markets.length, 2);
    assert.equal(t.retired.has(A), false);
  });
  it("apply removes only the empty market, persists it, and records it as retired", async () => {
    const t = setup(true, async (a) => (a === A ? EMPTY : { ...EMPTY, openInterest: 3n }));
    await runRetirePass(t.registry, t.deps);
    assert.deepEqual(t.registry.markets.map((m) => m.marketAddress), [B]);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.registryPath, "utf8")).markets.map((m: MarketEntry) => m.marketAddress), [B]);
    assert.equal(new RetiredSet(path.join(path.dirname(t.registryPath), "registry.json.retired.json")).has(A), true);
  });
  it("a read that throws or returns null keeps every market", async () => {
    const t = setup(true, async (a) => {
      if (a === A) throw new Error("rpc 429");
      return null;
    });
    await runRetirePass(t.registry, t.deps);
    assert.equal(t.registry.markets.length, 2);
  });
  it("does not retire a market with open interest", async () => {
    const t = setup(true, async () => ({ ...EMPTY, openInterest: 1n }));
    await runRetirePass(t.registry, t.deps);
    assert.equal(t.registry.markets.length, 2);
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
    const { readMarketEconomics } = await import("./retire.ts");
    const prog = new PublicKey(B);
    assert.equal(await readMarketEconomics({ getMultipleAccountsInfo: async () => { throw new Error("429"); } }, A, prog), null);
    assert.equal(await readMarketEconomics({ getMultipleAccountsInfo: async () => [null, null, null] }, A, prog), null);
    const junk = { data: Buffer.alloc(64), owner: prog, lamports: 1, executable: false };
    assert.equal(await readMarketEconomics({ getMultipleAccountsInfo: async () => [junk, null, null] as never }, A, prog), null);
  });
});
