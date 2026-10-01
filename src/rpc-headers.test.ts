import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { devnetConnectionConfig } from "./rpc-headers.ts";

describe("devnetConnectionConfig", () => {
  it("no DEVNET_RPC_ORIGIN -> no headers", () => {
    assert.deepEqual(devnetConnectionConfig({}), { commitment: "confirmed" });
  });
  it("sets the Origin header the Origin-restricted Helius key needs", () => {
    assert.deepEqual(devnetConnectionConfig({ DEVNET_RPC_ORIGIN: "https://trade.padre.gg" }), {
      commitment: "confirmed",
      httpHeaders: { Origin: "https://trade.padre.gg" },
    });
  });
  it("rejects a non-origin value", () => {
    assert.throws(() => devnetConnectionConfig({ DEVNET_RPC_ORIGIN: "https://trade.padre.gg/path" }), /bare origin/);
    assert.throws(() => devnetConnectionConfig({ DEVNET_RPC_ORIGIN: "padre" }), /not a URL/);
  });
});
