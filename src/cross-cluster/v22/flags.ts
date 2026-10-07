/**
 * cross-cluster/v22/flags.ts
 *
 * Every v2.2 keeper behaviour is gated by an env flag and DEFAULT OFF. With all of them unset the v2.2 layer is
 * never started (cross-cluster.ts checks `flags.enabled`), the legacy cranker / fee job / vault-LP cranker take
 * exactly the paths they took before, and the /health body gains no key. See README "v2.2 keeper".
 *
 *   KEEPER_V22                    master switch "on"|"off" (default off). Nothing below runs without it.
 *   KEEPER_V22_DRY_RUN            "on": every v2.2 cranker simulates and LOGS what it would send; sends nothing.
 *   KEEPER_V22_TICK_MS            v2.2 loop tick (default 20000)
 *   KEEPER_V22_FEE_CRANK_BOND     tag 78 on bond markets (LP crank first, ext + writable LP + tranche tail)
 *   KEEPER_V22_SWEEP              positioned-refresh sweep for v2.2 markets ([LP crank, refresh xN], weight-budgeted)
 *   KEEPER_V22_SETTLE_PAIRING     off | prefer | strict   (default prefer; only acts when KEEPER_V22_SWEEP is on)
 *   KEEPER_V22_HOLDING_RENT       tag 106 settle on rent markets
 *   KEEPER_V22_RENT_CADENCE_SLOTS slots between rent settles of one portfolio (default 9000, about one hour)
 *   KEEPER_V22_DUST_SWEEP         tag 118 (OFF by default, own flag; band markets only)
 *   KEEPER_V22_G9                 tag 111 propose -> wait 9,000 slots -> draw, and restore
 *   KEEPER_V22_G9_DRY_RUN         default ON: G9 logs only until this is set to "off" explicitly
 *   KEEPER_V22_G9_ALLOW_ANY_ORACLE_MODE  "on" skips the Hybrid-only gate (devnet testing; a mainnet wrapper refuses anyway)
 *   KEEPER_V22_G9_DRAW_CAP_ATOMS  cap passed to draw (mode 0) in atoms (default 18446744073709551615 = "the program's own caps decide")
 *   KEEPER_V22_STAKE_SYNC         stake tag 31 SyncInsuranceDeployment
 *   KEEPER_V22_STAKE_SYNC_INTERVAL_MS  minimum ms between syncs of one pool (default 60000)
 *   KEEPER_V22_EARN_EXIT          keeper-executed Earn exits (tag 77, keeper_ok requests)
 *   KEEPER_V22_MAINNET_BUILD      "on": the wrapper is a mainnet-flavoured build (G9 modes 0 and 2 take the allowlist + leg accounts)
 *   KEEPER_V22_ACCRUE_ANCHORS     "market:flatPortfolio,..." accrue-only crank targets (optional; else discovered)
 *   VAULT_LP_LONE_CRANK           "on" (default, today's behaviour) | "off": the lone LP crank 1.5 s after a landed push
 *
 * `SETTLE_PAIRING` and the lone LP crank: see settle-pairing.ts. With pairing on and the sweep on, the lone crank
 * is suppressed on v2.2 markets whatever VAULT_LP_LONE_CRANK says.
 *
 * PARSING IS STRICT: an unrecognised value of any of these variables is a startup error (V22FlagError), never a
 * silent default. Booleans accept on/1/true/yes and off/0/false/no; empty means unset.
 */

export type PairingMode = "off" | "prefer" | "strict";

export interface V22Flags {
  enabled: boolean;
  dryRun: boolean;
  tickMs: number;
  feeCrankBond: boolean;
  sweep: boolean;
  pairing: PairingMode;
  holdingRent: boolean;
  rentCadenceSlots: number;
  dustSweep: boolean;
  g9: boolean;
  g9DryRun: boolean;
  g9AllowAnyOracleMode: boolean;
  g9DrawCapAtoms: bigint;
  stakeSync: boolean;
  stakeSyncIntervalMs: number;
  earnExit: boolean;
  loneLpCrank: boolean;
  mainnetBuild: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Thrown at startup for a v2.2 variable with an unrecognised value (a typo must never silently pick a default). */
export class V22FlagError extends Error {
  constructor(key: string, value: string, expected: string) {
    super(`${key}="${value}" is not recognised (expected ${expected}). Refusing to start: a v2.2 flag is never silently defaulted.`);
    this.name = "V22FlagError";
  }
}

const TRUE_WORDS = ["on", "1", "true", "yes"];
const FALSE_WORDS = ["off", "0", "false", "no"];

/** unset / empty -> `def`; on/1/true/yes -> true; off/0/false/no -> false; anything else THROWS. */
export function parseFlag(env: Env, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(v)) return true;
  if (FALSE_WORDS.includes(v)) return false;
  throw new V22FlagError(key, raw, "on/1/true/yes or off/0/false/no");
}

function posInt(env: Env, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) throw new V22FlagError(key, raw, "a positive integer");
  return n;
}

const U64_MAX = (1n << 64n) - 1n;

export function v22FlagsFromEnv(env: Env = process.env): V22Flags {
  const pairingRaw = env.KEEPER_V22_SETTLE_PAIRING;
  let pairing: PairingMode = "prefer";
  if (pairingRaw !== undefined && pairingRaw.trim() !== "") {
    const v = pairingRaw.trim().toLowerCase();
    if (v !== "off" && v !== "prefer" && v !== "strict") throw new V22FlagError("KEEPER_V22_SETTLE_PAIRING", pairingRaw, "off | prefer | strict");
    pairing = v;
  }
  let cap = U64_MAX;
  const capRaw = env.KEEPER_V22_G9_DRAW_CAP_ATOMS;
  if (capRaw !== undefined && capRaw.trim() !== "") {
    if (!/^\d+$/.test(capRaw.trim())) throw new V22FlagError("KEEPER_V22_G9_DRAW_CAP_ATOMS", capRaw, "a positive integer of atoms");
    const c = BigInt(capRaw.trim());
    if (c <= 0n || c > U64_MAX) throw new V22FlagError("KEEPER_V22_G9_DRAW_CAP_ATOMS", capRaw, "1..=18446744073709551615");
    cap = c;
  }
  return {
    enabled: parseFlag(env, "KEEPER_V22", false),
    dryRun: parseFlag(env, "KEEPER_V22_DRY_RUN", false),
    tickMs: posInt(env, "KEEPER_V22_TICK_MS", 20_000),
    feeCrankBond: parseFlag(env, "KEEPER_V22_FEE_CRANK_BOND", false),
    sweep: parseFlag(env, "KEEPER_V22_SWEEP", false),
    pairing,
    holdingRent: parseFlag(env, "KEEPER_V22_HOLDING_RENT", false),
    rentCadenceSlots: posInt(env, "KEEPER_V22_RENT_CADENCE_SLOTS", 9_000),
    dustSweep: parseFlag(env, "KEEPER_V22_DUST_SWEEP", false),
    g9: parseFlag(env, "KEEPER_V22_G9", false),
    // default ON: only an explicit off arms real G9 sends
    g9DryRun: parseFlag(env, "KEEPER_V22_G9_DRY_RUN", true),
    g9AllowAnyOracleMode: parseFlag(env, "KEEPER_V22_G9_ALLOW_ANY_ORACLE_MODE", false),
    g9DrawCapAtoms: cap,
    stakeSync: parseFlag(env, "KEEPER_V22_STAKE_SYNC", false),
    stakeSyncIntervalMs: posInt(env, "KEEPER_V22_STAKE_SYNC_INTERVAL_MS", 60_000),
    earnExit: parseFlag(env, "KEEPER_V22_EARN_EXIT", false),
    // today's behaviour unless explicitly turned off
    loneLpCrank: parseFlag(env, "VAULT_LP_LONE_CRANK", true),
    mainnetBuild: parseFlag(env, "KEEPER_V22_MAINNET_BUILD", false),
  };
}

/** Every flag with its resolved value, for the startup banner and /health. */
export function describeV22Flags(f: V22Flags): Record<string, string | number | boolean> {
  return {
    enabled: f.enabled,
    dryRun: f.dryRun,
    feeCrankBond: f.feeCrankBond,
    sweep: f.sweep,
    settlePairing: f.pairing,
    holdingRent: f.holdingRent,
    rentCadenceSlots: f.rentCadenceSlots,
    dustSweep: f.dustSweep,
    g9: f.g9,
    g9DryRun: f.g9DryRun,
    stakeSync: f.stakeSync,
    earnExit: f.earnExit,
    loneLpCrank: f.loneLpCrank,
  };
}

/** True when the pairing policy is acting: it is part of the sweep, so the sweep flag gates it. */
export function pairingActive(f: Pick<V22Flags, "enabled" | "sweep" | "pairing">): boolean {
  return f.enabled && f.sweep && f.pairing !== "off";
}
