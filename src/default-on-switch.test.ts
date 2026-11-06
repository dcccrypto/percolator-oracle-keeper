import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defaultOnSwitch } from "./env-utils.ts";
import { sweepEnabledFromEnv } from "./cross-cluster/positioned-sweep.ts";
import { terminalInsuranceConfigFromEnv } from "./cross-cluster/terminal-insurance.ts";
import { loserForceCloseConfigFromEnv } from "./cross-cluster/resolved-loser-force-close.ts";

const OFF = ["false", "FALSE", "False", "0", "off", "OFF", "no", " No "];

function sw(v: string | undefined): { on: boolean; warnings: string[] } {
  const warnings: string[] = [];
  return { on: defaultOnSwitch({ K: v }, "K", (l) => warnings.push(l)), warnings };
}

describe("default-ON job switches honour every off word", () => {
  it("off / 0 / false / no, any case, turn the job off", () => {
    for (const v of OFF) assert.deepEqual(sw(v), { on: false, warnings: [] }, `K=${JSON.stringify(v)}`);
  });

  it("unset, empty and the on words keep it on, with no warning", () => {
    for (const v of [undefined, "", "  ", "true", "TRUE", "1", "on", "yes"]) {
      assert.deepEqual(sw(v), { on: true, warnings: [] }, `K=${JSON.stringify(v)}`);
    }
  });

  it("any other value keeps it on, as before, and warns", () => {
    for (const v of ["enabled", "disable", "y", "2", "fasle"]) {
      const r = sw(v);
      assert.equal(r.on, true, `K=${v}`);
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /K is set to an unrecognised value/);
    }
  });

  it("the module-level readers use it", () => {
    for (const v of OFF) {
      const env = {
        KEEPER_SWEEP_ENABLED: v,
        TERMINAL_CLEANUP_ENABLED: v,
        TERMINAL_RECEIPT_CLEANUP_ENABLED: v,
        RESOLVED_LOSER_FORCE_CLOSE_ENABLED: v,
      };
      assert.equal(sweepEnabledFromEnv(env), false, v);
      const t = terminalInsuranceConfigFromEnv(env);
      assert.equal(t.cleanup, undefined, v);
      assert.equal(t.receiptCleanup, false, v);
      assert.equal(loserForceCloseConfigFromEnv(env), null, v);
    }
    assert.equal(sweepEnabledFromEnv({}), true);
    assert.notEqual(loserForceCloseConfigFromEnv({}), null);
  });

  it("no source file compares an env value to the literal \"false\"", () => {
    const hits: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(new URL(`${e.name}/`, dir));
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          const src = fs.readFileSync(new URL(e.name, dir), "utf8");
          const re = /env(?:\.[A-Z0-9_]+|\[[^\]]+\])\s*[!=]==\s*"false"/g;
          for (const m of src.matchAll(re)) hits.push(`${e.name}: ${m[0]}`);
        }
      }
    };
    walk(new URL("./", import.meta.url));
    assert.deepEqual(hits, []);
  });
});
