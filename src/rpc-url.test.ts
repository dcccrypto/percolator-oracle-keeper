import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLocalRpcHostname, validateRpcEndpoint } from "./rpc-url.ts";

// Fake token only; never a real key.
const TOKEN = "FAKE-TOKEN-123";

describe("validateRpcEndpoint secret redaction", () => {
  it("does not echo the api-key query of a malformed URL (bad port)", () => {
    const msg = validateRpcEndpoint("MAINNET_RPC_URL", `https://rpc.example.com:99999/?api-key=${TOKEN}`, { required: true }) ?? "";
    assert.match(msg, /MAINNET_RPC_URL is not a valid URL/);
    assert.ok(!msg.includes(TOKEN), msg);
    assert.match(msg, /rpc\.example\.com/);
  });

  it("does not echo a query after a stray space", () => {
    const msg = validateRpcEndpoint("X", `https://rpc .example.com/?api-key=${TOKEN}`) ?? "";
    assert.ok(!msg.includes(TOKEN), msg);
  });

  it("does not echo userinfo or fragment of a malformed URL", () => {
    const msg = validateRpcEndpoint("X", `https://user:${TOKEN}@rpc.example.com:99999/p#${TOKEN}`) ?? "";
    assert.ok(!msg.includes(TOKEN), msg);
  });

  it("does not echo a path-embedded key (QuickNode style) of a malformed URL", () => {
    const msg = validateRpcEndpoint("X", `https://rpc.example.com:99999/${TOKEN}/`) ?? "";
    assert.ok(!msg.includes(TOKEN), msg);
  });

  it("keeps the message useful for a plain bad value", () => {
    assert.match(validateRpcEndpoint("X", "not-a-url") ?? "", /X is not a valid URL/);
  });
});

describe("other leads (not leaks)", () => {
  it("non-https protocol message carries only the scheme", () => {
    const msg = validateRpcEndpoint("X", `ftp://u:${TOKEN}@h/?k=${TOKEN}`) ?? "";
    assert.match(msg, /got: ftp:/);
    assert.ok(!msg.includes(TOKEN));
    const http = validateRpcEndpoint("X", `http://h/?k=${TOKEN}`) ?? "";
    assert.ok(!http.includes(TOKEN));
  });

  it("isLocalRpcHostname is fail-closed: only exact loopback names", () => {
    assert.equal(isLocalRpcHostname("127.0.0.1"), true);
    assert.equal(isLocalRpcHostname(new URL("http://[::1]:8899").hostname), true);
    assert.equal(isLocalRpcHostname("127.0.0.2"), false);
    assert.equal(isLocalRpcHostname(new URL("http://[::ffff:127.0.0.1]").hostname), false);
  });
});
