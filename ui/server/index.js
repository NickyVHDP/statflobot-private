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
    const status = data?.subscription?.status ?? 'none';
    if (ACTIVE_STATUSES.has(status)) {
      return { allowed: true, reason: 'ok', status };
    }
    return { allowed: false, reason: 'inactive', status, sub: data?.subscription ?? null };
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

console.log('[server] ── startup ─────────────────────────────────────────');
console.log(`[server] BOT_WORKING_DIR : ${BOT_WORKING_DIR}`);
console.log(`[server] NODE_BIN        : ${NODE_BIN}`);
console.log(`[server] USER_DATA_DIR   : ${process.env.USER_DATA_DIR || '(not set — dev mode)'}`);
console.log('[server] ────────────────────────────────────────────────────');

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
  try {
    const raw = fs.readFileSync(getMessagesFile(userId), 'utf8');
    return { ...DEFAULT_MESSAGES, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_MESSAGES };
  }
}

function writeMessages(userId, data) {
  const file = getMessagesFile(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
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
};

function parseLogLevel(line) {
  const upper = line.toUpperCase();
  if (upper.includes('SUCCESS')) return 'success';
  if (upper.includes('ERROR')) return 'error';
  if (upper.includes('WARN')) return 'warn';
  if (upper.includes('DRY RUN') || upper.includes('DRY-RUN')) return 'dryrun';
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
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);
  const access = await verifyAccess(token);

  if (access.allowed === false) {
    console.warn('[start] access denied —', access.reason, access.status);
    return res.status(403).json({
      error:   'Access denied — active subscription required to run the bot.',
      reason:  access.reason,
      status:  access.status,
      sub:     access.sub ?? null,
    });
  }

  // Backend unreachable: allow dry runs, block live runs.
  const { mode: reqMode } = req.body;
  if (access.allowed === null && reqMode === 'live') {
    console.warn('[start] backend unreachable — blocking live run');
    return res.status(403).json({
      error:  'Cannot verify subscription — live mode is disabled while the backend is unreachable.',
      reason: access.reason,
      status: 'unknown',
    });
  }
  // ── End verification ─────────────────────────────────────────────────────

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
  if (!['dry', 'live'].includes(mode)) {
    return res.status(400).json({ error: `Unknown mode: "${mode}". Expected: dry, live` });
  }

  // ── Build args explicitly ────────────────────────────────────────────────
  const args = [
    'src/main.js',
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

  // ── Log the exact launch command ─────────────────────────────────────────
  const launchLine = `${NODE_BIN} ${args.join(' ')}`;
  console.log(`[spawn] ── bot launch ────────────────────────────────────`);
  console.log(`[spawn] cwd : ${BOT_WORKING_DIR}`);
  console.log(`[spawn] bin : ${NODE_BIN}`);
  console.log(`[spawn] args: ${JSON.stringify(args)}`);
  console.log(`[spawn] full: ${launchLine}`);

  // ── Reset state ──────────────────────────────────────────────────────────
  state.stats = { processed: 0, messaged: 0, dnc: 0, skipped: 0, failed: 0 };
  state.loginState = null;
  state.runState = 'running';

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

  const botEnv = {
    ...process.env,
    RUFLO_LAUNCH_TOKEN:   launchToken,
    RUFLO_DASHBOARD_PORT: String(PORT),
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
    io.emit('run:complete', { stats: state.stats, exitCode: code, exitSignal: signal });
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
    io.emit('run:complete', { stats: state.stats, exitCode: -1, error: userMessage });
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
  io.emit('log', { timestamp: new Date().toISOString(), level: 'warn', text: 'Run stopped by user.' });
  io.emit('run:stopped');
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

// GET /api/messages — cloud-primary; per-user local file is a sync cache only.
// The bot subprocess reads from the local file at run time (src/config.js).
app.get('/api/messages', async (req, res) => {
  const token  = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const userId = decodeJwtSub(token);

  // Production: require a valid authenticated user — never serve shared/fallback data
  if (IS_PRODUCTION && !userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (CLOUD_API_URL && token) {
    try {
      const cloudRes = await fetch(`${CLOUD_API_URL}/api/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (cloudRes.ok) {
        const data = await cloudRes.json();

        // Only overwrite the local cache when cloud actually has content.
        // If cloud returns empty strings (user is new there, or the async cloud
        // sync from a previous POST hadn't propagated yet), we must NOT clobber
        // locally-saved messages.  This was causing messages to appear empty
        // on Windows after a fresh install where the fire-and-forget cloud sync
        // hadn't completed before the next GET fired.
        const cloudHasContent =
          (data.secondAttemptMessage || '').trim() ||
          (data.thirdAttemptMessage  || '').trim();

        if (userId && cloudHasContent) {
          writeMessages(userId, {
            secondAttemptMessage: data.secondAttemptMessage,
            thirdAttemptMessage:  data.thirdAttemptMessage,
          });
          return res.json(data);
        }

        // Cloud is empty — check local cache first before returning empty to client.
        if (userId) {
          const local = readMessages(userId);
          const localHasContent =
            (local.secondAttemptMessage || '').trim() ||
            (local.thirdAttemptMessage  || '').trim();

          if (localHasContent) {
            console.log('[messages] cloud returned empty — serving local cache (cloud sync may be pending)');
            return res.json(local);
          }
        }

        // Both cloud and local are empty — return cloud response (empty defaults).
        return res.json(data);
      }
    } catch (err) {
      console.warn('[messages] cloud fetch failed — falling back to local cache:', err.message);
    }
  }

  // Cloud unavailable — serve per-user local cache (empty for new users; never a shared file)
  // userId is guaranteed non-null in production by the guard above.
  res.json(readMessages(userId));
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

app.get ('/api/proxy/account',                    (req, res) => proxyCloud('GET',  '/api/account',                    req, res));
app.post('/api/proxy/checkout/lifetime',          (req, res) => proxyCloud('POST', '/api/checkout/lifetime',          req, res));
app.post('/api/proxy/checkout/monthly',           (req, res) => proxyCloud('POST', '/api/checkout/monthly',           req, res));
app.post('/api/proxy/billing/portal',             (req, res) => proxyCloud('POST', '/api/billing/portal',             req, res));
app.post('/api/proxy/licenses/register-device',   (req, res) => proxyCloud('POST', '/api/licenses/register-device',   req, res));
app.get ('/api/proxy/download',                   (req, res) => proxyCloud('GET',  `/api/download?platform=${encodeURIComponent(req.query.platform ?? '')}`, req, res));

// ── Static file serving for built React app (production / desktop:start) ─────
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback: serve index.html for any non-API, non-socket path
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
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
