'use strict';

// ── Boot logging ───────────────────────────────────────────────────────────────
// Runs before ANY Electron lifecycle code so we capture crashes that happen
// before app.whenReady() — including the silent single-instance exit path.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function resolveLogDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'StatfloBot');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'StatfloBot', 'Logs');
  }
  return path.join(os.homedir(), '.local', 'share', 'StatfloBot', 'logs');
}

const LOG_DIR  = resolveLogDir();
const LOG_FILE = path.join(LOG_DIR, 'main-boot.log');

function bootLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* never throw from logging */ }
}

bootLog('=== main process boot ===');
bootLog(`__dirname         : ${__dirname}`);
bootLog(`process.pid       : ${process.pid}`);
bootLog(`process.execPath  : ${process.execPath}`);
bootLog(`resourcesPath     : ${process.resourcesPath || '(not set)'}`);
bootLog(`platform          : ${process.platform}`);
bootLog(`node version      : ${process.version}`);
bootLog(`log file          : ${LOG_FILE}`);

// ── Global error traps ─────────────────────────────────────────────────────────
// Catch anything that escapes normal try/catch — including errors in
// app.whenReady callbacks and async chains.

process.on('uncaughtException', (err) => {
  bootLog(`UNCAUGHT EXCEPTION: ${err.message}`);
  bootLog(err.stack || '(no stack)');
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  bootLog(`UNHANDLED REJECTION: ${msg}`);
});

// ── Electron imports ───────────────────────────────────────────────────────────

const {
  app, BrowserWindow, ipcMain, Menu, shell, nativeTheme, dialog,
} = require('electron');
const serverManager = require('./server-manager');

// electron-updater — only loaded in production (not during dev).
// Wrapped in try/catch so a missing package never crashes the app.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = { info: bootLog, warn: bootLog, error: bootLog, debug: () => {} };
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Explicitly set the GitHub provider so the updater does not rely solely on
  // the app-update.yml baked at build time.  This also makes the feed source
  // visible in boot logs for easier diagnosis.
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner:    'NickyVHDP',
      repo:     'statflobot-private',
      private:  false,
    });
    bootLog('[UPDATER_INIT] setFeedURL → github NickyVHDP/statflobot-private (public)');
  } catch (feedErr) {
    bootLog(`[UPDATER_INIT] setFeedURL failed (will use app-update.yml): ${feedErr.message}`);
  }
} catch (e) {
  bootLog(`electron-updater not available: ${e.message}`);
}

bootLog(`app.isPackaged    : ${app?.isPackaged ?? '(pending)'}`);

// ── Constants ──────────────────────────────────────────────────────────────────

const APP_NAME   = 'StatfloBot';
const WIN_WIDTH  = 1280;
const WIN_HEIGHT = 860;
const DEV_URL    = 'http://localhost:5173';
const SERVER_URL = 'http://localhost:3001';

const isDev = process.env.ELECTRON_DEV === 'true';

app.setName(APP_NAME);
nativeTheme.themeSource = 'dark';

// ── App-level error handlers ───────────────────────────────────────────────────

app.on('render-process-gone', (_e, webContents, details) => {
  bootLog(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
});

app.on('child-process-gone', (_e, details) => {
  bootLog(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

app.on('window-all-closed', () => {
  bootLog('window-all-closed');
  serverManager.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  bootLog('before-quit');
  serverManager.stop();

  if (process.platform === 'win32') {
    // Safety net: if the process hasn't exited on its own within 3 seconds,
    // force it out.  This prevents residual node.exe children (the server
    // subprocess or any bot it spawned) from lingering and holding file locks
    // that block NSIS from replacing the executable during reinstall/update.
    // timer.unref() ensures the timer does NOT keep Node alive — it only fires
    // if we're still running 3 seconds from now.
    const timer = setTimeout(() => {
      bootLog('Windows: process still alive after cleanup window — forcing exit(0)');
      process.exit(0);
    }, 3000);
    timer.unref();
  }
});

app.on('will-quit', () => {
  bootLog('will-quit');
});

app.on('quit', (_e, exitCode) => {
  bootLog(`quit (exitCode=${exitCode})`);
});

// ── Single-instance lock ───────────────────────────────────────────────────────

bootLog('requesting single-instance lock…');
const gotLock = app.requestSingleInstanceLock();
bootLog(`single-instance lock acquired: ${gotLock}`);

if (!gotLock) {
  // Another instance is already running. Focus it and exit cleanly.
  bootLog('another instance is running — sending focus signal and exiting');
  app.quit();
  // Do NOT process.exit() here — let Electron drain normally so the
  // second-instance event fires on the first instance.
  return; // stop executing the rest of this file
}

// ── Window ─────────────────────────────────────────────────────────────────────

let mainWindow = null;

function resolveRendererUrl() {
  const url = isDev ? DEV_URL : SERVER_URL;
  bootLog(`renderer url: ${url} (isDev=${isDev})`);
  return url;
}

async function createWindow() {
  bootLog('createWindow() called');

  mainWindow = new BrowserWindow({
    width:          WIN_WIDTH,
    height:         WIN_HEIGHT,
    minWidth:       900,
    minHeight:      640,
    title:          APP_NAME,
    backgroundColor: '#0a0a0f',
    titleBarStyle:  'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      webSecurity:          true,
      allowRunningInsecureContent: false,
    },
    show: false,
  });

  bootLog('BrowserWindow created');

  mainWindow.once('ready-to-show', () => {
    bootLog('ready-to-show — calling mainWindow.show()');
    mainWindow.show();
    mainWindow.focus();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Failsafe: if ready-to-show never fires within 15 s, show anyway.
  // This can happen if the renderer hangs or the server takes too long.
  const showTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      bootLog('WARN: ready-to-show did not fire in 15 s — forcing show()');
      mainWindow.show();
      mainWindow.focus();
    }
  }, 15_000);
  mainWindow.once('show', () => clearTimeout(showTimer));

  mainWindow.webContents.on('did-finish-load', () => {
    bootLog('renderer did-finish-load');
  });

  mainWindow.webContents.on('dom-ready', () => {
    bootLog('renderer dom-ready');
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog(`RENDERER_FAIL_LOAD: code=${code} desc="${desc}" url="${url}"`);
    // If the local server isn't serving, show a diagnostic page so the window
    // is never blank — the user sees the error rather than a black void.
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bg = '#0a0a0f'; const fg = '#f87171'; const dim = '#475569';
      mainWindow.webContents.loadURL(
        `data:text/html,<html style="background:${bg};font-family:monospace;padding:40px"><body>` +
        `<p style="color:${fg};font-size:14px">StatfloBot failed to load (${code}: ${desc})</p>` +
        `<p style="color:${dim};font-size:12px">URL: ${url}</p>` +
        `<p style="color:${dim};font-size:12px">isPackaged: ${app.isPackaged} | resourcesPath: ${process.resourcesPath || 'n/a'}</p>` +
        `<p style="color:${dim};font-size:12px">Check ~/Library/Logs/StatfloBot/main-boot.log for details.</p>` +
        `</body></html>`
      ).catch(() => {});
    }
  });

  mainWindow.webContents.on('crashed', (_e, killed) => {
    bootLog(`renderer crashed (killed=${killed})`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    bootLog('mainWindow closed');
    mainWindow = null;
  });

  const rendererUrl = resolveRendererUrl();
  bootLog(`loadURL: ${rendererUrl}`);
  try {
    await mainWindow.loadURL(rendererUrl);
    bootLog('loadURL resolved');
  } catch (err) {
    bootLog(`loadURL failed: ${err.message}`);
    // Show the window anyway so the user sees an error state instead of nothing
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }
}

// ── Native menu ────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        { label: 'Hide', accelerator: 'Cmd+H', role: 'hide' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Updater status broadcast ───────────────────────────────────────────────────
function sendUpdaterStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', payload);
    }
  } catch { /* window may be closing */ }
}

// ── IPC handlers ───────────────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('updater:check', async () => {
  bootLog(`[UPDATER_CHECK_IPC] isPackaged=${app.isPackaged} updater=${autoUpdater ? 'loaded' : 'null'}`);
  bootLog(`[UPDATER_CHECK_IPC] appVersion=${app.getVersion()}`);
  if (!app.isPackaged || !autoUpdater) {
    return { ok: false, reason: 'not-packaged' };
  }
  try {
    sendUpdaterStatus({ state: 'checking' });
    const result = await autoUpdater.checkForUpdates();
    bootLog(`[UPDATER_CHECK_IPC] resolved — updateInfo.version=${result?.updateInfo?.version ?? '(none)'}`);
    return { ok: true };
  } catch (err) {
    bootLog(`[UPDATER_CHECK_IPC_ERROR] ${err.message}`);
    bootLog(`[UPDATER_CHECK_IPC_ERROR_STACK] ${err.stack ?? '(no stack)'}`);
    // The autoUpdater.on('error') event handler is responsible for sending the
    // status update to the UI — do NOT call sendUpdaterStatus() here, or we'll
    // overwrite the 'no-channel' classification from the event handler.
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('updater:install', () => {
  if (autoUpdater) {
    bootLog('[AUTO_UPDATE] user triggered quitAndInstall');
    autoUpdater.quitAndInstall();
  }
});
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('auth:changed', (_e, isSignedIn) => {
  bootLog(`auth state changed — signedIn: ${isSignedIn}`);
});
// shell.openExternal must be called from the main process in Electron 29+
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    return shell.openExternal(url);
  }
});

// ── Readiness poll ─────────────────────────────────────────────────────────────

const http = require('http');

function waitForUrl(url, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode < 500) return resolve();
        if (Date.now() > deadline) return reject(new Error(`${url} not ready`));
        setTimeout(poll, 500);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`${url} not ready`));
        setTimeout(poll, 500);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    poll();
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  bootLog('app.whenReady() fired');
  bootLog(`app.isPackaged    : ${app.isPackaged}`);
  bootLog(`resourcesPath     : ${process.resourcesPath || '(not set)'}`);
  bootLog(`userData dir      : ${app.getPath('userData')}`);

  // ── Resource existence checks ──────────────────────────────────────────────
  const preloadPath     = path.join(__dirname, 'preload.js');
  const clientDistPath  = app.isPackaged
    ? path.join(process.resourcesPath, 'ui', 'client', 'dist')
    : path.join(__dirname, '..', '..', 'ui', 'client', 'dist');
  const clientIndexPath = path.join(clientDistPath, 'index.html');
  const serverScriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ui', 'server', 'index.js')
    : path.join(__dirname, '..', '..', 'ui', 'server', 'index.js');

  bootLog(`preload path      : ${preloadPath}`);
  bootLog(`preload exists    : ${fs.existsSync(preloadPath)}`);
  bootLog(`server script     : ${serverScriptPath}`);
  bootLog(`server exists     : ${fs.existsSync(serverScriptPath)}`);
  bootLog(`client dist       : ${clientDistPath}`);
  bootLog(`index.html exists : ${fs.existsSync(clientIndexPath)}`);
  bootLog(`renderer url      : ${isDev ? DEV_URL : SERVER_URL} (isDev=${isDev})`);
  // ────────────────────────────────────────────────────────────────────────────

  buildMenu();

  if (isDev) {
    bootLog(`waiting for Vite dev server at ${DEV_URL}`);
    try {
      await waitForUrl(DEV_URL);
      bootLog('Vite ready');
    } catch (err) {
      bootLog(`Vite did not start in time: ${err.message}`);
    }
  } else {
    bootLog('starting bot server via server-manager…');
    try {
      await serverManager.start(app, bootLog);
      bootLog('server-manager: server ready');
    } catch (err) {
      bootLog(`server-manager ERROR: ${err.message}`);
      bootLog(err.stack ?? '(no stack)');
      // Don't abort — show the window anyway so the user sees something
    }
  }

  bootLog('calling createWindow()…');
  await createWindow();

  // ── Auto-update check (production only, non-blocking) ─────────────────────
  if (app.isPackaged && autoUpdater) {
    bootLog(`[UPDATER_READY] appVersion=${app.getVersion()}`);
    bootLog(`[UPDATER_READY] currentVersion=${autoUpdater.currentVersion?.version ?? 'unknown'}`);
    try {
      const feedUrl = autoUpdater.getFeedURL ? String(autoUpdater.getFeedURL()) : 'n/a';
      bootLog(`[UPDATER_READY] feedURL=${feedUrl}`);
    } catch { bootLog('[UPDATER_READY] getFeedURL not available'); }

    autoUpdater.on('checking-for-update', () => {
      bootLog('[AUTO_UPDATE] checking-for-update');
      sendUpdaterStatus({ state: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      bootLog(`[AUTO_UPDATE] update-available version=${info.version}`);
      sendUpdaterStatus({ state: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', (info) => {
      bootLog(`[AUTO_UPDATE] update-not-available version=${info.version}`);
      sendUpdaterStatus({ state: 'uptodate', version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      bootLog(`[AUTO_UPDATE] download-progress ${Math.floor(p.percent)}%`);
      sendUpdaterStatus({ state: 'downloading', percent: Math.floor(p.percent) });
    });
    autoUpdater.on('error', (err) => {
      const msg = err?.message ?? String(err);
      bootLog(`[AUTO_UPDATE_ERROR] ${msg}`);
      bootLog(`[AUTO_UPDATE_ERROR_STACK] ${err?.stack ?? '(no stack)'}`);
      // Only treat as "no channel" for genuine 404 / "no published versions".
      // Do NOT include HttpError here — it matches 401/403/500 which are real errors.
      const isNoChannel = /404|not found|no published versions/i.test(msg);
      if (isNoChannel) {
        bootLog('[AUTO_UPDATE] classified as no-channel (404 / no published versions)');
        sendUpdaterStatus({ state: 'no-channel' });
      } else {
        bootLog(`[AUTO_UPDATE_REAL_ERROR] sending error state: ${msg}`);
        sendUpdaterStatus({ state: 'error', message: msg });
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      bootLog(`[AUTO_UPDATE] update-downloaded version=${info.version} — will install on quit`);
      sendUpdaterStatus({ state: 'ready', version: info.version });
    });

    // Delay check by 5 s so the window finishes loading first
    setTimeout(() => {
      bootLog('[AUTO_UPDATE] scheduling background update check (5 s delay)…');
      autoUpdater.checkForUpdates().catch(err => {
        bootLog(`[AUTO_UPDATE_ERROR] background checkForUpdates: ${err.message}`);
        bootLog(`[AUTO_UPDATE_ERROR_STACK] ${err.stack ?? '(no stack)'}`);
      });
    }, 5_000);
  } else {
    bootLog(`[AUTO_UPDATE] skipped — isPackaged=${app.isPackaged} updater=${autoUpdater ? 'loaded' : 'missing'}`);
  }

  app.on('activate', async () => {
    bootLog('app activate event');
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('second-instance', () => {
  bootLog('second-instance event — focusing existing window');
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
