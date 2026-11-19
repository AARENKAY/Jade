#!/usr/bin/env bash
# Recursively index video files from an rclone remote, one at a time.
#
# Usage: bash vindex-folder.sh [--prune [--force]] 'remote:folder/path'
#   --prune   afterwards remove index entries of this folder whose files no longer exist
#   --force   let --prune remove more than half of the folder's entries
#
# Already-indexed files are detected by the same identity vindex.py uses, so a
# rerun skips finished files and retries failed ones. Stops promptly on SIGTERM/SIGINT.
#
# Progress reporting
#   Run by hand, it prints readable lines.
#   When JADE_EVENTS=1 (set by the Jade bot) every file-level event is printed as a
#   single line "JADE_EVENT {json}" instead, which the bot turns into terminal and
#   Discord progress. rclone's own transfer statistics (JSON log on stderr) and
#   vindex.py's "JADE_PROGRESS {json}" lines pass through untouched. Nothing here
#   ever modifies or deletes anything on the remote; only the temporary local
#   download is removed.
set -Eeuo pipefail

usage() {
  echo "Usage: bash vindex-folder.sh [--prune [--force]] 'remote:folder/path'" >&2
}

PRUNE=0
FORCE=0
ROOT_ARG=""
while (( $# )); do
  case "$1" in
    --prune) PRUNE=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *)
      if [[ -n "$ROOT_ARG" ]]; then usage; exit 2; fi
      ROOT_ARG="$1" ;;
  esac
  shift
done
if [[ -z "$ROOT_ARG" ]]; then usage; exit 2; fi

REMOTE_ROOT="${ROOT_ARG%/}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INDEXER="$SCRIPT_DIR/vindex.py"
JADE_DIR="${HOME}/Jade"
TMP_DIR="$JADE_DIR/tmp"
DB_PATH="$JADE_DIR/video-index.db"
MIN_FREE_MB="${VINDEX_MIN_FREE_MB:-200}"   # keep this much free space beyond each download
EVENTS="${JADE_EVENTS:-0}"
export JADE_EVENTS="$EVENTS" PYTHONUNBUFFERED=1   # vindex.py sees the same switch

# ---- progress helpers --------------------------------------------------------
# json_str TEXT -> TEXT escaped for use inside a JSON string.
json_str() {
  local s="$1" bs esc_bs esc_q
  printf -v bs '%s' '\'                 # exactly one backslash
  esc_bs="$bs$bs"
  esc_q="$bs\""
  s=${s//[[:cntrl:]]/ }                 # tabs, newlines and other control characters
  s=${s//"$bs"/"$esc_bs"}               # backslash first, then quotes
  s=${s//\"/"$esc_q"}
  printf '%s' "$s"
}
# json_num VALUE -> VALUE if it is a plain non-negative integer, otherwise null.
json_num() { if [[ "$1" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf 'null'; fi; }
# evt "human text" 'json body without braces'
# Prints the human text normally, or the JSON event when JADE_EVENTS=1.
evt() {
  if [[ "$EVENTS" == "1" ]]; then
    printf 'JADE_EVENT {%s}\n' "$2"
  else
    printf '%s\n' "$1"
  fi
}

declare -A PKG=([rclone]=rclone [python]=python [ffmpeg]=ffmpeg [ffprobe]=ffmpeg [flock]=util-linux [df]=coreutils [awk]=gawk)
for cmd in rclone python ffmpeg ffprobe flock df awk; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd. Install it with: pkg install ${PKG[$cmd]}" >&2; exit 1; }
done
[[ -f "$INDEXER" && -f "$SCRIPT_DIR/jadefp.py" ]] || { echo "Missing vindex.py or jadefp.py next to this script." >&2; exit 1; }
python -c 'import numpy, sqlite3' >/dev/null 2>&1 || {
  echo "Python NumPy is required. Install it with: pkg install python-numpy" >&2
  exit 1
}

mkdir -p "$JADE_DIR" "$TMP_DIR"
exec 9>"$JADE_DIR/bulk-index.lock"
if ! flock -n 9; then
  echo "Another bulk indexing run is already active." >&2
  exit 1
fi
# Leftovers from an earlier run that was killed (safe: we hold the bulk lock).
rm -f -- "$TMP_DIR"/vindex-bulk-* "$JADE_DIR"/remote-video-list.* "$JADE_DIR"/remote-video-plan.*

LIST_FILE="$(mktemp "$JADE_DIR/remote-video-list.XXXXXX")"
PLAN_FILE="$(mktemp "$JADE_DIR/remote-video-plan.XXXXXX")"
TEMP_FILE=""
CHILD_PID=""
HB_PID=""

# Removes this run's temporary download, including rclone's *.partial leftovers.
# Only files this process created (vindex-bulk-<pid>.*) are touched, locally.
remove_temp_download() {
  rm -f -- "$TMP_DIR"/vindex-bulk-$$.*
  TEMP_FILE=""
}

cleanup() {
  if [[ -n "$HB_PID" ]]; then kill -TERM "$HB_PID" 2>/dev/null || true; fi
  if [[ -n "$CHILD_PID" ]]; then kill -TERM "$CHILD_PID" 2>/dev/null || true; fi
  remove_temp_download
  rm -f -- "$LIST_FILE" "$PLAN_FILE"
}
on_signal() {
  echo "Interrupted; stopping." >&2
  exit 143            # the EXIT trap then runs cleanup
}
trap cleanup EXIT
trap on_signal INT TERM

# Run a command in the background and wait for it, so a signal is handled
# immediately instead of after the (possibly hours-long) command finishes.
run() {
  "$@" </dev/null 9>&- &       # children must not inherit the lock descriptor
  CHILD_PID=$!
  local rc=0
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  return "$rc"
}

evt "Scanning remote folder: $REMOTE_ROOT" \
  "\"type\":\"scan_start\",\"folder\":\"$(json_str "$REMOTE_ROOT")\""

# rclone lsf has no progress output of its own. It writes entries to the list
# file as it walks the folder, so a small heartbeat reports how many entries
# have been listed so far (a real count, not an estimate).
scan_heartbeat() {
  local n
  while true; do
    sleep 3 </dev/null >/dev/null 2>&1 || exit 0
    n="$(wc -l < "$LIST_FILE" 2>/dev/null || echo 0)"
    n=$(( n + 0 ))
    evt "  ...still scanning: $n entries listed so far" \
      "\"type\":\"scan_progress\",\"listed\":$n,\"stage\":\"listing\""
  done
}
scan_heartbeat 9>&- &
HB_PID=$!

if ! run rclone lsf "$REMOTE_ROOT" --contimeout 30s --timeout 90s --recursive --files-only --format sp --separator $'\t' > "$LIST_FILE"; then
  kill -TERM "$HB_PID" 2>/dev/null || true; wait "$HB_PID" 2>/dev/null || true; HB_PID=""
  echo "Could not list the remote folder. Check the remote name and rclone access." >&2
  exit 1
fi
kill -TERM "$HB_PID" 2>/dev/null || true
wait "$HB_PID" 2>/dev/null || true
HB_PID=""

LISTED=$(wc -l < "$LIST_FILE"); LISTED=$(( LISTED + 0 ))
evt "Listing finished: $LISTED entries. Checking which videos are already indexed..." \
  "\"type\":\"scan_progress\",\"listed\":$LISTED,\"stage\":\"checking\""

# One Python call decides which videos exist and which are already indexed.
# Output lines: <0 new|1 indexed> TAB <size> TAB <full remote path>
python "$INDEXER" status "$REMOTE_ROOT" < "$LIST_FILE" > "$PLAN_FILE"

TOTAL=$(wc -l < "$PLAN_FILE")
TOTAL=$(( TOTAL + 0 ))
ALREADY=$(awk -F'\t' '$1 == "1" { n++ } END { print n + 0 }' "$PLAN_FILE")
ALREADY=$(( ALREADY + 0 ))
if (( TOTAL == 0 )); then
  evt "No supported video files found in: $REMOTE_ROOT" \
    "\"type\":\"scan_done\",\"found\":0,\"indexed\":0"
  [[ "$EVENTS" == "1" ]] && echo "No supported video files found in: $REMOTE_ROOT"
  exit 0
fi

DONE=0
SKIPPED=0
FAILED=0
CURRENT=0
evt "$(printf 'Found %d video(s). Starting sequential indexing.' "$TOTAL")" \
  "\"type\":\"scan_done\",\"found\":$TOTAL,\"indexed\":$ALREADY"

while IFS=$'\t' read -r flag size remote; do
  [[ -n "$remote" ]] || continue
  ((CURRENT+=1))
  SHOWN="${remote#*:}"
  FILENAME="${remote##*/}"
  [[ "$remote" == */* ]] || FILENAME="${FILENAME#*:}"   # only root-level "remote:file.mp4" carries a prefix

  # Shared prefix of every per-file event.
  FILE_JSON="\"index\":$CURRENT,\"total\":$TOTAL,\"name\":\"$(json_str "$FILENAME")\",\"path\":\"$(json_str "$SHOWN")\""

  if [[ "$flag" == "1" ]]; then
    ((SKIPPED+=1))
    evt "$(printf '[%d/%d] SKIP  %s (already indexed)' "$CURRENT" "$TOTAL" "$SHOWN")" \
      "\"type\":\"skip\",$FILE_JSON"
    continue
  fi
  if [[ "$remote" == -* ]]; then
    ((FAILED+=1))
    evt "$(printf '[%d/%d] FAIL  Unsafe path skipped: %s' "$CURRENT" "$TOTAL" "$SHOWN")" \
      "\"type\":\"file_failed\",$FILE_JSON,\"stage\":\"precheck\",\"error\":\"Unsafe path skipped\""
    continue
  fi

  # Make sure the download fits before spending time on it.
  if [[ "$size" =~ ^[0-9]+$ ]]; then
    AVAIL_KB="$(df -Pk "$TMP_DIR" | awk 'NR==2 {print $4}')"
    NEED_KB=$(( size / 1024 + MIN_FREE_MB * 1024 ))
    if [[ "$AVAIL_KB" =~ ^[0-9]+$ ]] && (( AVAIL_KB < NEED_KB )); then
      ((FAILED+=1))
      SPACE_MSG="$(printf 'Not enough free space for %s (needs about %d MB plus %d MB spare, %d MB free)' \
        "$SHOWN" $(( size / 1048576 )) "$MIN_FREE_MB" $(( AVAIL_KB / 1024 )))"
      evt "$(printf '[%d/%d] FAIL  %s' "$CURRENT" "$TOTAL" "$SPACE_MSG")" \
        "\"type\":\"file_failed\",$FILE_JSON,\"stage\":\"precheck\",\"error\":\"$(json_str "$SPACE_MSG")\""
      continue
    fi
  fi

  EXT="${FILENAME##*.}"
  EXT="${EXT,,}"
  remove_temp_download
  TEMP_FILE="$TMP_DIR/vindex-bulk-$$.$EXT"
  evt "$(printf '[%d/%d] GET   %s' "$CURRENT" "$TOTAL" "$SHOWN")" \
    "\"type\":\"download_start\",$FILE_JSON,\"size\":$(json_num "$size")"

  # Events mode: rclone prints its statistics as JSON lines on stderr (raw byte
  # counts, speed, ETA) which the bot parses. By hand: rclone's one-line stats.
  if [[ "$EVENTS" == "1" ]]; then
    RCLONE_STATS=(--stats 2s --use-json-log --stats-log-level NOTICE --contimeout 30s --timeout 90s)
  else
    RCLONE_STATS=(--stats 10s --stats-one-line --stats-log-level NOTICE --contimeout 30s --timeout 90s)
  fi

  if ! run rclone copyto "$remote" "$TEMP_FILE" "${RCLONE_STATS[@]}"; then
    evt "       FAIL  Download failed: $SHOWN" \
      "\"type\":\"file_failed\",$FILE_JSON,\"stage\":\"download\",\"error\":\"Download failed\""
    ((FAILED+=1))
    remove_temp_download
    continue
  fi
  if [[ ! -s "$TEMP_FILE" ]]; then
    evt "       FAIL  Download was empty: $SHOWN" \
      "\"type\":\"file_failed\",$FILE_JSON,\"stage\":\"download\",\"error\":\"Download was empty\""
    ((FAILED+=1))
    remove_temp_download
    continue
  fi
  GOT_BYTES=$(wc -c < "$TEMP_FILE"); GOT_BYTES=$(( GOT_BYTES + 0 ))
  evt "       DOWNLOADED $FILENAME ($GOT_BYTES bytes)" \
    "\"type\":\"download_done\",$FILE_JSON,\"bytes\":$GOT_BYTES"

  evt "       INDEX $FILENAME" "\"type\":\"fingerprint_start\",$FILE_JSON"
  if run python "$INDEXER" "$TEMP_FILE" "$remote" --root "$REMOTE_ROOT"; then
    ((DONE+=1))
    evt "       DONE  $FILENAME" "\"type\":\"file_done\",$FILE_JSON"
  else
    ((FAILED+=1))
    evt "       FAIL  Indexing failed: $SHOWN" \
      "\"type\":\"file_failed\",$FILE_JSON,\"stage\":\"fingerprint\",\"error\":\"Indexing failed\""
  fi
  remove_temp_download
done < "$PLAN_FILE"

if [[ "$EVENTS" == "1" ]]; then
  printf 'JADE_EVENT {"type":"summary","total":%d,"indexed":%d,"skipped":%d,"failed":%d}\n' \
    "$TOTAL" "$DONE" "$SKIPPED" "$FAILED"
fi
printf '\nBulk indexing finished.\nIndexed this run: %d\nAlready indexed: %d\nFailed: %d\nTotal videos found: %d\n' \
  "$DONE" "$SKIPPED" "$FAILED" "$TOTAL"

if (( PRUNE )); then
  PRUNE_ARGS=(prune "$REMOTE_ROOT")
  if (( FORCE )); then PRUNE_ARGS+=(--force); fi
  python "$INDEXER" "${PRUNE_ARGS[@]}" < "$LIST_FILE" || echo "Pruning skipped (see the message above)."
fi

printf 'Database: %s\n' "$DB_PATH"
if (( FAILED > 0 )); then
  echo "Rerun the same command to retry failures. Successfully indexed videos will be skipped."
fi
