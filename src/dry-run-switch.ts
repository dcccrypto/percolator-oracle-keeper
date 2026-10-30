/**
 * dry-run-switch.ts -- the process-wide dry-run switch, FAIL-SAFE.
 *
 * The switch used to be `DRY_RUN === "true" || KEEPER_DRY_RUN === "1" || KEEPER_DRY_RUN === "true"`. Every other
 * spelling an operator would naturally write -- `DRY_RUN=1`, `DRY_RUN=yes`, `DRY_RUN=on`, `DRY_RUN=TRUE`,
 * `KEEPER_DRY_RUN=yes` -- silently meant LIVE, so a standby keeper meant to be silent would sign (and race the live
 * keeper into Custom(19) collisions). Same failure class as GH#226 (KEEPER_V22_DRY_RUN with KEEPER_V22 off).
 *
 * Rule: unset or empty = off; off / 0 / false / no (any case) = off; ANYTHING ELSE = dry, with a warning when the value
 * is not a recognised "on" word. A stray value can therefore only ever make the keeper quieter, never louder. Never
 * throws (a bad value must not stop a keeper that is otherwise fine).
 */
const OFF_WORDS = ["off", "0", "false", "no"];
const ON_WORDS = ["on", "1", "true", "yes"];

type Env = Readonly<Record<string, string | undefined>>;

export function dryRunDecision(env: Env, argv: readonly string[]): { dryRun: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let dry = argv.includes("--dry-run");
  for (const key of ["DRY_RUN", "KEEPER_DRY_RUN"]) {
    const raw = env[key];
    if (raw === undefined) continue;
    const v = raw.trim().toLowerCase();
    if (v === "" || OFF_WORDS.includes(v)) continue;
    dry = true;
    if (!ON_WORDS.includes(v)) warnings.push(`[dry-run] WARNING: ${key} is set to an unrecognised value; treating it as ON (fail-safe, nothing is sent). Use on/1/true/yes or off/0/false/no.`);
  }
  return { dryRun: dry, warnings };
}
