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
 * Allowlist (security review K-2, mirroring the SDK's #308 guard): an env value
 * must be one of the program IDs the SDK knows (PROGRAM_IDS devnet/mainnet +
 * PROGRAM_IDS_V17), unless KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1. The keeper key
 * signs and pays fees into whatever program this names, and on devnet that key
 * is also the upgrade authority (F7), so a poisoned `.env` line must not be
 * enough on its own. Once the keeper is on SDK 8.0.0 the fresh wrapper ID is
 * in the SDK tables and needs no flag. Before that, the cutover sets the flag
 * deliberately, and it is echoed in the boot log.
 *
 * The stake program ID matters for more than the stake-fee loop: the wrapper
 * PINS it at compile time (`constants::STAKE_PROGRAM_ID`, v16_program.rs:796)
 * and tag 87 re-derives the pool PDA under it. A keeper deriving the pool
 * under a different stake ID would read a non-existent pool and skip forever,
 * so the effective value is printed at boot next to the wrapper's.
 */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_IDS, PROGRAM_IDS_V17 } from "@percolatorct/sdk";

/**
 * Program-ID SETS, pinned here as literals (Devnet v2.1 fresh-ID cutover, 2026-10-05).
 *
 * v2.1 ships as a FRESH program-ID set (runbook deploy-runbook-v21 §5.2): the
 * ETDLAdi world is not upgraded; its markets stay on their rules, close-only.
 * Two keepers therefore run side by side after cutover:
 *   - the existing relaunch keeper (Railway `relaunch-live`, set "v1", switch OFF)
 *     keeps pushing marks and cranking the v1 markets so exits keep working;
 *   - a SECOND keeper service with KEEPER_DEVNET_V21=1 (set "v21") serves the
 *     re-seeded v2.1 markets.
 *
 * Why literals and not the SDK constants: SDK 9.0.0 moves its devnet defaults
 * to the v2.1 IDs. Re-pinning the SDK must not silently move the switch-OFF
 * keeper onto programs that are not deployed yet, so the OFF set is the literal
 * ETDLAdi set (identical to PROGRAM_IDS_V17 at the current SDK pin), and the
 * v2.1 set is reachable only through the explicit switch.
 */
export interface ProgramIdSet {
  wrapper: string;
  stake: string;
  matcher: string;
  nft: string;
}

/** v1 = the ETDLAdi relaunch world (2026-09-30). Default; close-only after the v2.1 cutover. */
export const PROGRAM_IDS_DEVNET_V1: Readonly<ProgramIdSet> = Object.freeze({
  wrapper: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  stake: "VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w",
  matcher: "EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX",
  nft: "EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ",
});

/** v2.1 = the fresh-ID world (ledger v21-fresh-ids-2026-10-05). Selected only by KEEPER_DEVNET_V21=1. */
export const PROGRAM_IDS_DEVNET_V21: Readonly<ProgramIdSet> = Object.freeze({
  wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
  nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
});

export type ProgramSetName = "v1" | "v21";

/**
 * The explicit v2.1 switch. Unset, blank or "0" = "v1" (today's behaviour);
 * "1" = "v21". Anything else fails boot: a typo must not pick a world.
 */
export function resolveProgramSet(env: Readonly<Record<string, string | undefined>>): ProgramSetName {
  const raw = env.KEEPER_DEVNET_V21?.trim() ?? "";
  if (raw === "" || raw === "0") return "v1";
  if (raw === "1") return "v21";
  throw new Error(`KEEPER_DEVNET_V21="${raw}" must be "1" (v2.1 program set) or unset/"0" (v1, ETDLAdi)`);
}

export function programIdSet(name: ProgramSetName): Readonly<ProgramIdSet> {
  return name === "v21" ? PROGRAM_IDS_DEVNET_V21 : PROGRAM_IDS_DEVNET_V1;
}

export interface ProgramIds {
  /** The Percolator wrapper (market/slab owner). */
  wrapper: PublicKey;
  /** percolator-stake (insurance/stake pools; destination of tag 87). */
  stake: PublicKey;
  /** percolator-match (matcher). Not sent to by the keeper today; recorded for P2. */
  matcher: PublicKey;
  /** percolator-nft. Its `["mint_authority"]` PDA is the owner of NFT-escrowed portfolios. */
  nft: PublicKey;
  /** Which pinned set supplied the defaults (KEEPER_DEVNET_V21). */
  programSet: ProgramSetName;
  /** Where each value came from, for the boot log. */
  source: { wrapper: string; stake: string; matcher: string; nft: string };
  /** Env IDs accepted only because KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1. */
  overridden: string[];
}

/** Every program ID the SDK build knows about, plus the two pinned devnet sets above. */
export function sdkKnownProgramIds(): Set<string> {
  const out = new Set<string>();
  for (const net of Object.values(PROGRAM_IDS)) for (const v of Object.values(net)) out.add(v);
  for (const v of Object.values(PROGRAM_IDS_V17)) out.add(v);
  for (const v of Object.values(PROGRAM_IDS_DEVNET_V1)) out.add(v);
  for (const v of Object.values(PROGRAM_IDS_DEVNET_V21)) out.add(v);
  return out;
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
  // KEEPER_NFT_PROGRAM_ID is an alias that exists because the SDK (dist, module scope) THROWS AT IMPORT on any
  // NFT_PROGRAM_ID env value outside its own table, with no bypass flag. A fresh-ID keeper whose NFT id is not in
  // the SDK yet therefore cannot set NFT_PROGRAM_ID at all; it sets KEEPER_NFT_PROGRAM_ID instead (the SDK never reads it).
  const nftAlias = nonEmpty(env.KEEPER_NFT_PROGRAM_ID);
  const nftPlain = nonEmpty(env.NFT_PROGRAM_ID);
  if (nftAlias && nftPlain && nftAlias.trim() !== nftPlain.trim()) {
    throw new Error(`KEEPER_NFT_PROGRAM_ID (${nftAlias}) and NFT_PROGRAM_ID (${nftPlain}) disagree - remove one`);
  }
  const nftEnv = nftAlias ?? nftPlain;

  const programSet = resolveProgramSet(env);
  const set = programIdSet(programSet);
  const other = programIdSet(programSet === "v21" ? "v1" : "v21");
  const setLabel = programSet === "v21" ? "PROGRAM_IDS_DEVNET_V21" : "PROGRAM_IDS_DEVNET_V1";

  // Cross-world guard: an env ID from the OTHER pinned set is a half-finished
  // cutover (e.g. the v1 keeper's .env edited to the v2.1 wrapper without the
  // switch, or the v2.1 service still carrying ETDLAdi). Refuse rather than run
  // a keeper whose wrapper and stake/matcher/nft disagree.
  const crossChecks: Array<[string, string | undefined, keyof ProgramIdSet]> = [
    ["WRAPPER_PROGRAM_ID", wrapperEnv, "wrapper"],
    ["PROGRAM_ID", wrapperEnv ? undefined : legacyEnv, "wrapper"],
    ["STAKE_PROGRAM_ID", stakeEnv, "stake"],
    ["MATCHER_PROGRAM_ID", matcherEnv, "matcher"],
    [nftAlias ? "KEEPER_NFT_PROGRAM_ID" : "NFT_PROGRAM_ID", nftEnv, "nft"],
  ];
  for (const [name, v, slot] of crossChecks) {
    if (!v) continue;
    const t = v.trim();
    if (Object.values(other).includes(t)) {
      throw new Error(
        `${name}=${t} belongs to the ${programSet === "v21" ? "v1 (ETDLAdi)" : "v2.1"} program set but ` +
          `KEEPER_DEVNET_V21 selects ${programSet}. ` +
          (programSet === "v1"
            ? "Set KEEPER_DEVNET_V21=1 to run the v2.1 keeper."
            : "Unset it (or KEEPER_DEVNET_V21) to run the v1 keeper."),
      );
    }
    if (Object.values(set).includes(t) && set[slot] !== t) {
      throw new Error(`${name}=${t} is the ${setLabel} id of a different program (expected ${set[slot]} for ${slot})`);
    }
  }

  const wrapperSrc = wrapperEnv
    ? { v: wrapperEnv, s: "env WRAPPER_PROGRAM_ID" }
    : legacyEnv
      ? { v: legacyEnv, s: "env PROGRAM_ID" }
      : { v: set.wrapper, s: `builtin ${setLabel}.wrapper` };

  const known = sdkKnownProgramIds();
  const allowOverride = env.KEEPER_ALLOW_PROGRAM_ID_OVERRIDE?.trim() === "1";
  const overridden: string[] = [];
  const envValues: Array<[string, string | undefined]> = [
    ["WRAPPER_PROGRAM_ID", wrapperEnv],
    ["PROGRAM_ID", wrapperEnv ? undefined : legacyEnv],
    ["STAKE_PROGRAM_ID", stakeEnv],
    ["MATCHER_PROGRAM_ID", matcherEnv],
    [nftAlias ? "KEEPER_NFT_PROGRAM_ID" : "NFT_PROGRAM_ID", nftEnv],
  ];
  for (const [name, v] of envValues) {
    if (!v) continue;
    parseKey(name, v); // a malformed value is a format error first, not an allowlist miss
    if (known.has(v.trim())) continue;
    if (!allowOverride) {
      throw new Error(
        `${name}=${v.trim()} is not a program id this SDK build knows. Set KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1 ` +
          "to accept it deliberately (e.g. a fresh-ID cutover before the SDK carries the new id)",
      );
    }
    overridden.push(`${name}=${v.trim()}`);
  }

  return {
    overridden,
    programSet,
    wrapper: parseKey(wrapperSrc.s, wrapperSrc.v),
    stake: parseKey(stakeEnv ? "STAKE_PROGRAM_ID" : `builtin ${setLabel}.stake`, stakeEnv ?? set.stake),
    matcher: parseKey(matcherEnv ? "MATCHER_PROGRAM_ID" : `builtin ${setLabel}.matcher`, matcherEnv ?? set.matcher),
    nft: parseKey(nftEnv ? (nftAlias ? "KEEPER_NFT_PROGRAM_ID" : "NFT_PROGRAM_ID") : `builtin ${setLabel}.nft`, nftEnv ?? set.nft),
    source: {
      nft: nftEnv ? `env ${nftAlias ? "KEEPER_NFT_PROGRAM_ID" : "NFT_PROGRAM_ID"}` : `builtin ${setLabel}.nft`,
      wrapper: wrapperSrc.s,
      stake: stakeEnv ? "env STAKE_PROGRAM_ID" : `builtin ${setLabel}.stake`,
      matcher: matcherEnv ? "env MATCHER_PROGRAM_ID" : `builtin ${setLabel}.matcher`,
    },
  };
}

/**
 * The process-wide IDs, resolved once at module load from `process.env`.
 * A bad value throws during import, before any loop starts — the entrypoint's
 * `uncaughtException` handler is not installed yet at that point, so the
 * process exits non-zero, which is what a supervisor needs to see.
 */
export const PROGRAM_IDS_RESOLVED: ProgramIds = resolveProgramIds(process.env);

export const WRAPPER_PROGRAM_ID: PublicKey = PROGRAM_IDS_RESOLVED.wrapper;
export const STAKE_PROGRAM_ID: PublicKey = PROGRAM_IDS_RESOLVED.stake;
export const MATCHER_PROGRAM_ID: PublicKey = PROGRAM_IDS_RESOLVED.matcher;
export const NFT_PROGRAM_ID: PublicKey = PROGRAM_IDS_RESOLVED.nft;

export function describeProgramIds(ids: ProgramIds = PROGRAM_IDS_RESOLVED): string[] {
  return [
    `program set=${ids.programSet}${ids.programSet === "v21" ? " (KEEPER_DEVNET_V21=1)" : " (v1 / ETDLAdi; KEEPER_DEVNET_V21 off)"}`,
    ...(ids.overridden.length ? [`OVERRIDE (KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1, not in the SDK tables): ${ids.overridden.join(", ")}`] : []),
    `wrapper=${ids.wrapper.toBase58()} (${ids.source.wrapper})`,
    `stake=${ids.stake.toBase58()} (${ids.source.stake})`,
    `matcher=${ids.matcher.toBase58()} (${ids.source.matcher})`,
    `nft=${ids.nft.toBase58()} (${ids.source.nft})`,
  ];
}
