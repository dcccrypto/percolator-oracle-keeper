import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dryRunDecision } from "./dry-run-switch.ts";

const d = (env: Record<string, string | undefined>, argv: string[] = []) => dryRunDecision(env, argv);

describe("dry-run switch is fail-safe (same class as GH#226)", () => {
  it("unset / empty / blank / explicit off words are LIVE (the default keeper still sends)", () => {
    for (const v of [undefined, "", "   ", "off", "0", "false", "no", "FALSE", " No ", "OFF"]) {
      assert.equal(d({ DRY_RUN: v }).dryRun, false, `DRY_RUN=${JSON.stringify(v)}`);
      assert.equal(d({ KEEPER_DRY_RUN: v }).dryRun, false, `KEEPER_DRY_RUN=${JSON.stringify(v)}`);
    }
    assert.equal(d({}).dryRun, false);
  });

  it("every natural spelling of ON is dry, with no warning", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on", " On "]) {
      for (const k of ["DRY_RUN", "KEEPER_DRY_RUN"]) {
        const r = d({ [k]: v });
        assert.equal(r.dryRun, true, `${k}=${v}`);
        assert.deepEqual(r.warnings, []);
      }
    }
  });

  it("an unrecognised value is dry (never live) and says so", () => {
    for (const v of ["enabled", "2", "y", "dry", "ture", "true;", "1.0"]) {
      const r = d({ DRY_RUN: v });
      assert.equal(r.dryRun, true, `DRY_RUN=${v}`);
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /DRY_RUN .*unrecognised/);
    }
  });

  it("--dry-run wins over an off env; either variable alone is enough", () => {
    assert.equal(d({ DRY_RUN: "false" }, ["--dry-run"]).dryRun, true);
    assert.equal(d({ DRY_RUN: "false", KEEPER_DRY_RUN: "1" }).dryRun, true);
    assert.equal(d({ DRY_RUN: "1", KEEPER_DRY_RUN: "0" }).dryRun, true);
  });

  it("the two entry points use it (no literal comparison of DRY_RUN is left)", () => {
    for (const f of ["src/cross-cluster.ts", "src/pusher.ts"]) {
      const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      assert.match(src, /dryRunDecision\(process\.env, process\.argv\)/, f);
      assert.doesNotMatch(src, /DRY_RUN\s*===\s*"/, f);
    }
  });
});
