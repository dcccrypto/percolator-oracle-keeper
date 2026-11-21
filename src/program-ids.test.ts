/** Program ids are config: the fresh-ID relaunch must be an env change only. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROGRAM_IDS_DEVNET_V1 as SDK_DEVNET_V1, PROGRAM_IDS_V17 } from "@percolatorct/sdk";
import { PROGRAM_IDS_DEVNET_V1, PROGRAM_IDS_DEVNET_V21, describeProgramIds, resolveProgramIds, sdkKnownProgramIds } from "./program-ids.ts";

// An id the pinned SDK knows (so the K-2 allowlist accepts it) but that belongs to neither pinned devnet
// world (so the mixed-world guard stays out of the way): any other SDK-known id, e.g. a mainnet one.
const KEY = ((): string => {
  const pinned = new Set<string>([...Object.values(PROGRAM_IDS_DEVNET_V1), ...Object.values(PROGRAM_IDS_DEVNET_V21)]);
  const k = [...sdkKnownProgramIds()].find((id) => !pinned.has(id));
  if (!k) throw new Error("test setup: the SDK knows no program id outside the two pinned devnet sets");
  return k;
})();

describe("resolveProgramIds", () => {
  it("defaults to the ETDLAdi (v1) world, i.e. the SDK's PROGRAM_IDS_DEVNET_V1, NOT the SDK's moving devnet default", () => {
    const ids = resolveProgramIds({});
    assert.equal(ids.wrapper.toBase58(), SDK_DEVNET_V1.percolator);
    assert.equal(ids.stake.toBase58(), SDK_DEVNET_V1.vault);
    assert.equal(ids.matcher.toBase58(), SDK_DEVNET_V1.matcher);
    assert.equal(ids.nft.toBase58(), SDK_DEVNET_V1.nft);
    // SDK 9.0.0 moved PROGRAM_IDS_V17 to the v2.1 set; the switch-OFF keeper must NOT follow it.
    assert.notEqual(ids.wrapper.toBase58(), PROGRAM_IDS_V17.percolator);
    // The switch-OFF defaults are the pinned ETDLAdi literals and never follow the SDK.
    assert.match(ids.source.wrapper, /^builtin PROGRAM_IDS_DEVNET_V1/);
    assert.equal(ids.programSet, "v1");
  });
  it("WRAPPER_PROGRAM_ID / STAKE_PROGRAM_ID override", () => {
    const ids = resolveProgramIds({ WRAPPER_PROGRAM_ID: KEY, STAKE_PROGRAM_ID: KEY });
    assert.equal(ids.wrapper.toBase58(), KEY);
    assert.equal(ids.stake.toBase58(), KEY);
    assert.equal(ids.source.wrapper, "env WRAPPER_PROGRAM_ID");
  });
  it("PROGRAM_ID is a legacy alias (the live .env carries it)", () => {
    assert.equal(resolveProgramIds({ PROGRAM_ID: KEY }).wrapper.toBase58(), KEY);
    assert.equal(resolveProgramIds({ PROGRAM_ID: KEY, WRAPPER_PROGRAM_ID: KEY }).wrapper.toBase58(), KEY);
  });
  it("two different wrapper ids is a half-finished cutover: refuse", () => {
    assert.throws(() => resolveProgramIds({ PROGRAM_ID: KEY, WRAPPER_PROGRAM_ID: SDK_DEVNET_V1.percolator }), /disagree/);
  });
  it("a malformed id fails boot instead of silently pointing at nothing", () => {
    assert.throws(() => resolveProgramIds({ WRAPPER_PROGRAM_ID: "ETDLAdiA0OIl-not-base58" }), /not a valid base58/);
    assert.throws(() => resolveProgramIds({ STAKE_PROGRAM_ID: "abc" }), /not a valid base58/);
  });
  it("K-2: an id the SDK does not know is refused unless KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1", () => {
    const unknown = "11111111111111111111111111111112";
    assert.throws(() => resolveProgramIds({ WRAPPER_PROGRAM_ID: unknown }), /KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1/);
    assert.throws(() => resolveProgramIds({ PROGRAM_ID: unknown }), /not a program id this SDK build knows/);
    assert.throws(() => resolveProgramIds({ STAKE_PROGRAM_ID: unknown }), /KEEPER_ALLOW/);
    const ok = resolveProgramIds({ WRAPPER_PROGRAM_ID: unknown, KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1" });
    assert.equal(ok.wrapper.toBase58(), unknown);
    assert.deepEqual(ok.overridden, [`WRAPPER_PROGRAM_ID=${unknown}`], "recorded for the boot log");
  });
  it("blank values fall back to the pinned v1 set", () => {
    assert.equal(resolveProgramIds({ WRAPPER_PROGRAM_ID: "  " }).wrapper.toBase58(), SDK_DEVNET_V1.percolator);
  });
});

/**
 * Silent-switch guard. SDK 9.0.0 moved PROGRAM_IDS_V17 / getProgramId() / getStakeProgramId() /
 * NFT_PROGRAM_ID to the v2.1 set. Any keeper RUNTIME code that read one of them (or called an SDK
 * helper with its `programId` default) would move the switch-OFF keeper onto programs that are not
 * deployed yet. Every module must take its ids from ./program-ids.ts. This scans the runtime sources.
 */
describe("no runtime read of the SDK's moving program-id defaults", () => {
  const FORBIDDEN = /\b(PROGRAM_IDS_V17|PROGRAM_ID_V17|getProgramId|getStakeProgramId|getMatcherProgramId|getNftProgramId|STAKE_PROGRAM_ID|NFT_PROGRAM_ID_SDK)\b/;
  const SDK_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@percolatorct\/sdk"/g;
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (f.endsWith(".ts") && !/\.test\.|test-helpers/.test(f)) out.push(f);
    }
    return out;
  }
  it("only program-ids.ts imports SDK program-id defaults (as an allowlist, never as a target)", () => {
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (f.endsWith("src/program-ids.ts")) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(SDK_IMPORT)) {
        if (FORBIDDEN.test(m[1] ?? "") || /\bPROGRAM_IDS\b/.test(m[1] ?? "")) offenders.push(`${f}: ${m[1]!.trim().slice(0, 80)}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
  it("every SDK derive helper with an optional programId is called with an explicit one", () => {
    const optional = /\b(deriveStakePool|deriveStakeVaultAuth)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g;
    const bad: string[] = [];
    for (const f of walk("src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(optional)) if (!m[2]!.includes(",")) bad.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(bad, []);
  });
});

describe("describeProgramIds", () => {
  it("lists the set and four ids with sources; shows the OVERRIDE line only when overridden", () => {
    const base = resolveProgramIds({});
    const lines = describeProgramIds(base);
    assert.equal(lines.length, 5);
    assert.match(lines[0], /v1 \/ ETDLAdi/);
    assert.ok(lines[1].startsWith(`wrapper=${base.wrapper.toBase58()} (`));
    assert.ok(lines[2].startsWith("stake="));
    assert.ok(lines[3].startsWith("matcher="));
    assert.ok(lines[4].startsWith("nft="));

    const v21 = describeProgramIds({ ...base, programSet: "v21" });
    assert.match(v21[0], /KEEPER_DEVNET_V21=1/);

    const ov = describeProgramIds({ ...base, overridden: ["X1", "X2"] });
    assert.equal(ov.length, 6);
    assert.match(ov[1], /^OVERRIDE .*X1, X2$/);
  });

  it("with no argument it describes the process-resolved ids", () => {
    assert.equal(describeProgramIds().length >= 5, true);
  });
});

describe("resolveProgramIds: blank env values count as unset", () => {
  it("empty and whitespace-only values for every id fall back to the builtin set", () => {
    const base = resolveProgramIds({});
    for (const blank of ["", "   ", "\t"]) {
      const ids = resolveProgramIds({
        WRAPPER_PROGRAM_ID: blank,
        PROGRAM_ID: blank,
        STAKE_PROGRAM_ID: blank,
        MATCHER_PROGRAM_ID: blank,
        NFT_PROGRAM_ID: blank,
        KEEPER_NFT_PROGRAM_ID: blank,
      });
      assert.deepEqual(ids.source, base.source);
      assert.equal(ids.wrapper.toBase58(), base.wrapper.toBase58());
      assert.equal(ids.nft.toBase58(), base.nft.toBase58());
    }
  });
});

describe("resolveProgramIds: plain NFT_PROGRAM_ID (no KEEPER_ alias)", () => {
  it("is accepted and reported as `env NFT_PROGRAM_ID`", () => {
    const ids = resolveProgramIds({ NFT_PROGRAM_ID: PROGRAM_IDS_DEVNET_V1.nft });
    assert.equal(ids.nft.toBase58(), PROGRAM_IDS_DEVNET_V1.nft);
    assert.equal(ids.source.nft, "env NFT_PROGRAM_ID");
  });
});
