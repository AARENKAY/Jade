'use strict';

// Jade local video indexer bot
// Uses your normal rclone configuration (Termux or Linux). No remote credentials are stored here.

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  escapeMarkdown,
} = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------- credentials
// The token is read from (first match wins):
//   1. the JADE_BOT_TOKEN environment variable
//   2. a file named .bot-token next to this script (run: chmod 600 .bot-token)
//   3. INLINE_BOT_TOKEN below (least safe: never share this file if you use it)
const INLINE_BOT_TOKEN = '';

function loadToken() {
  if (process.env.JADE_BOT_TOKEN) return process.env.JADE_BOT_TOKEN.trim();
  try {
    const fromFile = fsSync.readFileSync(path.join(__dirname, '.bot-token'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* no token file */ }
  return INLINE_BOT_TOKEN.trim();
}

const BOT_TOKEN = loadToken();

// ------------------------------------------------------------------- settings
// Every setting except the bot token lives in settings.py next to this script, as plain
// NAME = value lines. Nothing is hardcoded here: without settings.py every text setting is blank
// (off) and the bot refuses to start. The file is never executed: this reader accepts only "text"
// and whole-number values. Change settings with /settings in Discord, or edit the file and run
// /settings reload. (The token stays in .bot-token.)
// SETTINGS-BEGIN
const SETTINGS_FILE = path.join(__dirname, 'settings.py');
const SETTINGS = {
  GUILD_ID: { type: 'id', edit: false, restart: true,
    desc: 'Server the slash commands are registered in (required)' },
  LOG_CHANNEL_ID: { type: 'id',
    desc: 'Channel for short status messages and alerts (blank = off)' },
  CHANNEL_ID: { type: 'channels',
    desc: 'Channel where the bot answers !get (threads count too). Several IDs: separate with commas. * = every channel, blank = off' },
  REQUEST_CHANNEL_ID: { type: 'channels',
    desc: 'Channel where the bot answers "anyone has CODE?" (threads count too). Several IDs: separate with commas. * = every channel, blank = off' },
  ARCHIVE_CHANNEL_ID: { type: 'id',
    desc: 'Channel where the videos are stored: the answer reads "CODE is in #channel" (blank = "is in the archive")' },
  PREFIX_CHANNELS: { type: 'prefixes',
    desc: 'Per-prefix channels for the "anyone has CODE?" answer, as PREFIX=channelID pairs, e.g. SR=123456789012345678,SL=234567890123456789. Other prefixes use ARCHIVE_CHANNEL_ID. Blank = off' },
  ALLOWED_REMOTES: { type: 'remotes', edit: false,
    desc: 'rclone remotes /index may read. Edit here only: a Manage Server member must not be able to point rclone at any other remote' },
  COMMANDS_CHANNEL_ID: { type: 'id', edit: false,
    desc: 'The only channel the slash commands work in (blank = any channel). Edit here only' },
  SETTINGS_ROLE_ID: { type: 'id', edit: false,
    desc: 'Role allowed to use /settings (blank = anyone with Manage Server). Edit here only' },
  MAX_CLIP_MB: { type: 'int', min: 1, max: 1000, desc: 'Largest clip !get accepts (MB)' },
  SEARCH_COOLDOWN_SECONDS: { type: 'int', min: 0, max: 3600, desc: 'Seconds a user waits between !get searches' },
  STRIKE_LIMIT: { type: 'int', min: 0, max: 100, default: 5,
    desc: 'Too-early or invalid !get messages (cooldown, busy, nothing to search) before a user is ignored for a while (0 = off)' },
  STRIKE_MUTE_MINUTES: { type: 'int', min: 1, max: 1440, default: 10,
    desc: 'How long a user who reached STRIKE_LIMIT is ignored (minutes)' },
  BLOCKED_USER_IDS: { type: 'users',
    desc: 'User IDs the bot ignores completely. Several IDs: separate with commas, blank = nobody' },
  BLOCKED_ROLE_ID: { type: 'id',
    desc: 'Members with this role are ignored completely by the bot (blank = off)' },
  SEARCH_TIMEOUT_MINUTES: { type: 'int', min: 1, max: 60, desc: 'Give up on a !get search after this long' },
  DOWNLOAD_TIMEOUT_MINUTES: { type: 'int', min: 1, max: 60, desc: 'Give up downloading the replied-to file after this long' },
  GOOD_MATCH_PERCENT: { type: 'int', min: 1, max: 100, desc: 'Video clip match at or above this % is a good match, below it a guess' },
  FULL_CREDIT_BITS: { type: 'int', min: 0, max: 63,
    desc: 'Clip matching: a second whose frame is this many bits (of 64) or closer counts in full' },
  ZERO_CREDIT_BITS: { type: 'int', min: 1, max: 64,
    desc: 'Clip matching: a second this many bits or further away counts for nothing, partly in between. Must be above FULL_CREDIT_BITS' },
  MIN_EVIDENCE_SECONDS: { type: 'int', min: 1, max: 30,
    desc: 'Clip matching: a clip with fewer usable seconds than this cannot reach 100%' },
  HAVE_COOLDOWN_SECONDS: { type: 'int', min: 0, max: 600, desc: 'Seconds between "anyone has CODE?" answers per user' },
  MAX_CODES_PER_MESSAGE: { type: 'int', min: 1, max: 10, desc: 'Codes looked up per "anyone has" message' },
  STALL_MINUTES: { type: 'int', min: 1, max: 120, desc: 'A running job with no progress for this long is reported as stalled' },
  MAX_DOWNLOAD_FAILS: { type: 'int', min: 1, max: 100, desc: 'Stop a bulk run after this many downloads in a row fail' },
  ALERT_GAP_MINUTES: { type: 'int', min: 1, max: 1440, desc: 'At most one error alert in the log channel per this many minutes' },
  DEFAULT_THREADS: { type: 'int', min: 0, max: 256, desc: 'FFmpeg threads for /index jobs when none is given (0 = automatic)' },
  MAX_THREADS: { type: 'int', min: 1, max: 256, restart: true, desc: 'Highest threads value /index accepts (Termux cannot detect cores)' },
};
const EDITABLE_SETTINGS = Object.keys(SETTINGS).filter(key => SETTINGS[key].edit !== false);
const cfg = {};

// The two clip-scoring distances only make sense together: full credit must come before zero credit.
function scoringProblem(values) {
  const { FULL_CREDIT_BITS: full, ZERO_CREDIT_BITS: zero } = values;
  if (!Number.isInteger(full) || !Number.isInteger(zero)) return null;
  return full < zero ? null : 'FULL_CREDIT_BITS must be lower than ZERO_CREDIT_BITS.';
}

// Returns { value } or { error }. Text settings accept "off" or "none" for blank.
function checkSetting(key, raw) {
  const def = SETTINGS[key];
  if (def.type === 'int') {
    const n = typeof raw === 'number' ? raw : (/^-?\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN);
    if (!Number.isInteger(n)) return { error: 'Must be a whole number.' };
    if (n < def.min || n > def.max) return { error: `Must be between ${def.min} and ${def.max}.` };
    return { value: n };
  }
  if (typeof raw !== 'string') return { error: 'Must be text.' };
  let text = raw.trim();
  if (/^(off|none)$/i.test(text)) text = '';
  const parts = text.split(',').map(item => item.trim()).filter(Boolean);
  if (def.type === 'id') {
    if (text && !/^\d{15,25}$/.test(text)) return { error: 'Must be a Discord ID (digits only) or blank.' };
    return { value: text };
  }
  if (def.type === 'channels') {
    if (parts.some(id => id !== '*' && !/^\d{15,25}$/.test(id))) return { error: 'Use comma-separated channel IDs, `*` for every channel, or `off`.' };
    return { value: parts.join(',') };
  }
  if (def.type === 'users') {
    if (parts.some(id => !/^\d{15,25}$/.test(id))) return { error: 'Use comma-separated user IDs (digits only), or `off`.' };
    return { value: parts.join(',') };
  }
  if (def.type === 'prefixes') {
    const pairs = parts.map(item => /^([A-Za-z]{1,10})\s*=\s*(\d{15,25})$/.exec(item));
    if (pairs.some(pair => !pair)) return { error: 'Use PREFIX=channelID pairs separated by commas, e.g. `SR=123456789012345678,SL=234567890123456789`, or `off`.' };
    return { value: pairs.map(pair => `${pair[1].toUpperCase()}=${pair[2]}`).join(',') };
  }
  if (def.type === 'remotes') {
    if (parts.some(name => !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(name))) return { error: 'Use comma-separated rclone remote names.' };
    return { value: parts.join(',') };
  }
  return { error: 'Unknown setting type.' };
}

// Reads one literal at the start of text: "double" or 'single' quoted text (no backslashes), or a whole number.
function parseLiteral(text) {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, 1);
    if (close < 0) return null;
    const body = text.slice(1, close);
    if (body.includes('\\')) return null;
    return { value: body, end: close + 1 };
  }
  const number = /^-?\d[\d_]*/.exec(text);
  if (number) return { value: Number(number[0].replace(/_/g, '')), end: number[0].length };
  return null;
}

function settingLiteral(value) {
  return typeof value === 'number' ? String(value) : `"${value}"`;
}

// Fills cfg from settings.py. A text setting that is missing is blank (off). Whole-number settings
// have no fallback: missing or invalid ones stay unset (null) until the file is fixed, and a reload
// that finds a bad value keeps the one already in use. Returns warnings.
let invalidSettings = new Set();
function loadSettings() {
  const warnings = [];
  const found = {};
  const unreadable = new Set();
  let text = '';
  try {
    text = fsSync.readFileSync(SETTINGS_FILE, 'utf8');
  } catch {
    warnings.push('settings.py not found.');
  }
  // Earlier versions called these ARCHIVE_LINK_CHANNEL_ID and ARCHIVE_CHANNEL_IDS: keep their values.
  const migrated = text
    .replace(/^ARCHIVE_LINK_CHANNEL_ID(\s*=)/m, 'ARCHIVE_CHANNEL_ID$1')
    .replace(/^ARCHIVE_CHANNEL_IDS(\s*=)/m, 'CHANNEL_ID$1');
  if (migrated !== text) {
    text = migrated;
    try { fsSync.writeFileSync(SETTINGS_FILE, text); } catch { /* still applied in memory */ }
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const literal = parseLiteral(match[2]);
    if (!literal || !/^\s*(#.*)?$/.test(match[2].slice(literal.end))) {
      warnings.push(`${match[1]}: could not read the value.`);
      unreadable.add(match[1]);
      continue;
    }
    found[match[1]] = literal.value;
  }
  const next = {};
  const invalid = new Set();
  for (const [key, def] of Object.entries(SETTINGS)) {
    const isNumber = def.type === 'int';
    const previous = cfg[key];
    const inUse = previous !== undefined ? previous : (isNumber ? null : '');
    if (key in found) {
      const result = checkSetting(key, found[key]);
      if (!result.error) { next[key] = result.value; continue; }
      warnings.push(`${key}: ${result.error.replace(/`/g, '')}`);
      invalid.add(key);
      next[key] = inUse;
    } else if (unreadable.has(key)) {
      invalid.add(key);
      next[key] = inUse;
    } else if (isNumber && def.default !== undefined) {
      next[key] = Number.isInteger(previous) ? previous : def.default;      // optional setting: older settings.py files lack it
    } else if (isNumber) {
      warnings.push(`${key}: missing from settings.py.`);
      next[key] = Number.isInteger(previous) ? previous : null;
    } else {
      next[key] = '';
    }
  }
  for (const key of Object.keys(found)) if (!SETTINGS[key]) warnings.push(`${key}: unknown setting (ignored).`);
  const pairProblem = scoringProblem(next);
  if (pairProblem) {
    warnings.push(pairProblem);
    invalid.add('FULL_CREDIT_BITS');
    invalid.add('ZERO_CREDIT_BITS');
  }
  invalidSettings = invalid;
  Object.assign(cfg, next);
  return warnings;
}

// Reasons the bot cannot start (nothing is hardcoded to fall back on).
function settingsBlockers() {
  const blockers = [];
  if (!fsSync.existsSync(SETTINGS_FILE)) return ['settings.py was not found next to index.js.'];
  if (!cfg.GUILD_ID) blockers.push('GUILD_ID is blank.');
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.type === 'int' && !Number.isInteger(cfg[key])) blockers.push(`${key} is missing or not a valid whole number.`);
  }
  for (const key of invalidSettings) if (!blockers.some(line => line.startsWith(key))) blockers.push(`${key} has an invalid value.`);
  return blockers;
}

// Writes one validated value into settings.py (keeping the line's comment) and applies it now.
function saveSetting(key, value) {
  let text;
  try { text = fsSync.readFileSync(SETTINGS_FILE, 'utf8'); } catch { text = ''; }
  const lines = text.split('\n');
  const literal = settingLiteral(value);
  const pattern = new RegExp(`^${key}\\s*=\\s*(.+)$`);
  let done = false;
  for (let i = 0; i < lines.length && !done; i++) {
    const match = pattern.exec(lines[i].replace(/\r$/, ''));
    if (!match) continue;
    const parsed = parseLiteral(match[1]);
    lines[i] = `${key} = ${literal}${parsed ? match[1].slice(parsed.end) : ''}`;
    done = true;
  }
  if (!done) {
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key} = ${literal}`, '');
  }
  const temp = `${SETTINGS_FILE}.tmp`;
  fsSync.writeFileSync(temp, lines.join('\n'));
  fsSync.renameSync(temp, SETTINGS_FILE);
  cfg[key] = value;
}

// Derived values, recomputed on every use so a /settings change applies immediately.
const toSet = text => new Set(String(text).split(',').map(item => item.trim()).filter(Boolean));
const L = {
  get maxQueryBytes() { return cfg.MAX_CLIP_MB * 1024 * 1024; },
  get searchCooldownMs() { return cfg.SEARCH_COOLDOWN_SECONDS * 1000; },
  get searchTimeoutMs() { return cfg.SEARCH_TIMEOUT_MINUTES * 60 * 1000; },
  get downloadTimeoutMs() { return cfg.DOWNLOAD_TIMEOUT_MINUTES * 60 * 1000; },
  get haveCooldownMs() { return cfg.HAVE_COOLDOWN_SECONDS * 1000; },
  get stallMs() { return cfg.STALL_MINUTES * 60 * 1000; },
  get alertGapMs() { return cfg.ALERT_GAP_MINUTES * 60 * 1000; },
  get getChannelIds() { return toSet(cfg.CHANNEL_ID); },
  get requestChannelIds() { return toSet(cfg.REQUEST_CHANNEL_ID); },
  get allowedRemotes() { return toSet(cfg.ALLOWED_REMOTES); },
};

for (const warning of loadSettings()) console.warn(`[settings] ${warning}`);
// SETTINGS-END

// ------------------------------------------------------------------- settings
const INDEXER_PATH = path.join(__dirname, 'vindex.py');
const BULK_INDEXER_PATH = path.join(__dirname, 'vindex-folder.sh');
const MATCHER_PATH = path.join(__dirname, 'vget.py');
const JADE_DIR = path.join(os.homedir(), 'Jade');
const TEMP_DIR = path.join(JADE_DIR, 'tmp');
const DB_PATH = path.join(JADE_DIR, 'video-index.db');
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.wmv', '.flv', '.3gp', '.ogv', '.vob'
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
// !get only searches videos at least this long (0.5 s of slack: a clip trimmed to "30 s" is often 29.9 s).
const MIN_CLIP_SECONDS = 30;
// Screenshots (single frames) are unreliable, so !get only shows a screenshot result when the frame matches
// this well (100 = an identical frame). Anything lower is reported as "No match found", never as a guess.
const IMAGE_MIN_PERCENT = 100;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;     // largest screenshot !get accepts
// Discord interaction tokens stop working after 15 minutes.
const INTERACTION_TTL_MS = 14 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const STALL_CHECK_MS = 30 * 1000;

const NO_TOKEN = !BOT_TOKEN || BOT_TOKEN === 'BOT_TOKEN' || BOT_TOKEN === 'PASTE_YOUR_DISCORD_BOT_TOKEN_HERE';

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('index')
    .setDescription('Index one video or an entire remote folder')
    .addStringOption(option => option
      .setName('file_path')
      .setDescription('Single video path, e.g. remote:folder/video.mkv')
      .setRequired(false)
      .setMaxLength(1000))
    .addStringOption(option => option
      .setName('folder_path')
      .setDescription('Folder path to recursively index, e.g. remote:folder/videos')
      .setRequired(false)
      .setMaxLength(1000))
    .addIntegerOption(option => option
      .setName('threads')
      .setDescription('FFmpeg decoder threads for this job: 1 = coolest, higher = faster, 0 = automatic (all cores)')
      .setMinValue(0)
      .setMaxValue(cfg.MAX_THREADS)
      .setRequired(false))
    .addBooleanOption(option => option
      .setName('prune')
      .setDescription('Folder only: also remove index entries for files that no longer exist there')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('index-status')
    .setDescription('Show the current indexing job')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('index-db')
    .setDescription('Show the size and contents of the video index database')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('index-cancel')
    .setDescription('Cancel the current indexing job')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('View or change the bot settings (stored in settings.py)')
    .addSubcommand(sub => sub.setName('view').setDescription('Show every setting'))
    .addSubcommand(sub => sub.setName('set').setDescription('Change one setting')
      .addStringOption(option => option.setName('name').setDescription('Setting to change').setRequired(true)
        .addChoices(...EDITABLE_SETTINGS.map(key => ({ name: key, value: key }))))
      .addStringOption(option => option.setName('value').setDescription('New value (off = blank, * = every channel)')
        .setRequired(true).setMaxLength(200)))
    .addSubcommand(sub => sub.setName('reload').setDescription('Re-read settings.py after editing it by hand'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),    // hidden from normal members; the role check below still applies
].map(command => command.toJSON());

let client = null;
let activeJob = null;
let activeSearch = null;
let shuttingDown = false;
const searchCooldown = new Map();

// Spam protection. A "strike" is a !get that cannot be served: too early (cooldown), another search running,
// or nothing to search. STRIKE_LIMIT strikes within STRIKE_WINDOW_MS and the user is told off once, then ignored
// (no replies at all) for STRIKE_MUTE_MINUTES. Blocked users/roles are always ignored.
const STRIKE_WINDOW_MS = 2 * 60 * 1000;
const strikes = new Map();        // userId -> { count, first }
const mutedUntil = new Map();     // userId -> time (ms) the mute ends

function isIgnored(message) {
  const id = message.author.id;
  if (cfg.BLOCKED_USER_IDS && String(cfg.BLOCKED_USER_IDS).split(',').map(item => item.trim()).includes(id)) return true;
  if (cfg.BLOCKED_ROLE_ID && message.member?.roles?.cache?.has(cfg.BLOCKED_ROLE_ID)) return true;
  const until = mutedUntil.get(id);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  mutedUntil.delete(id);
  return false;
}

// Records a strike. Returns true when it starts a mute (the caller sends the one mute message).
function addStrike(message) {
  if (!cfg.STRIKE_LIMIT) return false;
  const id = message.author.id;
  const now = Date.now();
  const entry = strikes.get(id);
  if (!entry || now - entry.first > STRIKE_WINDOW_MS) strikes.set(id, { count: 1, first: now });
  else entry.count += 1;
  for (const [userId, item] of strikes) if (now - item.first > STRIKE_WINDOW_MS) strikes.delete(userId);   // keep the map small
  if (strikes.get(id).count < cfg.STRIKE_LIMIT) return false;
  strikes.delete(id);
  mutedUntil.set(id, now + cfg.STRIKE_MUTE_MINUTES * 60 * 1000);
  console.log(`[spam] Ignoring ${message.author.tag || id} (${id}) for ${cfg.STRIKE_MUTE_MINUTES} min.`);
  logStatus(`🔇 Ignoring <@${id}> for ${cfg.STRIKE_MUTE_MINUTES} minutes (too many !get requests).`);
  return true;
}

// What a user hears, once, when their last strike mutes them. After this the bot says nothing more until the mute ends.
function muteMessage(minutes) {
  const time = minutes === 1 ? '**1 minute**' : `**${minutes} minutes**`;
  const lines = [
    `Pipe down, will ya... 😒 You're bothering me. I won't be answering you for the next ${time}.`,
    `Pipe down, will ya... 😒 You're bothering me. Not a word out of me for ${time}. Go touch some grass. 🌱`,
    `Wow. Spamming me like I'm a vending machine. 🥤 I'm muting you for ${time}. Sit down and think about what you've done. 🪑`,
    `That's it, I'm out. 🚪 Ignoring you for ${time}. Come back when you've learned patience. 🧘`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

// Replies to a !get that cannot be served. The strike that reaches the limit gets the mute message instead.
function strikeReply(message, content, quiet) {
  if (addStrike(message)) return message.reply({ content: muteMessage(cfg.STRIKE_MUTE_MINUTES), ...quiet });
  return message.reply({ content, ...quiet });
}
// How long recent successful searches took, used to tell a waiting user roughly how long to wait.
const searchDurations = [];
const SEARCH_ESTIMATE_DEFAULT_MS = 30 * 1000;   // used until a search has finished since the bot started

// ----------------------------------------------------------------- status log
// Messages are sent one at a time, in order. A failure here (missing channel, no
// permission, Discord outage) is printed once to the terminal and never affects the bot.
let logQueue = Promise.resolve();
let logErrorShown = false;

function logStatus(text) {
  if (!cfg.LOG_CHANNEL_ID || !client) return logQueue;
  logQueue = logQueue.then(async () => {
    try {
      const channel = await client.channels.fetch(cfg.LOG_CHANNEL_ID);
      await channel.send({ content: String(text).slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (error) {
      if (!logErrorShown) {
        logErrorShown = true;
        console.error(`Could not post to the log channel ${cfg.LOG_CHANNEL_ID}: ${error && error.message}`);
      }
    }
  });
  return logQueue;
}

async function flushStatusLog(maxMs = 3000) {
  await Promise.race([logQueue, new Promise(resolve => setTimeout(resolve, maxMs))]);
}

function who(interaction) {
  return interaction && interaction.user ? escapeMarkdown(interaction.user.tag) : 'unknown';
}

function elapsedText(job) {
  return formatEta(Math.floor((Date.now() - job.startedAt) / 1000)) || '0s';
}

// -------------------------------------------------------------------- helpers
function filenameFromRemote(remotePath) {
  const clean = remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function tail(text, max = 1600) {
  return text.length > max ? text.slice(-max) : text;
}

// Which remotes /index may read is the L.allowedRemotes setting (settings.py only, not /settings):
// a Manage Server member must not be able to point rclone at any configured remote, a local path,
// or an on-the-fly ":backend:" string.

// Returns an error message, or null if the path is acceptable.
function remoteProblem(value) {
  if (typeof value !== 'string' || !value) return 'Empty path.';
  if (value.startsWith('-')) return 'Invalid path (no leading "-").';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Invalid path (control characters).';
  const colon = value.indexOf(':');
  if (colon <= 0) return 'Use the form `remote:path/to/file` (local paths and ":backend:" strings are not allowed).';
  const remote = value.slice(0, colon);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(remote)) return 'Invalid remote name.';
  if (L.allowedRemotes.size === 0) return 'No remotes are enabled. Set ALLOWED_REMOTES in settings.py.';
  if (!L.allowedRemotes.has(remote)) return 'That remote is not enabled for indexing.';
  if (value.slice(colon + 1).split(/[\\/]/).includes('..')) return 'Invalid path (no "..").';
  return null;
}

function validRemote(value) {
  return remoteProblem(value) === null;
}

// Children are spawned in their own process group so cancelling also stops
// everything they started (rclone, python, ffmpeg).
function signalGroup(child, signal) {
  if (!child || child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function stopChild(job) {
  const child = job && job.child;
  if (!child) return;
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref();
}

// ------------------------------------------------------- progress: formatting
// Terminal progress is redrawn in place on a real terminal (cheap, so 2 s). When output is
// piped to a file it cannot be redrawn, so it is written rarely to keep the log small.
const TERM_PROGRESS_INTERVAL_MS = process.stdout.isTTY ? 2000 : 30000;
const DISCORD_MIN_INTERVAL_MS = 3000;     // Discord: at most one edit per 3 s (coalesced)
const DISCORD_MAX_FAILURES = 5;           // consecutive edit failures before giving up on Discord
const MAX_LINE_CHARS = 64 * 1024;         // guard against a child printing without newlines
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i === 0 ? Math.round(value) : value.toFixed(2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  const text = formatBytes(bytesPerSec);
  return text === null ? null : `${text}/s`;
}

function formatEta(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  let s = Math.round(seconds);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatCount(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?';
}

function formatRate(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : null;
}

function percentOf(part, whole) {
  if (typeof part !== 'number' || typeof whole !== 'number' || !(whole > 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((part / whole) * 100)));
}

// 75 -> "1:15", 3725 -> "1:02:05"
function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.round(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function shortName(name, max = 150) {
  const clean = String(name || '').replace(/`/g, "'").replace(/[\u0000-\u001f]/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function displayDbPath() {
  const home = os.homedir();
  return DB_PATH.startsWith(home) ? `~${DB_PATH.slice(home.length)}` : DB_PATH;
}

// ----------------------------------------------------- progress: line handling
// Splits a byte stream into lines. "\n", "\r" and "\r\n" all end a line, because
// rclone-style progress rewrites the same terminal line with "\r". Partial
// chunks are buffered until their line ends (or the child exits).
class LineSplitter {
  constructor(onLine) {
    this.buffer = '';
    this.onLine = onLine;
  }

  push(text) {
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c === '\n' || c === '\r') {
        this.emit(this.buffer.slice(start, i));
        start = i + 1;
      }
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.emit(this.buffer);
      this.buffer = '';
    }
  }

  end() {
    if (this.buffer) this.emit(this.buffer);
    this.buffer = '';
  }

  emit(line) {
    const clean = line.replace(ANSI_RE, '').trim();
    if (clean) this.onLine(clean);
  }
}

const BYTE_UNIT = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };

function unitToBytes(value, unit) {
  const v = parseFloat(value);
  const mult = BYTE_UNIT[String(unit || 'B')[0].toLowerCase()];
  return Number.isFinite(v) && mult ? Math.round(v * mult) : null;
}

function parseEtaText(text) {
  if (!text) return null;
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    found = true;
    total += parseFloat(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 }[m[2].toLowerCase()]);
  }
  return found ? total : null;
}

// Fallback for rclone text statistics ("1.25 GiB / 2.4 GiB, 52%, 8.5 MiB/s, ETA 2m15s").
// Every field is extracted independently, so a missing or reordered field only
// leaves that value null.
function parseRcloneText(text) {
  const unit = '[KMGTP]?i?B(?:ytes)?';
  const pair = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unit})\\s*/\\s*(\\d+(?:\\.\\d+)?)\\s*(${unit})`, 'i').exec(text);
  const pct = /(?:^|[\s,(])(\d{1,3})%/.exec(text);
  const speed = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unit})/s`, 'i').exec(text);
  const eta = /ETA\s+([0-9dhms.\-]+)/i.exec(text);
  if (!pair && !(pct && (speed || eta))) return null;
  const bytes = pair ? unitToBytes(pair[1], pair[2]) : null;
  let total = pair ? unitToBytes(pair[3], pair[4]) : null;
  if (total !== null && total <= 0) total = null;
  let percent = pct ? Math.min(100, parseInt(pct[1], 10)) : null;
  if (percent === null) percent = percentOf(bytes, total);
  return {
    type: 'download_progress',
    bytes,
    total,
    percent,
    speed: speed ? unitToBytes(speed[1], speed[2]) : null,
    eta: eta ? parseEtaText(eta[1]) : null,
  };
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// rclone --use-json-log: every statistics line carries a "stats" object with raw numbers.
function rcloneStatsEvent(obj) {
  const s = obj && obj.stats;
  if (!s || typeof s !== 'object') return null;
  const t = Array.isArray(s.transferring) && s.transferring.length ? s.transferring[0] : null;
  const bytes = finiteOrNull(t && t.bytes) ?? finiteOrNull(s.bytes);
  let total = finiteOrNull(t && t.size);
  if (total === null && finiteOrNull(s.totalBytes) > 0) total = s.totalBytes;
  if (total !== null && total <= 0) total = null;
  let percent = finiteOrNull(t && t.percentage);
  if (percent === null) percent = percentOf(bytes, total);
  return {
    type: 'download_progress',
    bytes,
    total,
    percent: percent === null ? null : Math.min(100, Math.round(percent)),
    speed: finiteOrNull(s.speed) ?? finiteOrNull(t && t.speed),
    eta: finiteOrNull(s.eta) ?? finiteOrNull(t && t.eta),
    errors: finiteOrNull(s.errors),
    lastError: typeof s.lastError === 'string' && s.lastError.trim() ? s.lastError.trim() : null,
  };
}

const BASH_EVENT_TYPES = new Set([
  'scan_start', 'scan_progress', 'scan_done', 'skip', 'download_start',
  'download_done', 'fingerprint_start', 'file_done', 'file_failed', 'summary',
]);

// Turns one output line from ANY child (bash, rclone, python; stdout or stderr)
// into either a progress event or a plain log line. The line itself, not the
// stream it arrived on, decides how it is treated, so reordering between the
// two pipes cannot confuse the parser.
function parseChildLine(line, state) {
  if (line.startsWith('JADE_EVENT ')) {
    try {
      const ev = JSON.parse(line.slice(11));
      if (ev && typeof ev.type === 'string' && BASH_EVENT_TYPES.has(ev.type)) return ev;
    } catch { /* fall through: show it as a normal line */ }
    return { type: 'log', text: line };
  }

  if (line.startsWith('JADE_PROGRESS ')) {
    try {
      const ev = JSON.parse(line.slice(14));
      if (ev && ev.type === 'fingerprint') {
        return {
          type: 'fingerprint_progress',
          processed: finiteOrNull(ev.processed_seconds),
          total: finiteOrNull(ev.total_seconds),
          speed: finiteOrNull(ev.speed),
          final: ev.final === true,
          resumed: ev.resumed === true,
          structured: true,
        };
      }
    } catch { /* fall through */ }
    return { type: 'log', text: line };
  }

  if (line.startsWith('{')) {
    let obj = null;
    try { obj = JSON.parse(line); } catch { /* not JSON after all */ }
    if (obj && typeof obj === 'object') {
      const stats = rcloneStatsEvent(obj);
      if (stats) return stats;
      if (typeof obj.msg === 'string') {
        // An rclone without JSON statistics may still put the text block in "msg".
        if (state.phase === 'downloading') {
          const fromText = parseRcloneText(obj.msg);
          if (fromText) return fromText;
        }
        const level = String(obj.level || '').toLowerCase();
        return { type: 'log', text: `[rclone] ${level ? `${level.toUpperCase()}: ` : ''}${obj.msg.trim()}` };
      }
    }
  }

  const human = /^Processed\s+([\d,]+)\s*(?:seconds|source-sec)[^\d]*([\d.]+)\s*source-sec\/sec/i.exec(line);
  if (human) {
    // The Python script prints this human line next to its structured event.
    // Once structured events are flowing for this file the human line is a duplicate.
    if (state.file && state.file.fp && state.file.fp.structured) return null;
    return {
      type: 'fingerprint_progress',
      processed: parseInt(human[1].replace(/,/g, ''), 10),
      total: null,
      speed: parseFloat(human[2]),
      final: false,
      structured: false,
    };
  }

  if (state.phase === 'downloading' && /ETA|\/s\b/i.test(line)) {
    const fromText = parseRcloneText(line);
    if (fromText) return fromText;
  }

  return { type: 'log', text: line };
}

// What ends up in the captured stdout/stderr used for error messages and the
// final summary: progress noise is dropped, JSON log lines are reduced to text.
function captureText(line) {
  if (line.startsWith('JADE_EVENT ') || line.startsWith('JADE_PROGRESS ')) return null;
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        if (obj.stats) return null;
        if (typeof obj.msg === 'string') return obj.msg.trim() || null;
      }
    } catch { /* keep the raw line */ }
  }
  return line;
}

// ------------------------------------------------------------- CPU temperature
// Same method as ui_cpu_zone / ui_temp_color in the convert script (lib-ui-kit.sh):
// pick a sysfs thermal zone ("cpu-1-7-usr" first, else the first zone whose type
// contains cpu or soc, or is x86_pkg_temp) and read it in millidegrees.
const THERMAL_ROOT = '/sys/class/thermal';
let cpuZoneFile;                        // undefined = not looked up yet, null = none found
let cpuZoneCheckedAt = 0;

function findCpuZone() {
  let pick = null;
  let names = [];
  try { names = fsSync.readdirSync(THERMAL_ROOT).filter(n => n.startsWith('thermal_zone')).sort(); } catch { return null; }
  for (const name of names) {
    const dir = path.join(THERMAL_ROOT, name);
    try {
      const type = fsSync.readFileSync(path.join(dir, 'type'), 'utf8').trim();
      const temp = fsSync.readFileSync(path.join(dir, 'temp'), 'utf8').trim();
      if (!/^[0-9]+$/.test(temp) || Number(temp) <= 0) continue;
      if (type === 'cpu-1-7-usr') return path.join(dir, 'temp');
      if (!pick && (type.includes('cpu') || type.includes('soc') || type === 'x86_pkg_temp')) pick = path.join(dir, 'temp');
    } catch { /* unreadable zone: skip it */ }
  }
  return pick;
}

// Whole degrees C, or null when no sensor can be read (same as "n/a" in the convert script).
function readCpuTemp() {
  if (cpuZoneFile === undefined || (cpuZoneFile === null && Date.now() - cpuZoneCheckedAt > 60000)) {
    cpuZoneFile = findCpuZone();
    cpuZoneCheckedAt = Date.now();
  }
  if (!cpuZoneFile) return null;
  try {
    const raw = Number(fsSync.readFileSync(cpuZoneFile, 'utf8').trim());
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw / 1000);
  } catch { /* fall through and look the zone up again next time */ }
  cpuZoneFile = undefined;
  return null;
}

// Thresholds from ui_temp_color: >=90 red, >=85 orange, >=75 yellow, else green.
function tempLevel(t) {
  return t >= 90 ? 'red' : t >= 85 ? 'orange' : t >= 75 ? 'yellow' : 'green';
}
// Exact colours of the convert script (bold + 256-colour: red 196, orange 208, yellow 226, green 82).
const TEMP_ANSI = { red: '1;38;5;196', orange: '1;38;5;208', yellow: '1;38;5;226', green: '1;38;5;82' };
const TEMP_EMOJI = { red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢' };

function cpuTempTerminal() {              // "CPU: 62°C": dim label, colour-coded value (as in the convert script)
  const t = readCpuTemp();
  if (t === null) return null;
  const text = `${t}°C`;
  if (!process.stdout.isTTY) return `CPU: ${text}`;
  return `\x1b[2mCPU:\x1b[0m \x1b[${TEMP_ANSI[tempLevel(t)]}m${text}\x1b[0m`;
}

function cpuTempDiscord() {               // "🌡️ CPU: 62°C 🟢"
  const t = readCpuTemp();
  return t === null ? null : `🌡️ CPU: ${t}°C ${TEMP_EMOJI[tempLevel(t)]}`;
}

// ---------------------------------------------------------- progress: terminal
// Live area: the progress lines at the bottom of the terminal. Each update erases the
// previous block and draws the new one in the same place, so a long job never floods
// the screen. Any normal log line first erases the live block and takes its place.
let liveRows = 0;

function termWrite(text, stream = 'stdout', keepLive = false) {
  try {
    if (!keepLive) termClearLive();
    (stream === 'stderr' ? process.stderr : process.stdout).write(text);
  } catch { /* the terminal is gone; indexing must continue */ }
}

function termClearLive() {
  if (liveRows <= 0) return;
  const rows = liveRows;
  liveRows = 0;
  try { process.stdout.write(`\x1b[${rows}F\x1b[J`); } catch { /* terminal gone */ }
}

function termLive(lines) {
  if (!lines.length) return;
  if (!process.stdout.isTTY) {              // a file or pipe cannot be redrawn: plain lines
    for (const line of lines) termLog(line);
    return;
  }
  termClearLive();
  const cols = process.stdout.columns || 80;
  termWrite(lines.join('\n') + '\n', 'stdout', true);
  liveRows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.replace(/\x1b\[[0-9;]*m/g, '').length / cols)), 0);
}

function termLog(line, stream) {
  termWrite(`${line}\n`, stream);
}

function printChildLine(text, stream, label) {
  termLog(label ? `[${label}] ${text}` : text, stream);
}

// ------------------------------------------------------ progress: shared state
function newProgressState() {
  return {
    kind: 'single',        // 'single' or 'folder'
    folder: null,
    phase: 'preparing',    // preparing | scanning | queued | downloading | downloaded | fingerprinting | between
    status: 'Preparing',
    total: 0,
    scan: { listed: null, stage: null },
    counters: { indexed: 0, skipped: 0, failed: 0 },
    file: null,            // { index, name, path, size, dl: {...}, fp: {...} }
    summarySeen: false,
    failures: [],          // { name, error } of files that failed this run
    alert: null,           // { text, at }: latest rclone/indexer error for the current file
  };
}

function processedCount(state) {
  const c = state.counters;
  return c.indexed + c.skipped + c.failed;
}

// The only place progress state is changed. Terminal and Discord both render
// from this state, so they can never disagree.
function reduceEvent(job, ev) {
  const s = job.state;
  const nameOf = e => e.name || (s.file && s.file.name) || '';
  switch (ev.type) {
    case 'scan_start':
      s.phase = 'scanning';
      s.status = 'Scanning folder';
      s.folder = ev.folder || s.folder;
      s.scan = { listed: null, stage: 'listing' };
      job.phase = 'Scanning folder';
      break;
    case 'scan_progress':
      s.phase = 'scanning';
      s.status = ev.stage === 'checking' ? 'Checking index database' : 'Scanning folder';
      if (finiteOrNull(ev.listed) !== null) s.scan.listed = ev.listed;
      s.scan.stage = ev.stage || s.scan.stage;
      break;
    case 'scan_done':
      s.total = finiteOrNull(ev.found) ?? 0;
      s.scan.found = s.total;
      s.scan.alreadyIndexed = finiteOrNull(ev.indexed);
      s.phase = 'queued';
      s.status = s.total > 0 ? 'Starting' : 'No videos found';
      job.phase = 'Indexing folder';
      break;
    case 'skip':
      s.total = finiteOrNull(ev.total) ?? s.total;
      s.counters.skipped++;
      s.file = { index: ev.index, name: nameOf(ev), path: ev.path, dl: {}, fp: {} };
      s.alert = null;
      s.phase = 'between';
      s.status = 'Skipped (already indexed)';
      break;
    case 'download_start':
      s.total = finiteOrNull(ev.total) ?? s.total;
      s.file = { index: ev.index, name: nameOf(ev), path: ev.path, size: finiteOrNull(ev.size), dl: {}, fp: {} };
      s.phase = 'downloading';
      s.status = 'Downloading';
      s.alert = null;
      job.phase = s.kind === 'folder' ? 'Indexing folder' : 'Downloading';
      job.termLast = {};
      break;
    case 'download_progress':
      if (s.phase !== 'downloading' || !s.file) break;   // late stats from a finished download
      // rclone keeps retrying after an error and the byte count just stops moving: show why.
      if (ev.lastError && ev.errors > 0 && (!s.alert || s.alert.text !== ev.lastError)) {
        s.alert = { text: ev.lastError.slice(0, 250), at: Date.now() };
      }
      s.file.dl = {
        bytes: ev.bytes,
        total: ev.total ?? (s.file.size || null),
        percent: ev.percent,
        speed: ev.speed,
        eta: ev.eta,
      };
      if (s.file.dl.percent === null || s.file.dl.percent === undefined) {
        s.file.dl.percent = percentOf(ev.bytes, s.file.dl.total);
      }
      break;
    case 'download_done':
      if (!s.file) break;
      s.phase = 'downloaded';
      s.status = 'Download complete';
      s.file.dl = { ...s.file.dl, bytes: ev.bytes ?? s.file.dl.bytes, total: ev.bytes ?? s.file.dl.total, percent: 100, eta: 0 };
      break;
    case 'fingerprint_start':
      if (!s.file) break;
      s.phase = 'fingerprinting';
      s.status = 'Fingerprinting';
      s.file.fp = {};
      job.phase = s.kind === 'folder' ? 'Indexing folder' : 'Indexing';
      job.termLast = {};
      break;
    case 'fingerprint_progress': {
      if (s.phase !== 'fingerprinting' || !s.file) break;
      const prev = s.file.fp || {};
      const total = ev.total ?? prev.total ?? null;
      const processed = ev.processed ?? prev.processed ?? null;
      s.file.fp = {
        processed,
        total,
        percent: percentOf(processed, total),
        speed: ev.speed ?? prev.speed ?? null,
        resumedFrom: prev.resumedFrom ?? (ev.resumed ? processed : null),   // seconds already done by an earlier run
        structured: prev.structured || ev.structured === true,
      };
      break;
    }
    case 'file_done':
      s.counters.indexed++;
      s.alert = null;
      if (s.file) s.file.finished = true;
      s.phase = 'between';
      s.status = 'Completed';
      break;
    case 'file_failed':
      s.counters.failed++;
      s.alert = null;                      // the failure reason is shown instead
      if (!s.file || s.file.index !== ev.index) {
        s.file = { index: ev.index, name: nameOf(ev), path: ev.path, dl: {}, fp: {} };
      }
      s.file.finished = true;
      s.file.error = ev.error || 'Failed';
      if (s.failures.length < 50) s.failures.push({ name: s.file.name, error: s.file.error });
      s.phase = 'between';
      s.status = 'Failed';
      break;
    case 'summary':
      s.summarySeen = true;
      s.total = finiteOrNull(ev.total) ?? s.total;
      s.counters = {
        indexed: finiteOrNull(ev.indexed) ?? s.counters.indexed,
        skipped: finiteOrNull(ev.skipped) ?? s.counters.skipped,
        failed: finiteOrNull(ev.failed) ?? s.counters.failed,
      };
      break;
    default:
      break;
  }
}

function overallLines(state) {
  if (state.kind !== 'folder') return [];
  const c = state.counters;
  const remaining = Math.max(0, state.total - processedCount(state));
  return ['', 'Overall:', `Indexed: ${c.indexed} | Skipped: ${c.skipped} | Failed: ${c.failed} | Remaining: ${remaining}`];
}

function downloadTextLines(dl, fallbackTotal) {
  const bytes = formatBytes(dl.bytes);
  const total = formatBytes(dl.total ?? fallbackTotal);
  let transferred = null;
  if (bytes !== null) {
    transferred = `Transferred: ${bytes}${total ? ` / ${total}` : ''}`;
    if (dl.percent !== null && dl.percent !== undefined) transferred += ` (${dl.percent}%)`;
  } else if (dl.percent !== null && dl.percent !== undefined) {
    transferred = `Transferred: ${dl.percent}%`;
  }
  const speed = formatSpeed(dl.speed);
  const eta = formatEta(dl.eta);
  const second = [speed && `Speed: ${speed}`, eta && `ETA: ${eta}`].filter(Boolean).join(' | ');
  return [transferred, second || null].filter(Boolean);
}

// ["Processed: 300 source-sec", "Speed: 12.4 source-sec/sec"]; fields that were
// not reported by the indexer are simply left out.
function fingerprintParts(fp) {
  if (!fp || fp.processed === null || fp.processed === undefined) return [];
  let processed = `Processed: ${formatCount(fp.processed)} source-sec`;
  if (fp.total) processed += ` / ${formatCount(fp.total)} source-sec${fp.percent !== null ? ` (${fp.percent}%)` : ''}`;
  const rate = formatRate(fp.speed);
  const parts = rate === null ? [processed] : [processed, `Speed: ${rate} source-sec/sec`];
  // ffmpeg itself reports no ETA: work it out from the remaining source seconds and the current speed.
  if (fp.total && fp.speed > 0 && fp.processed < fp.total) {
    const eta = formatEta((fp.total - fp.processed) / fp.speed);
    if (eta) parts.push(`ETA: ${eta}`);
  }
  return parts;
}

function termThrottle(job, key, force) {
  const now = Date.now();
  job.termLast = job.termLast || {};
  if (!force && now - (job.termLast[key] || 0) < TERM_PROGRESS_INTERVAL_MS) return false;
  job.termLast[key] = now;
  return true;
}

// Appends the CPU temperature to the last line of a progress block (omitted when unreadable).
function withTemp(lines) {
  const temp = cpuTempTerminal();
  if (!temp || !lines.length) return lines;
  const out = lines.slice();
  out[out.length - 1] += ` | ${temp}`;
  return out;
}

function live(lines) {
  lines.live = true;                        // redrawn in place by termLive()
  return lines;
}

function terminalLinesFor(job, ev) {
  const s = job.state;
  const f = s.file;
  const idx = ev.index ?? (f && f.index);
  const tag = idx !== undefined && idx !== null ? `[${idx}/${ev.total ?? s.total}]` : '';
  const name = ev.name || (f && f.name) || '';
  switch (ev.type) {
    case 'scan_start':
      return [`[Jade] Scanning remote folder: ${ev.folder || s.folder}`];
    case 'scan_progress':
      if (ev.stage === 'checking') return [`[Jade] Listing finished (${formatCount(ev.listed)} entries). Checking the index database...`];
      return live([`[Jade] Still scanning: ${formatCount(ev.listed)} entries listed so far`]);
    case 'scan_done': {
      if (!s.total) return ['[Jade] No supported video files found.'];
      const already = finiteOrNull(ev.indexed);
      return [`[Jade] Found ${s.total} video(s)${already !== null ? ` (${already} already indexed)` : ''}.`];
    }
    case 'skip':
      return [`${tag} Skipped (already indexed): ${name}`];
    case 'download_start': {
      const size = f && f.size ? ` (${formatBytes(f.size)})` : '';
      return ['', `${tag} Downloading: ${name}${size}`];
    }
    case 'download_progress': {
      if (s.phase !== 'downloading' || !f) return [];
      const finished = f.dl.percent !== null && f.dl.percent !== undefined && f.dl.percent >= 100;
      if (!termThrottle(job, 'download', finished)) return [];
      return live(withTemp(downloadTextLines(f.dl, f.size)));
    }
    case 'download_done':
      return [`${tag} Downloaded: ${name}${f && f.dl.bytes ? ` (${formatBytes(f.dl.bytes)})` : ''}`];
    case 'fingerprint_start':
      return ['', `${tag} Indexing: ${name}`];
    case 'fingerprint_progress': {
      if (s.phase !== 'fingerprinting' || !f) return [];
      if (ev.resumed) {                                   // permanent line: this run continues an earlier one
        const of = f.fp.total ? ` of ${formatCount(f.fp.total)}` : '';
        return [`↻ Resuming from checkpoint: ${formatCount(ev.processed)}${of} source-sec already done`];
      }
      if (!ev.processed) return [];                       // the initial 0-second event is Discord-only
      if (!termThrottle(job, 'fingerprint', ev.final === true)) return [];
      const parts = fingerprintParts(f.fp);
      if (!parts.length) return [];
      // Line 1: progress. Line 2: speed, ETA and CPU temperature.
      const second = [...parts.slice(1), cpuTempTerminal()].filter(Boolean).join(' | ');
      return live(second ? [parts[0], second] : [parts[0]]);
    }
    case 'file_done':
      return ['', `${tag} Completed: ${name}`, ...overallLines(s)];
    case 'file_failed':
      return ['', `${tag} Failed: ${name}${ev.error ? ` (${ev.error})` : ''}`, ...overallLines(s)];
    default:
      return [];
  }
}

// ----------------------------------------------------------- progress: Discord
// One emoji per stage so the Discord progress message is easy to scan.
function statusEmoji(s) {
  switch (s.phase) {
    case 'preparing': return '⏳';
    case 'scanning': return '🔍';
    case 'queued': return '🚀';
    case 'downloading': return '⬇️';
    case 'downloaded': return '📥';
    case 'fingerprinting': return '🧬';
    case 'between':
      if (s.status === 'Failed') return '❌';
      if (s.status === 'Completed') return '✅';
      return '⏭️';
    default: return 'ℹ️';
  }
}

// Warning lines shown in the Discord message: the latest error and, if nothing has moved
// for a while, a "stuck" notice.
function alertLines(job) {
  const out = [];
  if (job.stalled) {
    out.push(`⚠️ No progress for ${job.stalledMinutes} min. It may be stuck; use /index-cancel to stop it.`);
  }
  if (job.state.alert) out.push(`⚠️ Error: ${shortName(job.state.alert.text, 250)}`);
  return out;
}

function renderDiscord(job) {
  const s = job.state;
  const f = s.file;
  const lines = [];

  if (s.kind === 'folder') {
    lines.push('📦 **Jade Bulk Indexing**');
    if (s.folder) lines.push(`📁 Folder: \`${shortName(s.folder, 200)}\``);
    lines.push('');
    if (s.phase === 'preparing' || s.phase === 'scanning') {
      lines.push(`${statusEmoji(s)} Status: ${s.status}`);
      if (s.scan.listed !== null && s.scan.listed !== undefined) {
        lines.push(`🔍 Entries listed so far: ${formatCount(s.scan.listed)}`);
      }
      lines.push(...alertLines(job));
      return lines.join('\n');
    }
    const done = processedCount(s);
    const pct = s.total > 0 ? (Math.floor((done / s.total) * 1000) / 10).toFixed(1) : null;
    lines.push(`📊 Progress: ${done} / ${s.total}${pct !== null ? ` (${pct}%)` : ''}`);
    lines.push('');
  } else {
    lines.push('📦 **Jade Indexing**');
  }

  if (f && f.name) {
    lines.push(s.kind === 'folder' ? `🎞️ **Current file** (#${f.index}):` : '🎞️ **File:**');
    lines.push(`\`${shortName(f.name)}\``);
  }
  lines.push(`${statusEmoji(s)} Status: ${s.status}`);

  if (f && s.phase === 'downloading') {
    const dl = f.dl || {};
    const bytes = formatBytes(dl.bytes);
    const total = formatBytes(dl.total ?? f.size);
    if (bytes !== null) {
      const pctText = dl.percent !== null && dl.percent !== undefined ? ` (${dl.percent}%)` : '';
      lines.push(`⬇️ Downloaded: ${bytes}${total ? ` / ${total}` : ''}${pctText}`);
    }
    const speed = formatSpeed(dl.speed);
    const eta = formatEta(dl.eta);
    if (speed) lines.push(`⚡ Speed: ${speed}`);
    if (eta) lines.push(`⏱️ ETA: ${eta}`);
    const temp = cpuTempDiscord();
    if (temp) lines.push(temp);
  } else if (f && s.phase === 'fingerprinting') {
    if (f.fp && f.fp.resumedFrom) lines.push(`↻ Resumed from checkpoint (${formatCount(f.fp.resumedFrom)} source-sec already done)`);
    lines.push(...fingerprintParts(f.fp).map(part => (part.startsWith('Speed') ? `⚡ ${part}` : part.startsWith('ETA') ? `⏱️ ${part}` : `🧬 ${part}`)));
    lines.push(`🧵 Threads: ${threadsLabel(job)}`);
    const temp = cpuTempDiscord();
    if (temp) lines.push(temp);
  } else if (f && f.error && s.status === 'Failed') {
    lines.push(`❗ Reason: ${shortName(f.error, 200)}`);
  }
  lines.push(...alertLines(job));

  if (s.kind === 'folder') {
    lines.push('');
    lines.push(`✅ Indexed: ${s.counters.indexed}`);
    lines.push(`⏭️ Skipped: ${s.counters.skipped}`);
    lines.push(`❌ Failed: ${s.counters.failed}`);
  }
  return lines.join('\n');
}

// One call per progress event: update the shared state once, then hand the
// same state to the terminal and to Discord. Neither sink can break the other
// or the indexing job.
function reportEvent(job, ev) {
  try {
    reduceEvent(job, ev);
  } catch (error) {
    termLog(`[Jade] Progress state error: ${error.message}`, 'stderr');
    return;
  }
  try {
    const lines = terminalLinesFor(job, ev);
    if (lines.live) termLive(lines);
    else for (const line of lines) termLog(line);
  } catch (error) {
    termLog(`[Jade] Terminal progress error: ${error.message}`, 'stderr');
  }
  try {
    editJobReply(job, renderDiscord(job));
  } catch (error) {
    termLog(`[Jade] Discord progress error: ${error.message}`, 'stderr');
  }
}

// Real progress = new bytes, new fingerprinted seconds, more listed entries, or any
// state-changing event. rclone prints statistics every 2 s even when it is stuck, so
// the mere arrival of output does not count.
function markProgress(job, ev) {
  const s = job.state;
  const f = s.file;
  let moved = true;
  if (ev.type === 'log') moved = false;
  else if (ev.type === 'download_progress') moved = !f || !f.dl || ev.bytes !== f.dl.bytes;
  else if (ev.type === 'fingerprint_progress') moved = !f || !f.fp || ev.processed !== f.fp.processed;
  else if (ev.type === 'scan_progress') moved = ev.listed !== s.scan.listed;
  if (moved) {
    job.lastProgressAt = Date.now();
    job.stalled = false;
  }
}

function raiseAlert(job, text) {
  job.state.alert = { text: text.slice(0, 250), at: Date.now() };
  if (!job.finished) {
    try { editJobReply(job, renderDiscord(job)); } catch { /* terminal output continues */ }
  }
  const now = Date.now();
  if (now - (job.alertNotifiedAt || 0) >= L.alertGapMs) {
    job.alertNotifiedAt = now;
    logStatus(`⚠️ Indexing error (still running): **${escapeMarkdown(shortName(job.filename))}**\n\`${text.slice(0, 500).replace(/`/g, "'")}\``);
  }
}

// Wakes every 30 s. If nothing has moved for L.stallMs, edits the Discord message to say so
// (nothing else would, because no progress events arrive) and sends one DM + log message.
function startWatchdog(job) {
  const timer = setInterval(() => {
    if (job.finished || job.cancelled || activeJob !== job) { clearInterval(timer); return; }
    const idle = Date.now() - job.lastProgressAt;
    if (idle < L.stallMs) return;
    job.stalledMinutes = Math.floor(idle / 60000);
    const first = !job.stalled;
    job.stalled = true;
    try { editJobReply(job, renderDiscord(job)); } catch { /* ignore */ }
    if (first) {
      const reason = job.state.alert ? `\nLast error: \`${job.state.alert.text.slice(0, 400).replace(/`/g, "'")}\`` : '';
      const text = `⚠️ Indexing may be stuck: **${escapeMarkdown(shortName(job.filename))}** has made no progress for ${job.stalledMinutes} min.${reason}\nCheck the console or use /index-cancel.`;
      logStatus(text);
      if (job.interaction && job.interaction.user) job.interaction.user.send({ content: text.slice(0, 1900) }).catch(() => {});
    }
  }, STALL_CHECK_MS);
  timer.unref();
}

function handleChildLine(job, line, stream) {
  let ev;
  try {
    ev = parseChildLine(line, job.state);
  } catch {
    ev = { type: 'log', text: line };
  }
  if (ev === null) return;
  markProgress(job, ev);
  if (ev.type === 'log') {
    // Errors used to reach only the terminal. Surface them in Discord as well.
    const errLine = /^(?:\[rclone\] (?:ERROR|CRITICAL|FATAL)|INDEX ERROR):\s*(.*)$/s.exec(ev.text);
    if (stream === 'stderr' && errLine && errLine[1].trim()) raiseAlert(job, errLine[1].trim());
    // Remember the last stderr message of the current file: it is the real
    // reason if the file then fails (e.g. "INDEX ERROR: ffprobe could not read...").
    if (stream === 'stderr') job.lastStderr = ev.text.replace(/^(?:INDEX ERROR|\[rclone\] (?:ERROR|CRITICAL)):\s*/, '').slice(0, 300);
    printChildLine(ev.text, stream);
    return;
  }
  if (ev.type === 'download_start') job.lastStderr = null;
  if (ev.type === 'file_failed' && job.lastStderr && (ev.stage === 'download' || ev.stage === 'fingerprint')) {
    ev = { ...ev, error: `${ev.error}: ${job.lastStderr}` };
  }
  reportEvent(job, ev);
  trackFailureStreak(job, ev);
}

// A run where every download fails (the same rclone problem each time) would grind through the
// whole folder one failure at a time. Stop it early and say why.
function trackFailureStreak(job, ev) {
  if (job.state.kind !== 'folder' || job.cancelled) return;
  if (ev.type === 'file_done') { job.failStreak = 0; return; }
  if (ev.type !== 'file_failed' || ev.stage !== 'download') return;
  job.failStreak = (job.failStreak || 0) + 1;
  if (job.failStreak < cfg.MAX_DOWNLOAD_FAILS) return;
  job.abortReason = `Stopped after ${job.failStreak} downloads in a row failed. Last error: ${ev.error || 'unknown'}`;
  job.cancelled = true;
  job.cancelReason = job.abortReason;
  stopChild(job);
}

// ------------------------------------------------------------ child processes
// Runs a child in its own process group. Every output line, from stdout and
// stderr alike, is passed to options.onLine(line, stream) as soon as it is
// complete (default: print it to the Termux terminal). The captured text kept
// for errors/summaries has progress noise removed.
function runProcess(command, args, job, options = {}) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error(job.cancelReason || 'Cancelled.'));

    const { onLine, label, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...spawnOptions,
    });
    job.child = child;
    let stdout = '';
    let stderr = '';

    const makeSplitter = stream => new LineSplitter(line => {
      const text = captureText(line);
      if (text !== null) {
        if (stream === 'stdout') stdout = tail(`${stdout}${text}\n`, 12000);
        else stderr = tail(`${stderr}${text}\n`, 12000);
      }
      try {
        if (onLine) onLine(line, stream);
        else printChildLine(line, stream, label);
      } catch (error) {
        termLog(`[Jade] Output handler error: ${error.message}`, 'stderr');
      }
    });
    const outSplitter = makeSplitter('stdout');
    const errSplitter = makeSplitter('stderr');

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => outSplitter.push(chunk));
    child.stderr.on('data', chunk => errSplitter.push(chunk));
    child.on('error', error => {
      if (job.child === child) job.child = null;
      reject(error);
    });
    child.on('close', (code, signal) => {
      outSplitter.end();
      errSplitter.end();
      if (job.child === child) job.child = null;
      if (job.cancelled) return reject(new Error(job.cancelReason || 'Cancelled.'));
      if (code === 0) return resolve({ stdout, stderr });
      const details = tail(stderr.trim() || stdout.trim() || `Process exited with code ${code}${signal ? ` (${signal})` : ''}`);
      reject(new Error(details));
    });
  });
}

// Child environment: structured progress on, Python unbuffered, FFmpeg thread count.
function progressEnv(job) {
  const env = { ...process.env, JADE_EVENTS: '1', PYTHONUNBUFFERED: '1' };
  env.JADE_FFMPEG_THREADS = String(job && Number.isInteger(job.threads) ? job.threads : cfg.DEFAULT_THREADS);   // /index threads: option, else the DEFAULT_THREADS setting
  return env;
}

// The thread setting a job really uses: the /index option, else the environment, else 1.
function threadsLabel(job) {
  const t = job && Number.isInteger(job.threads) ? job.threads : cfg.DEFAULT_THREADS;
  return String(t) === '0' ? 'auto' : String(t);
}

// rclone: --use-json-log gives raw byte counts/speed/ETA (no text scraping);
// --stats-log-level NOTICE makes it print them without -v.
// --contimeout/--timeout make a dead connection fail (and show an error) instead of hanging.
const RCLONE_PROGRESS_ARGS = ['--stats', '2s', '--use-json-log', '--stats-log-level', 'NOTICE', '--contimeout', '30s', '--timeout', '90s'];

// Removes the temp download and rclone's leftover "<name>.<random>.partial" files.
async function removeTempDownload(tempFile) {
  const dir = path.dirname(tempFile);
  const base = path.basename(tempFile);
  const stem = base.slice(0, base.length - path.extname(base).length);
  await fs.rm(tempFile, { force: true }).catch(() => {});
  try {
    for (const entry of await fs.readdir(dir)) {
      if (entry.startsWith(`${stem}.`)) await fs.rm(path.join(dir, entry), { force: true }).catch(() => {});
    }
  } catch { /* directory missing: nothing to clean */ }
}

// "anyone has SL-341?" -> answer if a filename in the index contains that code.
// Trigger (case-insensitive): any|some + one|body + got|has|have|share, e.g.
//   "anyone has SL-341", "Does somebody have SL-341?", "someone got sl341"
const ARCHIVE_TRIGGER_RE = /\b(?:any|some)\s*(?:one|body)\s+(?:got|has|have|share)\b(.*)/i;
// Codes in the rest of the message: 2+ letters, optional separator, 2+ digits (SL-341, sl341, SL 341).
const ARCHIVE_CODE_RE = /\b[A-Za-z]{2,10}[\s_-]?\d{2,8}\b/g;
const haveCooldown = new Map();
// Videos whose code starts with a prefix listed in PREFIX_CHANNELS (SR=123...,SL=456...) are answered with that
// prefix's channel. Any other prefix falls back to ARCHIVE_CHANNEL_ID (or "the archive" when that is blank).
function prefixChannel(prefix) {
  for (const item of String(cfg.PREFIX_CHANNELS || '').split(',')) {
    const [name, channelId] = item.split('=');
    if (name && channelId && name.trim().toUpperCase() === prefix) return channelId.trim();
  }
  return '';
}

// !get runs in CHANNEL_ID and "anyone has CODE?" runs in REQUEST_CHANNEL_ID. Both reveal what is in
// the archive, so blank turns them OFF; * means every channel the bot can read.
function channelInList(message, ids) {
  if (ids.size === 0) return false;
  if (ids.has('*')) return true;
  const channel = message.channel;
  return ids.has(message.channelId) || Boolean(channel && channel.parentId && ids.has(channel.parentId));
}
const getChannelAllowed = message => channelInList(message, L.getChannelIds);
const requestChannelAllowed = message => channelInList(message, L.requestChannelIds);

function archiveQuery(message) {
  if (!requestChannelAllowed(message)) return [];
  const m = ARCHIVE_TRIGGER_RE.exec(message.content);
  if (!m) return [];
  const found = m[1].match(ARCHIVE_CODE_RE) || [];
  return [...new Set(found.map(code => code.trim()))].slice(0, cfg.MAX_CODES_PER_MESSAGE);
}

async function answerArchiveQuestion(message, codes) {
  const quiet = { allowedMentions: { parse: [], repliedUser: false } };
  const now = Date.now();
  if (now - (haveCooldown.get(message.author.id) || 0) < L.haveCooldownMs) return;
  haveCooldown.set(message.author.id, now);
  for (const [userId, time] of haveCooldown) if (now - time > L.haveCooldownMs * 6) haveCooldown.delete(userId);
  if (!fsSync.existsSync(MATCHER_PATH) || !fsSync.existsSync(DB_PATH)) return;

  const job = { cancelled: false, cancelReason: 'Cancelled.', child: null };
  const timer = setTimeout(() => { job.cancelled = true; stopChild(job); }, 15 * 1000);
  try {
    const inArchive = [];
    for (const code of codes) {
      const result = await runProcess('python', [MATCHER_PATH, '--find', code], job, { onLine: () => {} });
      if (result.stdout.trim()) inArchive.push(code.toUpperCase());
    }
    if (inArchive.length) {
      const defaultWhere = cfg.ARCHIVE_CHANNEL_ID ? `<#${cfg.ARCHIVE_CHANNEL_ID}>` : 'the archive';
      const lines = inArchive.map(code => {
        const prefix = (/^[A-Z]+/.exec(code) || [''])[0];
        const channelId = prefixChannel(prefix);
        const where = channelId ? `<#${channelId}>` : defaultWhere;
        return `✅ **${escapeMarkdown(code)}** is in ${where}`;
      });
      await message.reply({ content: lines.join('\n'), ...quiet });
    }
    // Nothing found: stay silent, the question may be for other members.
  } catch (error) {
    console.error('Archive lookup failed:', error.message);
    logStatus(`⚠️ Archive lookup failed: ${tail(error.message, 600).replace(/`/g, "'")}`);
  } finally {
    clearTimeout(timer);
    stopChild(job);
  }
}

// A hard kill (Termux closing the app, power loss) can leave downloads behind.
// At startup nothing is running yet, so anything old enough in the temp folder
// is garbage. vindex-folder.sh clears its own vindex-bulk-* files itself.
const STALE_TEMP_MS = 60 * 60 * 1000;
async function sweepTempDir() {
  let removed = 0;
  try {
    for (const entry of await fs.readdir(TEMP_DIR)) {
      const full = path.join(TEMP_DIR, entry);
      try {
        const st = await fs.stat(full);
        if (st.isFile() && Date.now() - st.mtimeMs > STALE_TEMP_MS) {
          await fs.rm(full, { force: true });
          removed++;
        }
      } catch { /* vanished or unreadable: skip */ }
    }
  } catch { /* temp folder does not exist yet */ }
  if (removed) console.log(`Removed ${removed} stale temporary file(s) from ${TEMP_DIR}.`);
}

// ------------------------------------------------------------ Discord replies
function tokenStillValid(job) {
  return Date.now() - job.startedAt < INTERACTION_TTL_MS;
}

// Progress edits go to the original (ephemeral) reply while its token is valid.
// They are coalesced: at most one edit every DISCORD_MIN_INTERVAL_MS and never
// two in flight, and the newest content always wins. Once the token has expired
// they are skipped; the person is told once, by DM, that the job is still
// running and gets the final result by DM as well. Failures never throw.
function editJobReply(job, content) {
  job.progress = content;                  // also what /index-status shows
  if (!job.interaction || job.finished) return;
  // Once the interaction token is expired (or edits to it failed), progress moves
  // to a DM message that is edited in place until the job ends.
  if ((!tokenStillValid(job) || job.replyClosed) && job.handoffFailed) return;
  job.pendingContent = content;
  scheduleReply(job);
}

function scheduleReply(job) {
  if (job.finished || job.pendingContent === null) return;
  if (job.replyInFlight) return;           // sendReply re-schedules when it finishes
  const wait = Math.max(0, DISCORD_MIN_INTERVAL_MS - (Date.now() - job.lastReplyUpdate));
  if (wait > 0) {
    if (!job.replyTimer) {
      job.replyTimer = setTimeout(() => {
        job.replyTimer = null;
        scheduleReply(job);
      }, wait);
    }
    return;
  }
  job.replyPromise = sendReply(job);
}

// Where progress goes once the slash-command reply has expired: a DM if the user allows it,
// otherwise the bot's log channel (the same place its status messages already go).
async function openHandoff(job, body) {
  const options = { content: body, allowedMentions: { parse: [] } };
  try {
    const message = await job.interaction.user.send(options);
    job.handoffWhere = 'DM';
    return message;
  } catch (dmError) {
    // Discord answers "Cannot send messages to this user" (50007) whenever the user's privacy
    // settings block DMs from this server, even though the bot and user share a server.
    if (cfg.LOG_CHANNEL_ID && client) {
      try {
        const channel = await client.channels.fetch(cfg.LOG_CHANNEL_ID);
        const message = await channel.send(options);
        job.handoffWhere = 'log channel';
        termLog(`[Jade] Could not DM the progress (${dmError && dmError.message}); posting it in the log channel instead.`, 'stderr');
        return message;
      } catch { /* fall through to the original DM error */ }
    }
    throw dmError;
  }
}

async function sendReply(job) {
  const content = job.pendingContent;
  job.pendingContent = null;
  if (content === null || content === undefined) return;
  job.replyInFlight = true;
  job.lastReplyUpdate = Date.now();
  const body = content.slice(0, 1900);
  try {
    if (!job.replyClosed && tokenStillValid(job)) {
      try {
        await job.interaction.editReply({ content: body, allowedMentions: { parse: [] } });
        job.replyFailures = 0;
        return;
      } catch (error) {
        job.replyFailures += 1;
        const gone = error && (error.code === 10015 || error.code === 50027 || error.code === 10062);
        if (gone || job.replyFailures >= DISCORD_MAX_FAILURES) job.replyClosed = true;
        if (!job.replyErrorLogged) {
          job.replyErrorLogged = true;
          termLog(`[Jade] Discord progress update failed (${error && error.message}); switching to DM progress.`, 'stderr');
        }
        if (!job.replyClosed) return;      // transient error: retry on the next update
      }
    }
    // Token expired or reply gone: keep one progress message in the DMs and edit it.
    if (job.handoffFailed) return;
    try {
      if (!job.handoffMsg) {
        job.handoffMsg = await openHandoff(job, body);
      } else {
        await job.handoffMsg.edit({ content: body, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      if (job.handoffMsg && error && error.code !== 10008) return;   // transient: try again next time
      job.handoffFailed = true;            // DMs closed or message deleted
      termLog(`[Jade] Progress message unavailable (${error && error.message}); terminal output continues.`, 'stderr');
    }
  } finally {
    job.replyInFlight = false;
    if (job.pendingContent !== null && !job.finished) scheduleReply(job);
  }
}

// Final message: edit the reply if the token is still valid, otherwise DM the
// person who started the job. If DMs are closed, post only generic counts in
// the channel (never remote paths or file names).
async function finishJob(job, content, publicSummary) {
  job.finished = true;                     // no more progress edits after this point
  job.pendingContent = null;
  if (job.replyTimer) { clearTimeout(job.replyTimer); job.replyTimer = null; }
  try { await job.replyPromise; } catch { /* already handled in sendReply */ }

  const interaction = job.interaction;
  if (!interaction) return;
  if (!job.replyClosed && tokenStillValid(job)) {
    try {
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    } catch { /* fall through to DM */ }
  }
  // Finish the handoff progress message too; for a DM, also send a fresh DM so it notifies.
  let edited = false;
  if (job.handoffMsg) {
    edited = await job.handoffMsg.edit({ content: content.slice(0, 1900), allowedMentions: { parse: [] } }).then(() => true, () => false);
  }
  if (edited && job.handoffWhere !== 'DM') return;      // the log-channel message now shows the result
  try {
    await interaction.user.send({ content: edited ? (/^[❌🛑]/u.test(content) ? '⚠️ Indexing stopped, see the result above.' : '✅ Indexing finished, see the result above.') : content.slice(0, 1900) });
    return;
  } catch { /* DMs closed */ }
  try {
    await interaction.channel?.send({ content: publicSummary.slice(0, 1900), allowedMentions: { parse: [] } });
  } catch { /* nothing more we can do */ }
}

function newJob(interaction, remotePath, filename, phase) {
  return {
    remotePath,
    filename,
    phase,
    progress: '',
    startedAt: Date.now(),
    cancelled: false,
    cancelReason: 'Indexing cancelled.',
    child: null,
    interaction,
    lastReplyUpdate: 0,
    replyClosed: false,
    replyInFlight: false,
    replyPromise: null,
    replyTimer: null,
    replyFailures: 0,
    replyErrorLogged: false,
    pendingContent: null,
    finished: false,
    dmNotified: false,
    handoffMsg: null,
    handoffFailed: false,
    termLast: {},
    lastStderr: null,
    lastProgressAt: Date.now(),
    stalled: false,
    stalledMinutes: 0,
    alertNotifiedAt: 0,
    state: newProgressState(),
  };
}

// ------------------------------------------------------------------- indexing
async function startIndex(interaction, remotePath, threads = null) {
  const filename = filenameFromRemote(remotePath);
  const ext = path.extname(filename).toLowerCase();

  if (!remotePath || remotePath.endsWith('/') || !filename) {
    return interaction.reply({ content: '⚠️ Give the full path to one video file.', flags: MessageFlags.Ephemeral });
  }
  const pathProblem = remoteProblem(remotePath);
  if (pathProblem) {
    return interaction.reply({ content: `⚠️ ${pathProblem}`, flags: MessageFlags.Ephemeral });
  }
  if (!VIDEO_EXTS.has(ext)) {
    return interaction.reply({ content: `⚠️ Unsupported extension: ${ext || '(none)'}`, flags: MessageFlags.Ephemeral });
  }
  if (activeJob) {
    return interaction.reply({ content: `⏳ Already indexing: **${activeJob.filename}**.`, flags: MessageFlags.Ephemeral });
  }

  const job = newJob(interaction, remotePath, filename, 'Preparing');
  job.threads = threads;
  job.state.kind = 'single';
  job.state.total = 1;
  // Reserve the single-worker slot before the first await to prevent two
  // simultaneous /index commands from starting overlapping downloads.
  activeJob = job;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (activeJob === job) activeJob = null;
    throw error;
  }

  const tempFile = path.join(TEMP_DIR, `${crypto.randomUUID()}${ext}`);
  const onLine = (line, stream) => handleChildLine(job, line, stream);

  try {
    await fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
    await fs.mkdir(JADE_DIR, { recursive: true, mode: 0o700 });
    startWatchdog(job);

    termLog(`[Jade] Indexing single video: ${remotePath}`);
    termLog(`[Jade] FFmpeg threads: ${threadsLabel(job)}`);
    job.phase = 'Downloading';
    logStatus(`📥 Indexing started: **${escapeMarkdown(shortName(filename))}** (by ${who(interaction)})`);
    reportEvent(job, { type: 'download_start', index: 1, total: 1, name: filename, path: remotePath });

    await runProcess('rclone', ['copyto', ...RCLONE_PROGRESS_ARGS, '--', remotePath, tempFile], job, { onLine });

    const stat = await fs.stat(tempFile);
    if (!stat.isFile() || stat.size <= 0) throw new Error('rclone completed but the downloaded file is empty.');
    reportEvent(job, { type: 'download_done', index: 1, total: 1, name: filename, bytes: stat.size });

    job.phase = 'Indexing';
    reportEvent(job, { type: 'fingerprint_start', index: 1, total: 1, name: filename });
    await runProcess('python', [INDEXER_PATH, tempFile, remotePath], job, { onLine, env: progressEnv(job) });

    reportEvent(job, { type: 'file_done', index: 1, total: 1, name: filename });
    await finishJob(job, `✅ Indexed: **${filename}**`, '✅ Indexing job finished successfully.');
    logStatus(`✅ Indexed **${escapeMarkdown(shortName(filename))}** in ${elapsedText(job)}`);
  } catch (error) {
    const message = job.cancelled
      ? '🛑 Indexing was cancelled.'
      : `❌ Failed: **${filename}**\nReason: \`${tail(error.message, 1200).replace(/`/g, "'")}\``;
    termLog(job.cancelled ? `[Jade] Indexing cancelled: ${filename}` : `[Jade] Failed: ${filename}`, 'stderr');
    await finishJob(job, message, job.cancelled ? '🛑 Indexing job was cancelled.' : '❌ Indexing job failed. Check the bot console.');
    if (!job.cancelled) console.error(`Index failed for ${remotePath}:`, error.message);
    logStatus(job.cancelled
      ? `🛑 Indexing cancelled: **${escapeMarkdown(shortName(filename))}** after ${elapsedText(job)}`
      : `❌ Indexing failed: **${escapeMarkdown(shortName(filename))}**\n\`${tail(error.message, 600).replace(/`/g, "'")}\``);
  } finally {
    stopChild(job);
    await removeTempDownload(tempFile);
    if (activeJob === job) activeJob = null;
  }
}

function folderSummaryText(job, extra, withFailures = false) {
  const s = job.state;
  const failed = [];
  if (withFailures && s.failures.length) {
    failed.push('', '❗ **Failed files**');
    for (const f of s.failures.slice(0, 5)) failed.push(`• \`${shortName(f.name, 60)}\`: ${shortName(f.error, 120).replace(/`/g, "'")}`);
    if (s.counters.failed > 5) failed.push(`…and ${s.counters.failed - 5} more (see the console)`);
  }
  return [
    `🎞️ Total videos: ${s.total}`,
    `✅ Indexed this run: ${s.counters.indexed}`,
    `⏭️ Already indexed: ${s.counters.skipped}`,
    `❌ Failed: ${s.counters.failed}`,
    ...extra,
    ...failed,
  ].join('\n');
}

async function startFolderIndex(interaction, folderPath, prune, threads = null) {
  const remoteFolder = (folderPath || '').trim().replace(/\/+$/, '');
  const folderProblem = remoteProblem(remoteFolder);
  if (folderProblem) {
    return interaction.reply({ content: `⚠️ ${folderProblem}`, flags: MessageFlags.Ephemeral });
  }
  if (!fsSync.existsSync(BULK_INDEXER_PATH)) {
    return interaction.reply({ content: '❌ `vindex-folder.sh` is missing.', flags: MessageFlags.Ephemeral });
  }
  if (activeJob) {
    return interaction.reply({ content: `⏳ Already indexing: **${activeJob.filename}**.`, flags: MessageFlags.Ephemeral });
  }

  const folderName = remoteFolder.split(/[\\/]/).filter(Boolean).pop() || remoteFolder;
  const job = newJob(interaction, remoteFolder, `${folderName}/ (folder)`, 'Preparing folder scan');
  job.threads = threads;
  job.cancelReason = 'Bulk indexing cancelled.';
  job.state.kind = 'folder';
  job.state.folder = remoteFolder;
  // Share the same single-worker slot as individual indexing jobs.
  activeJob = job;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (activeJob === job) activeJob = null;
    throw error;
  }

  try {
    await fs.mkdir(JADE_DIR, { recursive: true, mode: 0o700 });
    startWatchdog(job);
    job.phase = 'Scanning folder';
    job.state.phase = 'scanning';
    job.state.status = 'Scanning folder';
    termLog('[Jade] Starting bulk indexing...');
    termLog(`[Jade] FFmpeg threads: ${threadsLabel(job)}`);
    logStatus(`📂 Bulk indexing started: **${escapeMarkdown(shortName(folderName))}**${prune ? ' (with prune)' : ''} (by ${who(interaction)})`);
    editJobReply(job, renderDiscord(job));

    const args = [BULK_INDEXER_PATH, ...(prune ? ['--prune'] : []), remoteFolder];
    const result = await runProcess('bash', args, job, {
      onLine: (line, stream) => handleChildLine(job, line, stream),
      env: progressEnv(job),
    });

    const s = job.state;
    // Older script versions (or a lost event) still produce the plain-text summary.
    if (!s.summarySeen) {
      const grab = label => {
        const m = new RegExp(`^${label}:\\s*(\\d+)`, 'im').exec(result.stdout);
        return m ? parseInt(m[1], 10) : null;
      };
      const indexed = grab('Indexed this run');
      if (indexed !== null) {
        s.counters = { indexed, skipped: grab('Already indexed') ?? 0, failed: grab('Failed') ?? 0 };
        s.total = grab('Total videos found') ?? s.total;
      }
    }
    const prunedMatch = /^Pruned:\s*(\d+)/im.exec(result.stdout);
    const extra = prunedMatch ? [`🧹 Pruned: ${prunedMatch[1]}`] : [];

    let final;
    let publicSummary;
    if (s.total === 0 && (s.scan.found === 0 || /No supported video files found/i.test(result.stdout))) {
      final = `ℹ️ No supported video files found in **${shortName(remoteFolder, 200)}**.`;
      publicSummary = 'ℹ️ Bulk indexing job finished: no supported videos found.';
    } else {
      const retry = s.counters.failed > 0 ? '\n\n♻️ Rerun the same command to retry failures; indexed videos are skipped.' : '';
      final = `${s.counters.failed > 0 ? `⚠️ **Bulk indexing completed with ${s.counters.failed} failed**` : '✅ **Bulk indexing completed**'}\n\n${folderSummaryText(job, extra, true)}\n\n🗄️ Database: ${displayDbPath()}${retry}`;
      publicSummary = `✅ Bulk indexing job finished.\n${folderSummaryText(job, extra)}`;
    }
    termLog('[Jade] Bulk indexing completed.');
    await finishJob(job, final, publicSummary);
    logStatus(s.total === 0 && (s.scan.found === 0 || /No supported video files found/i.test(result.stdout))
      ? `ℹ️ Bulk indexing finished: no supported videos found in **${escapeMarkdown(shortName(folderName))}** (${elapsedText(job)})`
      : `✅ Bulk indexing finished: **${escapeMarkdown(shortName(folderName))}** in ${elapsedText(job)}\n${folderSummaryText(job, extra)}`);
  } catch (error) {
    const message = job.abortReason
      ? `❌ **Bulk indexing stopped**: ${folderName}\n${folderSummaryText(job, [], true)}\n\n${job.abortReason.slice(0, 500)}\n\n♻️ Fix the problem, then rerun the same command; finished videos are skipped.`
      : job.cancelled
      ? '🛑 Bulk indexing was cancelled.'
      : `❌ Failed: **${folderName}**\nReason: \`${tail(error.message, 1100).replace(/`/g, "'")}\``;
    termLog(job.abortReason ? `[Jade] ${job.abortReason}` : job.cancelled ? '[Jade] Bulk indexing cancelled.' : '[Jade] Bulk indexing failed.', 'stderr');
    await finishJob(job, message, job.abortReason ? '❌ Bulk indexing stopped after repeated download failures. Check the bot console.' : job.cancelled ? '🛑 Bulk indexing job was cancelled.' : '❌ Bulk indexing job failed. Check the bot console.');
    if (!job.cancelled) console.error(`Bulk indexing failed for ${remoteFolder}:`, error.message);
    logStatus(job.abortReason
      ? `❌ Bulk indexing stopped: **${escapeMarkdown(shortName(folderName))}** after ${elapsedText(job)}\n\`${job.abortReason.slice(0, 500).replace(/`/g, "'")}\`\n${folderSummaryText(job, [])}`
      : job.cancelled
      ? `🛑 Bulk indexing cancelled: **${escapeMarkdown(shortName(folderName))}** after ${elapsedText(job)}\n${folderSummaryText(job, [])}`
      : `❌ Bulk indexing failed: **${escapeMarkdown(shortName(folderName))}**\n\`${tail(error.message, 600).replace(/`/g, "'")}\``);
  } finally {
    stopChild(job);
    if (activeJob === job) activeJob = null;
  }
}

// --------------------------------------------------------------------- search
// Shared by "nothing found" and "weak match": a weak match passes its best guess in.
function noMatchText(guess) {
  const reason = '**Reason:** Cropped/Edited, not Indexed, or not in the Archive.';
  return guess
    ? `## ❗ No confident match\n**Best guess:** ${guess}\n>>> ***This is only a guess and could be the wrong video!***\n${reason}`
    : `## ❗ No match found\n${reason}`;
}

// Seconds until the running search is probably done: the average of recent searches minus
// the time this one has already run (never below 5 s, never past the search timeout).
function searchWaitSeconds(job) {
  const avg = searchDurations.length
    ? searchDurations.reduce((a, b) => a + b, 0) / searchDurations.length
    : SEARCH_ESTIMATE_DEFAULT_MS;
  const elapsed = Date.now() - job.startedAt;
  const remaining = Math.min(Math.max(avg - elapsed, 5000), Math.max(L.searchTimeoutMs - elapsed, 5000));
  return Math.ceil(remaining / 5000) * 5;       // rounded up to 5 s
}

async function searchRepliedVideo(commandMessage) {
  const quiet = { allowedMentions: { repliedUser: false } };
  if (activeSearch) {
    const wait = formatEta(searchWaitSeconds(activeSearch));
    return strikeReply(commandMessage,
      `⏳ Another search is still running. Please wait for it to finish (about **${wait}**), then reply with \`!get\` again.`, quiet);
  }
  // Claim the single search slot before the first await so two quick "!get"
  // messages cannot both pass the check above.
  const job = { cancelled: false, cancelReason: 'Cancelled.', child: null, startedAt: Date.now(), completed: false };
  activeSearch = job;
  try {
    return await runSearch(commandMessage, job, quiet);
  } finally {
    if (job.completed) {                          // only real, finished searches feed the estimate
      searchDurations.push(Date.now() - job.startedAt);
      if (searchDurations.length > 10) searchDurations.shift();
    }
    if (activeSearch === job) activeSearch = null;
  }
}

// Reads what !get needs to know about the query video: whether it is portrait as displayed, and how long
// it is. ffprobe's width/height are the stored size, so phone videos saved sideways with a rotation flag
// are swapped. Anything that cannot be read comes back as "not portrait / unknown length", and the matcher
// then reports its own error.
async function probeVideo(file, job) {
  const unknown = { portrait: false, duration: null };
  const result = await runProcess('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration',
    '-of', 'json', file,
  ], job, { onLine: () => {} });
  try {
    const data = JSON.parse(result.stdout);
    const stream = data.streams?.[0];
    if (!stream) return unknown;
    let { width, height } = stream;
    const rotation = Number(stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    const duration = Number(data.format?.duration);
    return { portrait: height > width, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
  } catch {
    return unknown;
  }
}

async function runSearch(commandMessage, job, quiet) {
  if (!commandMessage.reference?.messageId) {
    return strikeReply(commandMessage, '↩️ Reply to a video or screenshot with `!get`.', quiet);
  }

  let sourceMessage;
  try {
    sourceMessage = await commandMessage.channel.messages.fetch(commandMessage.reference.messageId);
  } catch {
    return commandMessage.reply({ content: '🚫 Cannot read that message. Check my channel and history permissions.', ...quiet });
  }

  const attachments = [...sourceMessage.attachments.values()];
  const typeOf = item => (item.contentType || '').toLowerCase();
  const extOf = item => path.extname(item.name || '').toLowerCase();
  // A video wins if the message has both; otherwise a screenshot is searched as a single frame.
  let video = attachments.find(item => VIDEO_EXTS.has(extOf(item)) || typeOf(item).startsWith('video/'));
  const isImage = !video;
  if (isImage) video = attachments.find(item => IMAGE_EXTS.has(extOf(item)) || typeOf(item).startsWith('image/'));
  if (!video) {
    return strikeReply(commandMessage, '⚠️ No video or image found in that message.', quiet);
  }
  const sizeLimit = isImage ? MAX_IMAGE_BYTES : L.maxQueryBytes;
  if (video.size > sizeLimit) {
    return strikeReply(commandMessage, isImage
      ? `⚠️ Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB).`
      : `⚠️ Video too large (max ${Math.round(L.maxQueryBytes / 1048576)} MB). Use a shorter clip.`, quiet);
  }
  if (!fsSync.existsSync(MATCHER_PATH)) {
    return commandMessage.reply({ content: '❌ `vget.py` is missing.', ...quiet });
  }

  const now = Date.now();
  const last = searchCooldown.get(commandMessage.author.id) || 0;
  if (now - last < L.searchCooldownMs) {
    const wait = Math.ceil((L.searchCooldownMs - (now - last)) / 1000);
    return strikeReply(commandMessage, `⏳ Wait ${wait}s before searching again.`, quiet);
  }
  searchCooldown.set(commandMessage.author.id, now);
  for (const [userId, time] of searchCooldown) {
    if (now - time > L.searchCooldownMs * 3) searchCooldown.delete(userId);
  }

  const knownExts = isImage ? IMAGE_EXTS : VIDEO_EXTS;
  const ext = knownExts.has(extOf(video)) ? extOf(video) : (isImage ? '.png' : '.mp4');
  const tempFile = path.join(TEMP_DIR, `get-${crypto.randomUUID()}${ext}`);
  let statusMessage;
  let top = null;                          // best match, for the log channel
  const timer = setTimeout(() => {
    job.cancelled = true;
    job.cancelReason = 'The search timed out.';
    stopChild(job);
  }, L.searchTimeoutMs);

  try {
    statusMessage = await commandMessage.reply({
      content: '🔎 Searching...',
      ...quiet,
    });
    await fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });

    const response = await fetch(video.url, { signal: AbortSignal.timeout(L.downloadTimeoutMs) });
    if (!response.ok || !response.body) {
      throw new Error(`Could not download the attached video (HTTP ${response.status}).`);
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > sizeLimit) return callback(new Error('The uploaded video is too large.'));
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limiter, fsSync.createWriteStream(tempFile, { flags: 'wx' }));

    const stat = await fs.stat(tempFile);
    if (!stat.size) throw new Error('The uploaded video was empty.');

    const probe = isImage ? { portrait: false, duration: null } : await probeVideo(tempFile, job);
    const rejection = probe.portrait
      ? '⚠️ Portrait videos are not supported. Reply to a landscape video.'
      : (probe.duration !== null && probe.duration < MIN_CLIP_SECONDS - 0.5)
        ? `⚠️ Videos shorter than ${MIN_CLIP_SECONDS} seconds are not supported. Reply to a video that is at least ${MIN_CLIP_SECONDS} seconds long.`
        : null;
    if (rejection) {
      // The cooldown is kept: the file was already downloaded, and refunding it would let someone
      // re-send rejected clips and make the bot download them again and again.
      await statusMessage.edit({ content: rejection });
      return;
    }

    const matcherArgs = [MATCHER_PATH, tempFile, '--quiet', '--timestamps', ...(isImage ? ['--image'] : [])];
    const result = await runProcess('python', matcherArgs, job);
    const matches = result.stdout.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !isImage || Number(line.split('\t')[2]) >= IMAGE_MIN_PERCENT)   // screenshots: identical frame or nothing
      .slice(0, 1)                         // best match only (the matcher lists results best-first)
      .map(line => {
        const [filename, seconds, percent] = line.split('\t');
        const name = escapeMarkdown(path.parse(filename).name);
        const good = isImage || Number(percent) >= cfg.GOOD_MATCH_PERCENT;   // a screenshot only gets here if it met IMAGE_MIN_PERCENT
        top = { name, seconds: seconds === undefined ? null : Number(seconds), percent, good };
        const where = seconds === undefined ? '' : `  |  around ⏱️ \`~${formatTimestamp(Number(seconds))}\``;
        if (!good) return noMatchText(`🎬 ${name}  |  🎯 \`${percent}%\`${where}`);   // weak match
        return `## 🎬 ${name}\n✅ Good match${isImage ? ' (single frame)' : ''}  |  🎯 \`${percent}%\`${where}`;
      });
    const output = matches.length ? matches.join('\n\n') : noMatchText();
    await statusMessage.edit({ content: output.slice(0, 1900), allowedMentions: { parse: [] } });
    job.completed = true;
    // Log who searched and what came back (mentions are shown but never ping).
    const used = escapeMarkdown(commandMessage.content.trim().slice(0, 20));
    const result_ = top
      ? `${top.good ? '✅ Good match' : '⚠️ Guess'}: **${top.name}** · 🎯 \`${top.percent}%\`${top.seconds === null ? '' : ` · ⏱️ \`~${formatTimestamp(top.seconds)}\``}`
      : '❌ No match found';
    logStatus([
      `🔎 **${used}** by <@${commandMessage.author.id}> (${escapeMarkdown(commandMessage.author.tag)}) in <#${commandMessage.channelId}>`,
      `📎 Query: ${isImage ? 'screenshot' : 'video clip'}${formatBytes(video.size) ? ` (${formatBytes(video.size)})` : ''}`,
      result_,
      `⏱️ Took ${Math.max(1, Math.round((Date.now() - job.startedAt) / 1000))}s · [jump to message](${commandMessage.url})`,
    ].join('\n'));
  } catch (error) {
    const message = `❌ Search failed. Reason: ${tail(error.message, 900).replace(/`/g, "'")}`;
    if (statusMessage) await statusMessage.edit({ content: message }).catch(() => {});
    else await commandMessage.reply({ content: message, ...quiet }).catch(() => {});
    console.error('Video search failed:', error.message);
    logStatus(`⚠️ Search by <@${commandMessage.author.id}> (${escapeMarkdown(commandMessage.author.tag)}) in <#${commandMessage.channelId}> failed: ${tail(error.message, 600).replace(/`/g, "'")}`);
  } finally {
    clearTimeout(timer);
    stopChild(job);
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------- access rules
// Slash commands only work in COMMANDS_CHANNEL_ID (a thread of it counts). /settings additionally
// needs the SETTINGS_ROLE_ID role; the other commands need Manage Server. !get is not a slash
// command, so it follows CHANNEL_ID instead.
function commandChannelProblem(interaction) {
  const id = cfg.COMMANDS_CHANNEL_ID;
  if (!id) return null;
  const channel = interaction.channel;
  if (interaction.channelId === id || (channel && channel.parentId === id)) return null;
  return `🔒 Slash commands only work in <#${id}>.`;
}

function memberHasRole(interaction, roleId) {
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(roleId);      // uncached member: raw role ID list
  return Boolean(roles.cache && roles.cache.has(roleId));
}

function commandPermissionProblem(interaction) {
  if (interaction.commandName === 'settings' && cfg.SETTINGS_ROLE_ID) {
    return memberHasRole(interaction, cfg.SETTINGS_ROLE_ID) ? null : `🔒 /settings is only for members with the <@&${cfg.SETTINGS_ROLE_ID}> role.`;
  }
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ? null : '🔒 You need the Manage Server permission.';
}

// ---------------------------------------------------------------- /settings
async function handleSettings(interaction) {
  const sub = interaction.options.getSubcommand();
  const ephemeral = MessageFlags.Ephemeral;

  if (sub === 'view') {
    const lines = Object.keys(SETTINGS).map(key => `${SETTINGS[key].edit === false ? '🔒' : '  '} ${key} = ${JSON.stringify(cfg[key])}`);
    return interaction.reply({
      content: `⚙️ **Settings**  (🔒 = change in settings.py only)\n\`\`\`\n${lines.join('\n')}\n\`\`\``.slice(0, 1990),
      flags: ephemeral,
    });
  }

  if (sub === 'reload') {
    const warnings = loadSettings();
    logStatus(`⚙️ Settings reloaded by ${who(interaction)}`);
    return interaction.reply({
      content: warnings.length ? `⚠️ Reloaded with problems:\n${warnings.map(w => `• ${w}`).join('\n')}`.slice(0, 1900) : '✅ Reloaded settings.py.',
      flags: ephemeral,
    });
  }

  const key = interaction.options.getString('name', true);
  if (!EDITABLE_SETTINGS.includes(key)) {
    return interaction.reply({ content: '🔒 That setting can only be changed by editing settings.py.', flags: ephemeral });
  }
  const result = checkSetting(key, interaction.options.getString('value', true));
  if (result.error) return interaction.reply({ content: `⚠️ ${key}: ${result.error}`, flags: ephemeral });
  const pairProblem = scoringProblem({ ...cfg, [key]: result.value });
  if (pairProblem) return interaction.reply({ content: `⚠️ ${key}: ${pairProblem}`, flags: ephemeral });
  const old = cfg[key];
  try {
    saveSetting(key, result.value);
  } catch (error) {
    return interaction.reply({ content: `❌ Could not write settings.py: ${String(error.message).slice(0, 200)}`, flags: ephemeral });
  }
  logStatus(`⚙️ **${key}** changed ${JSON.stringify(old)} → ${JSON.stringify(result.value)} by ${who(interaction)}`);
  return interaction.reply({
    content: `✅ \`${key}\` = \`${JSON.stringify(result.value)}\` ${SETTINGS[key].restart ? '(saved; takes effect after a bot restart)' : '(applied now)'}`,
    flags: ephemeral,
  });
}

// ------------------------------------------------------------ discord plumbing
async function registerCommands() {
  if (cfg.GUILD_ID) {
    const guild = await client.guilds.fetch(cfg.GUILD_ID);
    await guild.commands.set(COMMANDS);
    console.log(`Registered ${COMMANDS.length} guild slash commands in ${cfg.GUILD_ID}.`);
  } else {
    await client.application.commands.set(COMMANDS);
    console.log(`Registered ${COMMANDS.length} global slash commands.`);
  }
}

function attachHandlers() {
  client.once('clientReady', async () => {
    console.log(`Bot online as ${client.user.tag}`);
    client.user.setPresence({
      activities: [{ name: 'custom', state: 'THE CODE finder 😁', type: ActivityType.Custom }],   // shows exactly this text under the bot's name
      status: 'online',
    });
    let commandsOk = true;
    try {
      await registerCommands();
    } catch (error) {
      commandsOk = false;
      console.error('Could not register slash commands:', error);
      logStatus(`⚠️ Could not register slash commands: ${tail(String(error && error.message), 400)}`);
    }
    logStatus(`🟢 Jade online${commandsOk ? '' : ' (slash commands not registered)'}`);
    console.log(`Database: ${DB_PATH}`);
    console.log('rclone will use its standard Termux configuration.');
    const describeChannels = ids => ids.size ? (ids.has('*') ? 'every channel' : `channel(s) ${[...ids].join(', ')}`) : 'OFF (no channel configured)';
    console.log(`!get runs in: ${describeChannels(L.getChannelIds)}`);
    console.log(`"anyone has CODE?" runs in: ${describeChannels(L.requestChannelIds)}`);
    console.log(L.allowedRemotes.size ? `/index may read remote(s): ${[...L.allowedRemotes].join(', ')}` : '/index is OFF until ALLOWED_REMOTES is set in settings.py.');
  });

  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (isIgnored(message)) return;                  // blocked or temporarily muted: no reply, no work
    const codes = archiveQuery(message);
    if (codes.length) return answerArchiveQuestion(message, codes);
    const command = message.content.trim().toLowerCase();
    // This is intentionally a reply-based text trigger, not a slash interaction:
    // Discord chat-input slash commands do not expose the replied-to message.
    if (command !== '!get' && command !== '!get code') return;
    if (!getChannelAllowed(message)) return;
    await searchRepliedVideo(message);               // "!get" and "!get code" both show the match % and moment
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const accessProblem = commandChannelProblem(interaction) || commandPermissionProblem(interaction);
    if (accessProblem) {
      return interaction.reply({ content: accessProblem, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }

    try {
      if (interaction.commandName === 'settings') return await handleSettings(interaction);

      if (interaction.commandName === 'index') {
        const remotePath = interaction.options.getString('file_path')?.trim() || '';
        const folderPath = interaction.options.getString('folder_path')?.trim() || '';
        const prune = interaction.options.getBoolean('prune') === true;
        const threads = interaction.options.getInteger('threads');       // null when not given
        if (Boolean(remotePath) === Boolean(folderPath)) {
          return interaction.reply({
            content: '⚠️ Give exactly one: `file_path` or `folder_path`.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (prune && !folderPath) {
          return interaction.reply({ content: '⚠️ `prune` works with `folder_path` only.', flags: MessageFlags.Ephemeral });
        }
        if (folderPath) return await startFolderIndex(interaction, folderPath, prune, threads);
        return await startIndex(interaction, remotePath, threads);
      }

      if (interaction.commandName === 'index-status') {
        if (!activeJob) {
          return interaction.reply({ content: 'ℹ️ No indexing job is running.', flags: MessageFlags.Ephemeral });
        }
        const elapsed = Math.floor((Date.now() - activeJob.startedAt) / 1000);
        const live = activeJob.state ? renderDiscord(activeJob) : activeJob.progress;
        const lastLine = live ? `\n\n${live.slice(0, 1500)}` : '';
        return interaction.reply({
          content: `🔄 **${activeJob.phase}**\n📁 Job: **${activeJob.filename}**\n⏱️ Elapsed: ${elapsed}s${lastLine}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'index-db') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          return await interaction.editReply({ content: renderDbInfo(await readDbInfo()), allowedMentions: { parse: [] } });
        } catch (error) {
          return await interaction.editReply({ content: `❌ Could not read the database: ${String(error.message).slice(0, 300)}` });
        }
      }

      if (interaction.commandName === 'index-cancel') {
        if (!activeJob) {
          return interaction.reply({ content: 'ℹ️ No indexing job is running.', flags: MessageFlags.Ephemeral });
        }
        activeJob.cancelled = true;
        stopChild(activeJob);
        logStatus(`🛑 Cancellation requested for **${escapeMarkdown(shortName(activeJob.filename))}** by ${who(interaction)}`);
        return interaction.reply({ content: `🛑 Cancelling **${activeJob.filename}**...`, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error('Interaction error:', error);
      const message = '❌ Something went wrong.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

// ------------------------------------------------------------------ /index-db
// Runs `vindex.py dbinfo` and returns its JSON summary.
function readDbInfo() {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [INDEXER_PATH, 'dbinfo'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The database report timed out.')); }, 60000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `vindex.py exited with ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Could not read the database report.')); }
    });
  });
}

function formatDuration(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function renderDbInfo(info) {
  const code = text => `\`${String(text).replace(/`/g, "'")}\``;
  const total = (info.bytes.db || 0) + (info.bytes.wal || 0) + (info.bytes.shm || 0);
  const temp = (info.bytes.wal || 0) + (info.bytes.shm || 0);
  const lines = [
    '🗄️ **Index database**',
    `💾 Size: **${formatBytes(total)}**${temp > 0 ? ` (${formatBytes(temp)} of it is temporary files)` : ''}`,
    `🎞️ **${formatCount(info.videos)}** videos indexed · ⏱️ **${formatDuration(info.seconds)}** of footage · ${formatCount(info.fingerprints)} fingerprints`,
  ];

  if (info.folders.length) {
    lines.push('', `📁 **Folders** (${info.folders_total})`);
    for (const f of info.folders) lines.push(`• ${code(f.folder)}: ${formatCount(f.videos)} videos · ${formatDuration(f.seconds)}`);
    if (info.folders_total > info.folders.length) lines.push(`…and ${info.folders_total - info.folders.length} more folders`);
  }

  if (info.recent.length) {
    lines.push('', '🕘 **Most recently indexed**');
    for (const r of info.recent) {
      const when = r.at ? ` · <t:${r.at}:R>` : '';
      lines.push(`• ${escapeMarkdown(r.name)}: ${formatDuration(r.seconds)}${when}`);
    }
  }

  if (info.unfinished.length) {
    lines.push('', '⏸️ **Unfinished (continues on the next run)**');
    for (const u of info.unfinished) lines.push(`• ${escapeMarkdown(u.name || 'a file from an earlier run')}: ${formatDuration(u.seconds)} done`);
  }

  if (info.unknown_paths > 0) {
    lines.push('', `ℹ️ ${formatCount(info.unknown_paths)} older entries have no folder info yet. Run \`/index\` on their folder again and it fills in (nothing is re-indexed).`);
  }
  if (info.outdated > 0) {
    lines.push(`⚠️ ${formatCount(info.outdated)} entries use an older fingerprint format and will be re-indexed next time.`);
  }

  let text = lines.join('\n');
  if (text.length > 1900) text = `${text.slice(0, 1880)}\n…`;
  return text;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; stopping the active indexing process...`);
  logStatus(`🔴 Jade shutting down (${signal})${activeJob ? ' - stopping the active indexing job' : ''}`);
  if (activeJob) {
    activeJob.cancelled = true;
    stopChild(activeJob);
  }
  if (activeSearch) {
    activeSearch.cancelled = true;
    stopChild(activeSearch);
  }
  const started = Date.now();
  while ((activeJob || activeSearch) && Date.now() - started < KILL_GRACE_MS + 2000) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await flushStatusLog();
  if (client) client.destroy();
  process.exit(0);
}

function main() {
  if (NO_TOKEN) {
    console.error('No Discord bot token found. Set JADE_BOT_TOKEN, or put the token in a file named .bot-token next to index.js.');
    process.exit(1);
  }
  const blockers = settingsBlockers();
  if (blockers.length) {
    console.error(`Cannot start: settings.py is not complete.\n${blockers.map(line => `  - ${line}`).join('\n')}\nNothing is built into index.js: put every setting in settings.py next to it.`);
    process.exit(1);
  }
  client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ] });
  attachHandlers();
  sweepTempDir().catch(() => {});

  // A closed terminal must never crash the bot or stop an indexing job.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
    logStatus(`⚠️ Unhandled error: ${tail(String(error && error.message || error), 500).replace(/`/g, "'")}`);
  });

  client.login(BOT_TOKEN).catch(error => {
    console.error('Discord login failed:', error);
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = {
  runProcess, stopChild, validRemote, filenameFromRemote,
  // exported for tests
  startIndex, startFolderIndex, LineSplitter, parseChildLine, captureText, renderDiscord,
  formatBytes, formatSpeed, formatEta, parseRcloneText, rcloneStatsEvent,
  getActiveJob: () => activeJob,
  cancelActiveJob: () => { if (activeJob) { activeJob.cancelled = true; stopChild(activeJob); } },
};
