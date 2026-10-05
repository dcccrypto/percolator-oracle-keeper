# percolator-oracle-keeper

Production-grade oracle keeper for [Percolator](https://github.com/dcccrypto/percolator-launch) — pushes price feeds to Percolator devnet markets via `PushOraclePrice` + `KeeperCrank`.

## What It Does

- **Multi-source price failover**: Pyth Hermes → Jupiter → DexScreener → mainnet CA lookup
- **Staleness detection**: alerts if price hasn't updated in configurable threshold (default 30s)
- **Circuit breaker**: rejects price moves > 10% per update (configurable); a sustained move confirms after 3 consecutive trips, and every published mark is rate-limited to ±30% of every mark in force during the trailing hour — sub-threshold steps included (a larger move advances to the band edge, is held there — re-pushed unchanged so the oracle stays fresh — and continues as older marks leave the window)
- **Health endpoint**: `/health` for Railway/monitoring with per-market stats
- **Graceful shutdown** with drain on SIGINT/SIGTERM
- **Supabase auto-discovery**: automatically cranks newly-created markets
- **HYPERP oracle mode**: cranks DEX-pool-based oracle markets (PumpSwap, Raydium, Meteora)
- **Wallet balance guard**: pauses pushes if keeper wallet goes below threshold
- **Oracle authority verification**: skips markets where the keeper isn't the oracle authority

## Requirements

- Node.js 20+
- A Solana keypair with oracle authority over the target markets
- RPC endpoint (Helius recommended for devnet)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your RPC_URL and keypair
npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | ✅ | — | Solana RPC endpoint |
| `ADMIN_KEYPAIR` | ✅* | — | JSON array of 64-byte keypair (for Railway) |
| `ADMIN_KEYPAIR_PATH` | ✅* | `~/.config/solana/percolator-upgrade-authority.json` | Path to keypair file |
| `SUPABASE_URL` | — | — | Enables auto-discovery of new markets |
| `SUPABASE_SERVICE_ROLE_KEY` | — | — | Required if SUPABASE_URL set |
| `DEPLOYMENT_JSON` | — | — | Deployment JSON (alternative to Supabase) |
| `PUSH_INTERVAL_MS` | — | `3000` | How often to push prices (ms) |
| `HEALTH_PORT` | — | `18810` | Health endpoint port |
| `HEALTH_BIND` | — | `0.0.0.0` | Health endpoint bind address |
| `HEALTH_AUTH_TOKEN` | — | — | Bearer token for health endpoint |
| `MAX_PRICE_MOVE_PCT` | — | `10` | Circuit breaker threshold (%) |
| `STALE_THRESHOLD_S` | — | `30` | Staleness alert threshold (seconds) |
| `MIN_KEEPER_BALANCE_SOL` | — | `0.05` | Minimum wallet balance before pausing |
| `ORACLE_KEEPER_BLOCKED_MARKETS` | — | — | Comma-separated slab addresses to skip |

*One of `ADMIN_KEYPAIR` or `ADMIN_KEYPAIR_PATH` is required.

## Health Endpoint

```
GET /health
```

Returns JSON with per-market stats, wallet balance, and overall status:

```json
{
  "status": "ok",
  "uptime": "3600s",
  "wallet": { "address": "...", "balanceSol": 0.12, "low": false },
  "markets": {
    "SOL": { "lastPrice": 135.42, "lastPushAgo": "2s", "stale": false, "source": "pyth", "totalPushes": 1200 }
  }
}
```

## Deployment (Railway)

This service is deployed to Railway as `oracle-keeper` (service ID: `8bcc8946`).

Required Railway environment variables:
- `RPC_URL` — Helius devnet RPC
- `ADMIN_KEYPAIR` — JSON keypair array
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — for market auto-discovery
- `HEALTH_AUTH_TOKEN` — for secured health checks

## Devnet v2.1 fresh-ID cutover: two keepers

v2.1 ships as a fresh program-ID set; the ETDLAdi world is not upgraded and its markets become close-only.
The program set is chosen by one explicit switch, `KEEPER_DEVNET_V21` (`src/program-ids.ts`):

| `KEEPER_DEVNET_V21` | wrapper / stake / matcher / nft | default registry (Railway) |
|---|---|---|
| unset / `0` (default) | `ETDLAdi…` / `VmpVUArR…` / `EDKKgRaV…` / `EMYT15LZ…` (pinned literals, independent of the SDK defaults) | `/data/registry.relaunch.json` |
| `1` | `5NGgnU2j…` / `A6DVNubv…` / `DfTxJUT5…` / `DWUNq2iY…` | `/data/registry.v21.json`, seeded from `deploy/registry.v21.seed.json` (TO-FILL from the Phase 3 `newmarkets` output) |

- The existing relaunch service (`relaunch-live`) keeps running unchanged with the switch off, so v1 markets keep
  oracle pushes and cranks and their exits keep working.
- v2.1 runs as a SECOND Railway service from the same image with `KEEPER_DEVNET_V21=1`, its own `/data` volume and
  `WRAPPER_PROGRAM_ID=5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe` (the launcher requires it). One replica per service.
- A v2.1 ID without the switch, or a v1 ID with it, fails boot. A registry is tagged `"programSet": "v21"`; each keeper
  refuses to boot or hot-reload the other world's registry. The register-poll owner filter follows the selected wrapper.

## Architecture

Previously part of `percolator-launch/bots/oracle-keeper/`. Extracted to standalone repo for cleaner architecture. The oracle-keeper is a backend service; the frontend lives in [percolator-launch](https://github.com/dcccrypto/percolator-launch).

## Chart tick publisher (optional)

When `TICK_INGEST_URL` and `TICK_INGEST_KEY` are both set, each cycle's *landed* pushes are POSTed
(`authorization: Bearer <key>`) as wire v1 `{v:1,src:"keeper",sentMs,ticks:[{slab,assetIndex,slot,landedMs,markE6,oracleE6}]}`
(max 200 ticks/request; `markE6` = published AuthMark, `oracleE6` = raw pool price or null). Fire-and-forget with a
single request in flight (extra batches are dropped and counted), `TICK_PUBLISH_TIMEOUT_MS` timeout (default 1500).
Counters appear under `tickPublisher` in `/health`. Unset = no-op; on-chain behaviour is never affected.

## v2.1 (P2b) layer — feature-detected, no-op on today's programs

The keeper carries the client side of the v2.1 wrapper (percolator-prog #524/#525/#526) behind a feature
gate (`src/cross-cluster/p2b-feature.ts`). There is no on-chain version byte, so `P2B_FEATURES=auto`
(default) runs one cached probe: a SIMULATED tag-103 (`VaultLpAllocate`) on a bound market.
`InvalidInstructionData` means the program predates P2b (cached 6 h, logged once, everything below stays
OFF); any `Custom(n)` (including 100 = no room) or success means supported. `on` skips the probe, `off`
never creates the loop.

When supported (tick every `P2B_TICK_MS`, one batched snapshot read per tick):

- **Tag 103 allocation cranks** (`p2b-allocate.ts`): per bound, Live market with no senior draw
  outstanding, paced ~60 s +-25%, simulated first, sent only on a clean simulation (`Custom(100)` = skip).
- **Tag 104 AdlWindDown** (`p2b-wind-down.ts`): for ADL reduce-only assets, one arming call per episode,
  then closes of the reduce-only side's legs once the episode expired or the side is dust; mark-age and
  per-cycle bounds; refusals 21/27/16/22 are classified and counted.
- **Hedged-lockout alert** (`p2b-hedged-lockout.ts`): both sides of a growth asset >= 90% of N_cap while the
  vault LP is within 3% of flat.
- **R3-M1** (`p2b-earn-gap.ts`): `/health` gains `earnVaults[]` (par - E3 gap per non-bound Earn vault,
  bigints as strings) and an alert when the gap exceeds `EARN_GAP_ALERT_BPS` for `EARN_GAP_ALERT_CYCLES`;
  the refresh prune budget no longer caps below the positioned set.

Independent of the gate: tag 78 on a bound vault appends `[7]` ext and `[8]` vault LP once the registry ext
flag (byte 161) is set (it is 0 on every pre-P2b program). See `.env.example` for every knob.

## Transaction v1 for the PushAuthMark batch (`TX_V1`, default off)

`TX_V1` switches the per-cycle PushAuthMark batch to Solana v1 transactions (SIMD-0385 format, SIMD-0296
4,096-byte limit) via the SDK encoder (`src/cross-cluster/tx-v1.ts`). Off, the keeper sends exactly the legacy
bytes it sent before (pinned by a golden test against the pre-v1 commit).

| `TX_V1` | Behaviour |
|---------|-----------|
| `off` (default) | Legacy txs, 13 markets per tx (1,232-byte limit). |
| `auto` | v1 while the devnet feature gate reports it active; on a FORMAT rejection (or a v1 CU / loaded-size error in preflight) the unsent markets go out in legacy and v1 is suspended for `TX_V1_RETRY_AFTER_REJECT_MS`. Program errors never fall back or resend. |
| `on` | v1 only. A cluster without v1, or a v1 rejection, means no push that cycle (fail closed). |

Measured on devnet (48 live markets): legacy 4 txs per cycle (1,142 / 1,142 / 1,142 / 854 B), v1 1 tx (3,682 B,
247,773 CU, loaded 3,590,545 B). A v1 tx is atomic like a legacy chunk: preflight still excludes a reverting
market and re-sends the rest in the same cycle, but a revert that only shows up on-chain (after a clean
preflight) now affects every market in the tx instead of its 13-market chunk. `TX_V1_PUSH_MAX_MARKETS` caps
markets per v1 tx (0 = all that fit). Other knobs: `TX_V1_PUSH_CU_PER_MARKET` (8000), `TX_V1_PUSH_CU_BASE`
(10000), `TX_V1_LOADED_ACCOUNTS_BYTES` (unset = 1.25 x (2,000,000 + sum of slab bytes + 64 each)),
`TX_V1_LOADED_OVERHEAD_BYTES` (2000000), `TX_V1_HEAP_BYTES` (0, like legacy). `/health` gains a `txV1` block
(last cycle's tx count vs the legacy baseline, fallbacks) only when `TX_V1` is not off. Cranks and refreshes
stay legacy (they are CU-bound: v1 would not add a single refresh per tx).
