import { mock } from "node:test";
const sdk = await import("@percolatorct/sdk");
mock.module("@percolatorct/sdk", { namedExports: { ...sdk, LAYOUT_V22: { ...sdk.LAYOUT_V22, version: 18 } } });
try {
  await import("./wrapper-market-group-offset.ts?stale-layout");
  console.log("GUARD_DID_NOT_THROW");
  process.exit(1);
} catch (e) {
  console.log("GUARD_THREW " + e.message.split(",")[0].replace(/^pinned SDK /, "") + "," + e.message.split(",")[1].split(":")[0]);
}
