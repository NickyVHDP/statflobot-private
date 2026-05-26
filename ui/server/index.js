const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log('[ENV_CHECK] SUPPORT_EMAIL_TO=' + (process.env.SUPPORT_EMAIL_TO || 'missing'));
console.log('[ENV_CHECK] RESEND_API_KEY=' + (process.env.RESEND_API_KEY ? 'present' : 'missing'));
console.log('[ENV_CHECK] SUPPORT_EMAIL_FROM=' + (process.env.SUPPORT_EMAIL_FROM || 'missing'));

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
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
console.log(`[server] STATFLOBOT_DESKTOP   : ${process.env.STATFLOBOT_DESKTOP   || '(not set)'}`);
console.log(`[server] EMBEDDED_BROWSER_WS_ENDPOINT: ${process.env.EMBEDDED_BROWSER_WS_ENDPOINT || '(not set)'}`);
console.log(`[server] process.parentPort   : ${process.parentPort ? 'present' : 'null'}`);
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
// In dev mode (no USER_DATA_DIR): ui/server/data/users/<userId or _dev>
function getUserScopedDir(userId) {
  if (process.env.USER_DATA_DIR) {
    if (!userId) return null;
    return path.join(process.env.USER_DATA_DIR, 'users', userId);
  }
  // Dev fallback — always return a stable local dir so identity can persist
  const segment = userId || '_dev';
  const devDir = path.join(__dirname, 'data', 'users', segment);
  console.log(`[USER_DATA_DIR_FALLBACK_DEV] no USER_DATA_DIR — using ${devDir}`);
  return devDir;
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
    smsSent: 0,
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
  lastRunToken:       null, // JWT from most recent /api/start — used for identity lock
  lastRunBotDataDir:  null, // botDataRoot from most recent /api/start — used for identity file
  lastIdentityBlock:  null, // { reason, locked, current } — preserved for re-emit on exit code 2
  smsSentSeen:        new Set(), // dedup keys for smsSent counting
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
  // Bot logs use '=' separator: processed=1/5, sent=1, dnc=0, skip=0, fail=0
  // Support both '=' and ': '/' ' for flexibility.
  const patterns = [
    { key: 'processed', regex: /processed[=:\s]+(\d+)/i },
    // Bot uses 'sent=' for messaged count in RUN_CLIENT_DONE / RUN_LOOP lines
    { key: 'messaged',  regex: /(?:messaged|sent)[=:\s]+(\d+)/i },
    { key: 'dnc',       regex: /dnc[=:\s]+(\d+)/i },
    // Bot uses 'skip=' for skipped count
    { key: 'skipped',   regex: /(?:skipped|skip)[=:\s]+(\d+)/i },
    // Bot uses 'fail=' for failed count
    { key: 'failed',    regex: /(?:failed|fail)[=:\s]+(\d+)/i },
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

// Poll the embedded CDP proxy until it responds 200, or timeout expires.
// Returns true on success, false after totalMs has elapsed without a response.
// Embedded mode is the PRIMARY expected path — retry aggressively before falling back.
async function waitForEmbeddedProxy(endpoint, totalMs = 7000, intervalMs = 400) {
  const httpUrl = endpoint.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
  const deadline = Date.now() + totalMs;
  let attempt = 0;

  async function probe() {
    // POST /api/embedded/cookies/clear first — the exact first operation the bot runs.
    // Proves the full request/session stack is usable, not just TCP connectivity.
    const clearOk = await new Promise((resolve) => {
      const body = '{}';
      const req = http.request(`${httpUrl}/api/embedded/cookies/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        if (res.statusCode !== 200) console.log(`[EMBEDDED_PROXY_PROBE] cookies/clear HTTP ${res.statusCode}`);
        resolve(res.statusCode === 200);
      });
      req.on('error', (e) => {
        console.log(`[EMBEDDED_PROXY_PROBE_ERR] cookies/clear: ${e.code ?? e.message}`);
        resolve(false);
      });
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
    if (!clearOk) return false;

    // GET /api/embedded/url — second bot operation
    return new Promise((resolve) => {
      const req = http.get(`${httpUrl}/api/embedded/url`, (res) => {
        const ok = res.statusCode === 200;
        if (!ok) console.log(`[EMBEDDED_PROXY_PROBE] url HTTP ${res.statusCode}`);
        res.resume();
        resolve(ok);
      });
      req.on('error', (e) => {
        console.log(`[EMBEDDED_PROXY_PROBE_ERR] url: ${e.code ?? e.message}`);
        resolve(false);
      });
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  }

  while (Date.now() < deadline) {
    attempt++;
    if (await probe()) {
      console.log(`[EMBEDDED_ENDPOINT_READY] attempt=${attempt} endpoint=${endpoint}`);
      return true;
    }
    console.log(`[EMBEDDED_ENDPOINT_POLL] attempt=${attempt} — proxy not ready yet, retrying`);
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(r => setTimeout(r, Math.min(intervalMs, remaining)));
  }

  console.log(`[EMBEDDED_ENDPOINT_TIMEOUT] proxy unreachable after ${attempt} attempts (${totalMs}ms)`);
  return false;
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

  const { list, mode, delay, everyoneMode } = req.body;

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

  // Always process all clients
  args.push('--max=all');

  // Everyone Mode — pass flag when enabled for the selected list type
  if (everyoneMode) {
    const isFst = list === '1st';
    const modeActive = isFst ? everyoneMode.first : everyoneMode.next;
    if (modeActive) {
      args.push(`--everyone-mode=${isFst ? 'first' : 'next'}`);
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

  // ── Build writable env paths for bot (per-user isolation) ────────────────
  // Scope all writable paths under users/<userId>/ so each app account gets
  // its own Statflo browser session and its own saved messages.
  const userScopedDir = getUserScopedDir(userId);
  // Fallback for dev mode or unauthenticated spawns: use USER_DATA_DIR root.
  const botDataRoot = userScopedDir || process.env.USER_DATA_DIR || null;

  // ── One-time launch token ─────────────────────────────────────────────────
  const launchToken = crypto.randomBytes(32).toString('hex');
  state.pendingLaunchToken = launchToken;

  // ── Reset state ──────────────────────────────────────────────────────────
  state.stats = { processed: 0, messaged: 0, smsSent: 0, dnc: 0, skipped: 0, failed: 0 };
  state.smsSentSeen = new Set();
  state.loginState        = null;
  state.runState          = 'running';
  state.lastRunStatus     = null;
  state.lastRunLogFile    = null;
  state.lastRunToken      = token;
  state.lastRunBotDataDir = botDataRoot;

  console.log('[RUN_START_SERVER_STILL_ALIVE] server alive — spawning bot subprocess');

  const sessionProfileDir = botDataRoot ? path.join(botDataRoot, 'playwright-profile') : null;
  const logsDir           = botDataRoot ? path.join(botDataRoot, 'logs')               : null;
  const messagesFile      = botDataRoot ? path.join(botDataRoot, 'messages.json')      : null;
  state.lastRunLogsDir = logsDir || path.join(BOT_WORKING_DIR, 'logs');

  // NODE_PATH tells Node.js where to find modules for the bot subprocess.
  // In packaged mode BOT_WORKING_DIR is Contents/Resources and node_modules lives
  // there as an extraResource — this makes the lookup explicit and immune to cwd
  // changes or symlink issues that can confuse relative require() resolution.
  const nodePath = path.join(BOT_WORKING_DIR, 'node_modules');

  const savedIdentity = botDataRoot ? readLocalStatfloIdentity(botDataRoot) : null;

  const botEnv = {
    ...process.env,
    NODE_PATH:            nodePath,
    RUFLO_LAUNCH_TOKEN:   launchToken,
    RUFLO_DASHBOARD_PORT: String(PORT),
    // User credentials forwarded to the bot so run-reporter.js can upload
    // a sanitized run summary to /api/runs after each run.
    // The access token is the user's Supabase JWT — same one used to verify
    // access above.  RUFLO_CLOUD_URL is the base URL of the cloud dashboard.
    RUFLO_ACCESS_TOKEN:   token,
    RUFLO_CLOUD_URL:      CLOUD_API_URL,
    // When no system Node is available, the bot is launched via the Electron binary
    // with ELECTRON_RUN_AS_NODE=1.  This makes the app self-contained on Windows —
    // customers do not need Node.js installed.
    ...(USE_ELECTRON_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(botDataRoot ? {
      SESSION_PROFILE_DIR: sessionProfileDir,
      LOGS_DIR:            logsDir,
      BOT_DATA_DIR:        botDataRoot,
    } : {}),
    ...(savedIdentity ? { STATFLO_IDENTITY: savedIdentity } : {}),
    // Server has already verified the user has access (local license + cloud account
    // check) before reaching this spawn. Signal the bot to skip its own authGate call
    // so it never hits the dead Vercel license API endpoint.
    DASHBOARD_ACCESS_VERIFIED: '1',
    // Debug bypass: set DEBUG_BYPASS_LICENSE=1 on the server to also skip the launch
    // token check in the bot. Use only for embedded-mode diagnosis.
    ...(process.env.DEBUG_BYPASS_LICENSE ? { LICENSE_SKIP: '1' } : {}),
  };

  // ── Desktop embedded-mode enforcement ────────────────────────────────────────
  // Desktop runtime is detected when any of these signals is present:
  //   1. STATFLOBOT_DESKTOP=true  — explicit marker injected by server-manager.js (v1.5.6+)
  //   2. EMBEDDED_BROWSER_WS_ENDPOINT — set by server-manager.js for all desktop forks
  //   3. process.parentPort      — Electron utilityProcess IPC channel
  //   4. USER_DATA_DIR           — always set by server-manager for packaged/dev Electron runs
  // All four are checked so detection is robust even if one signal is missing.
  const _isDesktop = !!(
    process.env.STATFLOBOT_DESKTOP === 'true' ||
    process.env.EMBEDDED_BROWSER_WS_ENDPOINT  ||
    process.parentPort                          ||
    process.env.USER_DATA_DIR
  );

  // Helper: log to both boot log (console) AND dashboard log panel (io.emit)
  const _dashLog = (level, text) => {
    console.log(text);
    io.emit('log', { timestamp: new Date().toISOString(), level, text });
  };

  if (_isDesktop) {
    _dashLog('info', '[EMBEDDED_READY_CHECK_START] desktop runtime — ensuring embedded automation is ready');

    // Ask the Electron main process to recreate the BrowserView/bridge if they
    // were torn down after the previous run. Only possible via utilityProcess IPC.
    if (process.parentPort) {
      _dashLog('info', '[EMBEDDED_READY_IPC_SENT] sending embedded:ensure-ready to main process');
      const embeddedReadyResult = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          process.parentPort.removeListener('message', onReady);
          resolve({ ok: false, reason: 'timeout' });
        }, 10000);
        function onReady(event) {
          if (event.data?.type === 'embedded:ready') {
            clearTimeout(timer);
            process.parentPort.removeListener('message', onReady);
            resolve(event.data);
          }
        }
        process.parentPort.addListener('message', onReady);
        process.parentPort.postMessage({ type: 'embedded:ensure-ready' });
      });
      _dashLog(embeddedReadyResult.ok ? 'info' : 'warn', `[EMBEDDED_READY_IPC_RESULT] ok=${embeddedReadyResult.ok} reason=${embeddedReadyResult.reason ?? 'none'} endpoint=${embeddedReadyResult.endpoint ?? '(none)'}`);
      if (!embeddedReadyResult.ok) {
        const _failReason = embeddedReadyResult.reason ?? 'unknown';
        _dashLog('error', `[BOT_START_ABORTED_REASON] embedded browser not ready — reason=${_failReason} — stop and restart the run`);
        state.runState = 'complete'; state.lastRunStatus = 'error';
        state.activeProcess = null; state.pendingLaunchToken = null;
        io.emit('run:complete', { stats: state.stats, exitCode: -1, error: `Embedded browser not ready (${_failReason}) — please try again.` });
        return res.status(503).json({ error: `Embedded browser not ready (${_failReason}) — please try again.` });
      }
    } else {
      _dashLog('warn', '[EMBEDDED_READY_IPC_SKIPPED] process.parentPort is null — skipping IPC, relying on existing bridge');
    }

    // Force embedded env vars on every desktop spawn — non-negotiable.
    botEnv.EMBEDDED_BROWSER_MODE        = 'true';
    botEnv.EMBEDDED_BROWSER_WS_ENDPOINT = process.env.EMBEDDED_BROWSER_WS_ENDPOINT || 'http://127.0.0.1:9225';
    botEnv.STATFLOBOT_DESKTOP           = 'true';
    _dashLog('info', '[EMBEDDED_MODE_FORCED_FOR_DESKTOP] forced EMBEDDED_BROWSER_MODE=true STATFLOBOT_DESKTOP=true for desktop spawn');

    // Probe bridge — hard-fail in desktop mode; no external-Chromium fallback ever.
    const _desktopEndpoint = botEnv.EMBEDDED_BROWSER_WS_ENDPOINT;
    _dashLog('info', `[EMBEDDED_PROXY_PROBE_START] probing bridge at ${_desktopEndpoint}`);
    const _bridgeAlive = await waitForEmbeddedProxy(_desktopEndpoint);
    if (!_bridgeAlive) {
      _dashLog('error', `[EMBEDDED_PROXY_PROBE_FAILED] bridge unreachable at ${_desktopEndpoint} — aborting run`);
      _dashLog('error', '[BOT_START_ABORTED_REASON] embedded browser unavailable — stop and restart the run');
      state.runState = 'complete'; state.lastRunStatus = 'error';
      state.activeProcess = null; state.pendingLaunchToken = null;
      io.emit('run:complete', { stats: state.stats, exitCode: -1, error: 'Embedded browser unavailable — please try again.' });
      return res.status(503).json({ error: 'Embedded browser unavailable — please try again.' });
    }
    _dashLog('info', `[EMBEDDED_PROXY_PROBE_OK] bridge alive at ${_desktopEndpoint}`);

  } else if (botEnv.EMBEDDED_BROWSER_MODE === 'true' && botEnv.EMBEDDED_BROWSER_WS_ENDPOINT) {
    // Non-desktop: embedded mode manually configured (dev/testing). Probe and allow
    // graceful fallback to external browser if the proxy is unreachable.
    const _devAlive = await waitForEmbeddedProxy(botEnv.EMBEDDED_BROWSER_WS_ENDPOINT);
    if (!_devAlive) {
      console.log('[EMBEDDED_ENDPOINT_MISSING] proxy unreachable — falling back to external browser (dev mode)');
      io.emit('log', { timestamp: new Date().toISOString(), level: 'warn', text: '[EMBEDDED_BROWSER_FALLBACK_USED] proxy unreachable — running in external browser' });
      botEnv.EMBEDDED_BROWSER_MODE = 'false';
    }
  }

  // ── Log exact embedded-mode env being passed to the bot subprocess ───────────
  const _spawnEnvText = `[SPAWN_ENV_DESKTOP] EMBEDDED_BROWSER_MODE=${botEnv.EMBEDDED_BROWSER_MODE ?? '(not set)'} EMBEDDED_BROWSER_WS_ENDPOINT=${botEnv.EMBEDDED_BROWSER_WS_ENDPOINT ?? '(not set)'} STATFLOBOT_DESKTOP=${botEnv.STATFLOBOT_DESKTOP ?? '(not set)'} DASHBOARD_ACCESS_VERIFIED=${botEnv.DASHBOARD_ACCESS_VERIFIED ?? '(not set)'}`;
  console.log(_spawnEnvText);
  if (_isDesktop) io.emit('log', { timestamp: new Date().toISOString(), level: 'info', text: _spawnEnvText });

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

  if (_isDesktop) {
    _dashLog('info', `[BRIDGE_SERVER_LISTENING_PID] spawning bot — bridge=${botEnv.EMBEDDED_BROWSER_WS_ENDPOINT ?? '(none)'} serverPid=${process.pid}`);
  }

  // ── FINAL_SPAWN_CONTRACT — printed to server console + dashboard panel ───────
  const _contractText = [
    '[FINAL_SPAWN_CONTRACT]',
    `  STATFLOBOT_DESKTOP=${botEnv.STATFLOBOT_DESKTOP ?? '(not set)'}`,
    `  EMBEDDED_BROWSER_MODE=${botEnv.EMBEDDED_BROWSER_MODE ?? '(not set)'}`,
    `  EMBEDDED_BROWSER_WS_ENDPOINT=${botEnv.EMBEDDED_BROWSER_WS_ENDPOINT ?? '(not set)'}`,
    `  USER_DATA_DIR=${botEnv.USER_DATA_DIR ?? '(not set)'}`,
    `  BOT_DATA_DIR=${botEnv.BOT_DATA_DIR ?? '(not set)'}`,
    `  LOGS_DIR=${botEnv.LOGS_DIR ?? '(not set)'}`,
    `  DASHBOARD_ACCESS_VERIFIED=${botEnv.DASHBOARD_ACCESS_VERIFIED ?? '(not set)'}`,
    `  RUFLO_LAUNCH_TOKEN=${botEnv.RUFLO_LAUNCH_TOKEN ? 'present' : 'missing'}`,
    `  RUFLO_DASHBOARD_PORT=${botEnv.RUFLO_DASHBOARD_PORT ?? '(not set)'}`,
  ].join('\n');
  console.log(_contractText);
  io.emit('log', { timestamp: new Date().toISOString(), level: 'info', text: _contractText });

  // ── boot-last.log — written BEFORE spawn so crash diagnostics survive exit ──
  // Captures the exact command, spawn env, and all child output. Always written
  // to BOT_WORKING_DIR/logs/boot-last.log regardless of per-user data paths.
  const bootLastPath = path.join(BOT_WORKING_DIR, 'logs', 'boot-last.log');
  try { fs.mkdirSync(path.dirname(bootLastPath), { recursive: true }); } catch {}
  const bootLastLines = [
    `=== boot-last.log — ${new Date().toISOString()} ===`,
    `[BOOT_LAST_CMD]  ${NODE_BIN} ${args.join(' ')}`,
    `[BOOT_LAST_CWD]  ${BOT_WORKING_DIR}`,
    `[BOOT_LAST_ENV]  STATFLOBOT_DESKTOP=${botEnv.STATFLOBOT_DESKTOP ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  EMBEDDED_BROWSER_MODE=${botEnv.EMBEDDED_BROWSER_MODE ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  EMBEDDED_BROWSER_WS_ENDPOINT=${botEnv.EMBEDDED_BROWSER_WS_ENDPOINT ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  USER_DATA_DIR=${botEnv.USER_DATA_DIR ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  BOT_DATA_DIR=${botEnv.BOT_DATA_DIR ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  LOGS_DIR=${botEnv.LOGS_DIR ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  RUFLO_LAUNCH_TOKEN=${botEnv.RUFLO_LAUNCH_TOKEN ? '(present)' : '(not set)'}`,
    `[BOOT_LAST_ENV]  RUFLO_DASHBOARD_PORT=${botEnv.RUFLO_DASHBOARD_PORT ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  LICENSE_SKIP=${botEnv.LICENSE_SKIP ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  DASHBOARD_ACCESS_VERIFIED=${botEnv.DASHBOARD_ACCESS_VERIFIED ?? '(not set)'}`,
    `[BOOT_LAST_ENV]  _isDesktop=${_isDesktop}`,
    '--- stdout/stderr follows ---',
  ];
  try { fs.writeFileSync(bootLastPath, bootLastLines.join('\n') + '\n', 'utf8'); } catch {}

  console.log('[BOT_SPAWN_START] calling spawn — pid will follow');
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

        // Detect identity mismatch — surface as error log + dedicated socket event
        if (line.includes('[STATFLO_IDENTITY_MISMATCH_BLOCKED]')) {
          const locked  = line.match(/locked=(\S+)/)?.[1] ?? null;
          const current = line.match(/current=([^\s—]+)/)?.[1] ?? null;
          state.lastIdentityBlock = { reason: 'mismatch', locked, current };
          io.emit('log', { timestamp: new Date().toISOString(), level: 'error', text: line });
          io.emit('run:identity_blocked', { reason: 'mismatch', locked, current, message: line });
        } else if (line.includes('[STATFLO_IDENTITY_UNKNOWN_BLOCKED]')) {
          const locked  = line.match(/locked=(?:"([^"]+)"|(\S+))/)?.[1] ?? line.match(/locked=(?:"([^"]+)"|(\S+))/)?.[2] ?? null;
          state.lastIdentityBlock = { reason: 'unknown', locked, current: null };
          io.emit('log', { timestamp: new Date().toISOString(), level: 'error', text: line });
          io.emit('run:identity_blocked', { reason: 'unknown', locked, current: null, message: line });
        }

        // Belt-and-suspenders: also detect the explicit STOP reason line so the
        // frontend modal fires even if the MISMATCH_BLOCKED line didn't parse.
        if (line.includes('[BOT_FLOW_STOP_AFTER_LOGIN_REASON]') && line.includes('identity=mismatch') && !state.lastIdentityBlock) {
          const locked  = line.match(/locked=(\S+)/)?.[1] ?? null;
          const current = line.match(/detected=(\S+)/)?.[1] ?? null;
          state.lastIdentityBlock = { reason: 'mismatch', locked, current };
          io.emit('run:identity_blocked', { reason: 'mismatch', locked, current, message: line });
        }

        // Count individual SMS sends for smsSent stat with dedup to handle duplicate stdout lines.
        // [EVERYONE_LINE_SENT] = one line in everyone mode; [SMS_SENT] = normal mode single send.
        if (line.includes('[EVERYONE_LINE_SENT]') || line.includes('[SMS_SENT]')) {
          const bucket = Math.floor(Date.now() / 1000);
          const dedupKey = `${line}:${bucket}`;
          if (state.smsSentSeen.has(dedupKey)) {
            console.log(`[SMS_SENT_DUPLICATE_SKIPPED]`);
          } else {
            state.smsSentSeen.add(dedupKey);
            state.stats.smsSent = (state.stats.smsSent ?? 0) + 1;
            console.log(`[SMS_SENT_COUNTED] total=${state.stats.smsSent}`);
          }
        }

        // Detect network pause/resume markers from statflo.js
        if (line.includes('[RUN_PAUSED_NETWORK]')) {
          io.emit('run:paused_network');
        } else if (line.includes('[RUN_RESUMED_NETWORK]')) {
          io.emit('run:resumed_network');
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
        // Mirror all stderr into boot-last.log for post-mortem diagnosis
        try { fs.appendFileSync(bootLastPath, `[stderr] ${line}\n`, 'utf8'); } catch {}
      } catch (e) {
        // non-fatal
      }
    }
  });

  child.on('error', (err) => {
    console.error(`[BOT_SPAWN_ERROR] spawn failed — ${err.code ?? err.message}`);
    io.emit('log', { timestamp: new Date().toISOString(), level: 'error', text: `[BOT_SPAWN_ERROR] ${err.message}` });
  });

  child.on('close', (code, signal) => {
    const exitLabel = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[BOT_PROCESS_EXIT] code=${code ?? 'null'} signal=${signal ?? 'none'}`);
    console.log(`[spawn] process exited — ${exitLabel}`);
    try { fs.appendFileSync(bootLastPath, `[BOOT_LAST_EXIT] code=${code ?? 'null'} signal=${signal ?? 'none'}\n`, 'utf8'); } catch {}

    // If the run was stopped by the user, suppress run:complete so the UI
    // doesn't show the completion modal for a user-initiated stop.
    if (state.lastRunStatus === 'stopped') {
      console.log('[spawn] run was user-stopped — suppressing run:complete event');
      state.activeProcess    = null;
      state.pendingLaunchToken = null;
      return;
    }

    let exitText = `Process exited — ${exitLabel}`;
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

    // Re-emit identity_blocked on exit code 2 so the frontend modal renders
    // even if the initial emit raced ahead of the run:complete event.
    const identityBlock = state.lastIdentityBlock;
    state.lastIdentityBlock = null;
    if (code === 2 && identityBlock) {
      io.emit('run:identity_blocked', { ...identityBlock, message: '[re-emit on exit]' });
      setTimeout(() => {
        io.emit('run:complete', { stats: state.stats, exitCode: code, exitSignal: signal, logFile: state.lastRunLogFile });
      }, 500);
    } else {
      io.emit('run:complete', { stats: state.stats, exitCode: code, exitSignal: signal, logFile: state.lastRunLogFile });
    }
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
  io.emit('run:stopped', { logFile: state.lastRunLogFile, stats: state.stats });
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

// Identity block endpoints — allow frontend to poll for block info when socket timing is unreliable.
app.get('/api/last-identity-block', (req, res) => {
  res.json(state.lastIdentityBlock ?? null);
});
app.post('/api/last-identity-block/clear', (req, res) => {
  state.lastIdentityBlock = null;
  res.json({ ok: true });
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

// ── Support report ────────────────────────────────────────────────────────────
// Saves the support form submission and optionally emails it via Resend.
// Required body fields: email, subject, description.
// Optional: logContent, logFile, runStatus, version, platform.

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.post('/api/support/report', async (req, res) => {
  const { email, subject, description, logContent, logFile, runStatus, version, platform } = req.body || {};

  if (!email || !subject || !description) {
    return res.status(400).json({ ok: false, error: 'email, subject, and description are required' });
  }
  console.log('[SUPPORT_FORM_SCHEMA_VALID] support report received from ' + (email || 'unknown'));
  if (logContent) {
    console.log(`[SUPPORT_REPORT_LOG_ATTACHED] logFile=${logFile ?? 'none'} lines=${String(logContent).split('\n').length}`);
  }

  // ── Save to disk ──────────────────────────────────────────────────────────
  const timestamp   = new Date().toISOString().replace(/[:.]/g, '-');
  const reportsDir  = path.join(process.env.USER_DATA_DIR || os.tmpdir(), 'support-reports');
  let saved = false;
  try {
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportsDir, `support-${timestamp}.json`),
      JSON.stringify({ email, subject, description, logContent, logFile, runStatus, version, platform, createdAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
    saved = true;
    console.log(`[SUPPORT_REPORT_SAVED] dir=${reportsDir} timestamp=${timestamp}`);
  } catch (err) {
    console.warn(`[SUPPORT_REPORT_SAVED] write failed: ${err.message}`);
  }

  // ── Email delivery via Resend ─────────────────────────────────────────────
  const supportEmailTo = process.env.SUPPORT_EMAIL_TO;
  const resendApiKey   = process.env.RESEND_API_KEY;
  let emailSent  = false;
  let emailError = null;

  if (supportEmailTo && resendApiKey) {
    console.log(`[SUPPORT_EMAIL_DELIVERY_START] to=${supportEmailTo} provider=resend`);
    const logSnippet = logContent
      ? String(logContent).split('\n').slice(-100).join('\n')
      : '(no log attached)';
    const htmlBody = [
      '<h2>StatfloBot Support Report</h2>',
      `<p><strong>From:</strong> ${escapeHtml(email)}</p>`,
      `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>`,
      `<p><strong>Version:</strong> ${escapeHtml(version ?? 'unknown')}</p>`,
      `<p><strong>Platform:</strong> ${escapeHtml(platform ?? 'unknown')}</p>`,
      `<p><strong>Run status:</strong> ${escapeHtml(runStatus ?? 'none')}</p>`,
      `<p><strong>Log file:</strong> ${escapeHtml(logFile ?? 'none')}</p>`,
      '<hr/>',
      '<h3>Description</h3>',
      `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;white-space:pre-wrap">${escapeHtml(description)}</pre>`,
      '<h3>Log (last 100 lines)</h3>',
      `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:11px;white-space:pre-wrap">${escapeHtml(logSnippet)}</pre>`,
    ].join('\n');

    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
        body:    JSON.stringify({
          from:     process.env.SUPPORT_EMAIL_FROM || 'StatfloBot Support <onboarding@resend.dev>',
          to:       [supportEmailTo],
          reply_to: email,
          subject:  `[StatfloBot Support] ${subject}`,
          html:     htmlBody,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (emailRes.ok) {
        emailSent = true;
        console.log(`[SUPPORT_EMAIL_DELIVERY_SUCCESS] to=${supportEmailTo}`);
      } else {
        const errBody = await emailRes.json().catch(() => ({}));
        emailError = errBody.message ?? `HTTP ${emailRes.status}`;
        console.warn(`[SUPPORT_EMAIL_DELIVERY_FAILED] status=${emailRes.status} error=${emailError}`);
      }
    } catch (err) {
      emailError = err.message;
      console.warn(`[SUPPORT_EMAIL_DELIVERY_FAILED] ${err.message}`);
    }
  } else {
    if (!supportEmailTo) console.log('[SUPPORT_EMAIL_DELIVERY_START] skipped — SUPPORT_EMAIL_TO not configured');
    if (!resendApiKey)   console.log('[SUPPORT_EMAIL_DELIVERY_START] skipped — RESEND_API_KEY not configured');
  }

  res.json({ ok: true, saved, emailSent, emailError });
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

// ── Statflo identity lock helpers ────────────────────────────────────────────

// Mirrors the normalization in src/identity.js — must stay in sync.
function normalizeStatfloKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const val = raw.trim().toLowerCase().replace(/@cellularsales\.com$/, '');
  return val.length > 0 ? val : null;
}

function getIdentityFile(botDataDir) {
  if (botDataDir) return path.join(botDataDir, 'statflo-identity.json');
  return null;
}

function readLocalStatfloIdentity(botDataDir) {
  const file = getIdentityFile(botDataDir);
  console.log(`[IDENTITY_LOCK_LOAD_START] dir=${botDataDir ?? '(none)'} file=${file ?? '(none)'}`);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Support both old schema (statfloEmail) and new schema (identityKey)
    const key = (data?.identityKey || data?.statfloEmail || '').trim().toLowerCase()
                  .replace(/@cellularsales\.com$/, '');
    if (key.length > 0) {
      console.log(`[IDENTITY_LOCK_LOAD_SUCCESS] key=${key}`);
      return key;
    }
    console.log(`[IDENTITY_LOCK_LOAD_MISSING] file exists but no valid key`);
    return null;
  } catch {
    console.log(`[IDENTITY_LOCK_LOAD_MISSING] file not found or unreadable`);
    return null;
  }
}

function writeLocalStatfloIdentity(botDataDir, raw, identityKey) {
  const file = getIdentityFile(botDataDir);
  if (!file) {
    console.warn(`[IDENTITY_LOCK_SAVE_START] no dir — write skipped`);
    return;
  }
  console.log(`[IDENTITY_LOCK_SAVE_START] dir=${botDataDir} key=${identityKey}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      raw,
      identityKey,
      lockedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    console.log(`[IDENTITY_LOCK_SAVE_SUCCESS] key=${identityKey} → ${file}`);
    // Verify persistence
    const readBack = (() => {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        return (d?.identityKey || d?.statfloEmail || '').trim().toLowerCase()
                 .replace(/@cellularsales\.com$/, '') || null;
      } catch { return null; }
    })();
    console.log(`[IDENTITY_LOCK_SAVE_VERIFY] readBack=${readBack ?? '(null)'}`);
  } catch (err) {
    console.warn(`[IDENTITY_LOCK_SAVE_FAILED] ${err.message}`);
  }
}

// ── /api/internal/check-identity ─────────────────────────────────────────────
// Called by the bot subprocess right after Statflo login is confirmed.
// Uses the JWT stored from /api/start to call the cloud identity lock endpoint.
// Falls back to local file when cloud is unavailable.
app.post('/api/internal/check-identity', async (req, res) => {
  // Accept both new format (identityKey + detectedRaw) and legacy (detectedEmail)
  const raw        = req.body.detectedRaw   ?? req.body.detectedEmail ?? '';
  const keyFromBot = req.body.identityKey   ?? null;
  const identityKey = keyFromBot ?? normalizeStatfloKey(raw);

  if (!identityKey || identityKey.length < 2) {
    console.warn('[identity-check] no valid identity key in request — blocking');
    return res.json({ allowed: false, reason: 'no-email-detected' });
  }

  const botDataDir = state.lastRunBotDataDir;
  const token      = state.lastRunToken;

  console.log(`[IDENTITY_CHECK] key=${identityKey} raw="${raw}" botDataDir=${botDataDir ?? '(none)'} hasToken=${!!token}`);

  // ── Cloud check ───────────────────────────────────────────────────────────
  if (CLOUD_API_URL && token) {
    try {
      const cloudRes = await fetch(`${CLOUD_API_URL}/api/identity/lock`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ identityKey, detectedRaw: raw }),
        signal:  AbortSignal.timeout(10000),
      });
      const data = await cloudRes.json().catch(() => ({}));

      if (cloudRes.status === 409) {
        console.log(`[IDENTITY_MISMATCH] locked=${data.lockedKey} attempted=${identityKey}`);
        return res.json({ allowed: false, reason: 'mismatch', lockedKey: data.lockedKey });
      }

      if (cloudRes.ok) {
        const action = data.action ?? 'matched';
        console.log(`[IDENTITY_CHECK] cloud result: action=${action} key=${identityKey}`);
        writeLocalStatfloIdentity(botDataDir, raw, identityKey);
        if (action === 'locked') {
          console.log(`[STATFLO_IDENTITY_LOCK_CREATED] username=${identityKey} (cloud)`);
        }
        return res.json({ allowed: true, action, lockedKey: identityKey });
      }

      console.warn(`[IDENTITY_CHECK] cloud returned ${cloudRes.status} — falling back to local`);
    } catch (err) {
      console.warn(`[IDENTITY_CHECK] cloud check failed: ${err.message} — falling back to local`);
    }
  }

  // ── Local fallback ────────────────────────────────────────────────────────
  const localKey = readLocalStatfloIdentity(botDataDir);

  if (!localKey) {
    writeLocalStatfloIdentity(botDataDir, raw, identityKey);
    console.log(`[STATFLO_IDENTITY_LOCK_CREATED] username=${identityKey} (local fallback)`);
    return res.json({ allowed: true, action: 'local-lock', lockedKey: identityKey });
  }

  if (localKey === identityKey) {
    console.log(`[IDENTITY_CHECK] local match key=${identityKey}`);
    return res.json({ allowed: true, action: 'local-match', lockedKey: identityKey });
  }

  console.log(`[IDENTITY_MISMATCH] locked=${localKey} attempted=${identityKey}`);
  return res.json({ allowed: false, reason: 'local-mismatch', lockedKey: localKey });
});

// ── GET /api/identity ─────────────────────────────────────────────────────────
// Returns the locked Statflo identity for the authenticated user.
// Checks local file first, falls back to cloud.
app.get('/api/identity', async (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);
  if (IS_PRODUCTION && !userId) return res.status(401).json({ error: 'Authentication required' });

  const userScopedDir  = getUserScopedDir(userId);
  const checkedPath    = userScopedDir ? path.join(userScopedDir, 'statflo-identity.json') : null;
  console.log(`[IDENTITY_API_GET_START] userId=${userId ?? '(none)'} dir=${userScopedDir ?? '(none)'}`);
  console.log(`[IDENTITY_LOCAL_PATH] ${checkedPath ?? '(none)'}`);

  const localKey = readLocalStatfloIdentity(userScopedDir);
  if (localKey) {
    console.log(`[IDENTITY_API_GET_RESULT] source=local key=${localKey}`);
    return res.json({ identityKey: localKey, source: 'local', checkedPath });
  }

  if (!CLOUD_API_URL || !token) {
    console.log(`[IDENTITY_API_GET_RESULT] source=missing (no cloud or no token)`);
    return res.json({ identityKey: null, source: 'missing', checkedPath });
  }
  try {
    const r = await fetch(`${CLOUD_API_URL}/api/identity/lock`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      console.log(`[IDENTITY_API_GET_RESULT] source=missing (cloud ${r.status})`);
      return res.json({ identityKey: null, source: 'missing', checkedPath });
    }
    const data = await r.json();
    console.log(`[IDENTITY_API_GET_RESULT] source=cloud key=${data.identityKey ?? null}`);
    return res.json({ identityKey: data.identityKey ?? null, source: 'cloud', checkedPath });
  } catch {
    console.log(`[IDENTITY_API_GET_RESULT] source=missing (cloud error)`);
    return res.json({ identityKey: null, source: 'missing', checkedPath });
  }
});

// ── POST /api/identity/set ────────────────────────────────────────────────────
// One-time Statflo username entry. Normalizes, saves to cloud + local file.
// Returns 409 on mismatch with existing lock.
app.post('/api/identity/set', async (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);
  if (IS_PRODUCTION && !userId) return res.status(401).json({ error: 'Authentication required' });

  const { raw } = req.body;
  const identityKey = normalizeStatfloKey(raw);
  if (!identityKey || identityKey.length < 3 || !identityKey.includes('.')) {
    return res.status(400).json({ error: 'Invalid Statflo username — use first.last format' });
  }

  console.log(`[IDENTITY_API_SET_START] userId=${userId ?? '(none)'} raw="${raw}" key=${identityKey}`);

  if (CLOUD_API_URL && token) {
    try {
      const r = await fetch(`${CLOUD_API_URL}/api/identity/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ identityKey, detectedRaw: raw }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        return res.status(409).json({ error: 'mismatch', lockedKey: data.lockedKey ?? null });
      }
      if (!r.ok) {
        console.warn(`[IDENTITY_SET] cloud returned ${r.status} — saving locally only`);
      }
    } catch (err) {
      console.warn(`[IDENTITY_SET] cloud unreachable: ${err.message} — saving locally only`);
    }
  }

  const userScopedDir = getUserScopedDir(userId);
  const savedPath     = userScopedDir ? path.join(userScopedDir, 'statflo-identity.json') : null;
  console.log(`[IDENTITY_LOCAL_PATH] ${savedPath ?? '(none)'}`);
  console.log(`[IDENTITY_LOCK_ALLOWED_DIR] POST /api/identity/set userId=${userId ?? '(none)'} dir=${userScopedDir ?? '(none)'}`);
  writeLocalStatfloIdentity(userScopedDir, raw, identityKey);

  const persisted = !!readLocalStatfloIdentity(userScopedDir);
  console.log(`[IDENTITY_LOCAL_READ_BACK] persisted=${persisted} key=${persisted ? identityKey : '(null)'}`);
  console.log(`[IDENTITY_API_SET_RESULT] key=${identityKey} persisted=${persisted} savedPath=${savedPath ?? '(none)'}`);
  console.log(`[IDENTITY_SET] saved identity key=${identityKey} userId=${userId}`);
  return res.json({ ok: true, identityKey, persisted, savedPath });
});

// Internal one-time launch token verification — called by spawned child on startup.
// Token is valid only once; it is cleared immediately after first use.
app.post('/api/internal/verify-launch', (req, res) => {
  const { token } = req.body;
  console.log(`[VERIFY_LAUNCH] token=${token ? 'present' : 'MISSING'} pendingToken=${state.pendingLaunchToken ? 'present' : 'MISSING'}`);
  if (!token || !state.pendingLaunchToken) {
    console.warn(`[VERIFY_LAUNCH_FAIL] reason=no-token token=${!!token} pending=${!!state.pendingLaunchToken}`);
    return res.status(403).json({ ok: false, reason: 'no-token' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(state.pendingLaunchToken))) {
      console.warn('[VERIFY_LAUNCH_FAIL] reason=invalid-token (mismatch)');
      return res.status(403).json({ ok: false, reason: 'invalid-token' });
    }
  } catch (e) {
    console.error(`[VERIFY_LAUNCH_FAIL] reason=compare-error tokenLen=${token.length} pendingLen=${state.pendingLaunchToken.length} err=${e.message}`);
    return res.status(403).json({ ok: false, reason: 'token-compare-error' });
  }
  state.pendingLaunchToken = null; // burn after one use
  console.log('[VERIFY_LAUNCH_OK] token accepted and burned');
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // Send current state on connect
  socket.emit('status', { state: state.runState, stats: state.stats });

  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET_DISCONNECT_REASON] socket=${socket.id} reason=${reason}`);
  });
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
