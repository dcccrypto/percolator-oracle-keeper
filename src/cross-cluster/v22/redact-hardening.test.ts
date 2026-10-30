import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactErrorText } from "./redact.ts";
import { redactText } from "../../rpc-failover.ts";

const S = "SECRETKEY1234567890";
const both = (s: string): string[] => [redactErrorText(s, 4000), redactText(s, [])];

describe("redactors: forms the #225 fix did not cover", () => {
  const leaks: Array<[string, string]> = [
    ["a non-http scheme with userinfo (DB / pooler URL)", `connect failed postgres://svc:${S}@db.example.com:5432/app`],
    ["redis scheme", `redis://:${S}@cache.example.com:6379`],
    ["ftp scheme path token", `ftp://a.example.com/${S}`],
    ["bearer token", `HTTP 401 Authorization: Bearer ${S}`],
    ["bare bearer", `rejected Bearer ${S} by upstream`],
    ["x-api-key header", `request failed x-api-key: ${S}`],
    ["key= in free text", `bad request key=${S}`],
    ["password= in free text", `login failed password=${S}`],
    ["scheme-less host/path token", `fetch to rpc.example.com/v2/${S} failed`],
    ["double-slash host/path token", `request to //rpc.example.com/${S} failed`],
    ["URL followed by a comma", `https://rpc.example.com/${S},retrying`],
  ];
  for (const [name, text] of leaks) {
    it(`redacts ${name}`, () => {
      for (const out of both(text)) assert.ok(!out.includes(S), `leaked: ${out}`);
    });
  }

  it("does not mangle ordinary diagnostics", () => {
    for (const t of ["Custom(19) at src/cross-cluster/v22/redact.ts:12", "slot 516,495,267 lag 3,800", "https://api.devnet.solana.com", "fetch failed (ECONNRESET) api.devnet.solana.com"]) {
      assert.equal(redactErrorText(t, 4000), t);
      assert.equal(redactText(t, []), t);
    }
  });

  it("keeps the host of a redacted URL (the endpoint stays identifiable)", () => {
    assert.match(redactErrorText(`https://rpc.example.com/${S}`, 400), /^https:\/\/rpc\.example\.com\/\*\*\*$/);
  });
});
