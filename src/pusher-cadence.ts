/**
 * Pusher cadence env parsing, kept free of pusher.ts boot side effects so it is unit-testable.
 *
 * parseInt/Number turned '' into NaN/0, '3e3' into 3 (parseInt) and '3' into a 3 ms push loop that
 * markCadenceCheck rates "ok". Both values now go through the shared strict parser
 * (bootPositiveNumberEnv: '' -> default, junk/zero/negative -> `[fatal]` + exit 1), plus a floor on the interval.
 */
import { bootPositiveNumberEnv } from "./env-utils.ts";
import { markCadenceCheck } from "./cross-cluster/mark-smoother.ts";

/** Anything faster than this hammers the RPC; a 3 ms interval passes markCadenceCheck. */
export const MIN_CC_INTERVAL_MS = 250;

export function resolvePusherCadence(
  dryRun: boolean,
  fatal: (msg: string) => never,
  exit: (code: number) => never = (c) => process.exit(c),
  logError: (line: string) => void = (l) => console.error(l),
): { intervalMs: number; windowMs: number } {
  const intervalMs = bootPositiveNumberEnv("CC_INTERVAL_MS", 3000, undefined, exit, logError);
  const windowMs = bootPositiveNumberEnv("CC_MARK_WINDOW_MS", 15_000, undefined, exit, logError);
  if (intervalMs < MIN_CC_INTERVAL_MS) {
    fatal(`CC_INTERVAL_MS=${intervalMs} is below the ${MIN_CC_INTERVAL_MS} ms floor (would hammer the RPC)`);
  }
  const c = markCadenceCheck(intervalMs, windowMs);
  if (c.verdict === "never" && !dryRun) fatal(`this cadence can never publish a mark. ${c.detail}`);
  return { intervalMs, windowMs };
}
