#!/usr/bin/env bash
# Interactive launcher for the Jade video matcher.
set -Eeuo pipefail

DB_PATH="$HOME/Jade/video-index.db"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MATCHER="$SCRIPT_DIR/vget.py"

for cmd in python ffmpeg; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing $cmd. Install it with pkg." >&2; exit 1; }
done
python -c 'import numpy, sqlite3' >/dev/null 2>&1 || { echo "NumPy missing. Install with: pkg install python-numpy" >&2; exit 1; }
[[ -f "$DB_PATH" ]] || { echo "Database not found: $DB_PATH" >&2; exit 1; }
[[ -f "$MATCHER" && -f "$SCRIPT_DIR/jadefp.py" ]] || { echo "vget.py or jadefp.py not found next to this script." >&2; exit 1; }

printf 'Query video path: '
IFS= read -r QUERY_PATH
[[ -f "$QUERY_PATH" ]] || { echo "Query video not found." >&2; exit 1; }

printf 'Hamming threshold [16]: '
IFS= read -r THRESHOLD
THRESHOLD="${THRESHOLD:-16}"
[[ "$THRESHOLD" =~ ^[0-9]+$ ]] && (( THRESHOLD <= 64 )) || { echo "Threshold must be 0-64." >&2; exit 1; }

printf 'Query seconds [30]: '
IFS= read -r SECONDS_TO_SCAN
SECONDS_TO_SCAN="${SECONDS_TO_SCAN:-30}"
[[ "$SECONDS_TO_SCAN" =~ ^[0-9]+$ ]] && (( SECONDS_TO_SCAN > 0 )) || { echo "Seconds must be a positive integer." >&2; exit 1; }

printf 'Minimum matching seconds [auto]: '
IFS= read -r MIN_HITS
MIN_HITS="${MIN_HITS:-0}"
[[ "$MIN_HITS" =~ ^[0-9]+$ ]] || { echo "Minimum matching seconds must be a number." >&2; exit 1; }

exec python "$MATCHER" "$QUERY_PATH" --db "$DB_PATH" --threshold "$THRESHOLD" --seconds "$SECONDS_TO_SCAN" --min-hits "$MIN_HITS" --details
