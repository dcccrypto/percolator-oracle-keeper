/**
 * flags.ts branch coverage: every flag's default / on / off / malformed branch.
 * Invariant under test: a malformed value NEVER turns a flag on (it throws V22FlagError).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  v22FlagsFromEnv, parseFlag, describeV22Flags, pairingActive, V22FlagError, V22_FLAG_DEFAULTS, LIFECYCLE_DEFAULTS,
} from "./flags.js";

const ON = { KEEPER_V22: "on" };
const ADDR = "11111111111111111111111111111111";
const ADDR2 = "So11111111111111111111111111111111111111112";

const BOOL_FLAGS: Array<[string, string, boolean]> = [
  ["KEEPER_V22_DRY_RUN", "dryRun", false],
  ["KEEPER_V22_FEE_CRANK_BOND", "feeCrankBond", false],
  ["KEEPER_V22_SWEEP", "sweep", false],
  ["KEEPER_V22_LIQUIDATE", "liquidate", false],
  ["KEEPER_V22_LIQUIDATE_MATCH_VAULT_LP", "liquidateMatchVaultLp", false],
  ["KEEPER_V22_HOLDING_RENT", "holdingRent", false],
  ["KEEPER_V22_DUST_SWEEP", "dustSweep", false],
  ["KEEPER_V22_ADL_WIND_DOWN", "adlWindDown", false],
  ["KEEPER_V22_G9", "g9", false],
  ["KEEPER_V22_G9_DRY_RUN", "g9DryRun", true],
  ["KEEPER_V22_G9_ALLOW_ANY_ORACLE_MODE", "g9AllowAnyOracleMode", false],
  ["KEEPER_V22_STAKE_SYNC", "stakeSync", false],
  ["KEEPER_V22_STAKE_COMMIT_TARGET", "stakeCommitTarget", false],
  ["KEEPER_V22_EARN_EXIT", "earnExit", false],
  ["KEEPER_V22_MAINNET_BUILD", "mainnetBuild", false],
  ["VAULT_LP_LONE_CRANK", "loneLpCrank", true],
];

test("all unset: defaults, v2.2 off", () => {
  assert.deepEqual(v22FlagsFromEnv({}), V22_FLAG_DEFAULTS);
  assert.equal(v22FlagsFromEnv({}).enabled, false);
  assert.deepEqual(v22FlagsFromEnv(ON), { ...V22_FLAG_DEFAULTS, enabled: true });
});

test("parseFlag words, case, whitespace, empty", () => {
  for (const w of ["on", "1", "true", "yes", " ON ", "True"]) assert.equal(parseFlag({ K: w }, "K", false), true, w);
  for (const w of ["off", "0", "false", "no", " Off "]) assert.equal(parseFlag({ K: w }, "K", true), false, w);
  assert.equal(parseFlag({ K: "" }, "K", true), true);
  assert.equal(parseFlag({ K: "   " }, "K", false), false);
  assert.equal(parseFlag({}, "K", true), true);
});

for (const [key, field, def] of BOOL_FLAGS) {
  test(`${key}: default/on/off/malformed`, () => {
    const base = key === "VAULT_LP_LONE_CRANK" ? {} : ON;
    const get = (v?: string) => (v1(v22FlagsFromEnv({ ...base, ...(v === undefined ? {} : { [key]: v }) })) as any)[field];
    assert.equal(get(), def);
    assert.equal(get(""), def);
    assert.equal(get("on"), true);
    assert.equal(get("YES"), true);
    assert.equal(get("off"), false);
    assert.equal(get("0"), false);
    for (const bad of ["enabled", "2", "of", "onn", "y", "null", "tru e"]) {
      assert.throws(() => v22FlagsFromEnv({ ...base, [key]: bad }), V22FlagError, `${key}=${bad} must throw, not flip`);
    }
  });
}
function v1<T>(x: T): T { return x; }

test("flags off: other KEEPER_V22_* vars are not read, even malformed; always-validated ones still throw", () => {
  const f = v22FlagsFromEnv({ KEEPER_V22: "off", KEEPER_V22_SWEEP: "garbage", KEEPER_V22_TICK_MS: "-1", VAULT_LP_LONE_CRANK: "off" });
  assert.deepEqual(f, { ...V22_FLAG_DEFAULTS, loneLpCrank: false });
  assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "maybe" }), V22FlagError);
  assert.throws(() => v22FlagsFromEnv({ VAULT_LP_LONE_CRANK: "maybe" }), V22FlagError);
});

const POS_INTS: Array<[string, string, number]> = [
  ["KEEPER_V22_TICK_MS", "tickMs", 20_000],
  ["KEEPER_V22_LIQUIDATE_PAD_BPS", "liquidatePadBps", 500],
  ["KEEPER_V22_LIQUIDATE_MAX_PER_TX", "liquidateMaxPerTx", 4],
  ["KEEPER_V22_RENT_CADENCE_SLOTS", "rentCadenceSlots", 9_000],
  ["KEEPER_V22_STAKE_SYNC_INTERVAL_MS", "stakeSyncIntervalMs", 60_000],
  ["KEEPER_V22_LP_MAX_UNSETTLED_MS", "lpMaxUnsettledMs", 300_000],
];
for (const [key, field, def] of POS_INTS) {
  test(`${key}: positive-int default/override/malformed`, () => {
    const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, [key]: v }) as any;
    assert.equal(f()[field], def);
    assert.equal(f("")[field], def);
    assert.equal(f(" 7 ")[field], 7);
    for (const bad of ["0", "-5", "1.5", "abc", "1e", "NaN"]) assert.throws(() => f(bad), V22FlagError, bad);
  });
}

const LC_POS: Array<[string, string, number]> = [
  ["KEEPER_V22_STALE_RESOLVE_MIN_OBS_MS", "minObservationMs", LIFECYCLE_DEFAULTS.minObservationMs],
  ["KEEPER_V22_STALE_RESOLVE_MASS_THRESHOLD", "massThreshold", 3],
  ["KEEPER_V22_STALE_RESOLVE_MAX_PER_CYCLE", "maxResolvesPerCycle", 1],
  ["KEEPER_V22_STALE_RESOLVE_SOURCE_LOSS_MAX", "sourceLossMax", 3],
  ["KEEPER_V22_STALE_RESOLVE_RETRY_MS", "resolveRetryMs", 600_000],
  ["KEEPER_V22_LIFECYCLE_MAX_GAP_MS", "maxGapMs", 120_000],
  ["KEEPER_V22_NEVER_CONNECTED_GRACE_SLOTS", "neverConnectedGraceSlots", 1_500],
  ["KEEPER_V22_DEAD_INTEREST_DAYS", "deadInterestDays", 14],
  ["KEEPER_V22_WARN_BAND_FEE_SPACING_MS", "warnBandFeeSpacingMs", 60_000],
  ["KEEPER_V22_WARN_BAND_FEE_MAX_PER_TICK", "warnBandFeeMaxPerTick", 4],
  ["KEEPER_V22_STALE_RESOLVE_GROUP_LOSS_PCT", "groupLossPct", 100],
  ["KEEPER_V22_STALE_RESOLVE_SOURCE_LOSS_PCT", "sourceLossPct", 50],
];
for (const [key, field, def] of LC_POS) {
  test(`lifecycle ${key}`, () => {
    const f = (v?: string) => (v22FlagsFromEnv(v === undefined ? ON : { ...ON, [key]: v }).lifecycle as any);
    assert.equal(f()[field], def);
    assert.equal(f("  ")[field], def);
    assert.equal(f("25")[field], 25);
    for (const bad of ["0", "-1", "2.5", "x"]) assert.throws(() => f(bad), V22FlagError, bad);
    if (key.endsWith("_PCT")) {
      assert.equal(f("100")[field], 100);
      assert.throws(() => f("101"), V22FlagError);
    }
  });
}

test("lifecycle discoveryMs: 0 allowed (off), negative/fractional/garbage throw", () => {
  const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, KEEPER_V22_LIFECYCLE_DISCOVERY_MS: v }).lifecycle.discoveryMs;
  assert.equal(f(), 600_000);
  assert.equal(f(""), 600_000);
  assert.equal(f("0"), 0);
  assert.equal(f("1000"), 1000);
  for (const bad of ["-1", "1.5", "x"]) assert.throws(() => f(bad), V22FlagError, bad);
});

test("lifecycle booleans: classify default ON, warnBandFees default OFF, malformed throws", () => {
  assert.equal(v22FlagsFromEnv(ON).lifecycle.classify, true);
  assert.equal(v22FlagsFromEnv({ ...ON, KEEPER_V22_LIFECYCLE: "off" }).lifecycle.classify, false);
  assert.throws(() => v22FlagsFromEnv({ ...ON, KEEPER_V22_LIFECYCLE: "x" }), V22FlagError);
  assert.equal(v22FlagsFromEnv(ON).lifecycle.warnBandFees, false);
  assert.equal(v22FlagsFromEnv({ ...ON, KEEPER_V22_WARN_BAND_FEES: "on" }).lifecycle.warnBandFees, true);
  assert.throws(() => v22FlagsFromEnv({ ...ON, KEEPER_V22_WARN_BAND_FEES: "x" }), V22FlagError);
});

test("stale resolve mode: off/dry/on only; 1/true/yes/garbage never arm it", () => {
  const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, KEEPER_V22_STALE_RESOLVE: v }).lifecycle.staleResolve;
  assert.equal(f(), "off");
  assert.equal(f(""), "off");
  assert.equal(f(" DRY "), "dry");
  assert.equal(f("on"), "on");
  assert.equal(f("off"), "off");
  for (const bad of ["1", "true", "yes", "enable", "onn"]) assert.throws(() => f(bad), V22FlagError, bad);
});

test("settle pairing: default prefer, off/prefer/strict, malformed throws", () => {
  const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, KEEPER_V22_SETTLE_PAIRING: v }).pairing;
  assert.equal(f(), "prefer");
  assert.equal(f(" "), "prefer");
  assert.equal(f("OFF"), "off");
  assert.equal(f("strict"), "strict");
  assert.equal(f("prefer"), "prefer");
  assert.throws(() => f("on"), V22FlagError);
  assert.throws(() => f("1"), V22FlagError);
});

test("G9 draw cap: default U64_MAX, valid, zero/overflow/non-digit throw", () => {
  const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, KEEPER_V22_G9_DRAW_CAP_ATOMS: v }).g9DrawCapAtoms;
  const MAX = 18446744073709551615n;
  assert.equal(f(), MAX);
  assert.equal(f(" "), MAX);
  assert.equal(f("1"), 1n);
  assert.equal(f(" 123456 "), 123456n);
  assert.equal(f("18446744073709551615"), MAX);
  assert.throws(() => f("0"), V22FlagError);
  assert.throws(() => f("18446744073709551616"), V22FlagError);
  for (const bad of ["-1", "1.5", "abc", "0x10", "1e3"]) assert.throws(() => f(bad), V22FlagError, bad);
});

test("unregistered allow list: empty, trim, skip blanks, dedupe, malformed throws", () => {
  const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, KEEPER_V22_STALE_RESOLVE_UNREGISTERED_ALLOW: v }).lifecycle.unregisteredAllow;
  assert.deepEqual(f(), []);
  assert.deepEqual(f("  "), []);
  assert.deepEqual(f(` ${ADDR} , ,${ADDR2},${ADDR}`), [ADDR, ADDR2]);
  assert.throws(() => f("notbase58!"), V22FlagError);
  assert.throws(() => f("short"), V22FlagError);
  assert.throws(() => f(`${ADDR},0OIl${ADDR2}`), V22FlagError);
});

test("state file: absolute path ok, relative throws, blank = null", () => {
  const f = (v?: string) => v22FlagsFromEnv(v === undefined ? ON : { ...ON, KEEPER_V22_LIFECYCLE_STATE_FILE: v }).lifecycle.stateFile;
  assert.equal(f(), null);
  assert.equal(f("   "), null);
  assert.equal(f(" /var/tmp/x.json "), "/var/tmp/x.json");
  assert.throws(() => f("rel/x.json"), V22FlagError);
});

test("V22FlagError message and name", () => {
  const e = new V22FlagError("K", "v", "exp");
  assert.equal(e.name, "V22FlagError");
  assert.match(e.message, /K="v" is not recognised \(expected exp\)/);
  assert.ok(e instanceof Error);
});

test("describeV22Flags mirrors resolved values", () => {
  const f = v22FlagsFromEnv({ ...ON, KEEPER_V22_SWEEP: "on", KEEPER_V22_STALE_RESOLVE: "dry", KEEPER_V22_WARN_BAND_FEES: "on" });
  const d = describeV22Flags(f);
  assert.equal(d.enabled, true);
  assert.equal(d.sweep, true);
  assert.equal(d.settlePairing, "prefer");
  assert.equal(d.staleResolve, "dry");
  assert.equal(d.warnBandFees, true);
  assert.equal(d.lifecycle, true);
  assert.equal(d.g9DryRun, true);
  assert.equal(d.loneLpCrank, true);
});

test("pairingActive: needs enabled, sweep and pairing != off", () => {
  assert.equal(pairingActive({ enabled: true, sweep: true, pairing: "prefer" }), true);
  assert.equal(pairingActive({ enabled: true, sweep: true, pairing: "strict" }), true);
  assert.equal(pairingActive({ enabled: true, sweep: true, pairing: "off" }), false);
  assert.equal(pairingActive({ enabled: true, sweep: false, pairing: "prefer" }), false);
  assert.equal(pairingActive({ enabled: false, sweep: true, pairing: "prefer" }), false);
});
