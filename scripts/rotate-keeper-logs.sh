#!/bin/bash
# rotate-keeper-logs.sh — size-capped rotation for the launchd-supervised keeper.
#
# WHY COPY-TRUNCATE, NOT RENAME
# -----------------------------
# launchd opens StandardOutPath/StandardErrorPath itself and holds those file
# descriptors for the life of the process. Renaming the file would leave the
# keeper writing to an unlinked inode: the "rotated" file keeps growing,
# invisibly, and the new file stays empty until the next restart. Copying then
# truncating in place keeps the fd valid — the next append lands at offset 0.
#
# The tradeoff is a small race: anything written between the copy and the
# truncate is lost. For logs that is acceptable; for anything else it would not be.
#
# WHY THIS EXISTS
# ---------------
# keeper.err.log reached 641 MB with no rotation configured anywhere, growing
# ~20 MB/day. On the Mac mini that is a slow disk-fill with no alarm on it.
# Most of that volume is RPC 429 retry noise, which is tracked separately — but
# the missing rotation is its own defect and would bite on any other chatty
# failure, so it is fixed independently of the noise that exposed it.
set -euo pipefail

LOG_DIR="${LOG_DIR:-$(cd "$(dirname "$0")/.." && pwd)/logs}"
MAX_BYTES="${MAX_LOG_BYTES:-52428800}"   # 50 MiB
KEEP="${KEEP_GENERATIONS:-3}"

rotate_one() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local size
  size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)
  if (( size < MAX_BYTES )); then
    return 0
  fi
  # Shift older generations down: .2 -> .3, .1 -> .2
  for (( i=KEEP-1; i>=1; i-- )); do
    [[ -f "$f.$i" ]] && mv -f "$f.$i" "$f.$((i+1))"
  done
  cp "$f" "$f.1"
  : > "$f"          # truncate in place — keeps launchd's fd valid
  gzip -f "$f.1" 2>/dev/null || true
  echo "[rotate-logs] rotated $(basename "$f") at ${size} bytes"
}

for f in "$LOG_DIR"/keeper.out.log "$LOG_DIR"/keeper.err.log; do
  rotate_one "$f"
done

# Drop anything beyond the keep window.
find "$LOG_DIR" -name 'keeper.*.log.*' -type f 2>/dev/null \
  | sort -r | tail -n +$(( KEEP * 2 + 1 )) | xargs -r rm -f
