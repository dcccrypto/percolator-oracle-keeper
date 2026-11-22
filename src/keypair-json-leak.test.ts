/**
 * A malformed keypair JSON must never echo key bytes. JSON.parse's SyntaxError quotes ~10 chars each side of the bad
 * token, and Node's crash printer (no handler: v22-create-anchor, scripts/stake-commit-target-run) prints the whole input
 * line, i.e. the full key. Part 1 runs common operator mistakes through parseSecretKeyJson; part 2 starts every entry
 * point that loads a keypair and scans its whole output. Throwaway keys only.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(b: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}

/**
 * A throwaway key whose base58 form starts with a letter. A digit-first base58 string fails JSON.parse with a message that
 * quotes nothing, so only a letter-first one exercises V8's excerpt (and leaks) on the unfixed code.
 */
function letterFirstKey(): Uint8Array {
  for (;;) {
    const sk = Keypair.generate().secretKey;
    if (/^[A-Za-z]/.test(base58(sk))) return sk;
  }
}

/** Common ways an operator mangles a keypair JSON, built from one key. */
function mistakes(sk: Uint8Array): Array<[string, string]> {
  const a = Array.from(sk, String);
  const j = JSON.stringify(Array.from(sk));
  const at = (i: number, f: (e: string) => string) => "[" + a.map((e, k) => (k === i ? f(e) : e)).join(",") + "]";
  return [
    ["truncated paste (first 60%)", j.slice(0, Math.floor(j.length * 0.6))],
    ["missing closing ]", j.slice(0, -1)],
    ["missing opening [", j.slice(1)],
    ["stray x touching element 9", at(9, (e) => e + "x")],
    ["stray x before element 10", at(10, (e) => "x" + e)],
    ["stray x before element 31", at(31, (e) => "x" + e)],
    ["stray x before element 33", at(33, (e) => "x" + e)],
    ["double comma before element 20", at(20, (e) => "," + e)],
    ["trailing comma", j.slice(0, -1) + ",]"],
    ["trailing garbage", j + "\nexport"],
    ["single quotes", `'${j}'`],
    ["smart quotes", `\u201C${j}\u201D`],
    ["base58 secret", base58(sk)],
    ["hex secret", Buffer.from(sk).toString("hex")],
    ["UTF-8 BOM", "\uFEFF" + j],
    ["UTF-16LE file read as utf8", Buffer.from("\uFEFF" + j, "utf16le").toString("utf8")],
  ];
}

/** Two consecutive key entries, or 8 chars of the base58 / hex form, anywhere in `out`. */
function keyLeak(out: string, sk: Uint8Array): string | null {
  for (let i = 0; i + 1 < sk.length; i++) {
    if (new RegExp(`(?<![0-9])${sk[i]},${sk[i + 1]}(?![0-9])`).test(out)) return `entries #${i},#${i + 1}`;
  }
  for (const [name, enc] of [["base58", base58(sk)], ["hex", Buffer.from(sk).toString("hex")]] as const) {
    for (let i = 0; i + 8 <= enc.length; i++) if (out.includes(enc.slice(i, i + 8))) return `${name} chars ${i}..${i + 7}`;
  }
  return null;
}

const FIXED =
  /^KEEPER_KEYPAIR is not valid JSON: expected the 64-number byte array from a `solana-keygen` keypair file \(base58 is not accepted\)\. The parse error is omitted because it can contain secret-key bytes\.$/;

describe("parseSecretKeyJson", async () => {
  // Dynamic import so the child-process tests below still run (and fail) on a tree without the helper.
  const { parseSecretKeyJson } = (await import("./env-utils.ts")) as unknown as {
    parseSecretKeyJson: (text: string, source: string) => Uint8Array;
  };
  const parse = (text: string, source: string): Uint8Array => {
    assert.equal(typeof parseSecretKeyJson, "function", "env-utils.ts exports parseSecretKeyJson");
    return parseSecretKeyJson(text, source);
  };

  const thrown = (text: string): unknown => {
    try {
      parse(text, "KEEPER_KEYPAIR");
    } catch (e) {
      return e;
    }
    return undefined;
  };
  const keys = [letterFirstKey(), letterFirstKey(), Keypair.generate().secretKey];
  keys.forEach((sk, round) => {
    for (const [name, text] of mistakes(sk)) {
      it(`key ${round}: ${name} -> fixed SyntaxError, no key bytes`, () => {
        const err = thrown(text);
        assert.ok(err instanceof SyntaxError, `expected a SyntaxError, got ${String(err)}`);
        assert.match(err.message, FIXED);
        assert.equal((err as { cause?: unknown }).cause, undefined, "no cause: Node would print it");
        assert.equal(keyLeak(`${err.message}\n${err.stack}`, sk), null);
      });
    }
  });

  // A message that differs between keys carries information about the key, even when no byte run is visible.
  mistakes(keys[0]).forEach(([name], i) => {
    it(`${name}: the message is identical for every key`, () => {
      const msgs = keys.map((sk) => {
        const err = thrown(mistakes(sk)[i][1]);
        assert.ok(err instanceof SyntaxError, `expected a SyntaxError, got ${String(err)}`);
        return err.message;
      });
      for (const m of msgs) assert.equal(m, msgs[0]);
    });
  });

  it("names the file for the path variant", () => {
    assert.throws(() => parse("[1,2,", "keypair file /k/id.json"), /^SyntaxError: keypair file \/k\/id\.json is not valid JSON/);
  });

  it("a valid key loads exactly as Uint8Array.from(JSON.parse(text)) did", () => {
    const kp = Keypair.generate();
    const text = JSON.stringify(Array.from(kp.secretKey));
    const got = parse(text, "KEEPER_KEYPAIR");
    assert.deepEqual(got, Uint8Array.from(JSON.parse(text) as number[]));
    assert.equal(Keypair.fromSecretKey(got).publicKey.toBase58(), kp.publicKey.toBase58());
    assert.deepEqual(parse(` ${text}\n`, "KEEPER_KEYPAIR"), kp.secretKey, "surrounding whitespace still accepted");
  });

  it("valid JSON of the wrong shape still fails in Keypair.fromSecretKey with its fixed text (unchanged)", () => {
    const sk = Array.from(Keypair.generate().secretKey);
    for (const [text, msg] of [
      [JSON.stringify(sk.slice(0, 63)), /bad secret key size/],
      [JSON.stringify(sk.slice(0, 32)), /bad secret key size/],
      [JSON.stringify(JSON.stringify(sk)), /bad secret key size/],
      [JSON.stringify(sk.map((v, i) => (i === 5 ? 256 : v))), /provided secretKey is invalid/],
    ] as const) {
      assert.throws(() => Keypair.fromSecretKey(parse(text, "KEEPER_KEYPAIR")), msg);
    }
  });
});

// ── Part 2: every entry point, whole stdout+stderr ─────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "keypair-leak-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Start an entry; stop it early once `until` shows up (a valid key leaves the keeper / pusher running). */
function run(args: string[], env: Record<string, string>, until?: RegExp): Promise<{ code: number | null; out: string }> {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("KEEPER_") || k === "DRY_RUN") delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", ...args], {
      cwd: ROOT,
      // No public-devnet fallback: nothing here may reach a real RPC.
      env: { ...base, CC_HEALTH_PORT: "65000", DEVNET_RPC_FALLBACK_URLS: "off", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      if (until?.test(out)) child.kill("SIGKILL");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const RPC = { MAINNET_RPC_URL: "https://127.0.0.1:1", DEVNET_RPC_URL: "https://127.0.0.1:2" };
const MARKET = Keypair.generate().publicKey.toBase58();
const NO_REGISTRY = path.join(TMP, "no-registry.json");
type Entry = { name: string; args: string[]; env: Record<string, string>; exitNonZero: boolean };
const ENTRIES: Entry[] = [
  // keeper / pusher: exit status is #245's (boot latch); on this base they still exit 0 after the handler logs.
  { name: "cross-cluster", args: ["src/cross-cluster.ts"], env: { ...RPC, DRY_RUN: "true", REGISTRY_PATH: NO_REGISTRY }, exitNonZero: false },
  { name: "pusher", args: ["src/pusher.ts"], env: { ...RPC, DRY_RUN: "true", REGISTRY_PATH: NO_REGISTRY }, exitNonZero: false },
  { name: "pre-resolve-drain", args: ["src/pre-resolve-drain.ts", "--market", MARKET, "--dry-run"], env: RPC, exitNonZero: true },
  { name: "v22-create-anchor", args: ["src/v22-create-anchor.ts", MARKET], env: { ...RPC, KEEPER_V22_CREATE_ANCHOR: "on" }, exitNonZero: true },
];
// The forms that leak at each site without the fix: a V8 window, a Node crash-printer full line, a base58 secret, a leading quote.
const PICK = ["stray x before element 10", "missing closing ]", "base58 secret", "single quotes"];

describe("entry points never print key bytes for a malformed keypair", { concurrency: 6 }, () => {
  const sk = letterFirstKey();
  const forms = mistakes(sk).filter(([n]) => PICK.includes(n));
  const check = (r: { code: number | null; out: string }, source: RegExp, exitNonZero: boolean) => {
    assert.equal(keyLeak(r.out, sk), null, `leak in output:\n${r.out.slice(0, 600)}`);
    assert.match(r.out, source, "the error names where the key came from");
    if (exitNonZero) assert.notEqual(r.code, 0);
  };
  for (const e of ENTRIES) {
    for (const [form, text] of forms) {
      it(`${e.name}: KEEPER_KEYPAIR ${form}`, async () => {
        check(await run(e.args, { ...e.env, KEEPER_KEYPAIR: text }), /KEEPER_KEYPAIR is not valid JSON/, e.exitNonZero);
      });
    }
    it(`${e.name}: KEEPER_KEYPAIR_PATH file, missing closing ]`, async () => {
      const f = path.join(TMP, `${e.name}.json`);
      fs.writeFileSync(f, JSON.stringify(Array.from(sk)).slice(0, -1), { mode: 0o600 });
      check(await run(e.args, { ...e.env, KEEPER_KEYPAIR_PATH: f }), /keypair file .* is not valid JSON/, e.exitNonZero);
    });
  }
  for (const [form, text] of [...forms, ["UTF-8 BOM", "\uFEFF" + JSON.stringify(Array.from(sk))] as [string, string]]) {
    it(`scripts/stake-commit-target-run: key file ${form}`, async () => {
      const f = path.join(TMP, `stake-${form.replace(/\W+/g, "_")}.json`);
      fs.writeFileSync(f, text, { mode: 0o600 });
      check(await run(["scripts/stake-commit-target-run.ts", MARKET, f, "--once", "--dry"], {}), /keypair file .* is not valid JSON/, true);
    });
  }
  it("a valid key gets past the keypair load at every entry", async () => {
    const kp = Keypair.generate();
    const text = JSON.stringify(Array.from(kp.secretKey));
    const f = path.join(TMP, "valid.json");
    fs.writeFileSync(f, text, { mode: 0o600 });
    const pub = kp.publicKey.toBase58();
    // What each entry prints only AFTER the keypair line: its signer, or (no signer print) its next step's failure.
    const past: Array<[Promise<{ code: number | null; out: string }>, RegExp]> = [
      ...ENTRIES.map((e): [Promise<{ code: number | null; out: string }>, RegExp] => {
        const want = e.name === "v22-create-anchor" ? /\[v22-create-anchor\] (refused|failed)|fetch failed|ECONNREFUSED/ : new RegExp(pub);
        return [run(e.args, { ...e.env, KEEPER_KEYPAIR: text }, want), want];
      }),
      [run(["scripts/stake-commit-target-run.ts", MARKET, f, "--once", "--dry"], { RPC_URL: "https://127.0.0.1:1" }, /market load failed/), /market load failed/],
    ];
    for (const [p, want] of past) {
      const r = await p;
      assert.doesNotMatch(r.out, /not valid JSON|SyntaxError|bad secret key size|secretKey is invalid/, r.out.slice(0, 600));
      assert.match(r.out, want, r.out.slice(0, 600));
    }
  });
});
