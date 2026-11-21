# percolator-oracle-keeper

Oracle keeper for [Percolator](https://github.com/dcccrypto/percolator-launch) devnet markets. It reads spot prices from mainnet DEX pools (Raydium CLMM, Meteora DLMM, PumpSwap) and pushes them to the matching devnet markets as `PushAuthMark` instructions. The keeper keypair is the oracle authority for those markets. It also runs a recovery crank loop and an LP fee crank loop.

The entrypoint is `src/cross-cluster.ts`. The markets it serves are listed in `registry.json`, which is hot-reloaded, and can be extended from Supabase registrations.

## Requirements

- Node.js 22 (the Dockerfile uses `node:22-slim`)
- A mainnet RPC URL (price reads) and a devnet RPC URL (pushes)
- A keypair that is the oracle authority for the markets in `registry.json`
- `@percolatorct/sdk` is a local dependency (`file:../percolator-sdk`), so a checkout of `percolator-sdk` must sit next to this repo before `npm install`

## Build and run

```bash
npm install
cp .env.example .env     # see the note on env vars below
npm test                 # node:test via tsx
npm run build            # type-check only (tsc --noEmit)
npm run cross-cluster:dry-run   # no on-chain writes
npm start                # live: pushes prices
```

The keeper does not load `.env` itself. Export the variables in your shell, or use `start-keeper.sh`, which sources `.env` first.

## Configuration

Read directly from `process.env` in `src/cross-cluster.ts`:

| Variable | Default | Notes |
|---|---|---|
| `MAINNET_RPC_URL` | required | Mainnet RPC for pool reads |
| `DEVNET_RPC_URL` | required | Devnet RPC for pushes |
| `KEEPER_KEYPAIR` | | Inline JSON u8 array |
| `KEEPER_KEYPAIR_PATH` | see source | Path to a keypair file, used if `KEEPER_KEYPAIR` is unset |
| `REGISTRY_PATH` | `./registry.json` | Market list |
| `CC_INTERVAL_MS` | `7000` | Push cycle interval |
| `CC_HEALTH_PORT` / `CC_HEALTH_BIND` | `3001` / `0.0.0.0` | Health server |
| `DRY_RUN` | `false` | Same as `--dry-run` |
| `CRANK_ENABLED`, `CRANK_INTERVAL_MS` | `true`, `20000` | Recovery crank loop |
| `REGISTER_SOURCE_URL` | unset | Polled for newly registered markets |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | unset | Realtime market registration |

`src/cross-cluster.ts` has the full list, including poll and reload intervals. `.env.example` may lag the source, so check the source when in doubt.

## Health

`GET /health` returns JSON with per-market stats and service counters.

## Deployment

The `Dockerfile` runs `npx tsx src/cross-cluster.ts` and `railway.toml` points Railway at it with `/health` as the healthcheck. Which branch Railway builds is set in the Railway project, not in this repo.

## Layout

- `src/cross-cluster.ts`: entrypoint
- `src/cross-cluster/`: price readers, mark pusher, keeper loop, crank loops, registry handling
- `src/circuit-breaker.ts`: price-move limiting
- `registry.json`: markets to serve
- `scripts/`: log rotation helpers
