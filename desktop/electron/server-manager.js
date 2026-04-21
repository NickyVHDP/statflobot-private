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
// Packaged GUI apps launch with a minimal PATH — nvm, Homebrew, and other
// user-installed Node versions are NOT present. We must locate node explicitly
// so the server can spawn the bot child process.

function findNodeBinary() {
  if (process.platform === 'win32') {
    // Windows: check well-known install directories for node.exe.
    const pf   = process.env.PROGRAMFILES          || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)']  || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA         || '';
    const roaming = process.env.APPDATA            || '';

    const candidates = [
      path.join(pf,    'nodejs', 'node.exe'),
      path.join(pf86,  'nodejs', 'node.exe'),
      path.join(local, 'Programs', 'nodejs', 'node.exe'),
      // nvm for Windows default paths
      path.join(roaming, 'nvm', 'current', 'node.exe'),
      path.join(local,   'nvm', 'current', 'node.exe'),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        console.log(`[server-manager] node found at: ${p}`);
        return p;
      }
    }
    console.warn('[server-manager] node not found in well-known Windows paths — falling back to "node" in PATH');
    return 'node';
  }

  // macOS / Linux ──────────────────────────────────────────────────────────────
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
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[server-manager] node found at: ${p}`);
      return p;
    }
  }

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
  const pid = childProcess.pid;
  childProcess = null;
  if (!pid) return;

  if (process.platform === 'win32') {
    // On Windows SIGTERM is not forwarded to child processes the same way as
    // Unix signals.  Use taskkill /F /T to force-kill the entire process tree
    // (the forked server AND any bot subprocesses it spawned).  Without this
    // the node.exe children keep file handles open inside the resources/
    // directory, which blocks NSIS from replacing them during reinstall and
    // triggers the "StatfloBot cannot be closed" installer dialog.
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch { /* process already gone — ignore */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }
}

module.exports = { start, stop };
