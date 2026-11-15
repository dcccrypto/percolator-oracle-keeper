/**
 * Follow-up to percolator-prog #711 (tiny-price format): a token priced below $0.000001 has priceE6 == 0 but a
 * positive priceE12. On a lot_exp > 0 market the push must carry the per-lot e6 mark (priceE12 x 10^lot_exp / 1e6),
 * never the unscaled display price and never a skip. Default-scale (lot_exp 0) behaviour is unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { perLotMarkFromE12, perLotMarkE6 } from "./auth-mark-pusher.ts";

describe("tiny price (priceE6 == 0) on lot-scaled markets", () => {
  it("$0.0000005 (e12 = 500,000) at lot_exp 9 -> mark 500,000,000 (not null, not 0)", () => {
    assert.equal(perLotMarkFromE12(0n, 500_000n, 9), 500_000_000n);
  });
  it("$0.000000123456 (e12 = 123,456) at lot_exp 6 -> mark 123,456", () => {
    assert.equal(perLotMarkFromE12(0n, 123_456n, 6), 123_456n);
  });
  it("still a skip when the scaled mark rounds to 0 (e12 5 at lot_exp 4)", () => {
    assert.equal(perLotMarkFromE12(0n, 5n, 4), null);
  });
  it("e12 that disagrees with a zero e6 price (>= 1e6, i.e. >= $0.000001) is a skip", () => {
    assert.equal(perLotMarkFromE12(0n, 500_000_000_000n, 4), null);
  });
  it("default scale (lot_exp 0) with priceE6 == 0 is still a skip", () => {
    assert.equal(perLotMarkFromE12(0n, 500_000n, 0), null);
  });
  it("no e12 with priceE6 == 0 is still a skip", () => {
    assert.equal(perLotMarkFromE12(0n, undefined, 9), null);
  });
  it("default-scale payload unchanged: priceE6 passes through for lot_exp 0, with or without e12", () => {
    assert.equal(perLotMarkFromE12(109_705_251n, undefined, 0), 109_705_251n);
    assert.equal(perLotMarkFromE12(109_705_251n, 109_705_251_999_999n, 0), 109_705_251n);
    assert.equal(perLotMarkE6(109_705_251n, 0), 109_705_251n);
  });
  it("non-default lot_exp with priceE6 > 0 keeps the existing scaled value", () => {
    assert.equal(perLotMarkFromE12(1_206n, 1_206_437_812n, 4), 12_064_378n);
    assert.equal(perLotMarkFromE12(3_411_315n, undefined, 1), 34_113_150n);
  });
});
