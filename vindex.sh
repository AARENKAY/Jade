#!/usr/bin/env bash
# Single-file indexer launcher. Database: $HOME/Jade/video-index.db
# Usage: bash vindex.sh LOCAL_VIDEO_FILE REMOTE_VIDEO_PATH
set -Eeuo pipefail

[[ $# -eq 2 ]] || { echo "Usage: $0 LOCAL_VIDEO_FILE REMOTE_VIDEO_PATH" >&2; exit 1; }
LOCAL_FILE="$1"
REMOTE_PATH="$2"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$LOCAL_FILE" && -s "$LOCAL_FILE" ]] || { echo "Video is missing or empty: $LOCAL_FILE" >&2; exit 1; }
for cmd in python ffmpeg ffprobe; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing $cmd. Install with: pkg install $([[ $cmd == python ]] && echo python || echo ffmpeg)" >&2; exit 1; }
done
python -c 'import numpy, sqlite3' >/dev/null 2>&1 || { echo "NumPy is missing. Install with: pkg install python-numpy" >&2; exit 1; }

exec python "$SCRIPT_DIR/vindex.py" "$LOCAL_FILE" "$REMOTE_PATH"
