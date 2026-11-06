#!/bin/bash
# run-v22fresh1106.sh — launcher for the NEW v2.2 keeper on the fresh-address set (wrapper 5NGgnU2j), 2026-11-06. Copy of run-v22fresh.sh with new ids/port/registry.
#
#   ./run-v22fresh1106.sh --dry-run   boots the real entrypoint with DRY_RUN=true (connections refuse sends), on port 18798
#   ./run-v22fresh1106.sh             LIVE (what launchd runs): requires a non-empty registry whose slabs are all owned by the fresh wrapper
#
# No secret lives in this file or in the plist: the Helius keeper key is read from deploy-tokens.env at runtime.
# Overridable: REGISTRY_PATH, CC_HEALTH_PORT, CC_INTERVAL_MS, CC_MARK_WINDOW_MS, CRANK_INTERVAL_MS, KEEPER_V22_* flags.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

MODE=live
[[ "${1:-}" == "--dry-run" ]] && MODE=dry

# --- code identity + tsx cache isolation (stale-transpile hazard) ---
BUILDTAG="v22fresh1106-$(git rev-parse --short HEAD)$([[ -n "$(git status --porcelain -- src package.json)" ]] && echo -dirty || true)"
export BUILDTAG
export TSX_DISABLE_CACHE=1
export TMPDIR="$HOME/wt-fresh-1105/tmp-keeper-fresh1106"
mkdir -p "$TMPDIR" "$HOME/wt-fresh-1105/logs"
rm -rf "$TMPDIR"/tsx-* 2>/dev/null || true

# --- scrub anything inherited that could point this keeper at other markets / the live DB / alerts ---
unset SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY REGISTER_SOURCE_URL TICK_INGEST_URL TICK_INGEST_KEY \
      KEEPER_KEYPAIR PROGRAM_ID KEEPER_DEVNET_V21 KEEPER_ALERT_WEBHOOK_URL KEEPER_ALERT_TELEGRAM_BOT_TOKEN \
      KEEPER_ALERT_TELEGRAM_CHAT_ID DEVNET_RPC_ORIGIN HELIUS_MAINNET_RPC_URL DRY_RUN KEEPER_DRY_RUN

# --- optional: chart ticks to the LOCAL v2.2 price-ws only (v22price 2026-10-22). KEEPER_V22_TICK_INGEST=local posts every
#     landed push to http://127.0.0.1:${PRICE_WS_PORT:-8797}/ingest/ticks with the local key file; nothing else is ever
#     accepted here (the scrub above stays: no live ingest URL can be inherited). Default off.
if [[ "${KEEPER_V22_TICK_INGEST:-off}" == "local" && -s "$HOME/v22-price-ws/tick-ingest.key" ]]; then
  export TICK_INGEST_URL="http://127.0.0.1:${PRICE_WS_PORT:-8797}/ingest/ticks"
  TICK_INGEST_KEY="$(cat "$HOME/v22-price-ws/tick-ingest.key")"
  export TICK_INGEST_KEY
fi

# --- RPC key (runtime only; never echoed) ---
TOK="$HOME/.openclaw/credentials/deploy-tokens.env"
KEY="$(grep -E '^(export )?HELIUS_KEEPER_API_KEY=' "$TOK" | head -1 | sed -E 's/^(export )?HELIUS_KEEPER_API_KEY=//; s/^["'"'"']//; s/["'"'"']$//')"
[[ -n "$KEY" ]] || { echo "[fatal] HELIUS_KEEPER_API_KEY missing from $TOK" >&2; exit 1; }
export DEVNET_RPC_URL="https://devnet.helius-rpc.com/?api-key=${KEY}"
export MAINNET_RPC_URL="https://mainnet.helius-rpc.com/?api-key=${KEY}"
unset KEY

# --- fresh v2.2 programs, explicit (not in the SDK/keeper tables yet, hence the override flag) ---
export WRAPPER_PROGRAM_ID="5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"
export STAKE_PROGRAM_ID="A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE"
export KEEPER_NFT_PROGRAM_ID="DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs"
export MATCHER_PROGRAM_ID="DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam"
export KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1
# the keeper's id table names 5NGgnU2j "v2.1" (those ids were reserved for v2.1 and never deployed until 2026-11-06); the switch only
# selects that id set + a registry tagged "v21". The v2.2 behaviour is the KEEPER_V22_* flags below.
export KEEPER_DEVNET_V21=1
# GH#163: the SOL/USD reference is judged on symbol "SOL/USDC" only; WSOL-quoted pools need it. Pin it explicitly too (SOL/USDC DLMM).
export SOL_USD_REFERENCE_POOL="${SOL_USD_REFERENCE_POOL:-5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6}"
export PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE=1   # the SDK has its own env allowlist (WRAPPER/STAKE/NFT/MATCHER)
export KEEPER_KEYPAIR_PATH="$HOME/.config/solana/percolator-v17-devnet.json"   # FbTbDeGW... (shared with the live keeper)

# --- registry: file only. Supabase/register-poll are scrubbed above, so no other market can ever be admitted. ---
export REGISTRY_PATH="${REGISTRY_PATH:-$HERE/registry.v22fresh1106.json}"
export REGISTRY_RELOAD_INTERVAL_MS="${REGISTRY_RELOAD_INTERVAL_MS:-15000}"

# --- cadence: modest (the key is shared with the live keeper). 3000/17000 passes markCadenceCheck as "ok". ---
export CC_INTERVAL_MS="${CC_INTERVAL_MS:-3000}"
export CC_MARK_WINDOW_MS="${CC_MARK_WINDOW_MS:-17000}"
export CRANK_INTERVAL_MS="${CRANK_INTERVAL_MS:-20000}"
export CC_HEALTH_BIND="127.0.0.1"
export CC_HEALTH_PORT="${CC_HEALTH_PORT:-18799}"

# --- v2.2 layer (stake v5 sync, paired positioned sweep for the 4-leg cap, bond fee crank) ---
export KEEPER_V22="${KEEPER_V22:-on}"
export KEEPER_V22_SWEEP="${KEEPER_V22_SWEEP:-on}"
export KEEPER_V22_LIQUIDATE="${KEEPER_V22_LIQUIDATE:-on}"   # F1: liquidation crank in the same sweep tx as the refresh (simulate first, falls back to the plain refresh)
export KEEPER_V22_SETTLE_PAIRING="${KEEPER_V22_SETTLE_PAIRING:-prefer}"
export KEEPER_V22_FEE_CRANK_BOND="${KEEPER_V22_FEE_CRANK_BOND:-on}"
export KEEPER_V22_STAKE_SYNC="${KEEPER_V22_STAKE_SYNC:-on}"
export KEEPER_V22_TICK_MS="${KEEPER_V22_TICK_MS:-20000}"
# G8 depth push (44-byte PushAuthMark). ON 2026-10-14 after post-upgrade checks passed; set KEEPER_PUSH_DEPTH=off to revert.
export KEEPER_PUSH_DEPTH="${KEEPER_PUSH_DEPTH:-on}"
# off by default: rent, dust, G9, earn-exit (not part of a first bring-up)
# bigtest F2 latch fix: ON for the fresh set (Khubair GO 2026-11-06 06:23 GMT). The old :18797 keeper keeps it off.
export KEEPER_V22_LIQUIDATE_MATCH_VAULT_LP=on
export KEEPER_V22_ADL_WIND_DOWN=on
export KEEPER_V22_TICK_INGEST=off

if [[ "$MODE" == "dry" ]]; then
  export DRY_RUN=true KEEPER_V22_DRY_RUN=on
  export CC_HEALTH_PORT="${DRY_HEALTH_PORT:-18800}"
  export PREFLIGHT_ALLOW_EMPTY=1
fi

echo "[run-v22fresh] $(date -u +%Y-%m-%dT%H:%M:%SZ) mode=$MODE BUILDTAG=$BUILDTAG registry=$REGISTRY_PATH health=127.0.0.1:$CC_HEALTH_PORT pid=$$"
node --import tsx/esm scripts/preflight-v22fresh.ts
exec node --import tsx/esm src/cross-cluster.ts
