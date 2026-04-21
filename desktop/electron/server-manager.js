'use strict';

const { fork }       = require('child_process');
const { execFileSync } = require('child_process');
const path           = require('path');
const http           = require('http');
const fs             = require('fs');

const SERVER_PORT    = 3001;
const READY_TIMEOUT  = 30_000;
const POLL_INTERVAL  = 300;

// ── Node binary resolution ───────────────────────────────────────────────────
// Packaged GUI apps on macOS launch with a minimal PATH — nvm, Homebrew, and
// other user-installed Node versions are NOT present. We must locate node
// explicitly so the server can spawn the bot child process.

function findNodeBinary() {
  // 1. Ask a login shell — this sources ~/.zprofile, ~/.bashrc, nvm init, etc.
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      if (!fs.existsSync(shell)) continue;
      const result = execFileSync(shell, ['-lc', 'which node'], {
        encoding: 'utf8',
        timeout: 5000,
        env: { HOME: process.env.HOME, PATH: process.env.PATH || '' },
      }).trim();
      if (result && fs.existsSync(result)) {
        console.log(`[server-manager] node found via ${shell}: ${result}`);
        return result;
      }
    } catch { /* try next */ }
  }

  // 2. Well-known install locations (official installer, Homebrew Intel/ARM)
  const candidates = [
    '/opt/homebrew/bin/node',   // Homebrew Apple Silicon
    '/usr/local/bin/node',       // Homebrew Intel / official .pkg installer
    '/usr/bin/node',             // system (rare)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[server-manager] node found at: ${p}`);
      return p;
    }
  }

  // 3. Last resort — may work if PATH is set at OS level
  console.warn('[server-manager] node not found in well-known paths — falling back to "node" in PATH');
  return 'node';
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function resolveServerPath(app) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ui', 'server', 'index.js');
  }
  return path.join(__dirname, '..', '..', 'ui', 'server', 'index.js');
}

function resolveWorkingDir(app) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath);
  }
  return path.join(__dirname, '..', '..');
}

// ── Server readiness poll ────────────────────────────────────────────────────

function waitForServer(timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;

    function poll() {
      const req = http.get(`http://localhost:${SERVER_PORT}/api/status`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() > deadline) return reject(new Error('Server health check failed'));
        setTimeout(poll, POLL_INTERVAL);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server did not start in time'));
        setTimeout(poll, POLL_INTERVAL);
      });
      req.setTimeout(1000, () => req.destroy());
    }

    poll();
  });
}

let childProcess = null;

// ── Start ────────────────────────────────────────────────────────────────────

async function start(app) {
  const serverScript  = resolveServerPath(app);
  const cwd           = resolveWorkingDir(app);
  const nodeBin       = findNodeBinary();
  const userData      = app.getPath('userData');
  const resourcesPath = app.isPackaged ? process.resourcesPath : '';

  console.log('[server-manager] ── startup ──────────────────────────────────');
  console.log(`[server-manager] server script : ${serverScript}`);
  console.log(`[server-manager] working dir   : ${cwd}`);
  console.log(`[server-manager] node binary   : ${nodeBin}`);
  console.log(`[server-manager] user data     : ${userData}`);
  console.log(`[server-manager] resources path: ${resourcesPath || '(dev mode)'}`);

  childProcess = fork(serverScript, [], {
    cwd,
    env: {
      ...process.env,
      PORT:           String(SERVER_PORT),
      NODE_BINARY:    nodeBin,
      RESOURCES_PATH: resourcesPath,
      USER_DATA_DIR:  userData,
    },
    stdio:    'pipe',
    detached: false,
  });

  childProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  childProcess.stderr?.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

  childProcess.on('exit', (code, signal) => {
    console.log(`[server-manager] server process exited — code ${code} signal ${signal}`);
    childProcess = null;
  });

  await waitForServer(READY_TIMEOUT);
  console.log('[server-manager] server ready');
}

function stop() {
  if (!childProcess) return;
  try { childProcess.kill('SIGTERM'); } catch { /* already dead */ }
  childProcess = null;
}

module.exports = { start, stop };
