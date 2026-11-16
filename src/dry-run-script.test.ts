/**
 * src/dry-run.ts is the read-only `cross-cluster:dry-run` CLI (it never builds or sends a transaction; the
 * send/simulate switch lives in dry-run-switch.ts). It runs at import time, so each scenario runs it in a child
 * process (child coverage is merged by node --test) against a LOCAL 127.0.0.1 JSON-RPC fake (no network).
 *
 * Run with: node --import tsx/esm --test src/dry-run-script.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey } from "@solana/web3.js";

const RAYDIUM_CLMM_OWNER = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const CANON_RAYDIUM = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const CANON_METEORA = "FoSDw2L5DmTuQTFe55gWPDXf88euaxAEKFre74CnvQbX";

/** Raydium CLMM pool mint0 (9 dp) / mint1 = USDC (6 dp) priced at `priceE6` USDC per mint0. */
function raydiumPool(priceE6: bigint): Buffer {
  const b = Buffer.alloc(300);
  Keypair.generate().publicKey.toBuffer().copy(b, 73);
  USDC.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  const target = (priceE6 << 128n) / 1_000_000_000n;
  let x = target;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + target / x) / 2n;
  }
  b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(x >> 64n, 261);
  return b;
}

type Acct = { owner: string; data: Buffer } | "rpc-error" | "empty-data";
const accounts = new Map<string, Acct>();
let server: http.Server;
let rpcUrl = "";
let tmp = "";

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "dry-run-script-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rq = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const reply = (o: object) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rq.id, ...o }));
      };
      if (rq.method !== "getAccountInfo") return reply({ error: { code: -32601, message: "method not faked" } });
      const a = accounts.get(String(rq.params[0]));
      if (a === "rpc-error") return reply({ error: { code: -32000, message: "boom from fake rpc" } });
      if (a === undefined) return reply({ result: { context: { slot: 1 }, value: null } });
      const [owner, data] = a === "empty-data" ? [RAYDIUM_CLMM_OWNER, Buffer.alloc(0)] : [a.owner, a.data];
      reply({
        result: {
          context: { slot: 1 },
          value: { data: [data.toString("base64"), "base64"], executable: false, lamports: 1, owner, rentEpoch: 0, space: data.length },
        },
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?api-key=SECRETKEY123`;
});
after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
/** Run dry-run.ts in a child process (coverage of children is merged) against the local fake; return stdout. */
async function runDryRun(registry: object | undefined): Promise<string> {
  const regPath = join(tmp, `registry-${n++}.json`);
  if (registry !== undefined) writeFileSync(regPath, JSON.stringify(registry));
  const env = { ...process.env, HELIUS_MAINNET_RPC_URL: rpcUrl, REGISTRY_PATH: regPath };
  delete env.MAINNET_RPC_URL;
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/dry-run.ts"], { env });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  assert.equal(code, 0, `dry-run exited ${code}: ${err}`);
  return out;
}

const mk = (label: string, pool: string, extra: object = {}) => ({
  label,
  marketAddress: Keypair.generate().publicKey.toBase58(),
  assetIndex: 0,
  poolAddress: pool,
  dexType: "raydium-clmm",
  ...extra,
});
const pool = () => Keypair.generate().publicKey.toBase58();

describe("src/dry-run.ts (read-only CLI)", () => {
  it("empty registry: canonical OK resolves the SOL/USD reference, a missing pool SKIPs, key is redacted", async () => {
    accounts.clear();
    accounts.set(CANON_RAYDIUM, { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(150_000_000n) });
    const out = await runDryRun(undefined);
    assert.match(out, /Mainnet RPC : http:\/\/127\.0\.0\.1:\d+\/\?api-key=\*\*\*/);
    assert.doesNotMatch(out, /SECRETKEY123/);
    assert.match(out, /SOL\/USDC — Raydium CLMM \.\.\. OK {2}priceE6=149999999 {2}\(\$150\.0000\)/);
    assert.match(out, /SOL\/USDC — Meteora DLMM \.\.\. SKIP: pool account not found on mainnet/);
    assert.match(out, /\[info\] SOL\/USD reference for this run: \$150\.0000/);
    assert.match(out, /\[info\] Registry is empty/);
    assert.match(out, /\(0 markets\)/);
    assert.match(out, /=== Dry-run complete ===/);
    assert.doesNotMatch(out, /\[DRY-RUN\] PushAuthMark/);
  });

  it("canonical pool errors are caught per pool, no reference line is printed, empty-data pool SKIPs", async () => {
    accounts.clear();
    accounts.set(CANON_RAYDIUM, "rpc-error");
    accounts.set(CANON_METEORA, "empty-data");
    const out = await runDryRun({ version: 1, markets: [] });
    assert.match(out, /Raydium CLMM \.\.\. ERROR: .*boom from fake rpc/);
    assert.match(out, /Meteora DLMM \.\.\. SKIP: (pool account has empty data|pool owner)/);
    assert.doesNotMatch(out, /SOL\/USD reference for this run/);
    assert.match(out, /Dry-run complete/);
  });

  it("registry: pool OK prints a [DRY-RUN] line (and only a line); SKIP and ERROR rows do not; fixed rows print FIXED", async () => {
    accounts.clear();
    const okPool = pool();
    const errPool = pool();
    const missPool = pool();
    accounts.set(okPool, { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(2_500_000n) });
    accounts.set(errPool, "rpc-error");
    const okEntry = mk("FOO/USDC — raydium-clmm", okPool, { symbol: "FOO" });
    const errEntry = mk("BAR/USDC — raydium-clmm", errPool);
    const missEntry = mk("BAZ/USDC — raydium-clmm", missPool);
    const multi = {
      label: "MULTI",
      marketAddress: Keypair.generate().publicKey.toBase58(),
      assetIndex: 0,
      assets: [
        { assetIndex: 0, source: "fixed", fixedPriceE6: "100000000", symbol: "QA" },
        { assetIndex: 1, source: "fixed" }, // invalid (no price): dropped by priceUnitsOf
      ],
    };
    const out = await runDryRun({ version: 1, markets: [okEntry, errEntry, missEntry, multi] });
    assert.match(out, /Registry\s+: .* \(4 markets\)/);
    assert.match(out, /FOO\/USDC — raydium-clmm \(raydium-clmm\) \.\.\. OK {2}priceE6=2499999 {2}\(\$2\.5000\)/);
    assert.ok(out.includes(`[DRY-RUN] PushAuthMark market=${okEntry.marketAddress.slice(0, 8)}… assetIndex=0 priceE6=2499999 ($2.5000)`));
    assert.match(out, /BAR\/USDC — raydium-clmm \(raydium-clmm\) \.\.\. ERROR: .*boom from fake rpc/);
    assert.match(out, /BAZ\/USDC — raydium-clmm \(raydium-clmm\) \.\.\. SKIP: pool account not found on mainnet/);
    assert.match(out, /MULTI \[0 QA\] \(fixed\) \.\.\. FIXED priceE6=100000000 {2}\[DRY-RUN\] PushAuthMark/);
    assert.doesNotMatch(out, /MULTI \[1/);
    assert.equal(out.match(/\[DRY-RUN\] PushAuthMark/g)?.length, 2, "only the OK pool row and the fixed row would push");
    assert.doesNotMatch(out, /Registry is empty/);
    // a non-SOL entry must not become the SOL/USD reference
    assert.doesNotMatch(out, /SOL\/USD reference now resolved/);
  });

  it("registry SOL/USDC entry becomes the SOL/USD reference when the canonical reads failed; a second SOL entry does not replace it", async () => {
    accounts.clear();
    accounts.set(CANON_RAYDIUM, "rpc-error");
    accounts.set(CANON_METEORA, "rpc-error");
    const p1 = pool();
    const p2 = pool();
    accounts.set(p1, { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(140_000_000n) });
    accounts.set(p2, { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(160_000_000n) });
    const out = await runDryRun({
      version: 1,
      markets: [mk("SOL/USDC (Raydium)", p1, { symbol: "SOL/USDC" }), mk("SOL/USDC (Raydium 2)", p2, { symbol: "SOL/USDC" })],
    });
    assert.equal(out.match(/SOL\/USD reference now resolved/g)?.length, 1);
    assert.match(out, /SOL\/USD reference now resolved: \$140\.0000 \(from this entry\)/);
  });

  it("a registry pool whose owner is not the expected DEX SKIPs with the owner reason", async () => {
    accounts.clear();
    const p = pool();
    accounts.set(p, { owner: Keypair.generate().publicKey.toBase58(), data: raydiumPool(1_000_000n) });
    const out = await runDryRun({ version: 1, markets: [mk("QUX/USDC — raydium-clmm", p)] });
    assert.match(out, /QUX\/USDC — raydium-clmm \(raydium-clmm\) \.\.\. SKIP: pool owner .* does not match dexType=raydium-clmm/);
    assert.doesNotMatch(out, /\[DRY-RUN\] PushAuthMark/);
  });
});
