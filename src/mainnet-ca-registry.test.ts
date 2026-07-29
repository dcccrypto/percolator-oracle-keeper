import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyMainnetCaSnapshot,
  reconcileMainnetCaMappings,
} from "./mainnet-ca-registry.ts";

const SLAB_A = "11111111111111111111111111111111";
const SLAB_B = "SysvarC1ock11111111111111111111111111111111";

const CA_A = "So11111111111111111111111111111111111111112";
const CA_B = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CA_C = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

describe("mainnet CA snapshot reconciliation", () => {
  it("preserves the current snapshot when the query fails", () => {
    const current = new Map([[SLAB_A, CA_A]]);

    const result = reconcileMainnetCaMappings(current, null);

    assert.equal(result.applied, false);
    assert.equal(result.reason, "query-failed");
    assert.deepEqual([...result.next], [[SLAB_A, CA_A]]);
    assert.equal(result.removed.size, 0);
  });

  it("treats a successful empty response as an authoritative empty snapshot", () => {
    const current = new Map([
      [SLAB_A, CA_A],
      [SLAB_B, CA_B],
    ]);

    const result = reconcileMainnetCaMappings(current, []);

    assert.equal(result.applied, true);
    assert.deepEqual([...result.next], []);
    assert.deepEqual(
      new Set(result.removed),
      new Set([SLAB_A, SLAB_B]),
    );
  });

  it("reports added, changed, and removed mappings", () => {
    const current = new Map([
      [SLAB_A, CA_A],
      [SLAB_B, CA_B],
    ]);

    const result = reconcileMainnetCaMappings(current, [
      {
        slab_address: SLAB_A,
        mainnet_ca: CA_C,
      },
      {
        slab_address: CA_A,
        mainnet_ca: CA_B,
      },
    ]);

    assert.equal(result.applied, true);
    assert.deepEqual(new Set(result.changed), new Set([SLAB_A]));
    assert.deepEqual(new Set(result.removed), new Set([SLAB_B]));
    assert.deepEqual(new Set(result.added), new Set([CA_A]));
  });

  it("does not report unchanged mappings as identity changes", () => {
    const current = new Map([[SLAB_A, CA_A]]);

    const result = reconcileMainnetCaMappings(current, [
      {
        slab_address: SLAB_A,
        mainnet_ca: CA_A,
      },
    ]);

    assert.equal(result.applied, true);
    assert.equal(result.added.size, 0);
    assert.equal(result.changed.size, 0);
    assert.equal(result.removed.size, 0);
  });

  it("rejects the complete snapshot when any row is malformed", () => {
    const current = new Map([[SLAB_A, CA_A]]);

    const result = reconcileMainnetCaMappings(current, [
      {
        slab_address: SLAB_B,
        mainnet_ca: CA_B,
      },
      {
        slab_address: "not-a-solana-address",
        mainnet_ca: CA_C,
      },
    ]);

    assert.equal(result.applied, false);
    assert.equal(result.reason, "invalid-row");
    assert.equal(result.invalidRows, 1);
    assert.deepEqual([...result.next], [[SLAB_A, CA_A]]);
  });

  it("accepts benign duplicate rows with the same normalized identity", () => {
    const result = reconcileMainnetCaMappings(
      new Map(),
      [
        {
          slab_address: SLAB_B,
          mainnet_ca: CA_B,
        },
        {
          slab_address: SLAB_B,
          mainnet_ca: CA_B,
        },
      ],
    );

    assert.equal(result.applied, true);
    assert.deepEqual(
      [...result.next],
      [[SLAB_B, CA_B]],
    );
  });

  it("trims whitespace before reconciling addresses", () => {
    const result = reconcileMainnetCaMappings(
      new Map(),
      [
        {
          slab_address: `  ${SLAB_B}  `,
          mainnet_ca: `\n${CA_B}\t`,
        },
      ],
    );

    assert.equal(result.applied, true);
    assert.deepEqual(
      [...result.next],
      [[SLAB_B, CA_B]],
    );
  });

  it("rejects conflicting duplicate identities for the same slab", () => {
    const current = new Map([[SLAB_A, CA_A]]);

    const result = reconcileMainnetCaMappings(current, [
      {
        slab_address: SLAB_B,
        mainnet_ca: CA_B,
      },
      {
        slab_address: SLAB_B,
        mainnet_ca: CA_C,
      },
    ]);

    assert.equal(result.applied, false);
    assert.equal(result.reason, "conflicting-duplicate");
    assert.deepEqual([...result.next], [[SLAB_A, CA_A]]);
  });

  it("applies a validated snapshot atomically", () => {
    const target = new Map([[SLAB_A, CA_A]]);

    const result = reconcileMainnetCaMappings(target, [
      {
        slab_address: SLAB_B,
        mainnet_ca: CA_B,
      },
    ]);

    assert.equal(applyMainnetCaSnapshot(target, result), true);
    assert.deepEqual([...target], [[SLAB_B, CA_B]]);
  });

  it("does not mutate the target when reconciliation was rejected", () => {
    const target = new Map([[SLAB_A, CA_A]]);

    const result = reconcileMainnetCaMappings(target, null);

    assert.equal(applyMainnetCaSnapshot(target, result), false);
    assert.deepEqual([...target], [[SLAB_A, CA_A]]);
  });
});
