#!/usr/bin/env python3
"""Jade video fingerprint indexer.

Usage:
  vindex.py LOCAL_VIDEO REMOTE_PATH [--root REMOTE_ROOT]   index one downloaded video
  vindex.py status REMOTE_ROOT   < rclone-lsf-listing       plan: "<0|1>\\t<size>\\t<remote path>" (1 = already indexed)
  vindex.py prune REMOTE_ROOT [--force] < rclone-lsf-listing  drop entries of this folder that no longer exist
  vindex.py purge-crops                                     delete legacy crop fingerprints (crop_id>0) and shrink the file
  vindex.py forget-root REMOTE_ROOT                         drop every entry recorded for this folder
  vindex.py dbinfo                                          print a JSON summary of the database (used by /index-db)

Listings are `rclone lsf --recursive --files-only --format sp --separator <TAB>` output.
Database: $HOME/Jade/video-index.db (schema v3: integer ids, one 64-bit hash per row, per-video fingerprint version).
"""
import os
import re
import sys
import time
import hashlib
import sqlite3
import signal
import fcntl
import subprocess
import tempfile
import json
from contextlib import contextmanager

for _v in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_v, '1')          # keep numpy single-threaded (set before importing numpy)
import numpy as np

import jadefp

DB_DIR = os.path.join(os.path.expanduser('~'), 'Jade')
DB_PATH = os.path.join(DB_DIR, 'video-index.db')
LOCK_PATH = os.path.join(DB_DIR, 'indexer.lock')
VIDEO_EXTS = {
    '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.mpg', '.mpeg',
    '.ts', '.m2ts', '.wmv', '.flv', '.3gp', '.ogv', '.vob',
}
BATCH_SECONDS = int(os.environ.get('JADE_BATCH_SECONDS', '300'))   # also the resume checkpoint interval
# Machine-readable progress for the Node.js bot. Only emitted when the caller
# sets JADE_EVENTS=1, so running vindex.py by hand stays as readable as before.
EVENTS = os.environ.get('JADE_EVENTS') == '1'
PROGRESS_EVENT_SECONDS = 2.0      # at most one progress event per this many wall-clock seconds
# Crop-based fingerprints are intentionally disabled.
# Each sampled second stores exactly one full-frame fingerprint (crop_id=0).
PRUNE_GUARD_FRACTION = 0.5
# FFmpeg decoder threads used while sampling frames. 1 keeps the phone cool and leaves CPU free
# for other apps. 0 = let FFmpeg decide. Override with the JADE_FFMPEG_THREADS environment variable.
FFMPEG_THREADS = os.environ.get('JADE_FFMPEG_THREADS', '1')


# ----------------------------------------------------------------- remote paths
def split_remote(path):
    """('remote', 'folder/file') for rclone paths, (None, path) for local ones."""
    p = path.strip().replace('\\', '/')
    head, sep, rest = p.partition(':')
    if sep and head and '/' not in head:
        return head, re.sub(r'/+', '/', rest).strip('/')
    return None, (re.sub(r'/+', '/', p).rstrip('/') or p)


def normalize_remote(path):
    head, rest = split_remote(path)
    return f'{head}:{rest}' if head is not None else rest


def join_remote(root, rel):
    base = normalize_remote(root)
    rel = rel.replace('\\', '/').lstrip('/')
    if base.endswith(':') or base.endswith('/'):
        return base + rel
    return f'{base}/{rel}'


def filename_of(path):
    return split_remote(path)[1].rsplit('/', 1)[-1]


def video_key(path):
    return hashlib.sha256(normalize_remote(path).encode('utf-8')).hexdigest()


def root_key(root):
    return hashlib.sha256(('root:' + normalize_remote(root)).encode('utf-8')).hexdigest()


def is_video_name(name):
    return os.path.splitext(name)[1].lower() in VIDEO_EXTS


# --------------------------------------------------------------------- database
@contextmanager
def tx(conn, mode='BEGIN IMMEDIATE'):
    conn.execute(mode)
    try:
        yield
    except BaseException:
        conn.execute('ROLLBACK')
        raise
    else:
        conn.execute('COMMIT')


def hex2signed(text):
    return jadefp.to_signed(int(text, 16))


def create_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY,
        video_key TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        root_key TEXT,
        fpv INTEGER NOT NULL DEFAULT 1,
        remote_path TEXT,
        indexed_at INTEGER
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS fingerprints (
        vid INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        second INTEGER NOT NULL CHECK(second >= 0),
        crop_id INTEGER NOT NULL CHECK(crop_id BETWEEN 0 AND 15),
        phash INTEGER NOT NULL,
        PRIMARY KEY(vid, second, crop_id)
    ) WITHOUT ROWID''')
    # Checkpoints of a file that was interrupted part-way, so the next run can resume.
    conn.execute('''CREATE TABLE IF NOT EXISTS partial (
        video_key TEXT PRIMARY KEY,
        fpv INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        done_seconds INTEGER NOT NULL,
        flat INTEGER NOT NULL DEFAULT 0,
        remote_path TEXT
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS partial_fp (
        video_key TEXT NOT NULL,
        second INTEGER NOT NULL,
        crop_id INTEGER NOT NULL,
        phash INTEGER NOT NULL,
        PRIMARY KEY(video_key, second, crop_id)
    ) WITHOUT ROWID''')
    cols = {r[1] for r in conn.execute('PRAGMA table_info(videos)')}
    if 'fpv' not in cols:                    # database created before fingerprint versions
        conn.execute('ALTER TABLE videos ADD COLUMN fpv INTEGER NOT NULL DEFAULT 1')
    # Human-readable details for /index-db (older databases only know the hashed key and file name).
    if 'remote_path' not in cols:
        conn.execute('ALTER TABLE videos ADD COLUMN remote_path TEXT')
    if 'indexed_at' not in cols:
        conn.execute('ALTER TABLE videos ADD COLUMN indexed_at INTEGER')
    if 'remote_path' not in {r[1] for r in conn.execute('PRAGMA table_info(partial)')}:
        conn.execute('ALTER TABLE partial ADD COLUMN remote_path TEXT')
    conn.execute('CREATE INDEX IF NOT EXISTS videos_root_idx ON videos(root_key)')


def migrate_to_v3(conn):
    """Convert the text-id / band-column schema to the compact integer schema."""
    print('Migrating database to the compact schema (integer ids, no band indexes)...', flush=True)
    conn.execute('PRAGMA foreign_keys=OFF')
    try:
        conn.execute('BEGIN IMMEDIATE')
        try:
            cols = {r[1] for r in conn.execute('PRAGMA table_info(videos)')}
            if 'video_key' in cols:          # another process migrated first
                conn.execute('ROLLBACK')
                return
            for band in range(4):
                conn.execute(f'DROP INDEX IF EXISTS fingerprints_band{band}_idx')
            conn.execute('ALTER TABLE fingerprints RENAME TO fingerprints_old')
            conn.execute('ALTER TABLE videos RENAME TO videos_old')
            create_schema(conn)
            conn.execute('INSERT INTO videos(video_key, filename) SELECT video_id, filename FROM videos_old')
            conn.execute('''INSERT INTO fingerprints(vid, second, crop_id, phash)
                SELECT v.id, f.second, f.crop_id, hex2signed(f.phash)
                FROM fingerprints_old f JOIN videos v ON v.video_key = f.video_id''')
            conn.execute('DROP TABLE fingerprints_old')
            conn.execute('DROP TABLE videos_old')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise
    finally:
        conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('VACUUM')
    print('Migration complete. Legacy crop fingerprints are retained for compatibility; '
          'the matcher now uses only full-frame fingerprints (crop_id=0).', flush=True)


def init_schema(conn):
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'videos' in tables:
        cols = {r[1] for r in conn.execute('PRAGMA table_info(videos)')}
        if 'video_key' in cols:
            pass
        elif 'video_id' in cols and 'fingerprints' in tables:
            migrate_to_v3(conn)
        else:
            raise RuntimeError('Unrecognised database layout; refusing to modify it.')
    create_schema(conn)


def open_db():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=120, isolation_level=None)
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA journal_mode=WAL')       # searches (readers) no longer block index commits
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('PRAGMA temp_store=FILE')
    conn.execute('PRAGMA cache_size=-64000')
    conn.create_function('hex2signed', 1, hex2signed, deterministic=True)
    init_schema(conn)
    return conn


# ------------------------------------------------------------------ ffmpeg bits
def read_exact(pipe, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = pipe.read(size - len(chunks))
        if not part:
            break
        chunks.extend(part)
    return bytes(chunks)


def video_duration(path):
    """Container duration in seconds, or None. Used only to show a percentage."""
    try:
        p = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        value = float(json.loads(p.stdout)['format']['duration'])
        return value if value > 0 and value != float('inf') else None
    except Exception:
        return None


def emit_progress(**fields):
    """One JSON line prefixed with JADE_PROGRESS (flushed immediately)."""
    if not EVENTS:
        return
    payload = {'type': 'fingerprint'}
    payload.update({k: v for k, v in fields.items() if v is not None})
    try:
        print('JADE_PROGRESS ' + json.dumps(payload, separators=(',', ':')), flush=True)
    except Exception:
        pass                              # progress must never break indexing


def ffmpeg_full_frame(path, start=0):
    """Decode one 32x32 grayscale full-frame sample per second, beginning at `start` seconds."""
    seek = ['-ss', str(int(start))] if start > 0 else []      # input seek: must come before -i
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-threads', FFMPEG_THREADS,          # decoder threads (input option: must come before -i)
            '-filter_threads', FFMPEG_THREADS if FFMPEG_THREADS != '0' else '0',  # scale filter threads
            *seek,
            '-i', path,
            '-map', '0:v:0', '-an', '-sn', '-dn',
            '-vf', jadefp.VIDEO_FILTER,
            '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']


def stderr_tail(handle, limit=2000):
    handle.flush()
    size = handle.seek(0, os.SEEK_END)
    handle.seek(max(0, size - limit))
    return size, handle.read().decode('utf-8', errors='replace').strip()


def _terminate(_signum, _frame):
    raise SystemExit(143)


# --------------------------------------------------------------------- indexing
def index_video(local_path, remote_path, root=None):
    local_path = os.path.abspath(local_path)
    remote = normalize_remote(remote_path)
    key = video_key(remote)
    filename = filename_of(remote)
    rkey = root_key(root) if root else None

    os.makedirs(DB_DIR, exist_ok=True)
    with open(LOCK_PATH, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another Jade indexer is already running.', file=sys.stderr)
            return 2

        conn = open_db()
        conn.execute('''CREATE TEMP TABLE stage (
            second INTEGER NOT NULL, crop_id INTEGER NOT NULL, phash INTEGER NOT NULL,
            PRIMARY KEY(second, crop_id)) WITHOUT ROWID''')

        print(f'Indexing video: {filename}', flush=True)
        print(f'Remote identity: SHA-256 {key[:16]}…', flush=True)
        print('Fingerprint mode: full-frame only (1 fingerprint per sampled second)', flush=True)
        total_seconds = video_duration(local_path) if EVENTS else None

        # Resume: a previous run of this exact file (same remote path, same size, same
        # fingerprint version) that was interrupted leaves checkpoints behind.
        local_size = os.path.getsize(local_path)
        base = 0
        flat = 0
        saved = conn.execute('SELECT fpv, file_size, done_seconds, flat FROM partial WHERE video_key=?',
                             (key,)).fetchone()
        if saved and saved[0] == jadefp.FP_VERSION and saved[1] == local_size and saved[2] > 0:
            base, flat = saved[2], saved[3]
            conn.execute('INSERT INTO stage SELECT second, crop_id, phash FROM partial_fp '
                         'WHERE video_key=? AND second < ?', (key, base))
            print(f'Resuming from {base:,} s (checkpoint of an interrupted run).', flush=True)
        elif saved:
            with tx(conn):
                conn.execute('DELETE FROM partial WHERE video_key=?', (key,))
                conn.execute('DELETE FROM partial_fp WHERE video_key=?', (key,))
            print('Discarded an old checkpoint (file changed); starting from the beginning.', flush=True)
        emit_progress(processed_seconds=base, total_seconds=total_seconds, resumed=True if base > 0 else None)

        err = tempfile.TemporaryFile()        # a file, not a pipe: decode errors cannot block ffmpeg
        proc = subprocess.Popen(
            ffmpeg_full_frame(local_path, base),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err)
        frame_bytes = 32 * 32
        rows = []
        count = base
        started = time.monotonic()
        last_event = started

        def flush_rows(checkpoint=False):
            if not rows:
                return
            batch = list(rows)
            conn.execute('BEGIN')             # deferred: touches only the temp table
            conn.executemany('INSERT OR REPLACE INTO stage VALUES (?,?,?)', batch)
            conn.execute('COMMIT')
            rows.clear()
            if checkpoint:                    # persist progress so an interrupted run can resume
                with tx(conn):
                    conn.executemany('INSERT OR REPLACE INTO partial_fp VALUES (?,?,?,?)',
                                     [(key, sec, crop, ph) for sec, crop, ph in batch])
                    conn.execute(
                        'INSERT INTO partial(video_key, fpv, file_size, done_seconds, flat, remote_path) VALUES (?,?,?,?,?,?) '
                        'ON CONFLICT(video_key) DO UPDATE SET fpv=excluded.fpv, file_size=excluded.file_size, '
                        'done_seconds=excluded.done_seconds, flat=excluded.flat, remote_path=excluded.remote_path',
                        (key, jadefp.FP_VERSION, local_size, count, flat, remote))

        try:
            while True:
                raw = read_exact(proc.stdout, frame_bytes)
                if not raw:
                    break
                if len(raw) != frame_bytes:
                    raise RuntimeError('FFmpeg returned an incomplete frame.')
                frame = np.frombuffer(raw, dtype=np.uint8).reshape(32, 32)
                value = jadefp.phash_tile(frame)
                if value is None:
                    flat += 1
                else:
                    rows.append((count, 0, jadefp.to_signed(value)))
                count += 1
                if count % BATCH_SECONDS == 0:
                    flush_rows(checkpoint=True)
                    elapsed = max(0.001, time.monotonic() - started)
                    print(f'Processed {count:,} seconds ({(count - base) / elapsed:.2f} source-sec/sec)...', flush=True)
                if EVENTS:
                    now = time.monotonic()
                    if now - last_event >= PROGRESS_EVENT_SECONDS:
                        last_event = now
                        emit_progress(processed_seconds=count, total_seconds=total_seconds,
                                      speed=round((count - base) / max(0.001, now - started), 2))
            flush_rows()
            rc = proc.wait()
            size, tail = stderr_tail(err)
            if rc != 0:
                raise RuntimeError(tail or f'FFmpeg exited with status {rc}')
            if size:
                print(f'Warning: FFmpeg reported {size:,} bytes of decode messages '
                      f'(file may be damaged); indexed what could be read.', flush=True)
            if count == 0:                    # (a resumed run may legitimately find nothing left)
                raise RuntimeError('No frames could be extracted.')
            emit_progress(processed_seconds=count, total_seconds=total_seconds, final=True,
                          speed=round((count - base) / max(0.001, time.monotonic() - started), 2))
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        finally:
            if proc.stdout:
                proc.stdout.close()
            err.close()

        kept = conn.execute('SELECT COUNT(*) FROM stage').fetchone()[0]
        if kept == 0:
            raise RuntimeError('No distinctive frames found (the video looks blank).')

        # Replace any existing entry for this exact remote path only now that
        # the new fingerprints were extracted successfully.
        with tx(conn):
            conn.execute(
                'INSERT INTO videos(video_key, filename, root_key, fpv, remote_path, indexed_at) VALUES (?,?,?,?,?,?) '
                'ON CONFLICT(video_key) DO UPDATE SET filename=excluded.filename, '
                'root_key=COALESCE(excluded.root_key, videos.root_key), fpv=excluded.fpv, '
                'remote_path=excluded.remote_path, indexed_at=excluded.indexed_at',
                (key, filename, rkey, jadefp.FP_VERSION, remote, int(time.time())))
            vid = conn.execute('SELECT id FROM videos WHERE video_key=?', (key,)).fetchone()[0]
            conn.execute('DELETE FROM fingerprints WHERE vid=?', (vid,))
            conn.execute('INSERT INTO fingerprints(vid, second, crop_id, phash) '
                         'SELECT ?, second, crop_id, phash FROM stage', (vid,))
            conn.execute('DELETE FROM partial WHERE video_key=?', (key,))      # finished: drop checkpoints
            conn.execute('DELETE FROM partial_fp WHERE video_key=?', (key,))

        videos = conn.execute('SELECT COUNT(*) FROM videos').fetchone()[0]
        conn.close()
        print(f'Indexed {filename}: {count:,} sampled frames, {kept:,} full-frame fingerprints '
              f'({flat:,} flat frames skipped).', flush=True)
        print(f'Total indexed videos: {videos:,}', flush=True)
        print(f'Database: {DB_PATH}', flush=True)
        return 0


# --------------------------------------------------------------- folder helpers
def read_listing(root, stream):
    items = []
    for line in stream:
        line = line.rstrip('\r\n')
        if not line:
            continue
        size, sep, rel = line.partition('\t')
        if not sep:
            size, rel = '-1', line
        if is_video_name(rel):
            items.append((size, join_remote(root, rel)))
    return items


def _natural(text):
    """Case-insensitive key where digit runs compare as numbers (clip2 < clip10)."""
    return [(0, int(p), '') if p.isdigit() else (1, 0, p.casefold())
            for p in re.split(r'(\d+)', text) if p]


def alpha_key(item):
    """Alphabetical by folder, then file, one path component at a time."""
    rel = split_remote(item[1])[1]
    return [_natural(part) for part in rel.split('/')] + [[(2, 0, item[1])]]   # raw path breaks exact ties


def cmd_status(root):
    items = sorted(read_listing(root, sys.stdin), key=alpha_key)   # bulk indexing runs in this order
    conn = open_db()
    keys = {path: video_key(path) for _, path in items}
    indexed = set()
    wanted = list(set(keys.values()))
    for i in range(0, len(wanted), 500):
        part = wanted[i:i + 500]
        marks = ','.join('?' for _ in part)
        indexed.update(r[0] for r in conn.execute(
            f'SELECT video_key FROM videos WHERE fpv=? AND video_key IN ({marks})',
            [jadefp.FP_VERSION, *part]))
    # Entries indexed before folders were tracked get tagged with this folder,
    # so --prune can manage them.
    rkey = root_key(root)
    found = list(indexed)
    with tx(conn):
        for i in range(0, len(found), 500):
            part = found[i:i + 500]
            marks = ','.join('?' for _ in part)
            conn.execute(f'UPDATE videos SET root_key=? WHERE root_key IS NULL AND video_key IN ({marks})',
                         [rkey, *part])
        # Older entries only know a hashed key: fill in the readable path now that we have the listing.
        conn.executemany('UPDATE videos SET remote_path=? WHERE video_key=? AND remote_path IS NULL',
                         [(normalize_remote(path), keys[path]) for _, path in items if keys[path] in indexed])
    conn.close()
    out = sys.stdout
    for size, path in items:
        out.write(f'{1 if keys[path] in indexed else 0}\t{size}\t{path}\n')
    return 0


def cmd_dbinfo():
    """Print a JSON summary of the database in plain terms (file names, folders, durations)."""
    conn = open_db()
    sizes = {}
    for label, suffix in (('db', ''), ('wal', '-wal'), ('shm', '-shm')):
        try:
            sizes[label] = os.path.getsize(DB_PATH + suffix)
        except OSError:
            sizes[label] = 0
    seconds = dict(conn.execute('SELECT vid, COUNT(*) FROM fingerprints WHERE crop_id=0 GROUP BY vid'))
    fingerprints = conn.execute('SELECT COUNT(*) FROM fingerprints').fetchone()[0]

    def folder_of(path):
        return path.rsplit('/', 1)[0] if '/' in path else path.split(':', 1)[0] + ':'

    folders = {}
    unknown = outdated = total_seconds = 0
    recent = []
    rows = conn.execute('SELECT id, filename, remote_path, indexed_at, fpv FROM videos '
                        'ORDER BY COALESCE(indexed_at, 0) DESC, id DESC').fetchall()
    for vid, filename, path, at, fpv in rows:
        secs = seconds.get(vid, 0)
        total_seconds += secs
        if fpv != jadefp.FP_VERSION:
            outdated += 1
        folder = folder_of(path) if path else None
        if folder is None:
            unknown += 1
        else:
            entry = folders.setdefault(folder, [0, 0])
            entry[0] += 1
            entry[1] += secs
        if len(recent) < 8:
            recent.append({'name': filename, 'folder': folder, 'seconds': secs, 'at': at})

    unfinished = []
    for path, done in conn.execute('SELECT remote_path, done_seconds FROM partial ORDER BY done_seconds DESC'):
        unfinished.append({'name': filename_of(path) if path else None,
                           'folder': folder_of(path) if path else None, 'seconds': done})

    top = sorted(folders.items(), key=lambda kv: (-kv[1][0], kv[0]))
    json.dump({
        'bytes': sizes,
        'videos': len(rows),
        'seconds': total_seconds,
        'fingerprints': fingerprints,
        'unknown_paths': unknown,
        'outdated': outdated,
        'folders_total': len(top),
        'folders': [{'folder': f, 'videos': v[0], 'seconds': v[1]} for f, v in top[:8]],
        'recent': recent,
        'unfinished': unfinished[:5],
    }, sys.stdout)
    sys.stdout.write('\n')
    conn.close()
    return 0


def _delete_videos(conn, ids):
    with tx(conn):
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            marks = ','.join('?' for _ in part)
            conn.execute(f'DELETE FROM fingerprints WHERE vid IN ({marks})', part)
            conn.execute(f'DELETE FROM partial_fp WHERE video_key IN (SELECT video_key FROM videos WHERE id IN ({marks}))', part)
            conn.execute(f'DELETE FROM partial WHERE video_key IN (SELECT video_key FROM videos WHERE id IN ({marks}))', part)
            conn.execute(f'DELETE FROM videos WHERE id IN ({marks})', part)


def cmd_prune(root, force):
    items = read_listing(root, sys.stdin)
    if not items:
        print('Refusing to prune: the remote listing contains no videos.', file=sys.stderr)
        return 1
    present = {video_key(path) for _, path in items}
    conn = open_db()
    rows = conn.execute('SELECT id, video_key FROM videos WHERE root_key=?', (root_key(root),)).fetchall()
    stale = [vid for vid, key in rows if key not in present]
    if (not force and len(rows) >= 5 and len(stale) > PRUNE_GUARD_FRACTION * len(rows)):
        print(f'Refusing to prune {len(stale)} of {len(rows)} entries: that is more than '
              f'{int(PRUNE_GUARD_FRACTION * 100)}% of this folder. Check the folder path, '
              f'or re-run with --force.', file=sys.stderr)
        conn.close()
        return 1
    if stale:
        _delete_videos(conn, stale)
        conn.execute('VACUUM')
    conn.close()
    print(f'Pruned: {len(stale)}')
    return 0


def cmd_forget_root(root):
    conn = open_db()
    ids = [r[0] for r in conn.execute('SELECT id FROM videos WHERE root_key=?', (root_key(root),))]
    if ids:
        _delete_videos(conn, ids)
        conn.execute('VACUUM')
    conn.close()
    print(f'Removed {len(ids)} entries recorded for {normalize_remote(root)}')
    return 0


def cmd_purge_crops():
    conn = open_db()
    n = conn.execute('SELECT COUNT(*) FROM fingerprints WHERE crop_id>0').fetchone()[0]
    if n:
        with tx(conn):
            conn.execute('DELETE FROM fingerprints WHERE crop_id>0')
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        conn.execute('VACUUM')
    conn.close()
    print(f'Removed {n:,} legacy crop fingerprints.')
    return 0


# ------------------------------------------------------------------------ main
def main(argv):
    if argv and argv[0] == 'status' and len(argv) == 2:
        return cmd_status(argv[1])
    if argv and argv[0] == 'prune' and len(argv) in (2, 3):
        force = len(argv) == 3 and argv[2] == '--force'
        if len(argv) == 3 and not force:
            sys.exit(__doc__)
        return cmd_prune(argv[1], force)
    if argv and argv[0] == 'dbinfo' and len(argv) == 1:
        return cmd_dbinfo()
    if argv and argv[0] == 'purge-crops' and len(argv) == 1:
        return cmd_purge_crops()
    if argv and argv[0] == 'forget-root' and len(argv) == 2:
        return cmd_forget_root(argv[1])

    root = None
    args = list(argv)
    if '--root' in args:
        i = args.index('--root')
        if i + 1 >= len(args):
            sys.exit(__doc__)
        root = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        sys.exit(__doc__)
    signal.signal(signal.SIGTERM, _terminate)
    return index_video(args[0], args[1], root)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:
        print(f'INDEX ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
