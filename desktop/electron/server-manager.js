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

// ── Start ────────────────────────────────────────────────────────────────────

async function start(app, log = console.log) {
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
      // Embedded browser mode (v1.3.0): Playwright connects to Electron's Chromium via CDP
      EMBEDDED_BROWSER_MODE: 'true',
      EMBEDDED_BROWSER_PORT: '9223',
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

  await waitForServer(READY_TIMEOUT, log);
  log('[server-manager] server ready ✓');
}

// ── Stop ─────────────────────────────────────────────────────────────────────

function stop() {
  if (!childProcess) return;
  const proc = childProcess;
  childProcess = null;

  if (process.platform === 'win32') {
    // taskkill /F /T kills the whole process tree, freeing file locks that
    // would otherwise block NSIS from replacing files during reinstall.
    const pid = proc.pid;
    if (pid) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
      catch { /* already gone */ }
    }
  } else {
    try { proc.kill(); } catch { /* already dead */ }
  }
}

module.exports = { start, stop };
