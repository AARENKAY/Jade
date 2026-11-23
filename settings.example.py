# Jade bot settings. Copy this file to settings.py and fill in the blanks.
# Plain NAME = value lines; the bot reads them without running this file.
# Change them with /settings in Discord, or edit here and run /settings reload.
# Text values: "..." (blank = off, "*" = every channel). Numbers: whole numbers only.
# The bot token is NOT here: put it in a file named .bot-token, or in the JADE_BOT_TOKEN environment variable.

GUILD_ID = ""  # Server the slash commands are registered in (required) (needs a restart)
LOG_CHANNEL_ID = ""  # Channel for short status messages and alerts (blank = off)
CHANNEL_ID = ""  # Channel where the bot answers !get (threads count too). Several IDs: separate with commas. * = every channel, blank = off
REQUEST_CHANNEL_ID = ""  # Channel where the bot answers "anyone has CODE?" (threads count too). Several IDs: separate with commas. * = every channel, blank = off
ARCHIVE_CHANNEL_ID = ""  # Channel where the videos are stored: the answer reads "CODE is in #channel" (blank = "is in the archive")
PREFIX_CHANNELS = ""  # Per-prefix channels for the "anyone has CODE?" answer, as PREFIX=channelID pairs, e.g. SR=123456789012345678,SL=234567890123456789. Other prefixes use ARCHIVE_CHANNEL_ID. Blank = off
ALLOWED_REMOTES = ""  # rclone remotes /index may read. Edit here only: a Manage Server member must not be able to point rclone at any other remote
COMMANDS_CHANNEL_ID = ""  # The only channel the slash commands work in (blank = any channel). Edit here only
SETTINGS_ROLE_ID = ""  # Role allowed to use /settings (blank = anyone with Manage Server). Edit here only
MAX_CLIP_MB = 150  # Largest clip !get accepts (MB)
SEARCH_COOLDOWN_SECONDS = 20  # Seconds a user waits between !get searches
STRIKE_LIMIT = 5  # Too-early or invalid !get messages (cooldown, busy, nothing to search) before a user is ignored for a while (0 = off)
STRIKE_MUTE_MINUTES = 10  # How long a user who reached STRIKE_LIMIT is ignored (minutes)
BLOCKED_USER_IDS = ""  # User IDs the bot ignores completely. Several IDs: separate with commas, blank = nobody
BLOCKED_ROLE_ID = ""  # Members with this role are ignored completely by the bot (blank = off)
SEARCH_TIMEOUT_MINUTES = 5  # Give up on a !get search after this long
DOWNLOAD_TIMEOUT_MINUTES = 2  # Give up downloading the replied-to file after this long
GOOD_MATCH_PERCENT = 70  # Video clip match at or above this % is a good match, below it a guess
FULL_CREDIT_BITS = 4  # Clip matching: a second whose frame is this many bits (of 64) or closer counts in full
ZERO_CREDIT_BITS = 12  # Clip matching: a second this many bits or further away counts for nothing, partly in between. Must be above FULL_CREDIT_BITS
MIN_EVIDENCE_SECONDS = 4  # Clip matching: a clip with fewer usable seconds than this cannot reach 100%
HAVE_COOLDOWN_SECONDS = 5  # Seconds between "anyone has CODE?" answers per user
MAX_CODES_PER_MESSAGE = 3  # Codes looked up per "anyone has" message
STALL_MINUTES = 5  # A running job with no progress for this long is reported as stalled
MAX_DOWNLOAD_FAILS = 5  # Stop a bulk run after this many downloads in a row fail
ALERT_GAP_MINUTES = 10  # At most one error alert in the log channel per this many minutes
DEFAULT_THREADS = 1  # FFmpeg threads for /index jobs when none is given (0 = automatic)
MAX_THREADS = 16  # Highest threads value /index accepts (Termux cannot detect cores) (needs a restart)
