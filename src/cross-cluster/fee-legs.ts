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
 *
 * The asset-0 profile offset is VERSION-gated through
 * `selectMarketGroupOffset`, the same helper the PushAuthMark path uses.
 */
import {
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
  V17_ASSET_ORACLE_PROFILE_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_MARKET_GROUP_LEN,
} from "@percolatorct/sdk";
import { selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";

export interface FeeLegs {
  protocolOwed: bigint;
  lpOwed: bigint;
  stakeOwed: bigint;
  /** null when the asset-0 profile could not be located (unknown VERSION). */
  creatorClaimable: bigint | null;
}

export function readFeeLegs(data: Uint8Array): FeeLegs {
  const cfg = parseWrapperConfigV17(data);
  let creatorClaimable: bigint | null = null;
  const g = selectMarketGroupOffset(data);
  if (g.ok) {
    const profileOff = g.marketGroupOff + V17_MARKET_GROUP_LEN + 0 * V17_MARKET_ASSET_SLOT_LEN;
    if (data.length >= profileOff + V17_ASSET_ORACLE_PROFILE_LEN) {
      creatorClaimable = parseAssetOracleProfileV17(data, profileOff).creatorFeeClaimableAtoms;
    }
  }
  return {
    protocolOwed: cfg.protocolFeeAccruedAtoms - cfg.protocolFeeWithdrawnAtoms,
    lpOwed: cfg.lpFeeAccruedAtoms - cfg.lpFeeWithdrawnAtoms,
    stakeOwed: cfg.insuranceReserveAccruedAtoms - cfg.insuranceReserveWithdrawnAtoms,
    creatorClaimable,
  };
}
