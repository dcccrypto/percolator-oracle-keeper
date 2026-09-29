/**
 * program-ids.ts — the ONE place the keeper learns which on-chain programs it
 * talks to.
 *
 * Why this exists (P0 fresh-ID relaunch, 2026-09-29):
 *   Every module used to build its own `new PublicKey(PROGRAM_IDS_V17.percolator)`
 *   from the SDK constant. Moving the keeper to a fresh wrapper ID therefore
 *   meant an SDK release AND a keeper code change in five files. With this
 *   module the relaunch is a config change: set `WRAPPER_PROGRAM_ID` (and, if
 *   it ever moves, `STAKE_PROGRAM_ID`) in `.env` and restart.
 *
 * Resolution, per program:
 *   1. the env var, if set (validated as a base58 public key — a typo fails
 *      boot instead of silently pointing the keeper at nothing);
 *   2. otherwise the SDK constant the keeper was built against.
 *
 * `PROGRAM_ID` is accepted as a legacy alias for the wrapper, because the live
 * `.env` already carries it (for the retired index.ts path). If both are set
 * they must agree: two different wrapper IDs in one config is a
 * half-finished cutover, and guessing which one is meant is how a keeper ends
 * up cranking the abandoned program.
 *
 * The stake program ID matters for more than the stake-fee loop: the wrapper
 * PINS it at compile time (`constants::STAKE_PROGRAM_ID`, v16_program.rs:796)
 * and tag 87 re-derives the pool PDA under it. A keeper deriving the pool
 * under a different stake ID would read a non-existent pool and skip forever,
 * so the effective value is printed at boot next to the wrapper's.
 */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_IDS_V17 } from "@percolatorct/sdk";

export interface ProgramIds {
  /** The Percolator wrapper (market/slab owner). */
  wrapper: PublicKey;
  /** percolator-stake (insurance/stake pools; destination of tag 87). */
  stake: PublicKey;
  /** percolator-match (matcher). Not sent to by the keeper today; recorded for P2. */
  matcher: PublicKey;
  /** Where each value came from, for the boot log. */
  source: { wrapper: string; stake: string; matcher: string };
}

type Env = Readonly<Record<string, string | undefined>>;

function parseKey(name: string, value: string): PublicKey {
  try {
    const pk = new PublicKey(value.trim());
    // PublicKey accepts a 32-byte buffer-ish string in some forms; insist the
    // round trip is exact so "  abc " or a non-canonical encoding is rejected.
    if (pk.toBase58() !== value.trim()) throw new Error("non-canonical");
    return pk;
  } catch {
    throw new Error(`${name}="${value}" is not a valid base58 public key`);
  }
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

/**
 * Resolve the program IDs from `env`. Pure: pass an explicit env object in
 * tests. Throws on a malformed or contradictory configuration.
 */
export function resolveProgramIds(env: Env): ProgramIds {
  const wrapperEnv = nonEmpty(env.WRAPPER_PROGRAM_ID);
  const legacyEnv = nonEmpty(env.PROGRAM_ID);
  if (wrapperEnv && legacyEnv && wrapperEnv.trim() !== legacyEnv.trim()) {
    throw new Error(
      `WRAPPER_PROGRAM_ID (${wrapperEnv}) and PROGRAM_ID (${legacyEnv}) disagree — ` +
        "remove one; the keeper will not guess which wrapper is live",
    );
  }
  const stakeEnv = nonEmpty(env.STAKE_PROGRAM_ID);
  const matcherEnv = nonEmpty(env.MATCHER_PROGRAM_ID);

  const wrapperSrc = wrapperEnv
    ? { v: wrapperEnv, s: "env WRAPPER_PROGRAM_ID" }
    : legacyEnv
      ? { v: legacyEnv, s: "env PROGRAM_ID" }
      : { v: PROGRAM_IDS_V17.percolator, s: "sdk PROGRAM_IDS_V17.percolator" };

  return {
    wrapper: parseKey(wrapperSrc.s, wrapperSrc.v),
    stake: parseKey(
      stakeEnv ? "STAKE_PROGRAM_ID" : "sdk PROGRAM_IDS_V17.vault",
      stakeEnv ?? PROGRAM_IDS_V17.vault,
    ),
    matcher: parseKey(
      matcherEnv ? "MATCHER_PROGRAM_ID" : "sdk PROGRAM_IDS_V17.matcher",
      matcherEnv ?? PROGRAM_IDS_V17.matcher,
    ),
    source: {
      wrapper: wrapperSrc.s,
      stake: stakeEnv ? "env STAKE_PROGRAM_ID" : "sdk PROGRAM_IDS_V17.vault",
      matcher: matcherEnv ? "env MATCHER_PROGRAM_ID" : "sdk PROGRAM_IDS_V17.matcher",
    },
  };
}

/**
 * The process-wide IDs, resolved once at module load from `process.env`.
 * A bad value throws during import, before any loop starts — the entrypoint's
 * `uncaughtException` handler is not installed yet at that point, so the
 * process exits non-zero, which is what a supervisor needs to see.
 */
export const PROGRAM_IDS: ProgramIds = resolveProgramIds(process.env);

export const WRAPPER_PROGRAM_ID: PublicKey = PROGRAM_IDS.wrapper;
export const STAKE_PROGRAM_ID: PublicKey = PROGRAM_IDS.stake;
export const MATCHER_PROGRAM_ID: PublicKey = PROGRAM_IDS.matcher;

export function describeProgramIds(ids: ProgramIds = PROGRAM_IDS): string[] {
  return [
    `wrapper=${ids.wrapper.toBase58()} (${ids.source.wrapper})`,
    `stake=${ids.stake.toBase58()} (${ids.source.stake})`,
    `matcher=${ids.matcher.toBase58()} (${ids.source.matcher})`,
  ];
}
