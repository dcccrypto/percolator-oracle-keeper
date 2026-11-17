/** redact.ts: URL branch coverage (root path, query, unparsable) plus the never-print-a-secret guarantee. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactErrorText } from "./redact.ts";

const SECRET = "s3cr3tVALUE0123456789abcdef";

describe("redactErrorText URL branches", () => {
  it("keeps scheme and host of a root URL with no path or query", () => {
    assert.equal(redactErrorText("fetch https://rpc.example.com/ failed"), "fetch https://rpc.example.com failed");
  });
  it("drops the path", () => {
    assert.equal(redactErrorText("https://rpc.example.com/v2/abc"), "https://rpc.example.com/***");
  });
  it("masks a bare query on a root URL (no key-like name, so only the URL branch handles it)", () => {
    assert.equal(redactErrorText("https://rpc.example.com/?x=1"), "https://rpc.example.com?***");
  });
  it("masks path and query together", () => {
    assert.equal(redactErrorText("https://rpc.example.com/p?x=1"), "https://rpc.example.com/***?***");
  });
  it("replaces an unparsable URL with <url>", () => {
    assert.equal(redactErrorText("bad http://[::1 end"), "bad <url> end");
  });
  it("honours the default 160 and an explicit max", () => {
    assert.equal(redactErrorText("a".repeat(500)).length, 160);
    assert.equal(redactErrorText("a".repeat(500), 10).length, 10);
    assert.equal(redactErrorText("short"), "short");
  });
});

describe("redactErrorText never prints a secret-looking value", () => {
  const inputs = [
    `https://mainnet.helius-rpc.com/?api-key=${SECRET}`,
    `https://solana-mainnet.g.alchemy.com/v2/${SECRET}`,
    `wss://rpc.example.com/${SECRET}`,
    `Authorization: Bearer ${SECRET}`,
    `Bearer ${SECRET}`,
    `x-api-key: ${SECRET}`,
    `token=${SECRET}&other=1`,
    `password=${SECRET}`,
    `postgres://user:${SECRET}@db.example.com/app`,
    `rpc.example.com/${SECRET}`,
    `Error: fetch failed for https://rpc.example.com/${SECRET}?api-key=${SECRET} (cause: ECONNRESET)`,
  ];
  for (const s of inputs) {
    it(`redacts: ${s.slice(0, 40)}`, () => {
      const out = redactErrorText(s, 10_000);
      assert.ok(!out.includes(SECRET), `leaked: ${out}`);
      assert.ok(!out.includes(SECRET.slice(0, 12)), `partial leak: ${out}`);
    });
  }
  it("is never printed to the console when an error is logged through the redactor", () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      console.error(redactErrorText(new Error(`GET https://rpc.example.com/${SECRET} 500`).message));
    } finally {
      console.error = orig;
    }
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes(SECRET));
    assert.match(logged[0], /rpc\.example\.com/);
  });
});
