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

## Capacity snapshots (growth telemetry, optional, OFF by default)

`KEEPER_CAPACITY_SNAPSHOTS=1` (plus `SUPABASE_URL` https and `SUPABASE_SERVICE_ROLE_KEY`; boot fails fast if
either is missing) starts a read-only loop (`src/cross-cluster/capacity-snapshots.ts`) that every
`CAPACITY_SNAPSHOT_INTERVAL_MS` (default 300000) inserts one row per growth market into Supabase
`market_capacity_snapshots` (N_cap, utilisation and max leverage per side, Earn principal/NAV/NAV per share,
allocated capital, junior, cushion, OI, fee income, ADL/h-lock flags). A market is snapshotted only if it is
bound to a vault LP and its growth record decodes, so every market of today's programs is skipped. The
loop never throws into the push/crank loops. Table: percolator-launch
`supabase/migrations/20261005000000_market_capacity_snapshots.sql` (apply it first; RLS on, no policies).
