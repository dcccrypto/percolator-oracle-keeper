/**
 * Coverage for the single-market AuthMark push path and its pure helpers in auth-mark-pusher.ts:
 * fetchOracleAuthority (version gate / short buffer / RPC throw), readMarketLotExp, perLotMarkE6,
 * perLotMarkFromE12, buildPushAuthMarkIx (legacy / depth / dex) and pushAuthMark (skip, dry-run,
 * sim-failure and send paths). Live callers: keeper-loop.ts imports fetchOracleAuthority and
 * pushAuthMarkBatch; push-deadline.ts imports parsePushAuthMarkGenerationFields.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/auth-mark-pusher-coverage.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_ORACLE_PROFILE_LEN,
} from "@percolatorct/sdk";
import {
  fetchOracleAuthority,
  readMarketLotExp,
  perLotMarkE6,
  perLotMarkFromE12,
  buildPushAuthMarkIx,
  pushAuthMark,
  parsePushAuthMarkGenerationFields,
  LOT_EXP_MAX,
  MAX_ORACLE_PRICE_E6,
  PROFILE_LOT_EXP_OFF,
  WRAPPER_PROGRAM_ID,
} from "./auth-mark-pusher.ts";
import { V19_MARKET_GROUP_OFF, V19_MARKET_GROUP_LEN } from "../wrapper-market-group-offset.ts";

const ORACLE_AUTHORITY_REL = 120; // oracle_authority within AssetOracleProfile (see fetchOracleAuthority)
const BH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 7 };

/** A parseable market account: valid magic/version, authority at asset-0 profile+120, lot_exp byte on v19. */
function marketAccount(opts: { authority: PublicKey; version?: number; lotExp?: number; marketId?: bigint }): Uint8Array {
  const version = opts.version ?? V17_EXPECTED_VERSION;
  const groupOff = version === 19 ? V19_MARKET_GROUP_OFF : V17_MARKET_GROUP_OFF;
  const groupLen = version === 19 ? V19_MARKET_GROUP_LEN : V17_MARKET_GROUP_LEN;
  const profileOff = groupOff + groupLen;
  const buf = new Uint8Array(profileOff + V17_ASSET_ORACLE_WRAPPER_LEN + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, version, true);
  buf.set(opts.authority.toBytes(), profileOff + ORACLE_AUTHORITY_REL);
  if (opts.lotExp !== undefined) buf[profileOff + PROFILE_LOT_EXP_OFF] = opts.lotExp;
  view.setBigUint64(profileOff + V17_ASSET_ORACLE_WRAPPER_LEN, opts.marketId ?? 5n, true);
  return buf;
}

function header(magic: bigint, version: number, len = 64): Uint8Array {
  const b = new Uint8Array(len);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, magic, true);
  v.setUint16(8, version, true);
  return b;
}

describe("fetchOracleAuthority", () => {
  const market = Keypair.generate().publicKey.toBase58();
  const conn = (info: { data: Uint8Array } | null) =>
    ({ getAccountInfo: async () => info }) as never;
  let warns: string[];
  const origWarn = console.warn;
  beforeEach(() => {
    warns = [];
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  });
  afterEach(() => {
    console.warn = origWarn;
  });

  it("returns null for a missing account", async () => {
    assert.equal(await fetchOracleAuthority(conn(null), market, 0), null);
  });

  it("returns null for a too-short buffer (no warning)", async () => {
    assert.equal(await fetchOracleAuthority(conn({ data: new Uint8Array(4) }), market, 0), null);
    assert.equal(warns.length, 0);
  });

  it("returns null and warns on bad magic", async () => {
    assert.equal(await fetchOracleAuthority(conn({ data: header(0xdeadn, 18) }), market, 0), null);
    assert.match(warns.join("\n"), /bad account magic 0xdead/);
  });

  it("returns null and warns on an unrecognized VERSION", async () => {
    assert.equal(await fetchOracleAuthority(conn({ data: header(V17_MAGIC, 999) }), market, 0), null);
    assert.match(warns.join("\n"), /unrecognized account VERSION=999/);
  });

  it("returns null when the buffer ends before the full oracle profile", async () => {
    const data = marketAccount({ authority: Keypair.generate().publicKey }).slice(0, V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_ASSET_ORACLE_PROFILE_LEN - 1);
    assert.equal(await fetchOracleAuthority(conn({ data }), market, 0), null);
  });

  it("reads the oracle_authority on v18 and v19 layouts", async () => {
    const auth = Keypair.generate().publicKey;
    for (const version of [V17_EXPECTED_VERSION, 19]) {
      const got = await fetchOracleAuthority(conn({ data: marketAccount({ authority: auth, version }) }), market, 0);
      assert.ok(got?.equals(auth), `version ${version}`);
    }
  });

  it("rethrows RPC errors (so the caller retries, not latches the market out)", async () => {
    const c = { getAccountInfo: async () => { throw new Error("429 too many"); } } as never;
    await assert.rejects(fetchOracleAuthority(c, market, 0), /429 too many/);
  });

  it("wraps a non-Error throw in an Error", async () => {
    const c = { getAccountInfo: async () => { throw "boom"; } } as never; // eslint-disable-line no-throw-literal
    await assert.rejects(fetchOracleAuthority(c, market, 0), (e: unknown) => e instanceof Error && e.message === "boom");
  });

  it("rejects a malformed address via the same rethrow path", async () => {
    await assert.rejects(fetchOracleAuthority(conn(null), "not-a-pubkey", 0));
  });
});

describe("readMarketLotExp", () => {
  it("is 0 below VERSION 19 without reading the byte", () => {
    assert.equal(readMarketLotExp(new Uint8Array(0), 18, 0), 0);
  });
  it("reads the byte on VERSION 19", () => {
    const d = new Uint8Array(40);
    d[10 + PROFILE_LOT_EXP_OFF] = 6;
    assert.equal(readMarketLotExp(d, 19, 10), 6);
    d[10 + PROFILE_LOT_EXP_OFF] = LOT_EXP_MAX;
    assert.equal(readMarketLotExp(d, 19, 10), LOT_EXP_MAX);
  });
  it("null when above LOT_EXP_MAX or out of range (skip, never guess)", () => {
    const d = new Uint8Array(40);
    d[PROFILE_LOT_EXP_OFF] = LOT_EXP_MAX + 1;
    assert.equal(readMarketLotExp(d, 19, 0), null);
    assert.equal(readMarketLotExp(new Uint8Array(PROFILE_LOT_EXP_OFF), 19, 0), null);
  });
});

describe("perLotMarkE6", () => {
  it("scales by 10^lotExp", () => {
    assert.equal(perLotMarkE6(1_206n, 6), 1_206_000_000n);
    assert.equal(perLotMarkE6(5n, 0), 5n);
  });
  it("rejects non-positive price, bad lotExp", () => {
    assert.equal(perLotMarkE6(0n, 3), null);
    assert.equal(perLotMarkE6(-1n, 3), null);
    assert.equal(perLotMarkE6(1n, -1), null);
    assert.equal(perLotMarkE6(1n, 1.5), null);
    assert.equal(perLotMarkE6(1n, LOT_EXP_MAX + 1), null);
  });
  it("rejects a mark above MAX_ORACLE_PRICE (skip, not clamp) and accepts exactly the max", () => {
    assert.equal(perLotMarkE6(MAX_ORACLE_PRICE_E6, 0), MAX_ORACLE_PRICE_E6);
    assert.equal(perLotMarkE6(MAX_ORACLE_PRICE_E6 + 1n, 0), null);
    assert.equal(perLotMarkE6(2_000_000n, 6), null);
  });
});

describe("perLotMarkFromE12", () => {
  it("tiny price (e6 == 0) on a lot-scaled market uses the e12 price, rounded", () => {
    assert.equal(perLotMarkFromE12(0n, 500n, 6), 500n);
    assert.equal(perLotMarkFromE12(0n, 999_999n, 1), 10n); // 9_999_990+500_000 /1e6 = 10
  });
  it("tiny price that rounds to zero or overflows the max is skipped", () => {
    assert.equal(perLotMarkFromE12(0n, 1n, 1), null);
    assert.equal(perLotMarkFromE12(0n, 999_999n, LOT_EXP_MAX), null);
  });
  it("tiny price with lotExp 0 / no e12 / e12 >= 1e6 stays a skip", () => {
    assert.equal(perLotMarkFromE12(0n, 500n, 0), null);
    assert.equal(perLotMarkFromE12(0n, undefined, 6), null);
    assert.equal(perLotMarkFromE12(0n, 1_000_000n, 6), null);
    assert.equal(perLotMarkFromE12(0n, 0n, 6), null);
  });
  it("keeps the extra digits when e12 agrees with e6 within one unit", () => {
    // $0.0012064: e6 floors to 1,206 (-> 1,206,000,000 per lot at lotExp 6), e12 keeps 1,206,400,000
    assert.equal(perLotMarkFromE12(1_206n, 1_206_400_000n, 6), 1_206_400_000n);
  });
  it("falls back to the coarse mark when e12 disagrees with e6", () => {
    assert.equal(perLotMarkFromE12(1_206n, 2_000_000_000n, 6), 1_206_000_000n);
  });
  it("falls back to coarse when lotExp 0, e12 missing or non-positive", () => {
    assert.equal(perLotMarkFromE12(1_206n, 1_206_400_000n, 0), 1_206n);
    assert.equal(perLotMarkFromE12(1_206n, undefined, 6), 1_206_000_000n);
    assert.equal(perLotMarkFromE12(1_206n, 0n, 6), 1_206_000_000n);
    assert.equal(perLotMarkFromE12(1_206n, -5n, 6), 1_206_000_000n);
  });
  it("falls back to coarse when the fine mark would exceed MAX_ORACLE_PRICE", () => {
    assert.equal(perLotMarkFromE12(1_000_000n, 1_000_000_500_000n, 6), MAX_ORACLE_PRICE_E6);
  });
  it("is null when the coarse mark is invalid (bad lotExp / price)", () => {
    assert.equal(perLotMarkFromE12(1n, 5n, LOT_EXP_MAX + 1), null);
    assert.equal(perLotMarkFromE12(0n, undefined, 0), null);
  });
});

describe("buildPushAuthMarkIx", () => {
  const auth = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  it("legacy form: wrapper program, authority signer + market, no extra accounts", () => {
    const ix = buildPushAuthMarkIx(auth, market, 0, 7n, 100n, 1_000_000n, 3n);
    assert.ok(ix.programId.equals(WRAPPER_PROGRAM_ID));
    assert.equal(ix.keys.length, 2);
    assert.ok(ix.keys[0].pubkey.equals(auth) && ix.keys[0].isSigner);
    assert.ok(ix.keys[1].pubkey.equals(market));
    assert.equal(ix.data.length, 35);
  });
  it("depth form is longer than legacy; null depth equals legacy", () => {
    const legacy = buildPushAuthMarkIx(auth, market, 0, 7n, 100n, 1_000_000n, 3n, null);
    const withDepth = buildPushAuthMarkIx(auth, market, 0, 7n, 100n, 1_000_000n, 3n, { depthE6: 5_000_000n, source: "cpmm" });
    assert.equal(legacy.data.length, 35);
    assert.ok(withDepth.data.length > 35);
    assert.equal(withDepth.keys.length, 2);
  });
  it("dex mode appends four read-only accounts and takes precedence over depth", () => {
    const k = () => Keypair.generate().publicKey;
    const dex = { depthSource: k(), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: k(), assetIndex: 0, marketId: 7n };
    const ix = buildPushAuthMarkIx(auth, market, 0, 7n, 100n, 1_000_000n, 3n, { depthE6: 1n, source: "x" }, dex);
    assert.equal(ix.keys.length, 6);
    for (const [i, key] of [dex.depthSource, dex.pool, dex.baseVault, dex.quoteVault].entries()) {
      assert.ok(ix.keys[2 + i].pubkey.equals(key));
      assert.equal(ix.keys[2 + i].isSigner, false);
      assert.equal(ix.keys[2 + i].isWritable, false);
    }
    assert.equal(ix.data.length, 44);
  });
});

describe("parsePushAuthMarkGenerationFields (edge cases)", () => {
  it("null on bad header, on a buffer too short for market_id, and on a bad lot_exp byte", () => {
    assert.equal(parsePushAuthMarkGenerationFields(new Uint8Array(2), 0), null);
    assert.equal(parsePushAuthMarkGenerationFields(header(V17_MAGIC, V17_EXPECTED_VERSION, 100), 0), null);
    const a = Keypair.generate().publicKey;
    assert.equal(parsePushAuthMarkGenerationFields(marketAccount({ authority: a, version: 19, lotExp: 99 }), 0), null);
  });
  it("reads lotExp and marketId on VERSION 19", () => {
    const a = Keypair.generate().publicKey;
    const f = parsePushAuthMarkGenerationFields(marketAccount({ authority: a, version: 19, lotExp: 4, marketId: 42n }), 0);
    assert.equal(f?.lotExp, 4);
    assert.equal(f?.marketId, 42n);
    assert.equal(f?.observationSequence, 1n);
  });
});

describe("pushAuthMark (single-market path)", () => {
  const keeper = Keypair.generate();
  const market = Keypair.generate().publicKey.toBase58();
  let logs: string[];
  const origWarn = console.warn;
  const origLog = console.log;
  beforeEach(() => {
    logs = [];
    console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  });
  afterEach(() => {
    console.warn = origWarn;
    console.log = origLog;
  });

  function fake(opts: {
    data?: Uint8Array | null | (() => Uint8Array | null);
    simErr?: unknown;
    calls?: string[];
  }) {
    const calls = opts.calls ?? [];
    const resolve = () => (typeof opts.data === "function" ? opts.data() : opts.data === undefined ? marketAccount({ authority: keeper.publicKey }) : opts.data);
    return {
      calls,
      conn: {
        async getSlot() { calls.push("getSlot"); return 321; },
        async getAccountInfo() { calls.push("getAccountInfo"); const d = resolve(); return d ? { data: d } : null; },
        async getLatestBlockhash() { calls.push("blockhash"); return BH; },
        async simulateTransaction() {
          calls.push("simulate");
          return { value: { err: opts.simErr ?? null, logs: ["l1", "l2", "l3", "l4", "l5", "l6"] } };
        },
        async sendRawTransaction(_raw: Buffer, o: { skipPreflight: boolean }) {
          calls.push(`send:skipPreflight=${o.skipPreflight}`);
          return "SIG1";
        },
        async confirmTransaction() { calls.push("confirm"); return { value: { err: null } }; },
      } as never,
    };
  }

  it("skips with authorityMismatch when the authority is unreadable", async () => {
    const f = fake({ data: null });
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false);
    assert.deepEqual([r.pushed, r.authorityMismatch, r.nowSlot], [false, true, 321n]);
    assert.ok(!f.calls.includes("simulate"));
    assert.match(logs.join("\n"), /not readable/);
  });

  it("skips with authorityMismatch when the on-chain authority is another key", async () => {
    const f = fake({ data: marketAccount({ authority: Keypair.generate().publicKey }) });
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false);
    assert.equal(r.pushed, false);
    assert.equal(r.authorityMismatch, true);
    assert.ok(!f.calls.includes("send:skipPreflight=false"));
  });

  it("skips (not a mismatch) when the account vanishes between the authority read and the generation read", async () => {
    let n = 0;
    const f = fake({ data: () => (n++ === 0 ? marketAccount({ authority: keeper.publicKey }) : null) });
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false);
    assert.deepEqual([r.pushed, r.authorityMismatch], [false, false]);
    assert.match(logs.join("\n"), /account not found/);
  });

  it("skips when generation fields cannot be parsed (bad lot_exp byte on v19)", async () => {
    let n = 0;
    const good = marketAccount({ authority: keeper.publicKey, version: 19, lotExp: 3 });
    const bad = marketAccount({ authority: keeper.publicKey, version: 19, lotExp: 200 });
    const f = fake({ data: () => (n++ === 0 ? good : bad) });
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false);
    assert.deepEqual([r.pushed, r.authorityMismatch], [false, false]);
    assert.match(logs.join("\n"), /could not read market_id/);
  });

  it("skips when the per-lot mark is out of range", async () => {
    const f = fake({ data: marketAccount({ authority: keeper.publicKey, version: 19, lotExp: 15 }) });
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false);
    assert.equal(r.pushed, false);
    assert.match(logs.join("\n"), /per-lot mark out of range/);
    assert.ok(!f.calls.includes("simulate"));
  });

  it("dry-run builds and logs but never fetches a blockhash or sends", async () => {
    const f = fake({});
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_234_567n, true);
    assert.deepEqual([r.pushed, r.dryRun, r.signature], [false, true, undefined]);
    assert.match(logs.join("\n"), /\[DRY-RUN\] PushAuthMark .*priceE6=1234567 \(\$1\.2346\)/);
    assert.ok(!f.calls.includes("blockhash") && !f.calls.includes("simulate"));
  });

  it("throws with the last five sim logs when simulation fails, and does not send", async () => {
    const f = fake({ simErr: { InstructionError: [1, { Custom: 21 }] } });
    await assert.rejects(
      pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false),
      (e: Error) => /sim failed/.test(e.message) && /Custom/.test(e.message) && /l2 \| l3 \| l4 \| l5 \| l6/.test(e.message) && !/l1 /.test(e.message),
    );
    assert.ok(!f.calls.some((c) => c.startsWith("send")));
  });

  it("simulates, sends with preflight on, confirms, and returns the signature", async () => {
    const f = fake({});
    const r = await pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false);
    assert.deepEqual([r.pushed, r.signature, r.priceE6, r.nowSlot], [true, "SIG1", 1_000_000n, 321n]);
    const order = f.calls.filter((c) => ["simulate", "confirm"].includes(c) || c.startsWith("send"));
    assert.deepEqual(order, ["simulate", "send:skipPreflight=false", "confirm"]);
  });

  it("propagates a send failure to the caller", async () => {
    const f = fake({});
    (f.conn as { sendRawTransaction: () => Promise<string> }).sendRawTransaction = async () => { throw new Error("blockhash expired"); };
    await assert.rejects(pushAuthMark(f.conn, keeper, market, 0, 1_000_000n, false), /blockhash expired/);
  });
});
