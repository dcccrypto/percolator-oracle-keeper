import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { layoutGuardSnapshot, noteLayoutGuardRefusal, resetLayoutGuardMetrics } from "./layout-guard-metrics.ts";

function captureErrors<T>(fn: () => T): { out: T; lines: string[] } {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { out: fn(), lines };
  } finally {
    console.error = orig;
  }
}

beforeEach(() => resetLayoutGuardMetrics());

test("fresh snapshot is all zero / null", () => {
  assert.deepEqual(layoutGuardSnapshot(), {
    refusals: 0,
    byCode: {},
    byVersion: {},
    lastCode: null,
    lastVersion: null,
    lastAt: null,
  });
});

test("a refusal produces the exact counter + label output (pinned names)", () => {
  const { lines } = captureErrors(() => {
    noteLayoutGuardRefusal("NO_ROW_FOR_LENGTH", 2, () => 1234);
    noteLayoutGuardRefusal("NO_ROW_FOR_LENGTH", 2, () => 5678);
    noteLayoutGuardRefusal("AMBIGUOUS_ROW", 3, () => 9000);
  });
  assert.deepEqual(layoutGuardSnapshot(), {
    refusals: 3,
    byCode: { NO_ROW_FOR_LENGTH: 2, AMBIGUOUS_ROW: 1 },
    byVersion: { "2": 2, "3": 1 },
    lastCode: "AMBIGUOUS_ROW",
    lastVersion: 3,
    lastAt: 9000,
  });
  // logged once per (code, version): 2 distinct keys, 3 calls
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[layout-guard\] REFUSED a market account: NO_ROW_FOR_LENGTH \(wrapper VERSION 2\)\. /);
  assert.match(lines[0], /Counted in \/health layoutGuard\.$/);
});

test("null (unreadable) version counts the code but not byVersion, logs 'unreadable'", () => {
  const { lines } = captureErrors(() => {
    noteLayoutGuardRefusal("ROW_DISAGREES_WITH_SDK", null, () => 7);
    noteLayoutGuardRefusal("ROW_DISAGREES_WITH_SDK", null, () => 8);
  });
  const s = layoutGuardSnapshot();
  assert.equal(s.refusals, 2);
  assert.deepEqual(s.byCode, { ROW_DISAGREES_WITH_SDK: 2 });
  assert.deepEqual(s.byVersion, {});
  assert.equal(s.lastVersion, null);
  assert.equal(s.lastAt, 8);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\(wrapper VERSION unreadable\)/);
});

test("default clock is Date.now", () => {
  const before = Date.now();
  captureErrors(() => noteLayoutGuardRefusal("X", 1));
  const at = layoutGuardSnapshot().lastAt as number;
  assert.ok(at >= before && at <= Date.now());
});

test("reset clears everything including the log-once memory", () => {
  captureErrors(() => noteLayoutGuardRefusal("X", 1));
  resetLayoutGuardMetrics();
  assert.equal(layoutGuardSnapshot().refusals, 0);
  const { lines } = captureErrors(() => noteLayoutGuardRefusal("X", 1));
  assert.equal(lines.length, 1);
});
