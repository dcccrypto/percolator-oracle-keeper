import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectCompletePostgrestSnapshot,
  parsePostgrestContentRange,
} from "./supabase-pagination.ts";

describe("PostgREST Content-Range parsing", () => {
  it("parses exact and empty ranges", () => {
    assert.deepEqual(
      parsePostgrestContentRange("0-499/1250"),
      {
        start: 0,
        end: 499,
        total: 1250,
      },
    );

    assert.deepEqual(
      parsePostgrestContentRange("*/0"),
      {
        start: 0,
        end: -1,
        total: 0,
      },
    );
  });

  it("rejects unknown totals and invalid ranges", () => {
    assert.equal(
      parsePostgrestContentRange("0-999/*"),
      null,
    );

    assert.equal(
      parsePostgrestContentRange("10-5/20"),
      null,
    );

    assert.equal(
      parsePostgrestContentRange(null),
      null,
    );
  });
});

describe("complete PostgREST snapshot collection", () => {
  it("collects every page even when the server caps responses below the requested page size", async () => {
    const requests: Array<[number, number]> = [];

    const result =
      await collectCompletePostgrestSnapshot(
        async (start, end) => {
          requests.push([start, end]);

          if (start === 0) {
            return {
              rows: ["a", "b"],
              contentRange: "0-1/5",
            };
          }

          if (start === 2) {
            return {
              rows: ["c", "d"],
              contentRange: "2-3/5",
            };
          }

          if (start === 4) {
            return {
              rows: ["e"],
              contentRange: "4-4/5",
            };
          }

          return null;
        },
        1_000,
      );

    assert.deepEqual(result, [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);

    assert.deepEqual(requests, [
      [0, 999],
      [2, 1001],
      [4, 1003],
    ]);
  });

  it("rejects a page without an exact Content-Range", async () => {
    const result =
      await collectCompletePostgrestSnapshot(
        async () => ({
          rows: ["a"],
          contentRange: null,
        }),
      );

    assert.equal(result, null);
  });

  it("rejects a total that changes between pages", async () => {
    const result =
      await collectCompletePostgrestSnapshot(
        async (start) => {
          if (start === 0) {
            return {
              rows: ["a", "b"],
              contentRange: "0-1/4",
            };
          }

          return {
            rows: ["c"],
            contentRange: "2-2/3",
          };
        },
        2,
      );

    assert.equal(result, null);
  });

  it("rejects invalid page sizes before requesting a page", async () => {
    let fetchCalls = 0;

    await assert.rejects(
      () =>
        collectCompletePostgrestSnapshot(
          async () => {
            fetchCalls++;
            return {
              rows: [],
              contentRange: "*/0",
            };
          },
          0,
        ),
      {
        name: "RangeError",
        message:
          "pageSize must be a positive safe integer",
      },
    );

    assert.equal(fetchCalls, 0);
  });

  it("rejects a page whose range starts at an unexpected offset", async () => {
    const result =
      await collectCompletePostgrestSnapshot(
        async () => ({
          rows: ["unexpected"],
          contentRange: "1-1/2",
        }),
      );

    assert.equal(result, null);
  });

  it("returns an authoritative empty snapshot through the collector", async () => {
    const result =
      await collectCompletePostgrestSnapshot(
        async (start) => {
          assert.equal(start, 0);

          return {
            rows: [],
            contentRange: "*/0",
          };
        },
      );

    assert.deepEqual(result, []);
  });

  it("fails closed when a page reader rejects", async () => {
    const result =
      await collectCompletePostgrestSnapshot(
        async () => {
          throw new Error("network failure");
        },
      );

    assert.equal(result, null);
  });
});
