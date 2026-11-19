# Jade Technical Documentation

This document explains how Jade works internally. For installation and everyday use, see the [README](README.md).

## Contents

1. [Architecture](#architecture)
2. [Fingerprinting](#fingerprinting)
3. [Database](#database)
4. [Indexing](#indexing)
5. [Searching](#searching)
6. [Bot internals](#bot-internals)
7. [Progress event protocol](#progress-event-protocol)
8. [Command reference](#command-reference)
9. [Tuning and compatibility](#tuning-and-compatibility)
10. [Safety guarantees](#safety-guarantees)

---

## Architecture

Jade is a Node.js Discord bot that delegates all heavy work to Python and shell child processes. Each part has one job:

| File | Role |
| --- | --- |
| `index.js` | Discord bot: slash commands, `!get`, archive lookups, job control, progress display |
| `vindex-folder.sh` | Bulk indexer: lists an rclone folder, downloads new videos one at a time, calls `vindex.py` |
| `vindex.py` | Fingerprints one local video into the database. Also holds database maintenance commands |
| `vget.py` | Searches the database for a clip or screenshot |
| `jadefp.py` | Shared fingerprint maths, imported by both `vindex.py` and `vget.py` |
| `vindex.sh`, `vget.sh` | Manual launchers for single-file indexing and interactive searching |

```
 Discord ──► index.js ──┬─► vindex-folder.sh ─► rclone (download) ─► vindex.py ─► SQLite
                        │                                                           ▲
                        ├─► vindex.py (single file)                                 │
                        │                                                           │
                        └─► vget.py (search, read-only) ────────────────────────────┘
                                     └── both import jadefp.py
```

Child processes run in their own process group, so cancelling a job or shutting the bot down stops the whole tree (rclone, ffmpeg and Python together).

---

## Fingerprinting

All fingerprint maths lives in `jadefp.py`, so the indexer and matcher cannot drift apart.

**Sampling.** Frames are decoded with ffmpeg at 1 frame per second, shrunk to 32×32 and converted to grayscale. The filter is `fps=1,scale=32:32:flags=area,format=gray`, shared by both programs.

**Hash.** Each tile gets a 64-bit perceptual hash:

1. A 2D DCT is applied to the 32×32 tile.
2. The 63 low-frequency AC coefficients of the top-left 8×8 block are taken (the DC term is skipped), plus one more AC term, giving 64 values.
3. Each value above the median becomes a `1` bit, the rest `0`.

**Flat frames.** If a tile's standard deviation is below `MIN_STD` (3.0), it is near-flat (black, white, fades). Its hash is meaningless and would match everything, so it is neither stored nor searched.

**Distance.** Two hashes are compared by Hamming distance (number of differing bits, 0–64). `popcount64` uses `numpy.bitwise_count` when available and a lookup-table fallback otherwise.

**Fingerprint version.** `FP_VERSION` (currently `2`) is stored per video. If the hash or sampling ever changes, bump it. The matcher then ignores older videos and the bulk indexer re-indexes them.

---

## Database

A single SQLite file at `~/Jade/video-index.db`, opened in WAL mode so searches never block indexing commits. Schema version 3:

### `videos`

| Column | Meaning |
| --- | --- |
| `id` | Integer primary key |
| `video_key` | SHA-256 of the normalised remote path (unique identity of a video) |
| `filename` | File name shown in results |
| `root_key` | SHA-256 of the folder it was indexed from (used by prune) |
| `fpv` | Fingerprint version it was indexed with |
| `remote_path` | Readable remote path (for `/index-db`) |
| `indexed_at` | Unix time of indexing |

### `fingerprints`

| Column | Meaning |
| --- | --- |
| `vid` | Video id (foreign key, deletes cascade) |
| `second` | Second offset in the video |
| `crop_id` | Always `0` (full frame). Crop fingerprints are retired |
| `phash` | 64-bit hash stored as a signed integer |

Primary key is `(vid, second, crop_id)`, and the table is `WITHOUT ROWID`.

### `partial` and `partial_fp`

Resume checkpoints for an interrupted file: how many seconds are done, how many flat frames were skipped, the file size and fingerprint version, plus the hashes computed so far.

### Migrations

On open, `init_schema` upgrades older layouts automatically (adds `fpv`, `remote_path` and `indexed_at` columns, and converts the old text-id schema to the integer schema, then `VACUUM`s). An unrecognised layout is refused rather than modified.

### Search cache

The first search after indexing builds memory-mapped arrays (`vid.npy`, `sec.npy`, `hash.npy`) in `~/Jade/cache/`. They are rebuilt only when the database file, its `-wal` file or the fingerprint version changes.

---

## Indexing

### One video (`vindex.py LOCAL REMOTE [--root ROOT]`)

1. Take an exclusive lock on `~/Jade/indexer.lock`. A second indexer exits with an error.
2. Compute `video_key` from the remote path.
3. **Resume check.** If a checkpoint exists with the same fingerprint version and file size, load its hashes and continue from `done_seconds`. Otherwise discard the stale checkpoint.
4. Stream raw frames from ffmpeg, hash each one, and collect them in a temporary staging table. Every `JADE_BATCH_SECONDS` (300) seconds, write a checkpoint.
5. When the whole file is read, **replace** the video's rows in one transaction (video row, fingerprints, checkpoint cleanup). The old entry is only replaced after new fingerprints were extracted successfully.
6. Fail with a clear message if no frames were extracted or the video is blank.

Re-indexing the same remote path overwrites its previous entry. Identity is the remote path, not the file contents.

### A folder (`vindex-folder.sh [--prune [--force]] REMOTE:PATH`)

1. Take a bulk lock (`~/Jade/bulk-index.lock`) so only one run is active.
2. `rclone lsf --recursive --files-only` lists the folder. A heartbeat reports the number of entries listed so far.
3. `vindex.py status` filters the listing to supported video extensions, sorts it in natural alphabetical order (`clip2` before `clip10`) and marks each file as new (`0`) or already indexed (`1`, at the current fingerprint version).
4. For each new file, in order:
   - Skip unsafe paths (starting with `-`).
   - Check free space against the file size plus `VINDEX_MIN_FREE_MB`.
   - `rclone copyto` to `~/Jade/tmp/vindex-bulk-<pid>.<ext>`.
   - Run `vindex.py` on it, then delete the temporary file.
5. Print a summary: indexed, already indexed, failed, total found.
6. With `--prune`, `vindex.py prune` removes entries of this folder whose files no longer exist.

**Prune guard.** If the folder has at least 5 entries and more than half would be removed, prune refuses unless `--force` is given. It also refuses if the listing contains no videos at all. This protects the index from a wrong folder path or a failed listing.

Rerunning the same command skips finished files and retries failed ones. `SIGINT`/`SIGTERM` stop the run promptly and clean up temporary files.

### Other `vindex.py` commands

| Command | Purpose |
| --- | --- |
| `status REMOTE_ROOT` | Reads an rclone listing on stdin, prints the new/indexed plan |
| `prune REMOTE_ROOT [--force]` | Removes vanished files of a folder (listing on stdin) |
| `forget-root REMOTE_ROOT` | Drops every entry recorded for a folder |
| `purge-crops` | Deletes legacy crop fingerprints (`crop_id > 0`) and shrinks the file |
| `dbinfo` | Prints a JSON summary (used by `/index-db`) |

---

## Searching

### Video clips

1. Decode the first `--seconds` (30) of the clip with the same sampling filter, skipping flat frames. `usable` is the number of distinct frames kept.
2. Load the fingerprint cache and compare every query hash against every stored hash, in chunks of 1,000,000 rows. Hits are pairs whose Hamming distance is at most the threshold (16).
3. **Offset voting.** Each hit implies where the clip's start would sit in that video (`stored_second − query_second`). Each hit also votes for the neighbouring offset, since a frame sampled at a slightly different instant lands one second off.
4. Per video, the offset with the most votes wins (ties broken by lowest mean distance). Each query second counts once per offset, using its closest hit.
5. **Filtering.**
   - A video needs at least `needed` agreeing seconds: `--min-hits` if given, otherwise 20% of `usable` rounded up, at least 3.
   - Of those, only videos with at least half of the best video's votes are kept, up to 10.
6. **Percent.** `votes / usable × 100`, capped at 100, is the share of the clip that agreed.
7. **Timestamp.** The winning offset (plus 1, to compensate for the neighbouring-window vote) is the approximate position of the clip's start in the video, accurate to about ±1 second.

### Screenshots (`--image`)

A single frame has no voting to protect it, so the threshold is tighter (12).

1. Decode the image and compute its hash.
2. If dark letterbox or pillarbox bars can be trimmed (without discarding too much of the image), also hash the trimmed version. Both are searched, because dark edges may be real picture content or player bars.
3. For each video, keep the closest stored frame (lowest distance, then earliest second).
4. **Percent.** `(64 − distance) / 64 × 100` for that frame. A distance of 12 or less means at least 81%.
5. Up to 5 results are returned, best first.

### Output modes

| Flag | Output line |
| --- | --- |
| `--timestamps` | `filename<TAB>seconds<TAB>percent` (what the bot uses) |
| `--details` | Human-readable votes and distance |
| `--quiet` | Names only, nothing if no match |
| `--find CODE` | Filenames containing the code (used for archive lookups) |

### How the bot decides "good" or "weak"

`vget.py` only filters results that are clearly implausible. The bot then classifies the best result:

| Query | Result is returned when | Reported as good at |
| --- | --- | --- |
| Video | percent is about 20% or higher | 70% or higher |
| Screenshot | percent is 81% or higher | 90% or higher |

Anything returned but below the good line is shown as a weak match: the best guess with a warning. No result at all shows "No match found". Both cases share one message builder, `noMatchText()`, which takes an optional guess.

---

## Bot internals

### Message handling

Every guild message from a human goes through `messageCreate`:

1. **Archive lookup.** If the message matches "any/some + one/body + got/has/have/share" and contains up to 3 codes, check each with `vget.py --find`. Replies only on a hit. Runs only in configured channels, if any are set.
2. **`!get` / `!get code`.** The text must be exactly one of these (case-insensitive), sent as a reply to a message with a video or image attachment. This is a reply-based trigger rather than a slash command because chat-input slash commands do not expose the replied-to message.

### The search flow (`searchRepliedVideo` → `runSearch`)

1. A single global slot (`activeSearch`) is claimed before the first `await`, so two quick `!get` messages cannot both run. Others get a wait estimate based on the average of the last 10 finished searches.
2. Validate: a reply reference exists, the source message is readable, it has an attachment (video wins over image), the size is within limits (150 MB video, 25 MB image), `vget.py` exists, and the per-user cooldown (20 s) has passed.
3. Download the attachment to `~/Jade/tmp/get-<uuid>.<ext>`, enforcing the size limit while streaming.
4. Run `vget.py <file> --quiet --timestamps [--image]` under a 5-minute timeout.
5. Take only the best line, classify it, and edit the "🔎 Searching…" message with the result (mentions are never pinged).
6. Always delete the temporary file. Log the outcome to the log channel, including weak guesses.

### Indexing jobs

`/index` creates a job (`activeJob`). Only one runs at a time.

- **Single file.** The bot downloads with rclone and runs `vindex.py`, parsing rclone's JSON statistics and `JADE_PROGRESS` lines.
- **Folder.** The bot runs `vindex-folder.sh` with `JADE_EVENTS=1` and parses its `JADE_EVENT` lines.
- Output from every child, on stdout or stderr, is parsed line by line. The line's content decides how it is treated, so ordering between the two pipes cannot confuse the parser.
- A progress state reducer turns events into a terminal view and a Discord message. Discord edits are coalesced (at most one every 3 seconds, never two in flight), and give up after 5 consecutive failures.
- **Stall watchdog.** Every 30 seconds it checks for real progress (new bytes, new fingerprinted seconds, more listed entries, or any state-changing event). Output alone does not count, since rclone prints statistics even when stuck. After `JADE_STALL_MINUTES` without progress, the Discord message shows a warning, and one DM plus a log message are sent.
- **Failure streak.** A folder run is stopped if 5 downloads in a row fail (bad rclone config, expired login, no network), with the last error as the reason.
- **Errors.** `[rclone] ERROR` and `INDEX ERROR` lines on stderr raise an alert in the Discord message, with at most one log-channel alert per 10 minutes.
- **Hand-off.** Interaction tokens expire after 15 minutes, so the bot stops editing the original reply at 14 minutes. Progress then moves to an edited DM, or to the log channel if DMs are closed. The final result is sent the same way.
- **Thread control.** The `threads` option sets `JADE_FFMPEG_THREADS` for that job only.

### Startup and shutdown

On startup the bot registers slash commands for the configured server, sets its presence, sweeps temporary files older than one hour from `~/Jade/tmp`, and posts "online" to the log channel.

On `SIGINT`/`SIGTERM`, it cancels the active job and search, waits for the children to exit (up to about 12 seconds), flushes the log queue and exits. A closed terminal never crashes the bot or stops a job.

---

## Progress event protocol

Used between the shell/Python tools and `index.js`. It is only emitted when `JADE_EVENTS=1`, so running the scripts by hand stays readable.

### `JADE_EVENT {json}` from `vindex-folder.sh`

| `type` | When |
| --- | --- |
| `scan_start` | Listing the remote folder begins |
| `scan_progress` | Heartbeat with `listed` count and `stage` (`listing` or `checking`) |
| `scan_done` | Plan ready: `found` videos, `indexed` already |
| `skip` | A file is already indexed |
| `download_start` | A download begins (includes `size`) |
| `download_done` | A download finished (includes `bytes`) |
| `fingerprint_start` | Fingerprinting begins |
| `file_done` | A file finished indexing |
| `file_failed` | A file failed: `stage` is `precheck`, `download` or `fingerprint`, plus `error` |
| `summary` | Final counts: `total`, `indexed`, `skipped`, `failed` |

Per-file events carry `index`, `total`, `name` and `path`.

### `JADE_PROGRESS {json}` from `vindex.py`

A `type: "fingerprint"` object with `processed_seconds`, and when known `total_seconds`, `speed` (source-seconds per second), `resumed` and `final`. Emitted at most once every 2 seconds.

### rclone statistics

In events mode, rclone writes JSON statistics to stderr every 2 seconds. The bot turns these into byte counts, speed and ETA.

---

## Command reference

### Slash commands (Manage Server permission required)

| Command | Options |
| --- | --- |
| `/index` | `file_path` or `folder_path` (exactly one), `threads` (0 to `JADE_MAX_THREADS`), `prune` (folder only) |
| `/index-status` | none |
| `/index-db` | none |
| `/index-cancel` | none |

### Environment variables

| Variable | Used by | Default |
| --- | --- | --- |
| `JADE_BOT_TOKEN` | `index.js` | none |
| `JADE_GUILD_ID` | `index.js` | none (required) |
| `JADE_LOG_CHANNEL_ID` | `index.js` | unset (logging off) |
| `JADE_ARCHIVE_CHANNEL_ID` | `index.js` | unset (every channel) |
| `JADE_MAX_THREADS` | `index.js` | `16` |
| `JADE_STALL_MINUTES` | `index.js` | `5` |
| `JADE_FFMPEG_THREADS` | `vindex.py`, `vget.py`, `index.js` | `1` |
| `JADE_BATCH_SECONDS` | `vindex.py` | `300` |
| `JADE_EVENTS` | `vindex.py`, `vindex-folder.sh` | `0` (set to `1` by the bot) |
| `VINDEX_MIN_FREE_MB` | `vindex-folder.sh` | `200` |

---

## Tuning and compatibility

| Setting | Where | Effect |
| --- | --- | --- |
| `GOOD_MATCH_PERCENT` | `index.js` | Video clips at or above this are "good" (70) |
| `GOOD_SCREENSHOT_PERCENT` | `index.js` | Screenshots at or above this are "good" (90) |
| `DEFAULT_THRESHOLD` | `vget.py` | Video Hamming threshold (16) |
| `IMAGE_THRESHOLD` | `vget.py` | Screenshot Hamming threshold (12) |
| `MAX_QUERY_SECONDS` | `vget.py` | Seconds of a clip analysed (30) |
| `RELATIVE_CUTOFF`, `TOP_RESULTS` | `vget.py` | Result filtering and count |
| `MAX_QUERY_BYTES`, `MAX_IMAGE_BYTES` | `index.js` | Upload size limits |
| `SEARCH_COOLDOWN_MS`, `SEARCH_TIMEOUT_MS` | `index.js` | Per-user cooldown and search timeout |
| `MIN_STD` | `jadefp.py` | How flat a frame must be to be skipped |

Changing `MIN_STD`, the filter, the hash or the sampling in `jadefp.py` means bumping `FP_VERSION`, then re-running the bulk indexer.

Raising the Hamming threshold finds more edited or compressed copies but also more false matches. Lowering it does the opposite. Keep the "good" cutoffs in step with it: the screenshot cutoff must stay above `(64 − IMAGE_THRESHOLD) / 64`, or no screenshot match can ever be classed weak.

---

## Safety guarantees

- Jade never writes to, moves or deletes anything on the remote. Only rclone reads (`lsf`, `copyto`) are used.
- Temporary downloads exist only in `~/Jade/tmp`. They are removed after each file, on cancellation, and by a startup sweep of anything older than an hour.
- Prune refuses suspicious deletions (empty listing, or more than half of a folder) unless forced.
- Index writes are transactional, and a video's old entry is replaced only after its new fingerprints were fully extracted.
- Lock files prevent two indexers, or two bulk runs, from writing at once.
- Bot replies suppress mentions, so file names and codes cannot ping anyone.
