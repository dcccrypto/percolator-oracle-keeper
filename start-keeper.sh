#!/bin/bash
# start-keeper.sh — launcher for the cross-cluster oracle keeper.
#
# WHY THIS EXISTS: neither src/cross-cluster.ts nor src/index.ts loads dotenv.
# They read process.env directly, so the .env file MUST be sourced by whatever
# starts them. Running `npm run cross-cluster:live` without sourcing .env fails
# immediately with "[fatal] MAINNET_RPC_URL is required".
#
# Keeping the env in .env (rather than duplicating it into the launchd plist)
# means there is exactly ONE copy of the keeper keypair path and RPC keys.
#
# Used by ~/Library/LaunchAgents/com.percolator.oracle-keeper.plist.

set -euo pipefail

# launchd gives a minimal PATH; node/npm live in Homebrew.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Disable tsx's on-disk transpile cache. The keeper runs via `tsx src/…`, and tsx
# caches transpiled output in $TMPDIR/tsx-<uid>/. That cache is keyed such that a
# plain restart can re-run STALE code after a source edit (the launchd process's
# $TMPDIR differs from an interactive shell's, so it's easy to "clear the cache"
# and still hit the stale one) — this silently cost a whole debugging session
# once. Boot transpile is ~1-3s and this keeper restarts rarely, so always
# transpiling fresh is a cheap guarantee that an edit + restart runs the new code.
export TSX_DISABLE_CACHE=1

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "[fatal] $(pwd)/.env not found — the keeper cannot start without it" >&2
  exit 1
fi

# Export every var defined in .env (the keeper reads process.env directly).
set -a
# shellcheck disable=SC1091
source .env
set +a

# Fail fast and loudly rather than letting launchd restart-loop on a silent
# misconfiguration. These are the two the cross-cluster entrypoint requires.
: "${MAINNET_RPC_URL:?[fatal] MAINNET_RPC_URL missing from .env}"
: "${DEVNET_RPC_URL:?[fatal] DEVNET_RPC_URL missing from .env}"

echo "[start-keeper] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting cross-cluster keeper (pid $$)"

# exec so launchd supervises node directly (correct KeepAlive semantics — no
# intermediate shell to mask exits).
exec npm run cross-cluster:live
