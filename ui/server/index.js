const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Cloud verification setup ──────────────────────────────────────────────────

// Resolve CLOUD_API_URL — priority order:
//   1. CLOUD_API_URL env var (highest — set by deployment/CI)
//   2. ui/server/.env  → CLOUD_API_URL
//   3. ui/client/.env  → VITE_CLOUD_API_URL (legacy fallback)
function _loadCloudUrlFromEnvFile() {
  const readKey = (file, key) => {
    try {
      const contents = fs.readFileSync(file, 'utf8');
      const match = contents.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
      return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
    } catch { return null; }
  };

  return (
    readKey(path.join(__dirname, '.env'), 'CLOUD_API_URL') ||
    readKey(path.join(__dirname, '..', 'client', '.env'), 'VITE_CLOUD_API_URL') ||
    ''
  );
}

const CLOUD_API_URL   = process.env.CLOUD_API_URL || _loadCloudUrlFromEnvFile();
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'lifetime']);

/**
 * Verify that the bearer token represents a user with active paid access.
 *
 * Returns:
 *   { allowed: true }                          — subscription active
 *   { allowed: false, reason, status, sub }    — subscription inactive/missing
 *   { allowed: null,  reason: 'backend-down' } — cloud unreachable (graceful degrade)
 */
async function verifyAccess(token) {
  if (!CLOUD_API_URL) {
    console.warn('[verify] CLOUD_API_URL not set — skipping cloud check');
    return { allowed: null, reason: 'no-cloud-url' };
  }
  if (!token) {
    return { allowed: false, reason: 'no-token', status: 'unauthenticated' };
  }
  try {
    const res = await fetch(`${CLOUD_API_URL}/api/account`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      return { allowed: false, reason: 'token-invalid', status: 'unauthenticated' };
    }
    if (!res.ok) {
      console.warn('[verify] cloud returned', res.status);
      return { allowed: null, reason: 'backend-error' };
    }
    const data = await res.json();
    // cloudEmail is the authenticated email as verified by the cloud (via Supabase JWT).
    // Returned on every path so the caller can use it for the local admin bypass even when
    // the cloud denies access (e.g. subscription lapsed but user is the admin owner).
    const cloudEmail = (data?.profile?.email ?? '').trim().toLowerCase() || null;
    // Admin flag is set server-side by isAdminEmail() — never trust a DB field directly.
    if (data?.profile?.is_admin === true) {
      console.log(`[ADMIN_BYPASS_ACTIVE] user=${cloudEmail ?? 'unknown'} — cloud confirmed admin`);
      return { allowed: true, reason: 'admin', status: 'lifetime', email: cloudEmail };
    }
    const status = data?.subscription?.status ?? 'none';
    if (ACTIVE_STATUSES.has(status)) {
      return { allowed: true, reason: 'ok', status, email: cloudEmail };
    }
    const licStatus = data?.license?.status ?? 'none';
    if (licStatus === 'active') {
      return { allowed: true, reason: 'license-active', status: licStatus, email: cloudEmail };
    }
    return { allowed: false, reason: 'inactive', status, sub: data?.subscription ?? null, email: cloudEmail };
  } catch (err) {
    console.warn('[verify] cloud unreachable:', err.message);
    return { allowed: null, reason: 'backend-down' };
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// ── Runtime path resolution ───────────────────────────────────────────────
// In packaged mode, RESOURCES_PATH is set by server-manager.js (Electron
// passes it via env before forking this process).
// In dev mode (no RESOURCES_PATH), walk up two levels: ui/server → ui → repo.
const BOT_WORKING_DIR = process.env.RESOURCES_PATH
  ? process.env.RESOURCES_PATH
  : path.join(__dirname, '..', '..');

// Node binary: resolved by server-manager at startup (handles nvm, Homebrew,
// official installer). Falls back to bare 'node' for dev / terminal use.
const NODE_BIN = process.env.NODE_BINARY || 'node';

// When no system Node.js is found on the customer machine (Windows packaged app),
// server-manager sets USE_ELECTRON_AS_NODE=1.  We then launch the bot subprocess
// with ELECTRON_RUN_AS_NODE=1, making the Electron binary act as a Node runtime.
// This makes the packaged app fully self-contained — no Node.js install required.
const USE_ELECTRON_AS_NODE = process.env.USE_ELECTRON_AS_NODE === '1';

const os = require('os');

const BUILD_TIME   = new Date().toISOString();
const BUILD_COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 8);

console.log('[server] ── startup ─────────────────────────────────────────');
console.log(`[server] BOT_WORKING_DIR      : ${BOT_WORKING_DIR}`);
console.log(`[server] NODE_BIN             : ${NODE_BIN}`);
console.log(`[server] NODE_BIN_EXISTS      : ${fs.existsSync(NODE_BIN)}`);
console.log(`[server] USE_ELECTRON_AS_NODE : ${USE_ELECTRON_AS_NODE}`);
console.log(`[server] USER_DATA_DIR        : ${process.env.USER_DATA_DIR || '(not set — dev mode)'}`);
console.log(`[server] BOT_DATA_DIR         : ${process.env.BOT_DATA_DIR  || '(not set — set per spawn)'}`);
console.log(`[server] CLOUD_API_URL        : ${CLOUD_API_URL             || '(not set)'}`);
console.log(`[server] platform             : ${process.platform}`);
console.log(`[server] hostname             : ${os.hostname()}`);
console.log(`[DEBUG_ENV] build commit=${BUILD_COMMIT} started=${BUILD_TIME}`);
console.log('[DEBUG_ENV] startup environment logged above');
console.log('[server] ────────────────────────────────────────────────────');

// ── Local admin allowlist — mirrors monetization/web/lib/admin.ts ────────────
// Must match exactly (lowercase). Hardcoded fallback survives missing env vars.
const LOCAL_HARDCODED_ADMINS = new Set(['nickymccracken159@gmail.com']);

function isLocalAdminEmail(email) {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (LOCAL_HARDCODED_ADMINS.has(normalized)) return true;
  const envAdmins = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return envAdmins.includes(normalized);
}

// ── Per-user isolation ────────────────────────────────────────────────────
// Decode the JWT payload to extract the Supabase user ID (sub claim).
// Used ONLY for per-user path namespacing — NOT for auth decisions.
// The token is validated against the cloud API separately in verifyAccess().
function decodeJwtSub(token) {
  try {
    if (!token) return null;
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    );
    // Sanitize: keep only URL-safe alphanumeric characters
    const sub = String(payload.sub || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return sub.length >= 8 ? sub : null;
  } catch {
    return null;
  }
}

// Extract the email claim from a Supabase JWT (payload.email).
// Only used for the local admin bypass — NOT for auth decisions.
// Tries multiple claim paths in case the JWT structure varies.
function decodeJwtEmail(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    // Normalize base64url → base64 for compatibility with all Node versions.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    // Supabase embeds email directly; older versions nested it in user_metadata.
    const raw =
      payload.email ||
      payload.user_metadata?.email ||
      payload.app_metadata?.email ||
      '';
    const email = String(raw).trim().toLowerCase();
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

// Returns the per-user data directory.
// In packaged mode: ~/Library/Application Support/StatfloBot/users/<userId>/
// In dev mode (no USER_DATA_DIR): null → callers fall back to flat dev paths.
function getUserScopedDir(userId) {
  if (!process.env.USER_DATA_DIR || !userId) return null;
  return path.join(process.env.USER_DATA_DIR, 'users', userId);
}

const DEFAULT_MESSAGES = {
  secondAttemptMessage: '',
  thirdAttemptMessage: '',
};

function getMessagesFile(userId) {
  const userDir = getUserScopedDir(userId);
  if (userDir) return path.join(userDir, 'messages.json');
  // Dev fallback: flat file alongside server (historic location)
  return path.join(__dirname, 'data', 'messages.json');
}

function readMessages(userId) {
  const file = getMessagesFile(userId);
  console.log(`[DEBUG_MESSAGES_LOAD_PATH] reading from: ${file}`);
  try {
    const raw  = fs.readFileSync(file, 'utf8');
    const data = { ...DEFAULT_MESSAGES, ...JSON.parse(raw) };
    const has2 = !!(data.secondAttemptMessage || '').trim();
    const has3 = !!(data.thirdAttemptMessage  || '').trim();
    console.log(`[DEBUG_MESSAGES_CONTENT] 2nd=${has2 ? 'YES' : 'EMPTY'} 3rd=${has3 ? 'YES' : 'EMPTY'}`);
    return data;
  } catch {
    console.log(`[DEBUG_MESSAGES_CONTENT] file not found — returning empty defaults`);
    return { ...DEFAULT_MESSAGES };
  }
}

function writeMessages(userId, data) {
  const file = getMessagesFile(userId);
  console.log(`[DEBUG_MESSAGES_SAVE_PATH] writing to: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  const has2 = !!(data.secondAttemptMessage || '').trim();
  const has3 = !!(data.thirdAttemptMessage  || '').trim();
  console.log(`[DEBUG_MESSAGES_SAVE_PATH] write complete — 2nd=${has2 ? 'YES' : 'EMPTY'} 3rd=${has3 ? 'YES' : 'EMPTY'}`);
}

// ── Device fingerprint ────────────────────────────────────────────────────────
// A stable per-machine identifier stored in USER_DATA_DIR/device.json.
// Generated once on first run and reused forever.
function getOrCreateDeviceFingerprint() {
  const dir  = process.env.USER_DATA_DIR || os.tmpdir();
  const file = path.join(dir, 'device.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.fingerprint && typeof saved.fingerprint === 'string') {
      return saved.fingerprint;
    }
  } catch { /* will create below */ }
  const fingerprint = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      fingerprint,
      hostname: os.hostname(),
      platform: process.platform,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    console.log(`[DEBUG_DEVICE_REGISTER_STORAGE] new fingerprint created: ${fingerprint.slice(0, 8)}… stored at ${file}`);
  } catch (err) {
    console.warn(`[DEBUG_DEVICE_REGISTER_STORAGE] could not persist fingerprint: ${err.message}`);
  }
  return fingerprint;
}

// Register this device with the cloud. Returns a result object — callers may
// await it (endpoint) or fire-and-forget (start path).
async function registerDeviceAsync(token) {
  if (!CLOUD_API_URL || !token) return null;
  const fingerprint = getOrCreateDeviceFingerprint();
  const deviceName  = `${os.hostname()} (${process.platform})`;
  const userId      = decodeJwtSub(token);
  console.log(`[DEVICE_REGISTER_START] userId=${userId ?? '?'} fingerprint=${fingerprint.slice(0, 8)}… name="${deviceName}"`);
  try {
    const res = await fetch(`${CLOUD_API_URL}/api/devices/upsert`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ deviceFingerprint: fingerprint, deviceName }),
      signal:  AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`[DEVICE_REGISTER_SUCCESS] action=${data.action ?? 'ok'} userId=${userId ?? '?'}`);
      return { ok: true, action: data.action ?? 'ok', fingerprintPrefix: fingerprint.slice(0, 8), deviceName, userId };
    }
    console.warn(`[DEVICE_REGISTER_FAILED] cloud returned ${res.status}: ${data.error ?? '(no error field)'}`);
    return { ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}`, fingerprintPrefix: fingerprint.slice(0, 8), deviceName, userId };
  } catch (err) {
    console.warn(`[DEVICE_REGISTER_FAILED] registration call failed: ${err.message}`);
    return { ok: false, error: err.message, fingerprintPrefix: fingerprint.slice(0, 8), deviceName, userId };
  }
}

let state = {
  runState: 'idle', // idle | running | login_required | complete
  loginState: null, // null | 'required' | 'detected'
  stats: {
    processed: 0,
    messaged: 0,
    dnc: 0,
    skipped: 0,
    failed: 0,
  },
  activeProcess: null,
  pendingLaunchToken: null,
  lastDeviceReg: null,   // result of most recent registerDeviceAsync call
  lastRunLogsDir:  null, // logsDir used by the most recent bot spawn
  lastRunLogFile:  null, // exact log file path captured from bot stdout
  lastRunStatus:   null, // 'complete' | 'stopped' | 'error'
};

// Patterns whose matching lines must never be served via the log API.
// Protects tokens, keys, and credentials while leaving bot behaviour visible.
const LOG_REDACT_PATTERNS = [
  /authorization/i,
  /bearer\s+[a-z0-9._-]{10,}/i,
  /stripe.*key/i,
  /supabase.*key/i,
  /access.?token/i,
  /refresh.?token/i,
  /secret/i,
  /password/i,
  /ADMIN_EMAILS/i,
  /CLOUD_API_URL/i,
];

function sanitizeLogLine(line) {
  for (const re of LOG_REDACT_PATTERNS) {
    if (re.test(line)) return '[REDACTED]';
  }
  return line;
}

function readLogFileSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map(sanitizeLogLine)
      .join('\n');
  } catch {
    return null;
  }
}

function listLogFiles(logsDir) {
  if (!logsDir || !fs.existsSync(logsDir)) return [];
  try {
    return fs.readdirSync(logsDir)
      .filter(f => f.startsWith('run-') && f.endsWith('.log'))
      .sort()
      .reverse() // most recent first
      .slice(0, 50)
      .map(f => ({
        filename: f,
        path:     path.join(logsDir, f),
        // Extract timestamp from filename: run-2026-05-03T12-34-56-789Z.log
        timestamp: f.replace(/^run-/, '').replace(/\.log$/, '').replace(/-/g, ':').replace(/T(\d{2}):(\d{2}):(\d{2})/, 'T$1:$2:$3'),
      }));
  } catch {
    return [];
  }
}

function latestLogFile(logsDir) {
  const files = listLogFiles(logsDir);
  return files.length > 0 ? files[0] : null;
}

function parseLogLevel(line) {
  const upper = line.toUpperCase();
  if (upper.includes('SUCCESS')) return 'success';
  if (upper.includes('ERROR')) return 'error';
  if (upper.includes('WARN')) return 'warn';
  return 'info';
}

function parseStats(line) {
  const lower = line.toLowerCase();
  const patterns = [
    { key: 'processed', regex: /processed[:\s]+(\d+)/i },
    { key: 'messaged', regex: /messaged[:\s]+(\d+)/i },
    { key: 'dnc', regex: /dnc[:\s]+(\d+)/i },
    { key: 'skipped', regex: /skipped[:\s]+(\d+)/i },
    { key: 'failed', regex: /failed[:\s]+(\d+)/i },
  ];

  let updated = false;
  for (const { key, regex } of patterns) {
    const match = line.match(regex);
    if (match) {
      state.stats[key] = parseInt(match[1], 10);
      updated = true;
    }
  }
  return updated;
}

function killActiveProcess() {
  if (!state.activeProcess) return;
  const proc = state.activeProcess;
  const pid  = proc.pid;
  state.activeProcess = null;

  try {
    if (process.platform === 'win32' && pid) {
      // On Windows, SIGTERM is not reliably forwarded to child processes.
      // Use taskkill /F /T to force-terminate the bot AND any subprocesses it spawned.
      const { execFileSync } = require('child_process');
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
      catch { /* process already gone */ }
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* already dead */ }
}

// Map dashboard list picker values to the CLI tokens main.js expects.
// main.js LIST_ALIASES accepts '1st'/'2nd'/'3rd' directly.
const LIST_MAP = { '1st': '1st', '2nd': '2nd', '3rd': '3rd' };

// Valid delay profiles accepted by main.js
const VALID_DELAYS = ['safe', 'normal', 'fast', 'turbo'];

app.post('/api/start', async (req, res) => {
  if (state.runState === 'running' || state.runState === 'login_required') {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  // ── Backend verification — enforce on every run ──────────────────────────
  const token    = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId   = decodeJwtSub(token);
  const jwtEmail = decodeJwtEmail(token);
  console.log(`[LOCAL_LICENSE_CHECK_START] jwtEmail=${jwtEmail ?? '(none)'} token=${token ? 'present' : 'MISSING'} userId=${userId ?? '(unknown)'}`);

  const access = await verifyAccess(token);

  // Prefer the cloud-verified email; fall back to JWT-decoded email.
  // The cloud email is validated against Supabase Auth — it cannot be spoofed.
  const effectiveEmail = access.email ?? jwtEmail ?? null;
  console.log(`[LOCAL_LICENSE_CHECK_START] effectiveEmail=${effectiveEmail ?? '(unknown)'} cloudAllowed=${access.allowed}`);

  // ── Local admin bypass — runs after cloud check.
  //    Fires whenever cloud doesn't already grant access (e.g. cloud down,
  //    subscription missing, or cloud returned is_admin=false despite being admin).
  if (access.allowed !== true && isLocalAdminEmail(effectiveEmail)) {
    console.log(`[LOCAL_ADMIN_EMAIL_DETECTED] email=${effectiveEmail}`);
    console.log(`[ADMIN_BYPASS_ACTIVE][LOCAL] email=${effectiveEmail} — local hardcoded admin, overriding access`);
    access.allowed = true;
    access.plan    = 'lifetime';
    access.source  = 'local-admin';
    access.reason  = 'admin';
    access.status  = 'lifetime';
  }

  console.log(`[LOCAL_LICENSE_CHECK_RESULT] allowed=${access.allowed} plan=${access.plan ?? 'n/a'} source=${access.source ?? access.reason ?? 'cloud'}`);

  if (access.allowed === false) {
    console.warn('[start] access denied —', access.reason, access.status);
    return res.status(403).json({
      error:   'Access denied — active subscription required to run the bot.',
      reason:  access.reason,
      status:  access.status,
      sub:     access.sub ?? null,
    });
  }

  // Backend unreachable and not an admin: block all runs.
  if (access.allowed === null) {
    console.warn('[start] backend unreachable — blocking run');
    return res.status(403).json({
      error:  'Cannot verify subscription — run is disabled while the backend is unreachable.',
      reason: access.reason,
      status: 'unknown',
    });
  }
  // ── End verification ─────────────────────────────────────────────────────

  // Register / update this device in the cloud (fire-and-forget — never blocks the run)
  if (access.allowed === true) {
    registerDeviceAsync(token).then(r => { if (r) state.lastDeviceReg = { ...r, registeredAt: new Date().toISOString() }; }).catch(() => {});
  }

  const { list, mode, max, delay } = req.body;

  if (!list || !mode) {
    return res.status(400).json({ error: 'list and mode are required' });
  }

  // ── Map and validate list ────────────────────────────────────────────────
  const mappedList = LIST_MAP[list];
  if (!mappedList) {
    return res.status(400).json({ error: `Unknown list value: "${list}". Expected: 1st, 2nd, 3rd` });
  }

  // ── Validate mode ────────────────────────────────────────────────────────
  if (mode !== 'live') {
    return res.status(400).json({ error: `Unknown mode: "${mode}". Expected: live` });
  }

  // ── Build args explicitly ────────────────────────────────────────────────
  const args = [
    path.join('src', 'main.js'),
    `--list=${mappedList}`,
    `--mode=${mode}`,
  ];

  // --max: pass numeric values as-is; pass 'all' only if explicitly requested.
  // Omit if missing or invalid so main.js keeps its own default.
  if (max) {
    if (max === 'all') {
      args.push('--max=all');
    } else {
      const n = parseInt(max, 10);
      if (!isNaN(n) && n > 0) {
        args.push(`--max=${n}`);
      }
    }
  }

  // --delay: only pass known profiles
  if (delay && VALID_DELAYS.includes(delay)) {
    args.push(`--delay=${delay}`);
  }

  // Dashboard already confirmed via ConfirmModal — skip interactive prompt
  if (mode === 'live') {
    args.push('--skip-confirm');
  }

  // ── Pre-spawn: runtime + file diagnostics ────────────────────────────────
  const mainScriptAbs    = path.join(BOT_WORKING_DIR, 'src', 'main.js');
  const sessionScriptAbs = path.join(BOT_WORKING_DIR, 'src', 'session.js');
  const nodeModulesAbs   = path.join(BOT_WORKING_DIR, 'node_modules');
  const minimistAbs      = path.join(nodeModulesAbs, 'minimist');
  const playwrightAbs    = path.join(nodeModulesAbs, 'playwright');
  const playwrightCoreAbs= path.join(nodeModulesAbs, 'playwright-core');
  const dotenvAbs        = path.join(nodeModulesAbs, 'dotenv');

  console.log(`[spawn] ── pre-spawn diagnostics ─────────────────────────`);
  console.log(`[spawn] platform             : ${process.platform}`);
  console.log(`[spawn] BOT_WORKING_DIR      : ${BOT_WORKING_DIR}`);
  console.log(`[spawn] NODE_BIN             : ${NODE_BIN}`);
  console.log(`[spawn] NODE_BIN_exists      : ${fs.existsSync(NODE_BIN)}`);
  console.log(`[spawn] USE_ELECTRON_AS_NODE : ${USE_ELECTRON_AS_NODE}`);
  console.log(`[spawn] src/main.js          : ${fs.existsSync(mainScriptAbs)}  (${mainScriptAbs})`);
  console.log(`[spawn] src/session.js       : ${fs.existsSync(sessionScriptAbs)}`);
  console.log(`[spawn] node_modules         : ${fs.existsSync(nodeModulesAbs)}`);
  console.log(`[spawn] minimist             : ${fs.existsSync(minimistAbs)}`);
  console.log(`[spawn] playwright           : ${fs.existsSync(playwrightAbs)}`);
  console.log(`[spawn] playwright-core      : ${fs.existsSync(playwrightCoreAbs)}`);
  console.log(`[spawn] dotenv               : ${fs.existsSync(dotenvAbs)}`);

  // Hard stops — surface packaging failures before spawning so the error is clear
  if (!fs.existsSync(mainScriptAbs)) {
    const msg = `FATAL: src/main.js not found at "${mainScriptAbs}" — packaging is broken`;
    console.error(`[spawn] ${msg}`);
    io.emit('log', { timestamp: new Date().toISOString(), level: 'error', text: msg });
    state.runState = 'complete'; state.lastRunStatus = 'error';
    io.emit('run:complete', { stats: state.stats, exitCode: -1, error: msg });
    return res.status(500).json({ error: msg });
  }
  if (!fs.existsSync(minimistAbs)) {
    const msg = `FATAL: node_modules/minimist missing from "${nodeModulesAbs}" — run npm ci at root before packaging`;
    console.error(`[spawn] ${msg}`);
    io.emit('log', { timestamp: new Date().toISOString(), level: 'error', text: msg });
    state.runState = 'complete'; state.lastRunStatus = 'error';
    io.emit('run:complete', { stats: state.stats, exitCode: -1, error: msg });
    return res.status(500).json({ error: msg });
  }

  // Node binary guard: if not using ELECTRON_RUN_AS_NODE and the binary path
  // doesn't exist on disk, fail fast with a clear message instead of ENOENT.
  const nodeBinIsAbsolute = NODE_BIN !== 'node' && path.isAbsolute(NODE_BIN);
  if (nodeBinIsAbsolute && !fs.existsSync(NODE_BIN) && !USE_ELECTRON_AS_NODE) {
    const msg = `FATAL: Node.js binary not found at "${NODE_BIN}" and ELECTRON_RUN_AS_NODE not set — Windows packaged app runtime is broken`;
    console.error(`[spawn] ${msg}`);
    io.emit('log', { timestamp: new Date().toISOString(), level: 'error', text: msg });
    state.runState = 'complete'; state.lastRunStatus = 'error';
    io.emit('run:complete', { stats: state.stats, exitCode: -1, error: msg });
    return res.status(500).json({ error: msg });
  }

  // ── Log the exact launch command ─────────────────────────────────────────
  const launchLine = `${NODE_BIN}${USE_ELECTRON_AS_NODE ? ' [ELECTRON_RUN_AS_NODE=1]' : ''} ${args.join(' ')}`;
  console.log(`[spawn] ── bot launch ────────────────────────────────────`);
  console.log(`[spawn] cwd : ${BOT_WORKING_DIR}`);
  console.log(`[spawn] bin : ${NODE_BIN}`);
  console.log(`[spawn] args: ${JSON.stringify(args)}`);
  console.log(`[spawn] full: ${launchLine}`);

  // ── Reset state ──────────────────────────────────────────────────────────
  state.stats = { processed: 0, messaged: 0, dnc: 0, skipped: 0, failed: 0 };
  state.loginState   = null;
  state.runState     = 'running';
  state.lastRunStatus   = null;
  state.lastRunLogFile  = null;

  // ── One-time launch token ─────────────────────────────────────────────────
  const launchToken = crypto.randomBytes(32).toString('hex');
  state.pendingLaunchToken = launchToken;

  // ── Build writable env paths for bot (per-user isolation) ────────────────
  // Scope all writable paths under users/<userId>/ so each app account gets
  // its own Statflo browser session and its own saved messages.
  const userScopedDir = getUserScopedDir(userId);
  // Fallback for dev mode or unauthenticated spawns: use USER_DATA_DIR root.
  const botDataRoot = userScopedDir || process.env.USER_DATA_DIR || null;

  const sessionProfileDir = botDataRoot ? path.join(botDataRoot, 'playwright-profile') : null;
  const logsDir           = botDataRoot ? path.join(botDataRoot, 'logs')               : null;
  const messagesFile      = botDataRoot ? path.join(botDataRoot, 'messages.json')      : null;
  state.lastRunLogsDir = logsDir || path.join(BOT_WORKING_DIR, 'logs');

  // NODE_PATH tells Node.js where to find modules for the bot subprocess.
  // In packaged mode BOT_WORKING_DIR is Contents/Resources and node_modules lives
  // there as an extraResource — this makes the lookup explicit and immune to cwd
  // changes or symlink issues that can confuse relative require() resolution.
  const nodePath = path.join(BOT_WORKING_DIR, 'node_modules');

  const botEnv = {
    ...process.env,
    NODE_PATH:            nodePath,
    RUFLO_LAUNCH_TOKEN:   launchToken,
    RUFLO_DASHBOARD_PORT: String(PORT),
    // When no system Node is available, the bot is launched via the Electron binary
    // with ELECTRON_RUN_AS_NODE=1.  This makes the app self-contained on Windows —
    // customers do not need Node.js installed.
    ...(USE_ELECTRON_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(botDataRoot ? {
      SESSION_PROFILE_DIR: sessionProfileDir,
      LOGS_DIR:            logsDir,
      BOT_DATA_DIR:        botDataRoot,
    } : {}),
  };

  // ── Spawn — comprehensive diagnostics (visible in dashboard log panel) ────
  console.log(`[spawn] ── Windows/Mac parity check ──────────────────────────`);
  console.log(`[spawn] platform           : ${process.platform}`);
  console.log(`[spawn] userId             : ${userId || '(dev/anon — not per-user isolated)'}`);
  console.log(`[spawn] USER_DATA_DIR      : ${process.env.USER_DATA_DIR || '(not set)'}`);
  console.log(`[spawn] botDataRoot        : ${botDataRoot || '(not set — dev mode)'}`);
  console.log(`[spawn] BOT_DATA_DIR       : ${botDataRoot || '(not set)'}`);
  console.log(`[spawn] SESSION_PROFILE_DIR: ${sessionProfileDir || '(default ./playwright-profile)'}`);
  console.log(`[spawn] LOGS_DIR           : ${logsDir           || '(default ./logs)'}`);
  console.log(`[spawn] messages file      : ${messagesFile       || '(default dev path)'}`);
  console.log(`[spawn] NODE_PATH          : ${nodePath}`);

  // Check whether the messages file exists and has content — helps debug empty-message runs
  if (messagesFile) {
    try {
      const msgs = JSON.parse(require('fs').readFileSync(messagesFile, 'utf8'));
      const has2nd = !!(msgs.secondAttemptMessage || '').trim();
      const has3rd = !!(msgs.thirdAttemptMessage  || '').trim();
      console.log(`[spawn] messages on disk   : 2nd=${has2nd ? 'YES' : 'EMPTY'}, 3rd=${has3rd ? 'YES' : 'EMPTY'}`);
    } catch {
      console.log(`[spawn] messages on disk   : (file not found — bot will use empty defaults)`);
    }
  }

  io.emit('log', {
    timestamp: new Date().toISOString(),
    level: 'info',
    text: `[SPAWN] Starting bot: ${launchLine}`,
  });

  const child = spawn(NODE_BIN, args, {
    cwd:   BOT_WORKING_DIR,
    env:   botEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.activeProcess = child;

  // Log PID immediately so we know the process actually started
  console.log(`[spawn] child pid: ${child.pid ?? '(no pid — spawn may have failed)'}`);
  io.emit('run:started', { args, cmd: launchLine, pid: child.pid });
  io.emit('log', {
    timestamp: new Date().toISOString(),
    level: 'info',
    text: `[SPAWN] Bot process started — PID ${child.pid}`,
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const timestamp = new Date().toISOString();
        const level = parseLogLevel(line);
        parseStats(line);
        io.emit('log', { timestamp, level, text: line });

        // Capture the log file path the bot announces at startup
        if (!state.lastRunLogFile) {
          const logFileMatch = line.match(/Log file\s*:\s*(.+\.log)/i);
          if (logFileMatch) {
            state.lastRunLogFile = logFileMatch[1].trim();
            console.log(`[spawn] captured log file: ${state.lastRunLogFile}`);
          }
        }

        // Detect login state markers emitted by session.js
        if (line.includes('[LOGIN_REQUIRED]')) {
          state.loginState = 'required';
          state.runState = 'login_required';
          io.emit('login:required');
        } else if (line.includes('[LOGIN_DETECTED]')) {
          state.loginState = 'detected';
          state.runState = 'running';
          io.emit('login:detected');
        }
      } catch (parseErr) {
        // Parser failure must never crash the run
        console.error('[stdout-parser] non-fatal error:', parseErr.message);
      }
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const timestamp = new Date().toISOString();
        console.error(`[stderr] ${line}`);
        io.emit('log', { timestamp, level: 'error', text: line });
      } catch (e) {
        // non-fatal
      }
    }
  });

  child.on('close', (code, signal) => {
    const exitLabel = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[spawn] process exited — ${exitLabel}`);

    let exitText = `Process exited — ${exitLabel}`;
    // Non-zero very-fast exit almost always means startup crash
    if (code !== 0 && code !== null) {
      exitText += '. Check logs above for the startup error.';
    }

    io.emit('log', {
      timestamp: new Date().toISOString(),
      level: code === 0 ? 'info' : 'error',
      text: exitText,
    });
    state.runState = 'complete';
    state.loginState = null;
    state.activeProcess = null;
    state.pendingLaunchToken = null;
    state.lastRunStatus = code === 0 ? 'complete' : 'error';
    // If we never captured a log file from stdout, fall back to newest in logsDir
    if (!state.lastRunLogFile) {
      const newest = latestLogFile(state.lastRunLogsDir);
      if (newest) state.lastRunLogFile = newest.path;
    }
    io.emit('run:complete', { stats: state.stats, exitCode: code, exitSignal: signal, logFile: state.lastRunLogFile });
  });

  child.on('error', (err) => {
    console.error(`[spawn] process error: ${err.message}`);

    // ENOENT means the node binary was not found in PATH — give an actionable message
    const userMessage = err.code === 'ENOENT'
      ? `FATAL: Cannot find Node.js — tried "${NODE_BIN}". Install Node.js or restart the app from a terminal.`
      : `FATAL: Bot process failed to start — ${err.message}`;

    console.error(`[spawn] ${userMessage}`);
    io.emit('log', {
      timestamp: new Date().toISOString(),
      level: 'error',
      text: userMessage,
    });
    state.runState = 'complete';
    state.activeProcess = null;
    state.pendingLaunchToken = null;
    state.lastRunStatus = 'error';
    io.emit('run:complete', { stats: state.stats, exitCode: -1, error: userMessage, logFile: state.lastRunLogFile });
  });

  res.json({ ok: true, args, cmd: launchLine });
});

app.post('/api/stop', (req, res) => {
  if (state.runState !== 'running' && state.runState !== 'login_required') {
    return res.status(409).json({ error: 'No active run to stop' });
  }
  killActiveProcess();
  state.runState = 'idle';
  state.loginState = null;
  state.lastRunStatus = 'stopped';
  if (!state.lastRunLogFile) {
    const newest = latestLogFile(state.lastRunLogsDir);
    if (newest) state.lastRunLogFile = newest.path;
  }
  io.emit('log', { timestamp: new Date().toISOString(), level: 'warn', text: 'Run stopped by user.' });
  io.emit('run:stopped', { logFile: state.lastRunLogFile });
  res.json({ ok: true });
});

// /api/continue — button-driven fallback for login flow.
// The session.js poll will detect the URL change automatically,
// but this endpoint can be used as an explicit "I'm done" signal.
// It simply emits a dashboard log so the user knows the bot is watching.
app.post('/api/continue', (req, res) => {
  if (state.runState !== 'login_required') {
    return res.status(409).json({ error: 'Not waiting for login' });
  }
  io.emit('log', {
    timestamp: new Date().toISOString(),
    level: 'info',
    text: 'Continue signal received — bot is checking for login…',
  });
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ state: state.runState, loginState: state.loginState, stats: state.stats });
});

// Production mode: USER_DATA_DIR is set when running as a packaged Electron app.
// In production we require a valid authenticated userId for every messages request.
// In dev (no USER_DATA_DIR) we allow unauthenticated requests for convenience.
const IS_PRODUCTION = !!process.env.USER_DATA_DIR;

// GET /api/messages — LOCAL-FIRST.
//
// Priority:
//   1. Local per-user file (BOT_DATA_DIR/users/<userId>/messages.json)
//   2. Cloud as fallback ONLY when local is empty (new device / fresh install)
//
// Cloud is NEVER allowed to overwrite non-empty local data — this prevents a
// race where the fire-and-forget POST sync hasn't finished yet, causing the
// next GET to see cloud-empty and clobber the just-saved local copy.
//
// The bot subprocess reads from the local file at run time (src/config.js).
app.get('/api/messages', async (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);

  // Production: require a valid authenticated user — never serve shared/fallback data
  if (IS_PRODUCTION && !userId) {
    console.warn('[messages] GET rejected — no valid userId decoded from token');
    return res.status(401).json({ error: 'Authentication required' });
  }

  // ── Step 1: read local file first ─────────────────────────────────────────
  const local = readMessages(userId);
  const localHasContent =
    (local.secondAttemptMessage || '').trim() ||
    (local.thirdAttemptMessage  || '').trim();

  if (localHasContent) {
    console.log('[messages] serving from local cache (local-first)');
    return res.json(local);
  }

  // ── Step 2: local is empty — try cloud as a one-time bootstrap ────────────
  if (CLOUD_API_URL && token) {
    try {
      const cloudRes = await fetch(`${CLOUD_API_URL}/api/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (cloudRes.ok) {
        const data = await cloudRes.json();
        if (typeof data.secondAttemptMessage !== 'string') {
          // Unexpected shape — cloud returned an error object, ignore it
          console.warn('[messages] cloud returned unexpected shape — using local empty');
          return res.json(local);
        }
        const cloudHasContent =
          (data.secondAttemptMessage || '').trim() ||
          (data.thirdAttemptMessage  || '').trim();
        if (cloudHasContent && userId) {
          // Cloud has data the user saved on another device — cache it locally
          writeMessages(userId, {
            secondAttemptMessage: data.secondAttemptMessage,
            thirdAttemptMessage:  data.thirdAttemptMessage,
          });
          console.log('[messages] bootstrapped local cache from cloud');
        }
        return res.json(cloudHasContent ? data : local);
      }
      console.warn('[messages] cloud returned', cloudRes.status, '— serving local empty');
    } catch (err) {
      console.warn('[messages] cloud fetch failed:', err.message, '— serving local empty');
    }
  }

  res.json(local);
});

// POST /api/messages — writes to per-user local cache, fire-and-forgets to cloud.
app.post('/api/messages', async (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);

  // Production: require auth — never write to a shared path
  if (IS_PRODUCTION && !userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { secondAttemptMessage, thirdAttemptMessage } = req.body;

  if (typeof secondAttemptMessage !== 'string' || typeof thirdAttemptMessage !== 'string') {
    return res.status(400).json({ error: 'secondAttemptMessage and thirdAttemptMessage must be strings' });
  }
  if (secondAttemptMessage.trim().length === 0 || thirdAttemptMessage.trim().length === 0) {
    return res.status(400).json({ error: 'Messages cannot be empty' });
  }

  const data = { secondAttemptMessage: secondAttemptMessage.trim(), thirdAttemptMessage: thirdAttemptMessage.trim() };

  // Write to per-user local cache first — bot subprocess needs this synchronously at run time
  writeMessages(userId, data);

  // Async cloud sync (non-blocking)
  if (CLOUD_API_URL && token) {
    fetch(`${CLOUD_API_URL}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    }).catch(err => console.warn('[messages] cloud sync failed:', err.message));
  }

  res.json({ ok: true, ...data });
});

// ── Cloud API proxy ─────────────────────────────────────────────────────────
// Forwards requests from the React client to the cloud backend server-to-server.
// This eliminates all CORS issues — the browser only ever talks to localhost.
//
// Routes proxied:
//   GET  /api/proxy/account
//   POST /api/proxy/checkout/lifetime
//   POST /api/proxy/checkout/monthly
//   POST /api/proxy/billing/portal
//   POST /api/proxy/licenses/register-device

async function proxyCloud(method, cloudPath, req, res) {
  if (!CLOUD_API_URL) {
    console.warn('[proxy] CLOUD_API_URL not configured — check ui/server/.env');
    return res.status(503).json({ error: 'Cloud API not configured', reason: 'no-cloud-url' });
  }
  const hasAuth = !!req.headers.authorization;
  console.log(`[proxy] ${method} ${cloudPath} — auth=${hasAuth ? 'yes' : 'NO'} target=${CLOUD_API_URL}`);
  try {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
      },
      signal: AbortSignal.timeout(12000),
    };
    if (method !== 'GET' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    const upstream = await fetch(`${CLOUD_API_URL}${cloudPath}`, opts);
    console.log(`[proxy] ${cloudPath} → ${upstream.status}`);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.warn(`[proxy] ${cloudPath} failed:`, err.message);
    res.status(503).json({ error: 'Cloud API unavailable', reason: 'backend-down' });
  }
}

// ── /api/proxy/account — admin-intercepted ───────────────────────────────────
// For the owner/admin email, return a synthetic account immediately without
// touching the cloud.  This guarantees access even when the cloud is unreachable,
// and prevents the UI subscription gate from ever firing for the owner.
app.get('/api/proxy/account', async (req, res) => {
  const token    = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const jwtEmail = decodeJwtEmail(token);
  console.log(`[OWNER_ADMIN_CHECK] email=${jwtEmail ?? '(unknown)'}`);

  if (isLocalAdminEmail(jwtEmail)) {
    console.log(`[OWNER_ADMIN_BYPASS_ACTIVE] email=${jwtEmail} — fetching real account data with admin overrides`);
    // Fetch real data from cloud so devices are accurate, but force admin access flags.
    // Falls back to synthetic account only when cloud is unreachable.
    try {
      const cloudRes = await fetch(`${CLOUD_API_URL}/api/account`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      const data = await cloudRes.json();
      console.log(`[OWNER_ADMIN_BYPASS_ACTIVE] cloud returned ${cloudRes.status} devices=${data?.devices?.length ?? 0}`);
      console.log(`[ACCOUNT_ACCESS_RESULT] hasAccess=true isAdmin=true plan=lifetime source=owner-admin-bypass-cloud`);
      return res.status(cloudRes.status).json({
        ...data,
        profile:      { ...(data.profile ?? {}), email: data.profile?.email ?? jwtEmail, is_admin: true },
        license:      data.license ?? { id: 'admin', license_key: 'ADMIN', status: 'active', plan: 'lifetime', max_devices: 999, created_at: null },
        subscription: data.subscription ?? { status: 'lifetime', plan: 'lifetime', is_admin: true },
        hasAccess:    true,
        isAdmin:      true,
        licenseSource: 'owner-admin-bypass',
      });
    } catch (err) {
      console.warn(`[OWNER_ADMIN_BYPASS_ACTIVE] cloud unreachable (${err.message}) — using synthetic account`);
      console.log(`[ACCOUNT_ACCESS_RESULT] hasAccess=true isAdmin=true plan=lifetime source=owner-admin-bypass-synthetic`);
      return res.json({
        profile:      { email: jwtEmail, is_admin: true, full_name: null },
        license:      { id: 'admin', license_key: 'ADMIN', status: 'active', plan: 'lifetime', max_devices: 999, created_at: null },
        subscription: { status: 'lifetime', plan: 'lifetime', is_admin: true },
        devices:      [],
        swapStatus:   null,
        hasAccess:    true,
        isAdmin:      true,
        licenseSource: 'owner-admin-bypass',
      });
    }
  }

  // Non-admin: fetch from cloud, log the result, then return to client.
  try {
    const cloudRes = await fetch(`${CLOUD_API_URL}/api/account`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await cloudRes.json();
    const subStatus = data?.subscription?.status ?? 'none';
    const licStatus = data?.license?.status ?? 'none';
    const hasAccess = data?.hasAccess ?? (licStatus === 'active' || ['active','trialing','lifetime'].includes(subStatus));
    console.log(`[DESKTOP_PROXY_ACCOUNT] hasAccess=${hasAccess} subStatus=${subStatus} licStatus=${licStatus} isAdmin=${data?.isAdmin ?? false} email=${jwtEmail ?? '(unknown)'}`);
    return res.status(cloudRes.status).json(data);
  } catch (err) {
    console.warn(`[DESKTOP_PROXY_ACCOUNT] cloud unreachable: ${err.message}`);
    return res.status(503).json({ error: 'Cloud API unavailable', reason: 'backend-down' });
  }
});

app.post('/api/proxy/checkout/lifetime',          (req, res) => proxyCloud('POST', '/api/checkout/lifetime',          req, res));
app.post('/api/proxy/checkout/monthly',           (req, res) => proxyCloud('POST', '/api/checkout/monthly',           req, res));
app.post('/api/proxy/billing/portal',             (req, res) => proxyCloud('POST', '/api/billing/portal',             req, res));
app.post('/api/proxy/licenses/register-device',   (req, res) => proxyCloud('POST', '/api/licenses/register-device',   req, res));
app.get ('/api/proxy/download',                   (req, res) => proxyCloud('GET',  `/api/download?platform=${encodeURIComponent(req.query.platform ?? '')}`, req, res));

// ── Debug endpoint ────────────────────────────────────────────────────────────
// Returns live runtime state for the in-app debug panel (admin only).
app.get('/api/debug', (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);
  const msgFile = userId ? getMessagesFile(userId) : null;

  let messages = null;
  let messagesSource = 'none';
  if (msgFile) {
    try {
      const raw = fs.readFileSync(msgFile, 'utf8');
      messages = JSON.parse(raw);
      messagesSource = 'local';
    } catch {
      messages = { ...DEFAULT_MESSAGES };
      messagesSource = 'empty-default';
    }
  }

  const deviceFpFile = process.env.USER_DATA_DIR
    ? path.join(process.env.USER_DATA_DIR, 'device.json')
    : null;
  let deviceFingerprint = null;
  try {
    if (deviceFpFile) deviceFingerprint = JSON.parse(fs.readFileSync(deviceFpFile, 'utf8')).fingerprint ?? null;
  } catch {}

  res.json({
    env: {
      platform:     process.platform,
      hostname:     os.hostname(),
      USER_DATA_DIR: process.env.USER_DATA_DIR || null,
      BOT_DATA_DIR:  process.env.BOT_DATA_DIR  || null,
      CLOUD_API_URL: CLOUD_API_URL             || null,
      IS_PRODUCTION,
      serverPort:   PORT,
      buildCommit:  BUILD_COMMIT,
      buildTime:    BUILD_TIME,
    },
    userId,
    messagesFile: msgFile,
    messagesSource,
    messages,
    deviceFingerprint: deviceFingerprint ? deviceFingerprint.slice(0, 8) + '…' : null,
    lastDeviceReg: state.lastDeviceReg,
    runState: state.runState,
  });
});

// ── Log file API ──────────────────────────────────────────────────────────────
// Exposes run log files for the in-app "Last Run Logs" panel.
// All content is sanitized — no tokens, keys, or secrets are ever returned.

app.get('/api/logs/latest', (req, res) => {
  const logsDir = state.lastRunLogsDir;
  const logFile = state.lastRunLogFile || (logsDir ? latestLogFile(logsDir)?.path : null);
  if (!logFile) return res.json({ ok: false, reason: 'no-log-file', content: null, logFile: null });
  const content = readLogFileSafe(logFile);
  if (content === null) return res.json({ ok: false, reason: 'read-error', content: null, logFile });
  res.json({ ok: true, logFile, content, status: state.lastRunStatus });
});

app.get('/api/logs/list', (req, res) => {
  const logsDir = state.lastRunLogsDir;
  const files = listLogFiles(logsDir).map(f => ({
    filename:  f.filename,
    timestamp: f.timestamp,
    isCurrent: f.path === state.lastRunLogFile,
  }));
  res.json({ ok: true, logsDir, files });
});

app.get('/api/logs/:filename', (req, res) => {
  const logsDir = state.lastRunLogsDir;
  if (!logsDir) return res.status(404).json({ ok: false, reason: 'no-logs-dir' });
  // Safety: only allow filenames matching expected pattern (no path traversal)
  const { filename } = req.params;
  if (!/^run-[0-9T:.-]+\.log$/.test(filename)) {
    return res.status(400).json({ ok: false, reason: 'invalid-filename' });
  }
  const filePath = path.join(logsDir, filename);
  // Ensure resolved path stays inside logsDir (prevent traversal)
  if (!filePath.startsWith(path.resolve(logsDir))) {
    return res.status(403).json({ ok: false, reason: 'forbidden' });
  }
  const content = readLogFileSafe(filePath);
  if (content === null) return res.status(404).json({ ok: false, reason: 'not-found' });
  res.json({ ok: true, logFile: filePath, content });
});

// ── Reset local data ──────────────────────────────────────────────────────────
// Clears the per-user local messages file so the next load fetches from cloud.
app.post('/api/reset-local', (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);
  if (IS_PRODUCTION && !userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const file = getMessagesFile(userId);
  try {
    fs.unlinkSync(file);
    console.log(`[reset-local] deleted messages file: ${file}`);
    res.json({ ok: true, deleted: file });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ ok: true, deleted: null, note: 'file did not exist' });
    res.status(500).json({ error: err.message });
  }
});

// ── Device registration endpoint ─────────────────────────────────────────────
// Called by the React app on login and on Account refresh — NOT gated behind a
// subscription check so it works before the user starts a run.
app.post('/api/register-device', async (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);

  if (IS_PRODUCTION && !userId) {
    console.warn('[register-device] 401 — no valid userId decoded from token');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const jwtEmail = decodeJwtEmail(token);
  const adminUser = isLocalAdminEmail(jwtEmail);

  const result = await registerDeviceAsync(token);

  if (!result) {
    return res.status(503).json({ error: 'Cloud API not configured or no token provided' });
  }

  // For admin users, a cloud sync failure is non-critical — suppress scary error text.
  if (result.error && adminUser) {
    const isNetworkError = /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(result.error);
    if (isNetworkError) {
      result.error = null;
      result.adminNote = 'Cloud device sync unavailable — local admin access active.';
    }
  }

  state.lastDeviceReg = { ...result, registeredAt: new Date().toISOString() };
  res.json(state.lastDeviceReg);
});

// ── Static file serving for built React app (production / desktop:start) ─────
const CLIENT_DIST       = path.join(__dirname, '..', 'client', 'dist');
const CLIENT_INDEX_HTML = path.join(CLIENT_DIST, 'index.html');

console.log(`[server] CLIENT_DIST       : ${CLIENT_DIST}`);
console.log(`[server] CLIENT_DIST_EXISTS: ${fs.existsSync(CLIENT_DIST)}`);
console.log(`[server] INDEX_HTML_EXISTS : ${fs.existsSync(CLIENT_INDEX_HTML)}`);

if (fs.existsSync(CLIENT_DIST) && fs.existsSync(CLIENT_INDEX_HTML)) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback: serve index.html for any non-API, non-socket path
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(CLIENT_INDEX_HTML);
  });
} else {
  // Client build missing — show a diagnostic page instead of a blank/404 response.
  // This makes packaging failures visible rather than showing a black window.
  console.error(`[server] FATAL: CLIENT_DIST not found at ${CLIENT_DIST}`);
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.status(503).send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>` +
      `<body style="background:#0a0a0f;color:#f87171;font-family:monospace;padding:40px;margin:0">` +
      `<h2 style="color:#818cf8">StatfloBot — packaging error</h2>` +
      `<p>React client build not found.</p>` +
      `<p style="color:#475569">Expected: ${CLIENT_DIST}</p>` +
      `<p style="color:#475569">resourcesPath env: ${process.env.RESOURCES_PATH || '(not set)'}</p>` +
      `<p style="color:#475569">__dirname: ${__dirname}</p>` +
      `<p style="color:#64748b">Run <code>npm run build:ui</code> then repackage.</p>` +
      `</body></html>`
    );
  });
}

// Internal one-time launch token verification — called by spawned child on startup.
// Token is valid only once; it is cleared immediately after first use.
app.post('/api/internal/verify-launch', (req, res) => {
  const { token } = req.body;
  if (!token || !state.pendingLaunchToken) {
    return res.status(403).json({ ok: false, reason: 'no-token' });
  }
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(state.pendingLaunchToken))) {
    return res.status(403).json({ ok: false, reason: 'invalid-token' });
  }
  state.pendingLaunchToken = null; // burn after one use
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // Send current state on connect
  socket.emit('status', { state: state.runState, stats: state.stats });
});

const PORT = process.env.PORT || 3001;

// Bind explicitly to 127.0.0.1 (IPv4 loopback) rather than letting Node pick
// an interface.  On Windows, server.listen(PORT) without a host can bind to
// the IPv6 loopback (::1) only, which causes the bot subprocess to fail when
// it tries to verify its launch token via http://127.0.0.1:<port>.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Statflo dashboard server running on http://127.0.0.1:${PORT}`);
  console.log(`[cloud] CLOUD_API_URL = ${CLOUD_API_URL || '(not set — proxy routes will return 503)'}`);
});
