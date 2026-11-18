import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactErrorText } from "./redact.ts";

const K = "SECRETKEY1234567890abcdef";
const noLeak = (out: string): void => assert.ok(!out.includes(K), `leaked: ${out}`);

describe("redactErrorText: realistic RPC URL forms", () => {
  it("Helius query key: host kept, key gone, search collapsed", () => {
    const out = redactErrorText(`fetch failed https://mainnet.helius-rpc.com/?api-key=${K}`);
    noLeak(out);
    assert.match(out, /mainnet\.helius-rpc\.com/);
  });

  it("URL with a root path and no query is kept as scheme+host only", () => {
    assert.equal(redactErrorText("GET https://api.devnet.solana.com/ failed"), "GET https://api.devnet.solana.com failed");
    assert.equal(redactErrorText("GET https://api.devnet.solana.com failed"), "GET https://api.devnet.solana.com failed");
  });

  it("Triton path key (no query) is dropped", () => {
    const out = redactErrorText(`429 from https://percolator.rpcpool.com/${K}`);
    noLeak(out);
    assert.match(out, /percolator\.rpcpool\.com\/\*\*\*/);
  });

  it("path key plus a non-secret-named query hits the generic search branch", () => {
    const out = redactErrorText(`https://x.example.com/v2/${K}?cluster=devnet&foo=${K}`);
    noLeak(out);
    assert.match(out, /x\.example\.com\/\*\*\*\?\*\*\*/);
  });

  it("query on a root path with an unnamed param still collapses to ?***", () => {
    const out = redactErrorText(`https://x.example.com/?${K}`);
    noLeak(out);
    assert.equal(out, "https://x.example.com?***");
  });

  it("basic-auth userinfo is removed (host only survives)", () => {
    const out = redactErrorText(`https://user:${K}@rpc.example.com/`);
    noLeak(out);
    assert.ok(!out.includes("user:"), out);
    assert.match(out, /rpc\.example\.com/);
  });

  it("basic-auth with password only and ws scheme", () => {
    const out = redactErrorText(`wss://:${K}@rpc.example.com/ws`);
    noLeak(out);
  });

  it("mixed-case key names and schemes", () => {
    for (const s of [
      `HTTPS://Rpc.Example.com/?API-KEY=${K}`,
      `https://rpc.example.com/?Api_Key=${K}`,
      `ApiKey=${K}`,
      `TOKEN=${K}`,
      `AUTHORIZATION: bearer ${K}`,
      `X-Api-Key: ${K}`,
    ]) noLeak(redactErrorText(s));
  });

  it("repeated keys: every occurrence is redacted", () => {
    const out = redactErrorText(
      `a https://h1.example.com/?api-key=${K}&api-key=${K} b https://h2.example.com/${K} c key=${K} key=${K}`,
      4000,
    );
    noLeak(out);
  });

  it("unparseable URL falls back to <url>", () => {
    const out = redactErrorText(`bad http://[${K}`);
    noLeak(out);
    assert.match(out, /<url>/);
  });

  it("default max truncates to 160 chars, explicit max is honoured", () => {
    const long = "x".repeat(500);
    assert.equal(redactErrorText(long).length, 160);
    assert.equal(redactErrorText(long, 10).length, 10);
  });

});

describe("redactErrorText: quoted / colon / spaced credential forms (JSON bodies, util.inspect headers)", () => {
  const forms: Array<[string, string]> = [
    ["JSON header", `{"headers":{"x-api-key":"${K}"}}`],
    ["util.inspect header", `{ headers: { 'x-api-key': '${K}' } }`],
    ["JSON api_key", `{"api_key":"${K}"}`],
    ["inspect apiKey", `{ apiKey: '${K}' }`],
    ["token colon", `token: ${K}`],
    ["password colon", `password: ${K}`],
    ["spaced equals", `key = ${K}`],
  ];
  for (const [name, s] of forms) {
    it(`redacts ${name}`, () => noLeak(redactErrorText(s, 4000)));
  }
});

describe("redactErrorText: non-string errors (callers pass String(err))", () => {
  it("Error instance via String() is redacted", () => {
    const e = new Error(`fetch failed https://rpc.example.com/?api-key=${K}`);
    noLeak(redactErrorText(String(e)));
  });

  it("String(non-Error values) of every common shape stays redacted", () => {
    for (const v of [{ message: `x api-key=${K}` }, [`api-key=${K}`], `api-key=${K}`]) {
      noLeak(redactErrorText(typeof v === "string" ? v : JSON.stringify(v), 4000));
    }
  });
});
