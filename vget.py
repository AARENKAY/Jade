#!/usr/bin/env python3
"""Read-only matcher for the Jade video index.

Searches a query clip against every stored fingerprint with an exact
(brute-force, NumPy) Hamming comparison, then votes on (video, time offset).
A video is only reported when enough different seconds of the clip agree on
the same offset, so one chance frame match never produces a result.

Results print filenames only.
"""
import os
import re
import ast
import sys
import json
import time
import shutil
import sqlite3
import argparse
import tempfile
import subprocess

import numpy as np

import jadefp

DEFAULT_DB = os.path.join(os.path.expanduser('~'), 'Jade', 'video-index.db')
MAX_QUERY_SECONDS = 30
FFMPEG_TIMEOUT = 180           # seconds; a hung or hostile file cannot block the bot forever
DEFAULT_THRESHOLD = 16
IMAGE_THRESHOLD = 12           # a single frame has no voting to protect it, so it must be a closer match
FFMPEG_THREADS = os.environ.get('JADE_FFMPEG_THREADS', '1')
MAX_IMAGE_PIXELS = 40_000_000  # refuse bigger screenshots before decoding (decompression bombs)
IMAGE_TOP_RESULTS = 5
CROP_PROBE_SIZE = 256          # clips are viewed at this many pixels square to find black bars
TOP_RESULTS = 10
CHUNK_ROWS = 1_000_000
CACHE_BATCH = 500_000
RELATIVE_CUTOFF = 0.5          # keep results with >= 50% of the best video's votes
# Clip scoring is tuned in settings.py (FULL_CREDIT_BITS, ZERO_CREDIT_BITS, MIN_EVIDENCE_SECONDS), the same
# file the bot's /settings command edits; nothing is built in here. A second does not count as a plain
# yes/no vote: how CLOSE its best frame is decides how much it counts (full credit at FULL_CREDIT_BITS or
# closer, none at ZERO_CREDIT_BITS or further, partial in between). A clip with fewer usable seconds than
# MIN_EVIDENCE_SECONDS cannot reach 100%.
SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'settings.py')
SCORING_KEYS = ('FULL_CREDIT_BITS', 'ZERO_CREDIT_BITS', 'MIN_EVIDENCE_SECONDS')


# ------------------------------------------------------------------ query side
def load_scoring(path=SETTINGS_FILE):
    """Read the clip-scoring values from settings.py WITHOUT running it. Returns (full, zero, min_evidence)."""
    try:
        with open(path, encoding='utf8') as handle:
            tree = ast.parse(handle.read())
    except OSError:
        sys.exit(f'settings.py not found next to vget.py ({path}). Clip scoring is configured there.')
    except SyntaxError as error:
        sys.exit(f'settings.py could not be read (line {error.lineno}).')
    values = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Constant)):
            values[node.targets[0].id] = node.value.value
    missing = [key for key in SCORING_KEYS if not isinstance(values.get(key), int) or isinstance(values.get(key), bool)]
    if missing:
        sys.exit('settings.py is missing a whole number for: ' + ', '.join(missing))
    full, zero, minimum = (values[key] for key in SCORING_KEYS)
    if not (0 <= full < zero <= 64):
        sys.exit('settings.py: FULL_CREDIT_BITS must be lower than ZERO_CREDIT_BITS (both between 0 and 64).')
    if not 1 <= minimum <= 30:
        sys.exit('settings.py: MIN_EVIDENCE_SECONDS must be between 1 and 30.')
    return full, zero, minimum


def _ffmpeg_clip(path, seconds, vf, size, pix_fmt='gray'):
    """Decodes the first `seconds` of the clip through the filter `vf`; returns the raw bytes."""
    proc = subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-protocol_whitelist', 'file,pipe',      # a crafted upload must not make ffmpeg open URLs
        '-threads', FFMPEG_THREADS, '-filter_threads', FFMPEG_THREADS, '-i', path,
        '-t', str(seconds), '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', vf, '-f', 'rawvideo',
        '-pix_fmt', pix_fmt, 'pipe:1'
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=FFMPEG_TIMEOUT)
    if proc.returncode:
        raise RuntimeError(proc.stderr.decode('utf-8', errors='replace').strip() or 'FFmpeg failed')
    return proc.stdout


# Orientations tried (in this order) only when the clip as given finds nothing.
# Each maps a 32x32 tile to what the tile would look like with the frame edited that way.
ORIENTATIONS = (
    ('flipped left-right', lambda t: t[:, ::-1]),
    ('flipped upside-down', lambda t: t[::-1, :]),
    ('rotated 180 degrees', lambda t: t[::-1, ::-1]),
)


def _hashes_from_raw(raw, orient=None):
    """32x32 tiles -> [(second, hash)]. `orient` is one of the ORIENTATIONS functions (None = as is)."""
    frame_bytes = 1024
    total = len(raw) // frame_bytes
    hashes = []
    for qi in range(total):
        tile = np.frombuffer(raw[qi * frame_bytes:(qi + 1) * frame_bytes], dtype=np.uint8)
        if orient is not None:
            tile = np.ascontiguousarray(orient(tile.reshape(32, 32)))
        value = jadefp.phash_tile(tile)
        if value is not None:
            hashes.append((qi, value))
    return hashes, total


def find_clip_crop(path, seconds):
    """Black bars of a screen recording (pillarbox left/right, letterbox top/bottom).

    Returns (x, y, w, h) as fractions of the frame, or None when there is nothing to trim.
    A column/row only counts as a bar when it is dark in EVERY sampled second, so a dark
    scene (which brightens later) is never mistaken for a bar."""
    n = CROP_PROBE_SIZE
    raw = _ffmpeg_clip(path, seconds, f'fps=1,scale={n}:{n}:flags=area,format=gray', n)
    frames = len(raw) // (n * n)
    if frames == 0:
        return None
    g = np.frombuffer(raw[:frames * n * n], dtype=np.uint8).reshape(frames, n, n)
    col_level = g.mean(axis=1).max(axis=0)        # per column: brightest it ever gets (mean of the column)
    row_level = g.mean(axis=2).max(axis=0)
    cols = np.flatnonzero(col_level >= BORDER_DARK)
    rows = np.flatnonzero(row_level >= BORDER_DARK)
    if cols.size == 0 or rows.size == 0:
        return None
    c0, c1, r0, r1 = int(cols[0]), int(cols[-1]) + 1, int(rows[0]), int(rows[-1]) + 1
    if (c1 - c0) * (r1 - r0) < MIN_KEEP_FRACTION * n * n:
        return None                                # would throw away too much: not plausible bars
    if c0 == 0 and r0 == 0 and c1 == n and r1 == n:
        return None                                # no bars
    return c0 / n, r0 / n, (c1 - c0) / n, (r1 - r0) / n


def extract_query(path, seconds):
    """Returns (hashes, total_seconds, variants): hashes = [(second, hash)] without flat frames.

    The clip is hashed as it is, and, when it has black bars (a screen recording of a video player),
    hashed again with the bars cropped off. Both sets are searched: dark edges may be real picture
    content (whole frame) or bars (trimmed). A second may therefore appear twice; the ranking keeps
    only the closest hash per second, so nothing is counted double.

    `variants` = [(label, hashes)] for the same frames flipped left-right, flipped upside-down and
    rotated 180 degrees. They are only searched when the normal search finds nothing (a flipped
    re-upload), so normal lookups cost the same."""
    raws = [_ffmpeg_clip(path, seconds, jadefp.VIDEO_FILTER, 32)]
    try:
        box = find_clip_crop(path, seconds)
        if box:
            x, y, w, h = box
            crop = f'crop=iw*{w:.5f}:ih*{h:.5f}:iw*{x:.5f}:ih*{y:.5f}'
            raws.append(_ffmpeg_clip(path, seconds, f'{crop},{jadefp.VIDEO_FILTER}', 32))
    except (RuntimeError, subprocess.TimeoutExpired):
        pass                                       # the untrimmed search still works without the bar check
    hashes, total = _hashes_from_raw(raws[0])
    for raw in raws[1:]:
        hashes = hashes + _hashes_from_raw(raw)[0]
    variants = []
    for label, orient in ORIENTATIONS:
        variant = []
        for raw in raws:
            variant = variant + _hashes_from_raw(raw, orient)[0]
        variants.append((label, variant))
    return hashes, total, variants


# ------------------------------------------------------------- filename lookup
def find_filenames(db_path, term):
    """Filenames in the index that contain the code `term`, ignoring case and separators.

    "SL-341" also finds sl341 / SL_341 / SL 341, but not SL-3410 or XSL-341."""
    tokens = re.findall(r'[A-Za-z]+|\d+', term)
    if not tokens:
        return []
    tail = r'(?!\d)' if tokens[-1].isdigit() else r'(?![A-Za-z])'
    pattern = re.compile(r'(?<![A-Za-z0-9])' + r'[\W_]*'.join(re.escape(t) for t in tokens) + tail, re.IGNORECASE)
    db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=30)
    try:
        return [name for (name,) in db.execute('SELECT filename FROM videos ORDER BY filename') if pattern.search(name)]
    finally:
        db.close()


# ------------------------------------------------------------ screenshot query
IMAGE_WORK_WIDTH = 1024        # screenshots are shrunk to at most this wide before analysis
BORDER_DARK = 14               # rows/columns whose average brightness is below this are black bars
MIN_KEEP_FRACTION = 0.25       # never trim away more than 75% of the image


def _run_ffmpeg(args, data=None):
    proc = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin' if data is None else '-y',
                           '-protocol_whitelist', 'file,pipe', *args],
                          input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=FFMPEG_TIMEOUT)
    if proc.returncode:
        raise RuntimeError(proc.stderr.decode('utf-8', errors='replace').strip() or 'FFmpeg failed')
    return proc.stdout


def _trim_dark_borders(gray):
    """Crops black letterbox/pillarbox bars (typical in screenshots of a video player)."""
    h, w = gray.shape
    rows = np.flatnonzero(gray.mean(axis=1) >= BORDER_DARK)
    cols = np.flatnonzero(gray.mean(axis=0) >= BORDER_DARK)
    if rows.size == 0 or cols.size == 0:
        return gray
    cropped = gray[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    if cropped.size < MIN_KEEP_FRACTION * gray.size:
        return gray
    return cropped


def _tile_gray(gray):
    """The 32x32 tile (flat uint8) a grey picture is fingerprinted from."""
    ch, cw = gray.shape
    tile = _run_ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', f'{cw}x{ch}', '-i', 'pipe:0',
                        '-vf', 'scale=32:32:flags=area,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
                       data=np.ascontiguousarray(gray).tobytes())
    return np.frombuffer(tile, dtype=np.uint8)


def _hash_tile(tile, orient=None):
    """Fingerprint of a tile, optionally as it would look flipped/rotated (an ORIENTATIONS function)."""
    if orient is not None:
        tile = np.ascontiguousarray(orient(tile.reshape(32, 32)))
    return jadefp.phash_tile(tile)


def extract_image_hashes(path):
    """Hashes to try for a screenshot: the whole image, and the image with black bars trimmed, each
    also as it would look flipped left-right, flipped upside-down and rotated 180 degrees.

    Both crops are searched because dark edges may be real picture content (whole image) or
    letterbox bars from a player (trimmed). All orientations are searched at once: a single frame is
    cheap to compare, and the closest one wins. Empty list if the image is too flat."""
    probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                           timeout=60)
    try:
        w, h = (int(x) for x in probe.stdout.strip().split('\n')[0].split(',')[:2])
    except (ValueError, IndexError):
        raise RuntimeError('That does not look like a readable image.')
    if w <= 0 or h <= 0 or w * h > MAX_IMAGE_PIXELS:
        raise RuntimeError('That image is too large to search (over 40 megapixels).')
    w2 = min(IMAGE_WORK_WIDTH, w)
    h2 = max(1, round(h * w2 / w))
    raw = _run_ffmpeg(['-i', path, '-frames:v', '1', '-vf', f'scale={w2}:{h2}:flags=area,format=gray',
                       '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
    if len(raw) != w2 * h2:
        raise RuntimeError('The image could not be decoded.')
    full = np.frombuffer(raw, dtype=np.uint8).reshape(h2, w2)
    trimmed = _trim_dark_borders(full)
    crops = [full] if trimmed.shape == full.shape else [full, trimmed]
    values = []
    for crop in crops:
        tile = _tile_gray(crop)
        for orient in [None] + [fn for _, fn in ORIENTATIONS]:
            values.append(_hash_tile(tile, orient))
    return list(dict.fromkeys(v for v in values if v is not None))


def search_image(vid, sec, ph, values, threshold):
    """Closest stored frame per video (best of all candidate hashes) -> [(video, second, distance)] best first."""
    parts = []
    for start in range(0, len(ph), CHUNK_ROWS):
        h = np.asarray(ph[start:start + CHUNK_ROWS])
        for value in values:
            dist = jadefp.popcount64(h ^ np.uint64(value))
            idx = np.flatnonzero(dist <= threshold)
            if idx.size:
                parts.append((np.asarray(vid[start:start + CHUNK_ROWS])[idx].astype(np.int64),
                              np.asarray(sec[start:start + CHUNK_ROWS])[idx].astype(np.int64),
                              dist[idx].astype(np.int64)))
    if not parts:
        return []
    V, S, D = (np.concatenate(col) for col in zip(*parts))
    order = np.lexsort((S, D, V))                      # per video: lowest distance, then earliest second
    V, S, D = V[order], S[order], D[order]
    first = np.ones(len(V), dtype=bool)
    first[1:] = V[1:] != V[:-1]
    V, S, D = V[first], S[first], D[first]
    best = np.lexsort((S, D))
    return [(int(V[i]), int(S[i]), int(D[i])) for i in best]


# ----------------------------------------------------------------- cache layer
def db_signature(db_path):
    # The database runs in WAL mode, so new data may sit in the -wal file while
    # the main file is unchanged; include both.
    sig = []
    for suffix in ('', '-wal'):
        try:
            st = os.stat(db_path + suffix)
            sig += [st.st_mtime_ns, st.st_size]
        except OSError:
            sig += [0, 0]
    return sig + [5, jadefp.FP_VERSION]


def _empty_arrays():
    return (np.empty(0, np.int32), np.empty(0, np.int32), np.empty(0, np.uint64))


def build_cache(db_path, cache_dir, signature):
    os.makedirs(cache_dir, exist_ok=True)
    db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=60)
    total = db.execute('SELECT COUNT(*) FROM fingerprints f JOIN videos v ON v.id=f.vid '
                       'WHERE f.crop_id=0 AND v.fpv=?', (jadefp.FP_VERSION,)).fetchone()[0]
    if total == 0:
        db.close()
        return _empty_arrays()
    tmp = tempfile.mkdtemp(dir=cache_dir, prefix='build-')
    try:
        fmt = np.lib.format
        vid = fmt.open_memmap(os.path.join(tmp, 'vid.npy'), mode='w+', dtype=np.int32, shape=(total,))
        sec = fmt.open_memmap(os.path.join(tmp, 'sec.npy'), mode='w+', dtype=np.int32, shape=(total,))
        ph = fmt.open_memmap(os.path.join(tmp, 'hash.npy'), mode='w+', dtype=np.uint64, shape=(total,))
        pos = 0
        cur = db.execute('SELECT f.vid, f.second, f.phash FROM fingerprints f JOIN videos v ON v.id=f.vid '
                         'WHERE f.crop_id=0 AND v.fpv=?', (jadefp.FP_VERSION,))
        while True:
            rows = cur.fetchmany(CACHE_BATCH)
            if not rows:
                break
            block = np.array(rows, dtype=np.int64)
            n = len(block)
            if pos + n > total:
                raise RuntimeError('The database changed while it was being read; please retry.')
            vid[pos:pos + n] = block[:, 0]
            sec[pos:pos + n] = block[:, 1]
            ph[pos:pos + n] = np.ascontiguousarray(block[:, 2]).view(np.uint64)
            pos += n
        if pos != total:
            raise RuntimeError('The database changed while it was being read; please retry.')
        for m in (vid, sec, ph):
            m.flush()
        del vid, sec, ph
        db.close()
        for name in ('vid', 'sec', 'hash'):
            os.replace(os.path.join(tmp, name + '.npy'), os.path.join(cache_dir, name + '.npy'))
        meta_tmp = os.path.join(tmp, 'meta.json')
        with open(meta_tmp, 'w') as handle:
            json.dump({'sig': signature, 'rows': total}, handle)
        os.replace(meta_tmp, os.path.join(cache_dir, 'meta.json'))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return load_cache_files(cache_dir)


def load_cache_files(cache_dir):
    return tuple(np.load(os.path.join(cache_dir, name + '.npy'), mmap_mode='r')
                 for name in ('vid', 'sec', 'hash'))


def load_fingerprints(db_path, quiet):
    cache_dir = os.path.join(os.path.dirname(db_path), 'cache')
    signature = db_signature(db_path)
    try:
        with open(os.path.join(cache_dir, 'meta.json')) as handle:
            meta = json.load(handle)
        if meta.get('sig') == signature:
            return load_cache_files(cache_dir)
    except (OSError, ValueError):
        pass
    if not quiet:
        print('Refreshing search cache (first search after indexing)...', flush=True)
    return build_cache(db_path, cache_dir, signature)


# ------------------------------------------------------------------- searching
def find_hits(vid, sec, ph, hashes, threshold, quiet):
    total = len(ph)
    queries = [(qi, np.uint64(value)) for qi, value in hashes]
    parts = []
    for start in range(0, total, CHUNK_ROWS):
        h = np.asarray(ph[start:start + CHUNK_ROWS])
        v = None
        for qi, q in queries:
            idx = np.flatnonzero(jadefp.popcount64(h ^ q) <= threshold)
            if idx.size == 0:
                continue
            if v is None:
                v = np.asarray(vid[start:start + CHUNK_ROWS])
                s = np.asarray(sec[start:start + CHUNK_ROWS])
            dist = jadefp.popcount64(h[idx] ^ q).astype(np.int64)
            parts.append((v[idx].astype(np.int64), s[idx].astype(np.int64) - qi,
                          np.full(idx.size, qi, dtype=np.int64), dist))
        if not quiet:
            print(f'\rSearched {min(start + CHUNK_ROWS, total):,}/{total:,} fingerprints', end='', flush=True)
    if not quiet:
        print()
    if not parts:
        return None
    return tuple(np.concatenate(col) for col in zip(*parts))


def rank_videos(hits, scoring):
    """hits = (video, offset, query_second, distance) -> [(video, score, mean_distance, offset)] best first.
    score = seconds of the clip that agree, each weighted by how close its best frame is (0 to 1).
    offset is where the start of the query clip sits in the video, in seconds (approximate: +-1 s)."""
    V, O, Q, D = hits
    full_bits, zero_bits, _ = scoring
    # A frame sampled at a slightly different instant lands one second off, so every
    # hit also votes for the neighbouring offset window (offset-1, offset).
    V = np.concatenate([V, V])
    O = np.concatenate([O, O - 1])
    Q = np.concatenate([Q, Q])
    D = np.concatenate([D, D])
    order = np.lexsort((D, Q, O, V))
    V, O, Q, D = V[order], O[order], Q[order], D[order]
    keep = np.ones(len(V), dtype=bool)                     # best distance per (video, offset, second)
    keep[1:] = (V[1:] != V[:-1]) | (O[1:] != O[:-1]) | (Q[1:] != Q[:-1])
    V, O, Q, D = V[keep], O[keep], Q[keep], D[keep]
    start = np.ones(len(V), dtype=bool)
    start[1:] = (V[1:] != V[:-1]) | (O[1:] != O[:-1])
    gid = np.cumsum(start) - 1
    credit = np.clip((zero_bits - D) / (zero_bits - full_bits), 0.0, 1.0)
    votes = np.bincount(gid, weights=credit)                # closeness-weighted seconds, not a plain count
    mean = np.bincount(gid, weights=D) / np.bincount(gid)
    gV = V[start]
    gO = O[start]
    best = np.lexsort((mean, -votes))                      # most votes, then lowest distance
    _, first = np.unique(gV[best], return_index=True)
    pick = best[np.sort(first)]                            # one group per video, still ranked
    return [(int(gV[i]), float(votes[i]), float(mean[i]), int(gO[i])) for i in pick]


def main():
    parser = argparse.ArgumentParser(description='Search a query clip against Jade video fingerprints')
    parser.add_argument('query', nargs='?', help='Query video path')
    parser.add_argument('--db', default=DEFAULT_DB, help='SQLite database path')
    parser.add_argument('--threshold', type=int, default=None,
                        help=f'Hamming threshold 0-64 (default {DEFAULT_THRESHOLD} for video, {IMAGE_THRESHOLD} for images)')
    parser.add_argument('--seconds', type=int, default=MAX_QUERY_SECONDS, help='Query duration to analyse')
    parser.add_argument('--min-hits', type=int, default=0,
                        help='Seconds of the clip that must agree (default: auto, about 20%% of the clip, at least 3)')
    parser.add_argument('--find', metavar='CODE',
                        help='Only check whether a code such as SL-341 appears in an indexed filename (prints matching names)')
    parser.add_argument('--image', action='store_true',
                        help='The query is a screenshot/image, not a video (single-frame search)')
    parser.add_argument('--timestamps', action='store_true',
                        help='Print "filename<TAB>seconds<TAB>percent": approximate position of the clip in the video and the share of the clip that matched')
    parser.add_argument('--details', action='store_true', help='Show votes and distance next to each name')
    parser.add_argument('--quiet', action='store_true', help='Print only matched filenames (nothing if no match)')
    args = parser.parse_args()
    if args.find is not None:
        if not os.path.isfile(args.db):
            sys.exit('Database not found.')
        for name in find_filenames(args.db, args.find):
            print(name)
        return
    query_path = args.query or input('Query video path: ').strip().strip('"')
    if not os.path.isfile(query_path):
        sys.exit('Query video not found.')
    if not os.path.isfile(args.db):
        sys.exit('Database not found.')
    if args.threshold is None:
        args.threshold = IMAGE_THRESHOLD if args.image else DEFAULT_THRESHOLD
    if not 0 <= args.threshold <= 64:
        sys.exit('Threshold must be between 0 and 64.')
    scoring = None if args.image else load_scoring()

    started = time.time()
    image_values = []
    if args.image:
        image_values = extract_image_hashes(query_path)
        if not image_values:
            sys.exit('The image has too little visual detail to search (it looks blank or flat).')
        hashes, total_seconds, variants = [], 1, []
    else:
        hashes, total_seconds, variants = extract_query(query_path, args.seconds)
        if total_seconds == 0:
            sys.exit('No query frames could be extracted.')
        if not hashes:
            sys.exit('The query clip has too little visual detail to search (all frames are blank or flat).')

    db = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True, timeout=30)
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    columns = {row[1] for row in db.execute('PRAGMA table_info(videos)')} if 'videos' in tables else set()
    if not {'videos', 'fingerprints'}.issubset(tables) or 'video_key' not in columns \
            or 'fpv' not in columns:
        sys.exit('Database uses an older layout. Run any indexing command once (e.g. bash vindex-folder.sh) '
                 'to upgrade it.')
    db.close()

    vid, sec, ph = load_fingerprints(args.db, args.quiet)
    if len(ph) == 0:
        sys.exit('The index has no videos in the current fingerprint format. '
                 'Re-index your videos (bash vindex-folder.sh) to upgrade them.')

    if args.image:
        found = search_image(vid, sec, ph, image_values, args.threshold)[:IMAGE_TOP_RESULTS]
        if not found:
            if not args.quiet:
                print('No match found.')
            return
        db = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True, timeout=30)
        marks = ','.join('?' for _ in found)
        names = dict(db.execute(f'SELECT id, filename FROM videos WHERE id IN ({marks})', [f[0] for f in found]))
        db.close()
        for video, second, dist in found:
            if video not in names:
                continue
            percent = round(100 * (64 - dist) / 64)             # similarity of the single frame
            if args.timestamps:
                print(f'{names[video]}\t{second}\t{percent}')
            elif args.details and not args.quiet:
                print(f'{names[video]}  (frame at {second}s, distance {dist}/64)')
            else:
                print(names[video])
        return

    def search(query_hashes):
        """Returns (ranked results that pass the evidence rules, usable seconds of this query)."""
        hits = find_hits(vid, sec, ph, query_hashes, args.threshold, args.quiet)
        found = rank_videos(hits, scoring) if hits is not None else []
        seconds = len({qi for qi, _ in query_hashes})
        auto = max(3, -(-seconds * 20 // 100))              # ceil(20% of usable seconds), min 3
        needed = args.min_hits if args.min_hits > 0 else min(seconds, auto)
        found = [r for r in found if r[1] >= 0.75 * needed]  # partial credit counts, so allow a little slack
        if found:
            floor = max(0.75 * needed, found[0][1] / 2)      # also >= half of the best result
            found = [r for r in found if r[1] >= floor][:TOP_RESULTS]
        return found, seconds

    ranked, usable = search(hashes)
    edit = ''
    for label, variant in variants:                        # nothing found: maybe the clip was flipped or turned over
        if ranked:
            break
        if variant:
            ranked, usable = search(variant)
            edit = label if ranked else ''

    if not ranked:
        if not args.quiet:
            print('No match found.')
        return

    db = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True, timeout=30)
    ids = [r[0] for r in ranked]
    marks = ','.join('?' for _ in ids)
    names = dict(db.execute(f'SELECT id, filename FROM videos WHERE id IN ({marks})', ids))
    db.close()
    for video, votes, mean, offset in ranked:
        if video not in names:
            continue
        if args.timestamps:
            percent = min(100, round(100 * votes / max(usable, scoring[2])))   # share of the clip that agrees, closeness-weighted
            print(f'{names[video]}\t{max(0, offset + 1)}\t{percent}')  # group key k holds offsets k and k+1
        elif args.details and not args.quiet:
            print(f'{names[video]}  ({votes:.1f}/{usable} seconds, avg distance {mean:.1f}{", " + edit if edit else ""})')
        else:
            print(names[video])
    if not args.quiet:
        print(f'\nSearch time: {time.time() - started:.1f}s')


if __name__ == '__main__':
    try:
        main()
    except subprocess.TimeoutExpired:
        sys.exit('The file took too long to process and was stopped.')
