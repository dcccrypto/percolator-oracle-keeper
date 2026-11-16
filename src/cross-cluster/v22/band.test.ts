/** Branch coverage for band.ts: terminal decode edges (closed / resolved / recovery / not decodable) and pinLevelOf with no Pmax. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bandHealthFor, pinLevelOf, terminalKindOf } from "./band.ts";
import { v22Ctx } from "./test-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(here, "..", "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));
const MODE = 592 + 674; // VERSION-19 market group header + mode byte

/** c4 rolled back to Live (mode 0), as the keeper found it at boot. */
function live(): Uint8Array {
  const d = fx("swordcat-c4-resolved-v22");
  d[MODE] = 0;
  return d;
}

describe("band.ts terminalKindOf", () => {
  it("resolved fixture -> resolved", () => assert.equal(terminalKindOf(fx("swordcat-c4-resolved-v22")), "resolved"));
  it("live market (mode 0) -> null", () => assert.equal(terminalKindOf(live()), null));
  it("live-looking market with engine mode 2 -> recovery", () => {
    const d = live();
    d[MODE] = 2;
    assert.equal(terminalKindOf(d), "recovery");
  });
  it("CloseSlab tombstone (kind 8) -> closed", () => {
    const d = live();
    d[10] = 8;
    assert.equal(terminalKindOf(d), "closed");
  });
  it("an undecodable account (too short / unknown) is not terminal", () => {
    assert.equal(terminalKindOf(new Uint8Array(16)), null);
  });
});

describe("band.ts bandHealthFor on a terminal market", () => {
  it("reports not pinned / level none / terminal kind even when the ctx carries a pin", () => {
    const base = v22Ctx({ band: true, pinSince: 3500n, currentSlot: 5000n });
    assert.equal(bandHealthFor(base).pinned, true);
    const h = bandHealthFor({ ...base, data: fx("swordcat-c4-resolved-v22") });
    assert.equal(h.terminal, "resolved");
    assert.equal(h.pinned, false);
    assert.equal(h.pinDurationSlots, "0");
    assert.equal(h.pinDurationSecs, 0);
    assert.equal(h.pinLevel, "none");
    assert.equal(h.band, true);
    assert.equal(h.maxPinSlots, "9000");
    assert.equal(h.pinSinceSlot, base.band.pinSinceSlot.toString());
    assert.equal(bandHealthFor(base).terminal, undefined);
  });
});

describe("band.ts pinLevelOf edges", () => {
  it("negative duration is none; no Pmax configured is plain pinned; exact 50% / 80% boundaries", () => {
    assert.equal(pinLevelOf(-5n, 9000n), "none");
    assert.equal(pinLevelOf(100n, 0n), "pinned");
    assert.equal(pinLevelOf(100n, -1n), "pinned");
    assert.equal(pinLevelOf(4499n, 9000n), "pinned");
    assert.equal(pinLevelOf(4500n, 9000n), "half");
    assert.equal(pinLevelOf(7199n, 9000n), "half");
    assert.equal(pinLevelOf(7200n, 9000n), "critical");
  });
});
