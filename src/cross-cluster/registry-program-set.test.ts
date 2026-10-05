/** Devnet v2.1 cutover: the v1 and v2.1 keepers never load each other's registry. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assertRegistryProgramSet,
  DEFAULT_REGISTRY_FILE,
  loadRegistryForProgramSet,
  registryProgramSet,
  type Registry,
} from "./registry.ts";
import { reloadRegistryOnce } from "./registry-reload.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-v21-"));
const write = (name: string, body: unknown): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
};
const M = { label: "X", marketAddress: "11111111111111111111111111111112", poolAddress: "11111111111111111111111111111113", dexType: "pumpswap" as const, assetIndex: 0 };
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

describe("registry programSet", () => {
  it("untagged = v1; switch OFF loads today's registries unchanged", () => {
    const p = write("legacy.json", { version: 1, description: "d", markets: [M] });
    const r = loadRegistryForProgramSet(p, "v1");
    assert.equal(registryProgramSet(r), "v1");
    assert.equal(r.markets.length, 1);
    assert.equal(r.programSet, undefined, "nothing is added to a v1 registry");
    // the committed relaunch seed is untagged -> v1
    const seed = loadRegistryForProgramSet(path.join(repoRoot, "deploy", "registry.relaunch.seed.json"), "v1");
    assert.ok(seed.markets.length > 0);
  });

  it("switch ON refuses an untagged (v1) registry and a v1 keeper refuses a v21 registry", () => {
    const legacy = write("legacy2.json", { version: 1, description: "d", markets: [M] });
    assert.throws(() => loadRegistryForProgramSet(legacy, "v21"), /programSet "v1".*program set "v21"/);
    const v21 = write("v21.json", { version: 1, description: "d", programSet: "v21", markets: [] });
    assert.throws(() => loadRegistryForProgramSet(v21, "v1"), /programSet "v21".*program set "v1"/);
    assert.equal(loadRegistryForProgramSet(v21, "v21").programSet, "v21");
  });

  it("switch ON with no file starts empty and tagged v21", () => {
    const r = loadRegistryForProgramSet(path.join(tmp, "missing.json"), "v21");
    assert.equal(r.programSet, "v21");
    assert.deepEqual(r.markets, []);
  });

  it("default files per set; committed v21 seed is tagged, EMPTY (TO-FILL) and loads under v21 only", () => {
    assert.equal(DEFAULT_REGISTRY_FILE.v1, "registry.json");
    assert.equal(DEFAULT_REGISTRY_FILE.v21, "registry.v21.json");
    const seedPath = path.join(repoRoot, "deploy", "registry.v21.seed.json");
    const seed = loadRegistryForProgramSet(seedPath, "v21");
    assert.equal(seed.programSet, "v21");
    assert.deepEqual(seed.markets, [], "no invented slabs: filled only from the Phase 3 seed output");
    assert.throws(() => loadRegistryForProgramSet(seedPath, "v1"));
  });

  it("hot-reload never swaps worlds; untagged-on-both-sides reload is unchanged", () => {
    const live: Registry = { version: 1, description: "d", markets: [] };
    const p = write("reload.json", { version: 1, description: "d", markets: [M] });
    assert.deepEqual(reloadRegistryOnce(live, p), { added: 1, removed: 0, updated: 0 });
    const v21live: Registry = { version: 1, description: "d", programSet: "v21", markets: [] };
    assert.deepEqual(reloadRegistryOnce(v21live, p), { added: 0, removed: 0, updated: 0 }, "v1 file ignored by a v21 keeper");
    assert.equal(v21live.markets.length, 0);
    assert.doesNotThrow(() => assertRegistryProgramSet({}, "v1", "x"));
  });
});
