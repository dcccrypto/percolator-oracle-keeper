/**
 * Devnet v2.1 fresh-ID cutover (2026-10-05): the v2.1 program set is reachable
 * ONLY through KEEPER_DEVNET_V21=1, and switch-OFF resolution is exactly today's
 * ETDLAdi set (the live relaunch keeper's config).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROGRAM_IDS_DEVNET_V1,
  PROGRAM_IDS_DEVNET_V21,
  programIdSet,
  resolveProgramIds,
  resolveProgramSet,
  sdkKnownProgramIds,
} from "./program-ids.ts";

const V1 = {
  wrapper: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  stake: "VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w",
  matcher: "EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX",
  nft: "EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ",
};
const V21 = {
  wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
  nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
};

function flat(ids: ReturnType<typeof resolveProgramIds>) {
  return { wrapper: ids.wrapper.toBase58(), stake: ids.stake.toBase58(), matcher: ids.matcher.toBase58(), nft: ids.nft.toBase58() };
}

describe("KEEPER_DEVNET_V21 switch", () => {
  it("pinned literals are the ledger IDs (v21-fresh-ids-2026-10-05)", () => {
    assert.deepEqual({ ...PROGRAM_IDS_DEVNET_V1 }, V1);
    assert.deepEqual({ ...PROGRAM_IDS_DEVNET_V21 }, V21);
    assert.deepEqual({ ...programIdSet("v1") }, V1);
    assert.deepEqual({ ...programIdSet("v21") }, V21);
  });

  it("OFF (unset / blank / \"0\"): every program resolves to the ETDLAdi set", () => {
    for (const env of [{}, { KEEPER_DEVNET_V21: "" }, { KEEPER_DEVNET_V21: " " }, { KEEPER_DEVNET_V21: "0" }]) {
      const ids = resolveProgramIds(env);
      assert.equal(ids.programSet, "v1");
      assert.deepEqual(flat(ids), V1);
    }
  });

  it("OFF with the live relaunch .env (WRAPPER_PROGRAM_ID=ETDLAdi) is unchanged", () => {
    const ids = resolveProgramIds({ WRAPPER_PROGRAM_ID: V1.wrapper });
    assert.deepEqual(flat(ids), V1);
    assert.deepEqual(ids.overridden, []);
    assert.equal(ids.source.wrapper, "env WRAPPER_PROGRAM_ID");
  });

  it("ON (\"1\"): every program resolves to the v2.1 set, no override flag needed", () => {
    const ids = resolveProgramIds({ KEEPER_DEVNET_V21: "1" });
    assert.equal(ids.programSet, "v21");
    assert.deepEqual(flat(ids), V21);
    assert.deepEqual(ids.overridden, []);
    assert.match(ids.source.wrapper, /^builtin PROGRAM_IDS_DEVNET_V21/);
    // explicit v2.1 env on the second service is accepted and agrees
    const explicit = resolveProgramIds({ KEEPER_DEVNET_V21: "1", WRAPPER_PROGRAM_ID: V21.wrapper, STAKE_PROGRAM_ID: V21.stake });
    assert.deepEqual(flat(explicit), V21);
  });

  it("a v2.1 ID without the switch is refused (cannot go live by an env edit alone)", () => {
    for (const [k, v] of [
      ["WRAPPER_PROGRAM_ID", V21.wrapper],
      ["PROGRAM_ID", V21.wrapper],
      ["STAKE_PROGRAM_ID", V21.stake],
      ["MATCHER_PROGRAM_ID", V21.matcher],
      ["NFT_PROGRAM_ID", V21.nft],
    ] as const) {
      assert.throws(() => resolveProgramIds({ [k]: v }), /belongs to the v2\.1 program set.*KEEPER_DEVNET_V21=1/, k);
      // even with the K-2 override flag
      assert.throws(() => resolveProgramIds({ [k]: v, KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1" }), /belongs to the v2\.1/, k);
    }
  });

  it("a v1 ID with the switch on is refused (mixed worlds)", () => {
    assert.throws(() => resolveProgramIds({ KEEPER_DEVNET_V21: "1", WRAPPER_PROGRAM_ID: V1.wrapper }), /belongs to the v1 \(ETDLAdi\)/);
    assert.throws(() => resolveProgramIds({ KEEPER_DEVNET_V21: "1", STAKE_PROGRAM_ID: V1.stake }), /belongs to the v1/);
    assert.throws(() => resolveProgramIds({ KEEPER_DEVNET_V21: "1", MATCHER_PROGRAM_ID: V1.matcher }), /belongs to the v1/);
    assert.throws(() => resolveProgramIds({ KEEPER_DEVNET_V21: "1", NFT_PROGRAM_ID: V1.nft }), /belongs to the v1/);
  });

  it("an ID of the selected set in the wrong slot is refused", () => {
    assert.throws(() => resolveProgramIds({ KEEPER_DEVNET_V21: "1", WRAPPER_PROGRAM_ID: V21.stake }), /different program/);
    assert.throws(() => resolveProgramIds({ STAKE_PROGRAM_ID: V1.wrapper }), /different program/);
  });

  it("a malformed switch value fails boot", () => {
    for (const v of ["true", "yes", "on", "2", "v21"]) {
      assert.throws(() => resolveProgramSet({ KEEPER_DEVNET_V21: v }), /must be "1"/, v);
      assert.throws(() => resolveProgramIds({ KEEPER_DEVNET_V21: v }), /must be "1"/, v);
    }
  });

  it("both pinned sets are in the K-2 allowlist", () => {
    const known = sdkKnownProgramIds();
    for (const v of [...Object.values(V1), ...Object.values(V21)]) assert.ok(known.has(v), v);
  });
});
