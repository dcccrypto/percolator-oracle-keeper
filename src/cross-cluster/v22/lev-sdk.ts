/**
 * cross-cluster/v22/lev-sdk.ts
 *
 * The ONE place the tag-124 (leverage guard) SDK surface is imported from, with hand-written types.
 *
 * WHY AN ALIAS: tag-124 support was merged into percolator-sdk `feat/v22-sdk-integration` (f1cada61), a line that does NOT contain the 27
 * growth commits this keeper is pinned to (`feat/v22-sdk-growth` 3a435f00: depth source, `buildPushAuthMarkDexIxV22`, `growthFlagsOk`, the
 * contlev3 views). Repinning the main `@percolatorct/sdk` dependency to f1cada61 breaks typecheck (40 errors) and the mode-2 push at runtime.
 * So `package.json` carries a SECOND, aliased dependency `@percolatorct/sdk-lev-guard` on f1cada61, imported only here.
 *
 * WHY HAND-WRITTEN TYPES: both packages are named `@percolatorct/sdk` at version `9.0.0-candidate`, and TypeScript treats two installs with
 * the same name and version as ONE package, so the alias would be typed with the main pin's declarations (which lack tag 124). At runtime
 * node resolves them separately. The runtime values are therefore cast to the interface below; `lev-guard.test.ts` pins every builder to
 * the documented bytes and account metas, so a drifting SDK fails a test, not a send. Both resolve the same `@solana/web3.js`.
 *
 * WHEN THE SDK LINES MERGE: repoint the import at `@percolatorct/sdk`, delete the interface and the alias, keep the exports.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as raw from "@percolatorct/sdk-lev-guard";

/** Decoded `LevGuardV22` (the fields the keeper reads; the SDK's type has all of them). */
export interface LevGuardV22 {
  market: PublicKey;
  riskKey: PublicKey;
  t0Slot: bigint;
  assetIndex: number;
  flags: number;
  mintAuthLive: boolean;
  freezeAuthLive: boolean;
  roundActive: boolean;
  roundLpLong: boolean;
  repJDumpBps: number;
  repMIndBps: number;
  repLCapX100: number;
  repNMultBps: number;
  repSlot: bigint;
  holderDumpBps: number;
  roundKeepBps: number;
  touchedN: number;
  holderDumpSlot: bigint;
  navps: bigint;
  navPeakCur: bigint;
  navPeakPrev: bigint;
  navRef: bigint;
  roundId: bigint;
  roundTargetQ: bigint;
  roundOpenSlot: bigint;
  touchedTags: bigint[];
}

export interface LevGuardCtxV22 {
  programId: PublicKey;
  market: PublicKey;
}
export interface LevGuardReportV22 {
  jDumpBps: number;
  mIndBps: number;
  lCapX100: number;
  nMultBps: number;
}
export interface LevGuardTightenOptsV22 {
  baseMint: PublicKey;
  poolBaseVault: PublicKey;
  holderTokenAccount?: PublicKey;
}
export interface LevGuardPokeOptsV22 {
  vaultLpPortfolio: PublicKey;
  sampleNav?: boolean;
}

interface LevSdk {
  TAG_LEV_GUARD_V22: number;
  LEV_GUARD_OP_V22: Readonly<{ Init: number; SetRiskKey: number; Report: number; Tighten: number; Poke: number; LpStop: number; SetT0: number }>;
  LEV_SLOTS_PER_DAY_V22: bigint;
  buildLevGuardLpStopIxV22(c: LevGuardCtxV22, caller: PublicKey, vaultLpPortfolio: PublicKey, opposing?: readonly PublicKey[]): TransactionInstruction;
  buildLevGuardPokeIxV22(c: LevGuardCtxV22, caller: PublicKey, o: LevGuardPokeOptsV22): TransactionInstruction;
  buildLevGuardReportIxV22(c: LevGuardCtxV22, riskKey: PublicKey, report: LevGuardReportV22): TransactionInstruction;
  buildLevGuardTightenIxV22(c: LevGuardCtxV22, caller: PublicKey, o: LevGuardTightenOptsV22): TransactionInstruction;
  decodeLevGuardV22(data: Uint8Array): LevGuardV22;
  deriveLevGuardV22(programId: PublicKey, market: PublicKey): [PublicKey, number];
  deriveVaultLpStateV22(programId: PublicKey, market: PublicKey): [PublicKey, number];
  deriveVaultLpExtV22(programId: PublicKey, market: PublicKey): [PublicKey, number];
  levKeyTagV22(key: PublicKey): bigint;
  levLpStopTriggeredV22(g: Pick<LevGuardV22, "navps" | "navPeakCur" | "navPeakPrev" | "navRef">): boolean;
  levW1RoundLiveV22(g: Pick<LevGuardV22, "roundActive" | "roundOpenSlot">, nowSlot: bigint): boolean;
}

const sdk = raw as unknown as LevSdk;

export const TAG_LEV_GUARD_V22 = sdk.TAG_LEV_GUARD_V22;
export const LEV_GUARD_OP_V22 = sdk.LEV_GUARD_OP_V22;
export const LEV_SLOTS_PER_DAY_V22 = sdk.LEV_SLOTS_PER_DAY_V22;
export const buildLevGuardLpStopIxV22 = sdk.buildLevGuardLpStopIxV22;
export const buildLevGuardPokeIxV22 = sdk.buildLevGuardPokeIxV22;
export const buildLevGuardReportIxV22 = sdk.buildLevGuardReportIxV22;
export const buildLevGuardTightenIxV22 = sdk.buildLevGuardTightenIxV22;
export const decodeLevGuardV22 = sdk.decodeLevGuardV22;
export const deriveLevGuardV22 = sdk.deriveLevGuardV22;
export const deriveVaultLpStateV22 = sdk.deriveVaultLpStateV22;
export const deriveVaultLpExtV22 = sdk.deriveVaultLpExtV22;
export const levKeyTagV22 = sdk.levKeyTagV22;
export const levLpStopTriggeredV22 = sdk.levLpStopTriggeredV22;
export const levW1RoundLiveV22 = sdk.levW1RoundLiveV22;
