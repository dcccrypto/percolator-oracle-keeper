/** Program ids are config: the fresh-ID relaunch must be an env change only. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_IDS_V17 } from "@percolatorct/sdk";
import { resolveProgramIds } from "./program-ids.ts";

const KEY = "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT";

describe("resolveProgramIds", () => {
  it("defaults to the SDK constants", () => {
    const ids = resolveProgramIds({});
    assert.equal(ids.wrapper.toBase58(), PROGRAM_IDS_V17.percolator);
    assert.equal(ids.stake.toBase58(), PROGRAM_IDS_V17.vault);
    assert.equal(ids.matcher.toBase58(), PROGRAM_IDS_V17.matcher);
    assert.match(ids.source.wrapper, /^sdk/);
  });
  it("WRAPPER_PROGRAM_ID / STAKE_PROGRAM_ID override", () => {
    const ids = resolveProgramIds({ WRAPPER_PROGRAM_ID: KEY, STAKE_PROGRAM_ID: KEY });
    assert.equal(ids.wrapper.toBase58(), KEY);
    assert.equal(ids.stake.toBase58(), KEY);
    assert.equal(ids.source.wrapper, "env WRAPPER_PROGRAM_ID");
  });
  it("PROGRAM_ID is a legacy alias (the live .env carries it)", () => {
    assert.equal(resolveProgramIds({ PROGRAM_ID: KEY }).wrapper.toBase58(), KEY);
    assert.equal(resolveProgramIds({ PROGRAM_ID: KEY, WRAPPER_PROGRAM_ID: KEY }).wrapper.toBase58(), KEY);
  });
  it("two different wrapper ids is a half-finished cutover: refuse", () => {
    assert.throws(() => resolveProgramIds({ PROGRAM_ID: KEY, WRAPPER_PROGRAM_ID: PROGRAM_IDS_V17.percolator }), /disagree/);
  });
  it("a malformed id fails boot instead of silently pointing at nothing", () => {
    assert.throws(() => resolveProgramIds({ WRAPPER_PROGRAM_ID: "ETDLAdiA0OIl-not-base58" }), /not a valid base58/);
    assert.throws(() => resolveProgramIds({ STAKE_PROGRAM_ID: "abc" }), /not a valid base58/);
  });
  it("K-2: an id the SDK does not know is refused unless KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1", () => {
    const unknown = "11111111111111111111111111111112";
    assert.throws(() => resolveProgramIds({ WRAPPER_PROGRAM_ID: unknown }), /KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1/);
    assert.throws(() => resolveProgramIds({ PROGRAM_ID: unknown }), /not a program id this SDK build knows/);
    assert.throws(() => resolveProgramIds({ STAKE_PROGRAM_ID: unknown }), /KEEPER_ALLOW/);
    const ok = resolveProgramIds({ WRAPPER_PROGRAM_ID: unknown, KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1" });
    assert.equal(ok.wrapper.toBase58(), unknown);
    assert.deepEqual(ok.overridden, [`WRAPPER_PROGRAM_ID=${unknown}`], "recorded for the boot log");
  });
  it("blank values fall back to the SDK", () => {
    assert.equal(resolveProgramIds({ WRAPPER_PROGRAM_ID: "  " }).wrapper.toBase58(), PROGRAM_IDS_V17.percolator);
  });
});
