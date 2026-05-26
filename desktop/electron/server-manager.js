'use strict';

const { utilityProcess } = require('electron');
const { execFileSync }   = require('child_process');
const path               = require('path');
const http               = require('http');
const fs                 = require('fs');
const os                 = require('os');

const SERVER_PORT    = 3001;
const READY_TIMEOUT  = 30_000;
const POLL_INTERVAL  = 300;

// Read desktop app version so we can inject it into the server and verify after startup.
let _desktopVersion = 'unknown';
try { _desktopVersion = require(path.join(__dirname, '..', 'package.json')).version; } catch {}

// ── Node binary resolution ───────────────────────────────────────────────────
// The SERVER itself runs via utilityProcess (Electron's embedded Node) so no
// system Node.js is required for startup.  This function finds system Node
// only for the BOT SUBPROCESS that the server spawns during automation runs.

function findNodeBinary() {
  if (process.platform === 'win32') {
    const pf      = process.env.PROGRAMFILES          || 'C:\\Program Files';
    const pf86    = process.env['PROGRAMFILES(X86)']  || 'C:\\Program Files (x86)';
    const local   = process.env.LOCALAPPDATA          || path.join(os.homedir(), 'AppData', 'Local');
    const roaming = process.env.APPDATA               || path.join(os.homedir(), 'AppData', 'Roaming');
    const home    = os.homedir();
    const pgData  = process.env.PROGRAMDATA           || 'C:\\ProgramData';

    const candidates = [
      // Official nodejs.org installer (most common)
      path.join(pf,     'nodejs', 'node.exe'),
      path.join(pf86,   'nodejs', 'node.exe'),
      // LOCALAPPDATA installer (per-user, no admin)
      path.join(local,  'Programs', 'nodejs', 'node.exe'),
      // nvm-windows (roaming and local variants)
      path.join(roaming, 'nvm', 'current', 'node.exe'),
      path.join(local,   'nvm', 'current', 'node.exe'),
      // Scoop package manager (~\scoop\apps\nodejs\current\)
      path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'node.exe'),
      path.join(home, 'scoop', 'apps', 'nodejs-lts', 'current', 'node.exe'),
      // Chocolatey package manager
      path.join(pgData, 'chocolatey', 'bin', 'node.exe'),
      // fnm (Fast Node Manager) — stores under AppData\Local\fnm_multishells or similar
      path.join(local, 'fnm_multishells', 'node.exe'),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }

    // Last resort: ask PowerShell where.exe — works when node is in user PATH
    // but not in any of the standard installation directories above.
    try {
      const result = execFileSync('where.exe', ['node.exe'], {
        encoding: 'utf8',
        timeout:  3000,
        stdio:    ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n')[0].trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* where.exe failed or node not in PATH */ }

    return null; // no system Node found — caller will use ELECTRON_RUN_AS_NODE fallback
  }

  // macOS / Linux — try login shell first so nvm/Homebrew paths are sourced.
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      if (!fs.existsSync(shell)) continue;
      const result = execFileSync(shell, ['-lc', 'which node'], {
        encoding: 'utf8',
        timeout:  5000,
        env: { HOME: process.env.HOME, PATH: process.env.PATH || '' },
      }).trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* try next */ }
  }

  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(p)) return p;
  }

  return 'node'; // last resort — likely to fail, but lets the error surface clearly
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function resolveServerPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ui', 'server', 'index.js')
    : path.join(__dirname, '..', '..', 'ui', 'server', 'index.js');
}

function resolveWorkingDir(app) {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..');
}

// ── Server readiness poll ────────────────────────────────────────────────────

function waitForServer(timeout, log) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let attempt    = 0;

    function poll() {
      attempt++;
      const req = http.get(`http://127.0.0.1:${SERVER_PORT}/api/status`, (res) => {
        log(`[server-manager] health check #${attempt} → HTTP ${res.statusCode}`);
        if (res.statusCode === 200) return resolve();
        if (Date.now() > deadline) return reject(new Error('Server health check returned non-200'));
        setTimeout(poll, POLL_INTERVAL);
      });
      req.on('error', (err) => {
        if (attempt % 10 === 1) { // log every 10th attempt to avoid flooding
          log(`[server-manager] health check #${attempt} → ${err.message}`);
        }
        if (Date.now() > deadline) return reject(new Error('Server did not start in time'));
        setTimeout(poll, POLL_INTERVAL);
      });
      req.setTimeout(1000, () => req.destroy());
    }

    poll();
  });
}

// ── Server identity verification ─────────────────────────────────────────────
// After waitForServer resolves, confirm the answering server was started by
// server-manager (has embedded desktop vars) — not a manual dev server.
// Manual servers lack STATFLOBOT_DESKTOP/USER_DATA_DIR and would open popup browsers.

function verifyEmbeddedServer(log) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/api/debug/server-env`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          log(`[server-manager] server-env: instanceId=${data.instanceId ?? '?'} isDesktop=${data.isDesktop} source=${data.source ?? '?'} userDataDir=${data.userDataDir ? 'present' : 'MISSING'}`);
          if (!data.isDesktop) {
            const err = new Error(
              `[PORT_CONFLICT_WRONG_SERVER] Port ${SERVER_PORT} is occupied by a non-embedded server (source=${data.source ?? 'unknown'}, pid=${data.pid ?? '?'}). ` +
              'Close that process and restart StatfloBot.'
            );
            err.code = 'PORT_CONFLICT_WRONG_SERVER';
            err.serverData = data;
            return reject(err);
          }
          resolve(data);
        } catch (parseErr) {
          log(`[server-manager] server-env parse failed: ${parseErr.message} — assuming correct server`);
          resolve(null); // endpoint may not exist on old server; allow startup
        }
      });
    });
    req.on('error', (err) => {
      log(`[server-manager] server-env check failed: ${err.message} — assuming correct server`);
      resolve(null); // network error; don't block startup
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// ── Server version verification ──────────────────────────────────────────────
// After the server answers the health check and passes identity verification,
// confirm the running server code matches the expected app version and has the
// diagnostics capture route.  A mismatch means an old server is still bound to
// port 3001 (e.g. from a previous session on macOS that was not fully quit).

function verifyServerVersion(expectedVersion, log) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/api/version`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) {
          log(`[SERVER_VERSION_MISMATCH_OR_STALE] /api/version → 404 — server code is stale (no version endpoint). expectedVersion=${expectedVersion}`);
          return resolve({ ok: false, reason: 'no-version-endpoint', stale: true });
        }
        try {
          const data = JSON.parse(body);
          const serverVer  = data.serverVersion || 'unknown';
          const hasCapture = data.routeListIncludesDiagnosticsCapture === true;
          if (serverVer !== expectedVersion) {
            log(`[SERVER_VERSION_MISMATCH_OR_STALE] serverVersion=${serverVer} expectedVersion=${expectedVersion} routeHasCapture=${hasCapture}`);
            return resolve({ ok: false, reason: 'version-mismatch', serverVersion: serverVer, expectedVersion, hasCapture });
          }
          if (!hasCapture) {
            log(`[SERVER_VERSION_MISMATCH_OR_STALE] diagnostics capture route missing serverVersion=${serverVer}`);
            return resolve({ ok: false, reason: 'missing-capture-route', serverVersion: serverVer });
          }
          log(`[SERVER_VERSION_OK] serverVersion=${serverVer} routeHasCapture=${hasCapture}`);
          return resolve({ ok: true, serverVersion: serverVer });
        } catch (e) {
          log(`[SERVER_VERSION_MISMATCH_OR_STALE] /api/version parse failed: ${e.message}`);
          return resolve({ ok: false, reason: 'parse-error' });
        }
      });
    });
    req.on('error', (err) => {
      log(`[SERVER_VERSION_MISMATCH_OR_STALE] /api/version request failed: ${err.message}`);
      resolve({ ok: false, reason: 'request-error' });
    });
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
  });
}

// ── Server env loading ────────────────────────────────────────────────────────
// Read ui/server/.env from the MAIN process (reliable __dirname, full fs access)
// and inject values as explicit env vars into the child process.
// This is more reliable than letting the child read its own .env — in packaged
// builds utilityProcess may resolve __dirname differently.

const PROD_CLOUD_API_URL = 'https://statflobot.store'; // public production URL — not a secret

function loadServerEnv(serverDir) {
  const envFile = path.join(serverDir, '.env');
  const result  = {};
  try {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) result[key] = val;
    }
  } catch { /* .env missing is acceptable — CI injects vars another way */ }
  return result;
}

let childProcess = null;

// ── Port 3001 owner detection ─────────────────────────────────────────────────
// Identifies the process listening on port 3001 so we can decide whether to kill
// a stale manual server that survived an app update.

const SAFE_TO_KILL_COMMANDS = ['node', 'electron', 'npm', 'vite', 'statflo'];

function getPort3001Owner(log = console.log) {
  try {
    let raw = '';
    if (process.platform === 'win32') {
      // netstat -ano lists all TCP sockets with PIDs; findstr filters for our port
      try {
        raw = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 4000 });
      } catch (e) { raw = (typeof e.stdout === 'string') ? e.stdout : ''; }
      for (const line of raw.split('\n')) {
        if (line.includes(':3001') && (line.includes('LISTENING') || line.includes('LISTEN'))) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) {
            let command = 'unknown';
            try {
              const w = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'Name', '/VALUE'], {
                encoding: 'utf8', timeout: 3000,
              });
              const m = w.match(/Name=(.+)/);
              if (m) command = m[1].trim();
            } catch {}
            log(`[PORT_3001_OWNER] pid=${pid} command=${command}`);
            return { pid, command };
          }
        }
      }
    } else {
      // macOS / Linux: lsof exits 1 with no output when nothing is listening
      try {
        raw = execFileSync('lsof', ['-nP', '-iTCP:3001', '-sTCP:LISTEN'], {
          encoding: 'utf8', timeout: 4000,
        });
      } catch (e) {
        raw = (typeof e.stdout === 'string') ? e.stdout : '';
      }
      const lines = raw.trim().split('\n').filter(l => l && !l.startsWith('COMMAND'));
      if (lines.length > 0) {
        const parts = lines[0].trim().split(/\s+/);
        const command = parts[0] || 'unknown';
        const pid = parseInt(parts[1], 10) || null;
        if (pid) {
          log(`[PORT_3001_OWNER] pid=${pid} command=${command}`);
          return { pid, command };
        }
      }
    }
    log('[PORT_3001_OWNER] port 3001 is not occupied');
    return null;
  } catch (e) {
    log(`[PORT_3001_OWNER] detection error: ${e.message}`);
    return null;
  }
}

function isSafeToKill(command, pid) {
  if (!command || !pid) return false;
  if (pid === process.pid) return false; // never kill the main process
  const cmd = command.toLowerCase();
  return SAFE_TO_KILL_COMMANDS.some(s => cmd.includes(s));
}

function killPid(pid, log = console.log) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 3000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    log(`[PORT_3001_KILL] sent kill to PID ${pid}`);
    return true;
  } catch (e) {
    log(`[PORT_3001_KILL_FAILED] PID ${pid}: ${e.message}`);
    return false;
  }
}

function getChildPid() {
  return childProcess?.pid ?? null;
}

// ── Start ────────────────────────────────────────────────────────────────────

async function start(app, log = console.log, embeddedReadyCallback = null, bridgeEndpoint = null) {
  const serverScript  = resolveServerPath(app);
  const cwd           = resolveWorkingDir(app);
  const userData      = app.getPath('userData');
  const resourcesPath = app.isPackaged ? process.resourcesPath : '';

  // Find system Node.js for the bot subprocess (not used by the server itself).
  // If no system Node is found in a packaged build, fall back to Electron's own
  // binary with ELECTRON_RUN_AS_NODE=1 — this makes the app fully self-contained
  // and works even when the customer has no Node.js installed.
  let nodeBinForBot = findNodeBinary();
  let useElectronAsNode = false;

  if (app.isPackaged && (!nodeBinForBot || !fs.existsSync(nodeBinForBot))) {
    nodeBinForBot    = process.execPath; // StatfloBot.exe / StatfloBot app
    useElectronAsNode = true;
  }

  // ── Read server .env in the main process ──────────────────────────────────
  const serverDir = app.isPackaged
    ? path.join(resourcesPath, 'ui', 'server')
    : path.join(__dirname, '..', '..', 'ui', 'server');
  const serverEnv    = loadServerEnv(serverDir);
  const cloudApiUrl  = serverEnv.CLOUD_API_URL
                    || process.env.CLOUD_API_URL
                    || PROD_CLOUD_API_URL;

  // Log key paths so startup failures are diagnosable from main-boot.log.
  log('[server-manager] ── startup ──────────────────────────────────────────');
  log(`[server-manager] runtime       : utilityProcess (Electron embedded Node)`);
  log(`[server-manager] server script : ${serverScript}`);
  log(`[server-manager] script exists : ${fs.existsSync(serverScript)}`);
  log(`[server-manager] working dir   : ${cwd}`);
  log(`[server-manager] resources     : ${resourcesPath || '(dev mode)'}`);
  log(`[server-manager] user data     : ${userData}`);
  log(`[server-manager] bot node bin  : ${nodeBinForBot}`);
  log(`[server-manager] bot node exists: ${nodeBinForBot ? fs.existsSync(nodeBinForBot) : 'n/a'}`);
  log(`[server-manager] ELECTRON_AS_NODE: ${useElectronAsNode} (self-contained=${useElectronAsNode})`);
  log(`[server-manager] CLOUD_API_URL : present=${!!cloudApiUrl} source=${serverEnv.CLOUD_API_URL ? '.env' : process.env.CLOUD_API_URL ? 'process.env' : 'hardcoded-default'}`);

  // Confirm critical node_modules are present so missing deps surface early.
  const serverModules = path.join(serverDir, 'node_modules');
  log(`[server-manager] server node_modules: ${serverModules}`);
  log(`[server-manager] server node_modules exists: ${fs.existsSync(serverModules)}`);

  if (!fs.existsSync(serverScript)) {
    throw new Error(`Server script not found: ${serverScript}`);
  }

  // ── Launch via utilityProcess ─────────────────────────────────────────────
  // utilityProcess.fork() runs the script inside Electron's own Node.js runtime.
  // No external system Node.js binary is required — this is the fix for the
  // blank window in packaged builds where PATH does not include nvm/Homebrew Node.
  const _injectedEndpoint = bridgeEndpoint || null;
  log(`[SERVER_MANAGER_ENV_INJECT] STATFLOBOT_DESKTOP=true USER_DATA_DIR=${userData} EMBEDDED_BROWSER_WS_ENDPOINT=${_injectedEndpoint ?? '(none — bridge not confirmed)'} STATFLOBOT_APP_VERSION=${_desktopVersion}`);

  childProcess = utilityProcess.fork(serverScript, [], {
    cwd,
    env: {
      ...process.env,
      PORT:                String(SERVER_PORT),
      HOST:                '127.0.0.1',
      NODE_BINARY:         nodeBinForBot,   // used by server to spawn the bot subprocess
      USE_ELECTRON_AS_NODE: useElectronAsNode ? '1' : '',
      RESOURCES_PATH:      resourcesPath,
      USER_DATA_DIR:       userData,
      // Inject config explicitly — do NOT rely on the child reading its own .env
      CLOUD_API_URL:       cloudApiUrl,
      // Embedded browser mode (v1.3.9): native Electron automation bridge on port 9225.
      // main.js starts the bridge via startAutomationBridge() using webContents directly.
      // Only the automation BrowserView is controlled — the main renderer is never accessible.
      EMBEDDED_BROWSER_MODE:         'true',
      // Use the confirmed bridge endpoint from main.js — injected after bridge readiness check.
      // If bridgeEndpoint is null (bridge failed to start), do not set a fallback value.
      ...(_injectedEndpoint ? { EMBEDDED_BROWSER_WS_ENDPOINT: _injectedEndpoint } : {}),
      // Explicit desktop marker (v1.5.6): lets the server self-detect desktop mode
      // independently of process.parentPort, which is not always available at /api/start time.
      STATFLOBOT_DESKTOP:            'true',
      // App version injected so the server can report it in /api/version and logs.
      STATFLOBOT_APP_VERSION:        _desktopVersion,
    },
    stdio: 'pipe',
  });

  const pid = childProcess.pid ?? '(pending)';
  log(`[server-manager] utilityProcess forked — pid=${pid}`);

  // Route ALL child output to the boot log so crashes are immediately visible.
  childProcess.stdout?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log(`[server] ${line}`);
    }
  });
  childProcess.stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log(`[server:err] ${line}`);
    }
  });

  childProcess.on('exit', (code) => {
    log(`[server-manager] server process exited — code=${code}`);
    childProcess = null;
  });

  // Handle messages from the server utilityProcess.
  // 'embedded:ensure-ready' — server needs embedded view/bridge before spawning the bot.
  if (embeddedReadyCallback) {
    childProcess.on('message', async (msg) => {
      if (msg?.type === 'embedded:ensure-ready') {
        log('[server-manager] received embedded:ensure-ready — calling main process handler');
        try {
          const result = await embeddedReadyCallback();
          childProcess?.postMessage({ type: 'embedded:ready', ...result });
        } catch (err) {
          log(`[SERVER_MANAGER_EMBEDDED_READY_CALLBACK_THROW] ${err.message}`);
          childProcess?.postMessage({ type: 'embedded:ready', ok: false, reason: 'callback-threw', detail: err.message });
        }
      }
    });
  }

  await waitForServer(READY_TIMEOUT, log);
  log('[server-manager] server answered health check ✓');

  // Verify the answering server has embedded desktop vars.
  // Throws PORT_CONFLICT_WRONG_SERVER if a manual dev server is intercepting.
  await verifyEmbeddedServer(log);
  log('[server-manager] server identity confirmed — embedded vars present ✓');

  // Verify server code version matches expected app version and has diagnostics routes.
  // Does NOT throw — a mismatch is logged and the UI will show a banner.
  const _versionCheck = await verifyServerVersion(_desktopVersion, log);
  if (!_versionCheck.ok) {
    log(`[SERVER_VERSION_MISMATCH_OR_STALE] startup version check failed reason=${_versionCheck.reason} — UI will show version mismatch banner`);
  } else {
    log(`[SERVER_VERSION_OK] startup version confirmed serverVersion=${_versionCheck.serverVersion}`);
  }
}

// ── Stop ─────────────────────────────────────────────────────────────────────

function _killProc(proc, log = console.log) {
  if (process.platform === 'win32') {
    const pid = proc.pid;
    if (pid) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
      catch { /* already gone */ }
    }
  } else {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
}

function stop() {
  if (!childProcess) return;
  const proc = childProcess;
  childProcess = null;
  _killProc(proc);
}

// Async stop that waits for the child to exit, force-kills on timeout.
// Use this for intentional restarts so the port is free before re-binding.
function stopAndWait(log = console.log, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!childProcess) {
      log('[BACKEND_STOP_SUCCESS] no child process running');
      return resolve();
    }
    const proc = childProcess;
    childProcess = null;

    let _done = false;
    const done = () => { if (!_done) { _done = true; resolve(); } };

    proc.once('exit', () => {
      log('[BACKEND_STOP_SUCCESS] child process exited');
      done();
    });

    const forceTimer = setTimeout(() => {
      log('[BACKEND_STOP_TIMEOUT_FORCE_KILL] child did not exit in time — force killing');
      try {
        if (process.platform === 'win32') {
          const pid = proc.pid;
          if (pid) execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* already gone */ }
      done();
    }, timeoutMs);
    forceTimer.unref();

    _killProc(proc, log);
    // Windows taskkill is synchronous force-kill — resolve immediately
    if (process.platform === 'win32') done();
  });
}

module.exports = { start, stop, stopAndWait, getPort3001Owner, isSafeToKill, killPid, getChildPid };
