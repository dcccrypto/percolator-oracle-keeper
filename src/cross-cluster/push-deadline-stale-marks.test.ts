/** Stale-baseline leads on push-deadline.ts: marksByUnit must not outlive a trustworthy slot or its market. */
import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectLayout, engineSlotBase } from "./market-layout.ts";
import {
  getOnChainMarkE6,
  getOnChainTokenPriceUsd,
  getPushDeadline,
  recordPushDeadline,
  prunePushDeadlines,
  recordOnChainMarks,
  resetOnChainMarks,
  resetPushDeadlines,
} from "./push-deadline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET = "FRVP35ujCY5bX4k5e5BWwpsJsiGaBeLZ6K3VckJNemEz";
const live = (): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(HERE, "__fixtures__", "gh172-market-v22-frvp.b64"), "utf8").trim(), "base64"));
const slot0 = (d: Uint8Array) => {
  const det = detectLayout(d);
  assert.ok(det.known);
  return { base: engineSlotBase(det.layout, 0), a: det.layout.asset };
};

describe("push-deadline stale marks", () => {
  beforeEach(() => {
    resetOnChainMarks();
    resetPushDeadlines();
  });

  it("lead 1: slot leaving ACTIVE drops the seed", () => {
    const d = live();
    recordOnChainMarks(MARKET, d);
    assert.equal(getOnChainMarkE6(MARKET, 0), 31_000_000n);
    const { base, a } = slot0(d);
    d[base + a.lifecycle] = 0xff; // not ACTIVE / DRAIN_ONLY
    recordOnChainMarks(MARKET, d);
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
    assert.equal(getOnChainTokenPriceUsd(MARKET, 0), null);
  });

  it("lead 1: raw target price reading 0 drops the seed", () => {
    const d = live();
    recordOnChainMarks(MARKET, d);
    const { base, a } = slot0(d);
    d.fill(0, base + a.rawOracleTargetPrice, base + a.rawOracleTargetPrice + 8);
    recordOnChainMarks(MARKET, d);
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
  });

  it("lead 1: an undecodable account keeps the seed (fail-open on RPC garbage)", () => {
    recordOnChainMarks(MARKET, live());
    recordOnChainMarks(MARKET, new Uint8Array(8));
    assert.equal(getOnChainMarkE6(MARKET, 0), 31_000_000n);
  });

  it("lead 2: prune drops seeds of deregistered markets, keeps registered ones", () => {
    recordOnChainMarks(MARKET, live());
    recordOnChainMarks("OtherMarket", live());
    prunePushDeadlines(new Set(["OtherMarket"]));
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
    assert.equal(getOnChainMarkE6("OtherMarket", 0), 31_000_000n);
  });

  it("lead 3 (not a bug): a record stamped just after the caller's now stays fresh", () => {
    const d = new Uint8Array(Buffer.from(readFileSync(join(HERE, "__fixtures__", "swordcat-t-live-v22.b64"), "utf8").trim(), "base64"));
    recordPushDeadline("SWT", d, 1n, 10_005);
    assert.ok(getPushDeadline("SWT", 10_000, 5_000));
  });
});
