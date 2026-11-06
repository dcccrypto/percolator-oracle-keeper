/**
 * cross-cluster/fee-legs.ts
 *
 * Read a market's four outstanding trade-fee legs from its slab bytes. Every
 * field comes from an SDK decoder (no hand-written offsets):
 *
 *   protocol  cfg.protocol_fee_accrued − withdrawn        (tag 84 claims)
 *   lp        cfg.lp_fee_accrued − withdrawn              (tag 78 cranks)
 *   stake     cfg.insurance_reserve_accrued − withdrawn   (tag 87 pushes)
 *   creator   asset-0 profile creator_fee_claimable       (tag 90 claims)
 *   creatorRoute  who can claim it (prog #587/#644): "AdminSigned" (live asset_admin signs),
 *             "Payee" (admin burned after recording a payee: anyone sends tag 90, it pays
 *             the payee; CloseSlab refuses 71 until paid), "Refused" (admin burned, no
 *             payee: CloseSlab re-books the pot to the protocol leg)
 *
 * The asset-0 profile offset is VERSION-gated through
 * `selectMarketGroupOffset`, the same helper the PushAuthMark path uses.
 */
import {
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
  V17_ASSET_ORACLE_PROFILE_LEN,
} from "@percolatorct/sdk";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { PROFILE_P4_FLAGS_OFF, creatorRoute } from "./creator-fee-payee.ts";
import type { CreatorRoute } from "./creator-fee-payee.ts";

export interface FeeLegs {
  protocolOwed: bigint;
  lpOwed: bigint;
  stakeOwed: bigint;
  /** null when the asset-0 profile could not be located (unknown VERSION). */
  creatorClaimable: bigint | null;
  /** null when the asset-0 profile could not be located (unknown VERSION). */
  creatorRoute: CreatorRoute | null;
}

export function readFeeLegs(data: Uint8Array): FeeLegs {
  const cfg = parseWrapperConfigV17(data);
  let creatorClaimable: bigint | null = null;
  let route: CreatorRoute | null = null;
  const g = selectMarketGroupOffset(data);
  if (g.ok) {
    const profileOff = assetSlotOffset(g, 0); // K-2: per-VERSION group length (806 on VERSION 19)
    if (data.length >= profileOff + V17_ASSET_ORACLE_PROFILE_LEN) {
      const profile = parseAssetOracleProfileV17(data, profileOff);
      creatorClaimable = profile.creatorFeeClaimableAtoms;
      route = creatorRoute(profile.assetAdmin.toBytes(), data[profileOff + PROFILE_P4_FLAGS_OFF]);
    }
  }
  return {
    protocolOwed: cfg.protocolFeeAccruedAtoms - cfg.protocolFeeWithdrawnAtoms,
    lpOwed: cfg.lpFeeAccruedAtoms - cfg.lpFeeWithdrawnAtoms,
    stakeOwed: cfg.insuranceReserveAccruedAtoms - cfg.insuranceReserveWithdrawnAtoms,
    creatorClaimable,
    creatorRoute: route,
  };
}
