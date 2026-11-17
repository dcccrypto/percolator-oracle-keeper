import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyStakeFeeError } from "./stake-fee-pusher.ts";

describe("classifyStakeFeeError robustness", () => {
  it("a BigInt-carrying error yields failed, not a throw", () => {
    const r = classifyStakeFeeError({ x: 10n }, null);
    assert.equal(r.kind, "failed");
  });
  it("a circular error yields failed, not a throw", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    assert.equal(classifyStakeFeeError(o, null).kind, "failed");
  });
  it("the success line is not picked as the error tail", () => {
    const r = classifyStakeFeeError({ InstructionError: [2, { Custom: 5 }] }, [
      "Program log: AccrueFees: accrued 5 fees",
      "Program log: Error: boom",
    ]);
    assert.equal(r.kind, "failed");
    assert.ok(r.kind === "failed" && !r.error.includes("accrued 5 fees") && r.error.includes("boom"));
  });
});
