// Differential test: the optimised price-reader must give byte-identical output to the frozen reference
// (ed00e3c, __fixtures__/price-reader-ref.ts) on the same fixtures: prices, e12 sink, depth sink, skip reasons, logs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as neu from "./price-reader.ts";
import * as ref from "./__fixtures__/price-reader-ref.ts";
import { buildFixture, mockConn, USDC, USDT, WSOL } from "./__fixtures__/price-reader-pools.ts";

type Mod = typeof neu;

async function runOnce(mod: Mod, tag: string, fx: ReturnType<typeof buildFixture>, opts: { refPool?: string; entries?: unknown[]; cycles?: number }) {
  const logs: string[] = [];
  const saved = [console.log, console.warn, console.error];
  console.log = (...a: unknown[]) => void logs.push("L " + a.join(" "));
  console.warn = (...a: unknown[]) => void logs.push("W " + a.join(" "));
  console.error = (...a: unknown[]) => void logs.push("E " + a.join(" "));
  try {
    const conn = mockConn(fx, `diff://${tag}`);
    const dec = new Map();
    const res: unknown[] = [];
    for (let c = 0; c < (opts.cycles ?? 2); c++) {
      const e12 = new Map<string, bigint>();
      const q = new Map<string, bigint>();
      const skip = new Map<string, string>();
      const out = await mod.readAllPoolPricesE6(conn as never, (opts.entries ?? fx.entries) as never, dec, opts.refPool, skip, e12, q);
      res.push({
        out: [...out],
        e12: [...e12],
        q: [...q],
        skip: [...skip],
      });
    }
    return { res, logs, dec: [...dec], calls: conn.calls };
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
}

function same(a: unknown, b: unknown) {
  assert.deepEqual(JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))), JSON.parse(JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))));
}

describe("price-reader: optimised vs reference are identical", () => {
  for (const [n, seed] of [[16, 7], [64, 7], [64, 99], [200, 3]] as const) {
    it(`readAllPoolPricesE6 on ${n} pools (seed ${seed}) incl. 100-key chunking`, async () => {
      const fx = buildFixture(n, seed, true);
      const a = await runOnce(ref as unknown as Mod, `ref${n}${seed}`, fx, {});
      const b = await runOnce(neu, `new${n}${seed}`, fx, {});
      same(a, b);
      assert.ok((a.res[0] as { out: unknown[] }).out.length > n / 2, "fixture actually prices pools");
      assert.ok((a.res[0] as { q: unknown[] }).q.length > 0, "depth sink exercised");
      assert.ok((a.res[0] as { e12: unknown[] }).e12.length > 0, "e12 sink exercised");
    });
  }

  it("SOL/USD reference pool path (no registered SOL entry) and a malformed poolAddress row", async () => {
    const fx = buildFixture(40, 11, true);
    const refPool = fx.entries[0].poolAddress;
    const entries = [...fx.entries.slice(1), { ...fx.entries[3], poolAddress: "not-a-pubkey", label: "bad" }];
    const a = await runOnce(ref as unknown as Mod, "refR", fx, { refPool, entries });
    const b = await runOnce(neu, "newR", fx, { refPool, entries });
    same(a, b);
    assert.ok((a.res[0] as { out: unknown[] }).out.length > 5);
    assert.ok(a.logs.some((l) => l.includes("malformed poolAddress")));
  });

  it("no SOL rate at all: WSOL-quoted pools are skipped identically", async () => {
    const fx = buildFixture(40, 5, false);
    const a = await runOnce(ref as unknown as Mod, "refN", fx, {});
    const b = await runOnce(neu, "newN", fx, {});
    same(a, b);
  });

  it("checkMintBinding / quote predicates agree on canonical, non-canonical, wrong and absent mainnetCa", () => {
    const keys = [USDC, USDT, WSOL, ...Array.from({ length: 30 }, () => Keypair.generate().publicKey)];
    const cas: Array<string | undefined> = [undefined, "", "garbage", " ", "1".repeat(32), "1" + keys[5].toBase58(), keys[5].toBase58() + " "];
    for (const k of keys) cas.push(k.toBase58());
    for (const base of keys) {
      for (const quote of [USDC, WSOL, keys[7], PublicKey.default]) {
        for (const ca of cas) same(neu.checkMintBinding(ca, base, quote), ref.checkMintBinding(ca, base, quote));
        assert.equal(neu.raydiumPriceIsNotUsd(quote), ref.raydiumPriceIsNotUsd(quote));
        assert.equal(neu.quoteIsNotUsdOrWsol(quote), ref.quoteIsNotUsdOrWsol(quote));
        assert.equal(neu.poolIsSolUsd(base, quote), ref.poolIsSolUsd(base, quote));
      }
    }
  });
});
