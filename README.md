# percolator-oracle-keeper

Production-grade oracle keeper for [Percolator](https://github.com/dcccrypto/percolator-launch) — pushes price feeds to Percolator devnet markets via `PushOraclePrice` + `KeeperCrank`.

## What It Does

- **Multi-source price failover**: Pyth Hermes → Jupiter → DexScreener → mainnet CA lookup
- **Staleness detection**: alerts if price hasn't updated in configurable threshold (default 30s)
- **Circuit breaker**: rejects price moves > 10% per update (configurable); a sustained move confirms after 3 consecutive trips, and confirmed moves are rate-limited to 30% per hour from the drift anchor (a larger move advances to the bound edge each window instead of being refused)
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
