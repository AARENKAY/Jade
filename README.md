# Jade

A Discord bot that works out **which video in your archive a clip or screenshot came from**.

You point it at a folder on any [rclone](https://rclone.org) remote. It fingerprints every video in it (one tiny fingerprint per second of video) and stores only those fingerprints. Later, someone replies to a clip with `!get` and the bot tells them which archived video it is, and roughly where in that video the clip comes from.

Built to run on a phone under [Termux](https://termux.dev), and runs fine on a normal Linux machine too.

## Features

- **`!get` on a video clip**: reply to a clip and get the matching video's name, a match percentage and the approximate moment.
- **Handles re-recorded and re-uploaded clips**: screen recordings with black bars (sides, or top and bottom), and clips that were mirrored, flipped upside-down or rotated 180°.
- **`!get` on a screenshot**: single-frame search, shown only when the frame is an exact (100%) match. Anything less is answered with "No match found", never a guess.
- **"anyone has CODE?" replies** in a request channel: if a code such as `SL-341` is in the index, the bot points to the channel where that video lives, with a different channel per code prefix if you like.
- **Indexing from Discord**: `/index` indexes one file or a whole folder, shows live progress, can be cancelled, and can prune entries for files that no longer exist.
- **Spam protection**: per-user cooldowns, one search at a time, automatic mutes for spammers, and a block list for users or a role.
- **Nothing on your remote is ever modified.** Videos are downloaded one at a time to a temporary file, fingerprinted and deleted.
- **Everything is configurable** from `settings.py` or live with `/settings` in Discord.

## How it works

**Indexing.** Each video is sampled at 1 frame per second. Every frame is shrunk to a 32×32 grayscale tile and turned into a 64-bit DCT perceptual hash. Near-blank frames (black screens, fades) are skipped because their hashes would match everything. The hashes go into a SQLite database at `~/Jade/video-index.db`.

**Matching.** The first 30 seconds of the query clip are hashed the same way, and compared with every stored hash using an exact (brute-force, NumPy) Hamming distance. Each close frame votes for a `(video, time offset)` pair. A video is reported only when enough *different* seconds of the clip agree on the same offset (about 20% of the clip, at least 3 seconds), so one lucky frame never produces a result. The clip is also searched with its black bars cropped off, and, if nothing matches, mirrored, upside-down and rotated 180°.

## Requirements

- **Node.js 18.17 or newer**
- **Python 3** with **NumPy** (tested on Python 3.12 and Node 22), reachable as the command `python`
- **ffmpeg** and **ffprobe**
- **rclone**, with the remote(s) you want to index already configured
- `bash`, `flock`, `awk` (gawk) and coreutils (standard on Linux and Termux; macOS has no `flock`)
- A Discord bot token (see below)

## Setup

### 1. Install the tools

**Termux (Android):**
```sh
pkg update
pkg install git nodejs python python-numpy ffmpeg rclone util-linux gawk
```

**Debian / Ubuntu:**
```sh
sudo apt install git nodejs npm python3 python-is-python3 python3-numpy ffmpeg rclone util-linux gawk
```
If your distribution's Node.js is older than 18, install a newer one from [nodejs.org](https://nodejs.org) or with nvm.

### 2. Configure rclone

Run `rclone config` and add the remote that holds your videos, then check it works:
```sh
rclone lsd myremote:
```

### 3. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application, then add a **Bot**.
2. Under **Bot → Privileged Gateway Intents**, turn on **Message Content Intent**. The bot needs it to read `!get` and "anyone has" messages.
3. Copy the bot token (**Reset Token** if you need a new one).
4. Under **OAuth2 → URL Generator**, tick the scopes `bot` and `applications.commands`, and the permissions **View Channels**, **Send Messages** and **Read Message History**. Open the generated URL to add the bot to your server.
5. In Discord, turn on **Developer Mode** (Settings → Advanced) so you can right-click servers, channels and roles to **Copy ID**.

### 4. Install and configure

```sh
git clone https://github.com/AARENKAY/Jade.git
cd Jade
npm install

cp settings.example.py settings.py     # then edit settings.py (see Settings below)
echo 'YOUR_BOT_TOKEN' > .bot-token     # or set the JADE_BOT_TOKEN environment variable
chmod 600 .bot-token
```

At minimum, set these in `settings.py`:

- `GUILD_ID`: your server's ID (required).
- `ALLOWED_REMOTES`: the rclone remote name(s) `/index` may read, e.g. `"myremote"`.
- `CHANNEL_ID`: the channel(s) where `!get` works (`"*"` = every channel). It is blank by default, which turns `!get` off.
- `COMMANDS_CHANNEL_ID`: the one channel where the slash commands work (a private staff channel is a good choice).

`settings.py` and `.bot-token` are in `.gitignore`, so your IDs and token never get committed.

### 5. Run

```sh
npm start        # same as: node index.js
```
Run it inside `tmux` (or a process manager such as pm2) so it keeps running. On Termux, run `termux-wake-lock` so Android does not put it to sleep.

### 6. Index your videos

In your commands channel:
```
/index folder_path:myremote:Videos/Archive
```
Progress is shown live. Raise `threads` to go faster (1 is the coolest and slowest). You can also run the same job from a terminal:
```sh
bash vindex-folder.sh 'myremote:Videos/Archive'
```

## Using the bot

### `!get`: find the source of a clip or screenshot

Reply to a video (or screenshot) with `!get`. The bot replies with the match:

```
## 🎬 SL-341 Beach Day
✅ Good match  |  🎯 `92%`  |  around ⏱️ `~12:34`
```

A weaker result is labelled as a guess, and no result is "No match found".

| Query | Rules |
|---|---|
| Video clip | At least **30 seconds**, **landscape** (portrait videos are rejected), up to `MAX_CLIP_MB` |
| Screenshot | Up to 25 MB. Shown only when it is an **identical frame** (100%); anything else is "No match found" |

Since the index holds one frame per second, a screenshot taken between two sampled frames usually does not reach 100%. If you want screenshots to be more forgiving, lower `IMAGE_MIN_PERCENT` near the top of `index.js` (for example to 95).

Only one search runs at a time, and each user has a cooldown (`SEARCH_COOLDOWN_SECONDS`).

### "anyone has CODE?"

In `REQUEST_CHANNEL_ID`, a message like `anyone has SL-341?` makes the bot look for that code in the indexed filenames (case, dashes and spaces do not matter, so `sl341` works too). If it finds one it replies, for example:

```
✅ **SL-341** is in #sl-videos
```

If it finds nothing it stays silent, because the question may be for other members. By default it points to `ARCHIVE_CHANNEL_ID`. Set `PREFIX_CHANNELS` to send different code prefixes to different channels:

```python
PREFIX_CHANNELS = "SR=123456789012345678,SL=234567890123456789"
```

### Slash commands

All of them need the **Manage Server** permission and only work in `COMMANDS_CHANNEL_ID`.

| Command | What it does |
|---|---|
| `/index file_path:` or `folder_path:` | Index one video, or every video in a folder (recursively). Options: `threads` (ffmpeg threads, 0 = automatic) and `prune` |
| `/index-status` | Show the running indexing job |
| `/index-cancel` | Cancel the running job |
| `/index-db` | Show the size and contents of the index, grouped by folder |
| `/settings view` / `set` / `reload` | Show settings, change one, or re-read `settings.py` after editing it by hand. If `SETTINGS_ROLE_ID` is set, only that role may use it |

### Spam protection

- One search at a time, plus a per-user cooldown.
- A `!get` that cannot be served (too early, another search running, nothing to search, file too large) counts as a **strike**. After `STRIKE_LIMIT` strikes within 2 minutes the bot sends one cheeky "pipe down" reply and then ignores that user completely for `STRIKE_MUTE_MINUTES`. Each mute is announced in the log channel, if you set `LOG_CHANNEL_ID`.
- `BLOCKED_USER_IDS` and `BLOCKED_ROLE_ID` make the bot ignore people entirely. Moderators who use `/settings` can change them live.

## Settings

Settings live in `settings.py` as plain `NAME = value` lines. Change them by editing the file and running `/settings reload`, or with `/settings set`. A few are marked "Edit here only" because changing them from Discord would be a security risk, and some need a restart. If you upgrade from an older `settings.py`, text settings that are missing count as blank and the newer number settings fall back to their defaults, so the bot still starts.

| Setting | Default | What it does |
|---|---|---|
| `GUILD_ID` | `""` | Server the slash commands are registered in (required) (needs a restart) |
| `LOG_CHANNEL_ID` | `""` | Channel for short status messages and alerts (blank = off) |
| `CHANNEL_ID` | `""` | Channel where the bot answers !get (threads count too). Several IDs: separate with commas. * = every channel, blank = off |
| `REQUEST_CHANNEL_ID` | `""` | Channel where the bot answers "anyone has CODE?" (threads count too). Several IDs: separate with commas. * = every channel, blank = off |
| `ARCHIVE_CHANNEL_ID` | `""` | Channel where the videos are stored: the answer reads "CODE is in #channel" (blank = "is in the archive") |
| `PREFIX_CHANNELS` | `""` | Per-prefix channels for the "anyone has CODE?" answer, as PREFIX=channelID pairs, e.g. SR=123456789012345678,SL=234567890123456789. Other prefixes use ARCHIVE_CHANNEL_ID. Blank = off |
| `ALLOWED_REMOTES` | `""` | rclone remotes /index may read. Edit here only: a Manage Server member must not be able to point rclone at any other remote |
| `COMMANDS_CHANNEL_ID` | `""` | The only channel the slash commands work in (blank = any channel). Edit here only |
| `SETTINGS_ROLE_ID` | `""` | Role allowed to use /settings (blank = anyone with Manage Server). Edit here only |
| `MAX_CLIP_MB` | `150` | Largest clip !get accepts (MB) |
| `SEARCH_COOLDOWN_SECONDS` | `20` | Seconds a user waits between !get searches |
| `STRIKE_LIMIT` | `5` | Too-early or invalid !get messages (cooldown, busy, nothing to search) before a user is ignored for a while (0 = off) |
| `STRIKE_MUTE_MINUTES` | `10` | How long a user who reached STRIKE_LIMIT is ignored (minutes) |
| `BLOCKED_USER_IDS` | `""` | User IDs the bot ignores completely. Several IDs: separate with commas, blank = nobody |
| `BLOCKED_ROLE_ID` | `""` | Members with this role are ignored completely by the bot (blank = off) |
| `SEARCH_TIMEOUT_MINUTES` | `5` | Give up on a !get search after this long |
| `DOWNLOAD_TIMEOUT_MINUTES` | `2` | Give up downloading the replied-to file after this long |
| `GOOD_MATCH_PERCENT` | `70` | Video clip match at or above this % is a good match, below it a guess |
| `FULL_CREDIT_BITS` | `4` | Clip matching: a second whose frame is this many bits (of 64) or closer counts in full |
| `ZERO_CREDIT_BITS` | `12` | Clip matching: a second this many bits or further away counts for nothing, partly in between. Must be above FULL_CREDIT_BITS |
| `MIN_EVIDENCE_SECONDS` | `4` | Clip matching: a clip with fewer usable seconds than this cannot reach 100% |
| `HAVE_COOLDOWN_SECONDS` | `5` | Seconds between "anyone has CODE?" answers per user |
| `MAX_CODES_PER_MESSAGE` | `3` | Codes looked up per "anyone has" message |
| `STALL_MINUTES` | `5` | A running job with no progress for this long is reported as stalled |
| `MAX_DOWNLOAD_FAILS` | `5` | Stop a bulk run after this many downloads in a row fail |
| `ALERT_GAP_MINUTES` | `10` | At most one error alert in the log channel per this many minutes |
| `DEFAULT_THREADS` | `1` | FFmpeg threads for /index jobs when none is given (0 = automatic) |
| `MAX_THREADS` | `16` | Highest threads value /index accepts (Termux cannot detect cores) (needs a restart) |

Two values are constants at the top of `index.js` rather than settings: `MIN_CLIP_SECONDS` (30) and `IMAGE_MIN_PERCENT` (100).

### Environment variables

Everything above is configured in `settings.py`. These environment variables are also still read:

| Variable | Purpose | Default |
|---|---|---|
| `JADE_BOT_TOKEN` | Discord bot token (alternative to the `.bot-token` file) | none |
| `JADE_FFMPEG_THREADS` | ffmpeg decoder threads for the command-line tools (`1` keeps a phone cool, `0` = automatic). The bot sets it per `/index` job from the `threads` option or `DEFAULT_THREADS` | `1` |
| `JADE_BATCH_SECONDS` | Seconds of video per resume checkpoint while indexing | `300` |
| `VINDEX_MIN_FREE_MB` | Free disk space to keep beyond each download in a bulk run | `200` |

> **Upgrading from an older version?** Earlier versions were configured with `JADE_GUILD_ID`, `JADE_LOG_CHANNEL_ID`, `JADE_ARCHIVE_CHANNEL_ID`, `JADE_MAX_THREADS` and `JADE_STALL_MINUTES`. Those are no longer read: use `GUILD_ID`, `LOG_CHANNEL_ID`, `CHANNEL_ID` / `REQUEST_CHANNEL_ID`, `MAX_THREADS` and `STALL_MINUTES` in `settings.py` instead.

## Indexing notes

- **Files are identified by their full remote path**, not their contents. Re-running `/index` on a folder skips files whose path is already indexed. This means **replacing a file with a different video under the same name is not noticed**. Re-index that one file with `/index file_path:...` (the new fingerprints replace the old ones).
- **Pruning.** `/index folder_path:... prune:True` indexes the folder first, then removes index entries inside that folder whose files no longer exist. Renamed or moved files count as removed (and are indexed again under the new name). Safety rails: it refuses to prune if the listing contains no videos, or if more than half of the folder's entries (with at least 5) would be removed. From a terminal, `vindex-folder.sh --prune --force` overrides the second rail.
- **Resumable.** A re-run skips finished files and retries failed ones. A bulk run stops after `MAX_DOWNLOAD_FAILS` downloads in a row fail.
- Supported video types: mp4, mkv, avi, mov, m4v, webm, mpg, mpeg, ts, m2ts, wmv, flv, 3gp, ogv, vob.

## Command-line tools

The bot is a thin layer over these, and they work on their own. `vget.py` reads its clip-scoring values from the `settings.py` next to it, so create that first.

```sh
bash vindex-folder.sh [--prune [--force]] 'remote:folder/path'   # index a whole folder
python vindex.py LOCAL_VIDEO REMOTE_PATH                          # index one downloaded video
python vindex.py dbinfo                                           # JSON summary of the index
python vindex.py forget-root 'remote:folder/path'                 # drop every entry recorded for a folder
python vget.py clip.mp4 --details                                 # search a clip
python vget.py screenshot.png --image                             # search a screenshot
python vget.py --find SL-341                                      # is this code in an indexed filename?
bash vget.sh                                                      # interactive version
```

Run `python vget.py --help` and read the top of `vindex.py` for every option.

## Limitations

- Heavy edits (crops, zooms, filters, speed changes) will not match.
- Clips shorter than 30 seconds, and portrait clips, are rejected.
- A screenshot only matches if it is an identical frame to one the index holds (see above).
- Same-name replacements are not re-indexed automatically (see Indexing notes).

## Data and privacy

The bot stores filenames, remote paths and fingerprints in `~/Jade/video-index.db`. It does not keep any video content: downloads go to `~/Jade/tmp` and are deleted after fingerprinting. rclone uses your normal rclone configuration; the bot never stores remote credentials. `ALLOWED_REMOTES` limits which remotes `/index` can touch.

## Development

```sh
npm run check    # syntax checks (Node, Python, shell)
npm test         # settings and spam-guard tests, plus an end-to-end test of the command-line tools
```

The end-to-end test needs ffmpeg and NumPy. It builds small synthetic videos in a temporary `HOME`, so it never touches your real index or `settings.py`. GitHub Actions runs the same commands on every push (`.github/workflows/ci.yml`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Used disallowed intents` at startup | Turn on **Message Content Intent** in the Developer Portal |
| Bot starts but `!get` never answers | `CHANNEL_ID` is blank (that means off), you are in the wrong channel, you did not *reply* to a video, or you are on cooldown or muted |
| `/index` says the remote is not allowed | Add the remote name to `ALLOWED_REMOTES` in `settings.py` and run `/settings reload` |
| `settings.py not found` | `cp settings.example.py settings.py` and fill it in |
| `python: command not found` | On Debian/Ubuntu install `python-is-python3` |
| `Database not found` | Index something first with `/index` |

## License

Released under the [MIT License](LICENSE).
