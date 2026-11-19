# Jade

A Discord bot that finds which video a clip or screenshot came from.

Jade indexes videos stored on any [rclone](https://rclone.org) remote by fingerprinting one frame per second. Members then reply to a clip or screenshot with `!get`, and the bot searches the index and reports the best match with the approximate moment in the video. It is built to run on a phone under [Termux](https://termux.dev), but works on any Linux machine with the same tools.

## Features

- **Reverse video search.** Reply to a video clip or screenshot with `!get` to find the source video and the approximate timestamp.
- **Confidence-aware answers.** Strong matches are reported as good matches. Weak ones are shown as a best guess with a clear warning.
- **Archive lookups.** Messages like "anyone has SL-341?" are answered automatically if a filename in the index contains that code.
- **Bulk indexing.** Index a single video or a whole remote folder, with resume, skip-if-already-indexed, and optional pruning of deleted files.
- **Live progress in Discord.** Progress is shown while the job runs, with stall detection and a DM or log-channel hand-off for long jobs.
- **Read-only on your storage.** Nothing is ever modified or deleted on the remote. Only the temporary local download is removed.

## How it works

1. **Indexing.** Each video is downloaded to a temporary file, sampled at 1 frame per second, and shrunk to a 32×32 grayscale tile. A 64-bit DCT perceptual hash is computed per frame and stored in a local SQLite database. Near-flat frames (black, white, fades) are skipped because they match everything. The temporary file is deleted afterwards.
2. **Searching.** The query clip is sampled the same way (first 30 seconds by default) and each frame's hash is compared against the index by Hamming distance. Every matching second casts a vote for a video and an offset. Screenshots use a single frame, with dark borders trimmed.
3. **Ranking.** Videos need a minimum number of agreeing seconds (about 20% of the clip, at least 3), and only results within half of the best video's votes are kept. The reported percentage is the share of the clip's seconds that agreed.

| Query type | Hamming threshold | Reported as "good match" at |
| --- | --- | --- |
| Video clip | 16 | 70% or higher |
| Screenshot | 12 | 90% or higher |

Anything found below the "good" line is shown as a weak match, with the best guess and a warning that it could be the wrong video.

## Requirements

- **Node.js** (current LTS) and **discord.js v14**
- **Python 3** with **NumPy**
- **ffmpeg** (including `ffprobe`)
- **rclone**, configured with your remote(s)
- `flock` (util-linux), `awk`, and `df` (coreutils), used by the bulk indexer

On Termux:

```bash
pkg install nodejs python python-numpy ffmpeg rclone util-linux gawk
```

The shell scripts use `#!/usr/bin/env bash`. On current Termux this works through `termux-exec`; if it doesn't on your setup, run them as `bash script.sh`.

## Installation

1. Clone the repository, or put the project files in one folder. The Python files must stay together, because `vindex.py` and `vget.py` both import `jadefp.py`:

   ```
   index.js          Discord bot
   package.json      Node dependencies and scripts
   vindex.py         Fingerprint indexer
   vget.py           Matcher / search
   jadefp.py         Shared fingerprint maths (keeps indexer and matcher in sync)
   vindex-folder.sh  Bulk indexer for an rclone folder
   vindex.sh         Single-file indexer launcher
   vget.sh           Interactive matcher launcher
   ```

2. Install the Node dependency:

   ```bash
   npm install
   ```

3. Configure rclone as usual (`rclone config`). Jade uses your normal rclone configuration and stores no remote credentials.

## Discord bot setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) and add a bot.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The bot also uses the Guilds and Guild Messages intents.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes. It needs permission to read messages, send messages, and reply in the channels where it will be used.
4. Optionally create a private channel for status logs and give the bot access to it.

## Configuration

### Bot token

The token is read from the first source that has it:

1. The `JADE_BOT_TOKEN` environment variable
2. A file named `.bot-token` next to `index.js` (run `chmod 600 .bot-token`)
3. `INLINE_BOT_TOKEN` inside `index.js` (least safe, and never share the file if you use it)

Never commit your token.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `JADE_BOT_TOKEN` | Discord bot token | none |
| `JADE_GUILD_ID` | **Required.** ID of the server where slash commands are registered | none |
| `JADE_LOG_CHANNEL_ID` | Channel for short status messages (online/offline, job start/finish, errors). Leave unset to turn logging off. | off |
| `JADE_ARCHIVE_CHANNEL_ID` | Comma-separated channel IDs where archive lookups run (threads of a listed channel count). Leave unset to run in every channel. | every channel |
| `JADE_MAX_THREADS` | Upper limit for the `threads` option of `/index` | `16` |
| `JADE_FFMPEG_THREADS` | FFmpeg decoder threads while sampling frames (`1` keeps the phone cool, `0` lets FFmpeg decide) | `1` |
| `JADE_STALL_MINUTES` | Minutes without real progress before a job is reported as stalled | `5` |
| `JADE_BATCH_SECONDS` | Seconds of video per resume checkpoint while indexing | `300` |
| `VINDEX_MIN_FREE_MB` | Free space to keep beyond each download in bulk mode | `200` |

To get IDs, enable **Developer Mode** in Discord (Settings → Advanced), then right-click a server or channel and choose **Copy ID**.

Example (Linux/Termux):

```bash
export JADE_BOT_TOKEN='your-token'
export JADE_GUILD_ID='123456789012345678'
export JADE_LOG_CHANNEL_ID='123456789012345678'   # optional
node index.js
```

## Running

```bash
node index.js
```

On Termux, you may also want `termux-wake-lock` so Android doesn't suspend the process, and a terminal multiplexer such as `tmux` to keep it running.

On startup the bot registers its slash commands, sets its presence, sweeps stale temporary files, and posts "online" to the log channel if one is configured.

## Using the bot

### Find a video: `!get`

Reply to a message that contains a video or screenshot with `!get` (or `!get code`; both behave the same).

| | Limit |
| --- | --- |
| Accepted images | `.png` `.jpg` `.jpeg` `.webp` `.bmp` `.gif`, up to 25 MB |
| Accepted videos | up to 150 MB |
| Cooldown | 20 seconds per user |
| Concurrency | One search at a time; others are asked to wait |
| Timeout | 5 minutes per search |

Example replies:

> **Good match**
>
> ## 🎬 SR075
> ✅ Good match  |  🎯 `92%`  |  around ⏱️ `~2:50`

> **Weak match**
>
> ## ❗ No confident match
> **Best guess:** 🎬 SR075  |  🎯 `81%`  |  around ⏱️ `~2:50`
> ***This is only a guess and could be the wrong video!***
> **Reason:** Cropped/Edited, not Indexed, or not in the Archive.

> **Nothing found**
>
> ## ❗ No match found
> **Reason:** Cropped/Edited, not Indexed, or not in the Archive.

### Archive lookups

Casual questions such as "anyone has SL-341?", "does somebody have sl341?", or "someone got SL 341" are checked against the filenames in the index. If a filename contains the code, the bot replies that it is in the archive. Up to 3 codes per message are checked, with a 5-second cooldown per user. If nothing is found, the bot stays silent, since the question may be meant for other members.

### Indexing: slash commands

These require the **Manage Server** permission.

| Command | What it does |
| --- | --- |
| `/index file_path:` | Index one video, e.g. `remote:folder/video.mkv` |
| `/index folder_path:` | Recursively index a folder, e.g. `remote:folder/videos` |
| `/index … threads:` | FFmpeg threads for this job (`1` = coolest, higher = faster, `0` = automatic) |
| `/index … prune:true` | Folder only: also remove index entries whose files no longer exist there |
| `/index-status` | Show the current indexing job |
| `/index-db` | Show the size and contents of the index database |
| `/index-cancel` | Cancel the current indexing job |

Give exactly one of `file_path` or `folder_path`. Only one indexing job runs at a time. Reruns skip videos that are already indexed and retry failed ones. A bulk run stops early if several downloads in a row fail (for example a bad rclone login or no network).

Progress is edited into the reply while Discord's 15-minute interaction window is open. After that, progress and the final result move to your DMs, or to the log channel if DMs are closed.

## Command-line use

The scripts work without the bot.

```bash
# Index one video you already downloaded
bash vindex.sh LOCAL_VIDEO_FILE 'remote:folder/video.mkv'

# Index a whole remote folder (optionally prune deleted files)
bash vindex-folder.sh 'remote:folder/videos'
bash vindex-folder.sh --prune 'remote:folder/videos'
bash vindex-folder.sh --prune --force 'remote:folder/videos'   # allow removing more than half the entries

# Search interactively
bash vget.sh

# Search directly
python vget.py clip.mp4 --details
python vget.py screenshot.png --image
python vget.py --find SL-341
```

Useful `vget.py` options: `--threshold`, `--seconds`, `--min-hits`, `--image`, `--timestamps`, `--details`, `--quiet`, `--find CODE`, `--db PATH`.

Other `vindex.py` commands: `status`, `prune`, `forget-root`, `purge-crops`, and `dbinfo`. Run `python vindex.py` with no arguments for the full usage.

## Data and files

Everything lives under `~/Jade/`:

| Path | Contents |
| --- | --- |
| `video-index.db` | SQLite fingerprint database |
| `tmp/` | Temporary downloads (stale files are swept on startup) |
| `bulk-index.lock`, `indexer.lock` | Prevent two indexing runs at once |

The database stores one 64-bit hash per sampled second, per video. If the fingerprint maths in `jadefp.py` ever changes, bump `FP_VERSION`. Videos indexed with an older version are ignored by the matcher and re-indexed by the bulk indexer.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Bot starts but ignores `!get` | **Message Content Intent** is enabled, and the bot can read the channel |
| Slash commands don't appear | The bot is in the server set as the guild ID, and was invited with `applications.commands` |
| `Missing python / ffmpeg / rclone` | Install the packages listed under Requirements |
| `Database not found` | Index at least one video first |
| `Could not list the remote folder` | The remote name is correct and `rclone lsf remote:` works by hand |
| Downloads fail repeatedly | rclone login or token has expired, or there is no network |
| Not enough free space | Free space on the device, or lower `VINDEX_MIN_FREE_MB` |
| A job looks stuck | The bot reports stalls after `JADE_STALL_MINUTES`; use `/index-cancel` and rerun, since progress resumes from checkpoints |
| Weak matches for edited clips | Heavy crops, overlays, or speed changes reduce accuracy; the video may also not be indexed yet |

## Limitations

- Matching works on visual content only. Audio is ignored.
- Heavily cropped, mirrored, or speed-changed clips may not match.
- Position timestamps are approximate, at 1-second resolution.
- Only video formats the indexer knows are picked up: `.mp4 .mkv .avi .mov .m4v .webm .mpg .mpeg .ts .m2ts .wmv .flv .3gp .ogv .vob`.

## License

Released under the [MIT License](LICENSE).
