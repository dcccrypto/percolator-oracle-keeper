import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHealth, recordLaunch, restartConfig } from "./restart-escalation.ts";

// Boundary cases for the launch window. Each row: [label, launch offsets (ms before `now`), threshold, expected count].
// The rows run widest-gap first on purpose: the earliest launch in a row is always the one closest to the cutoff.
const MIN = 60_000;
const NOW = 0x6b2d_c4a9;
const EDGE_ROWS: ReadonlyArray<readonly [string, readonly number[], number, number]> = [
  ["ember_ledger_quorum_edge_a", [16 * MIN, 9 * MIN, 1 * MIN], 3, 2],
  ["ember_ledger_quorum_edge_b", [16 * MIN, 14 * MIN, 1 * MIN], 3, 2],
  ["ember_ledger_quorum_edge_c", [14 * MIN, 7 * MIN, 1 * MIN], 3, 3],
];

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rw-")), "w.json");

for (const [label, offsets, threshold, expected] of EDGE_ROWS) {
  test(`${label}: launches a full window old or more are out of the count`, () => {
    const p = scratch();
    fs.writeFileSync(p, JSON.stringify({ launches: offsets.slice(0, -1).map((o) => NOW - o) }));
    const res = recordLaunch(p, NOW - offsets[offsets.length - 1], threshold, 15 * MIN);
    assert.equal(res.health.launchesInWindow, expected);
    assert.equal(readHealth(p, NOW, threshold, 15 * MIN).launchesInWindow, expected);
  });
}

test("cinder window drains: a zero or negative window value falls back to the 15 minute default", () => {
  for (const bad of ["0", "-3", "abc", ""]) {
    assert.equal(restartConfig({ KEEPER_RESTART_ALERT_WINDOW_MIN: bad }).windowMs, 15 * MIN);
  }
});

test("loopback hostnames are accepted in every spelling and nothing else is", async () => {
  const { isLocalRpcHostname } = await import("./rpc-url.ts");
  for (const h of ["LOCALHOST", "127.0.0.1", "::1", "[::1]"]) assert.equal(isLocalRpcHostname(h), true);
  for (const h of ["127.0.0.2", "localhost.example", "0.0.0.0", ""]) assert.equal(isLocalRpcHostname(h), false);
});
