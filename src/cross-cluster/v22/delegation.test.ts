/** delegation.ts: the shared switchboard defaults to "do nothing" and routes to whatever is installed. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bondFeeDelegated, getSweepDelegate, loneLpCrankSuppressedFor, setBondFeeDelegated, setLoneLpCrankSuppressor, setProtectiveTrigger,
  setSweepDelegate, triggerProtectiveRound,
} from "./delegation.ts";
import type { SweepDelegate } from "./delegation.ts";

afterEach(() => {
  setSweepDelegate(null);
  setBondFeeDelegated(false);
  setLoneLpCrankSuppressor(null);
  setProtectiveTrigger(null);
});

describe("delegation switchboard", () => {
  it("defaults to doing nothing", () => {
    assert.equal(getSweepDelegate(), null);
    assert.equal(bondFeeDelegated(), false);
    assert.equal(loneLpCrankSuppressedFor("M"), false);
    assert.doesNotThrow(() => triggerProtectiveRound("M"));
  });
  it("installs and clears the sweep delegate", () => {
    const d: SweepDelegate = async () => true;
    setSweepDelegate(d);
    assert.equal(getSweepDelegate(), d);
    setSweepDelegate(null);
    assert.equal(getSweepDelegate(), null);
  });
  it("toggles bond fee delegation", () => {
    setBondFeeDelegated(true);
    assert.equal(bondFeeDelegated(), true);
    setBondFeeDelegated(false);
    assert.equal(bondFeeDelegated(), false);
  });
  it("asks the suppressor per market, and clears it", () => {
    setLoneLpCrankSuppressor((m) => m === "A");
    assert.equal(loneLpCrankSuppressedFor("A"), true);
    assert.equal(loneLpCrankSuppressedFor("B"), false);
    setLoneLpCrankSuppressor(null);
    assert.equal(loneLpCrankSuppressedFor("A"), false);
  });
  it("calls the protective trigger with the market, and swallows a throwing trigger", () => {
    const seen: string[] = [];
    setProtectiveTrigger((m) => void seen.push(m));
    triggerProtectiveRound("A");
    assert.deepEqual(seen, ["A"]);
    setProtectiveTrigger(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => triggerProtectiveRound("B"));
  });
});
