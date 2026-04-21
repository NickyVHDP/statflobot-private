'use strict';

// ── Boot logging ───────────────────────────────────────────────────────────────
// Runs before ANY Electron lifecycle code so we capture crashes that happen
// before app.whenReady() — including the silent single-instance exit path.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const LOG_DIR  = path.join(os.homedir(), 'Library', 'Logs', 'StatfloBot');
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

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog(`renderer did-fail-load: code=${code} desc=${desc} url=${url}`);
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

// ── IPC handlers ───────────────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion());
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
      await serverManager.start(app);
      bootLog('server-manager: server ready');
    } catch (err) {
      bootLog(`server-manager ERROR: ${err.message}`);
      // Don't abort — show the window anyway so the user sees something
    }
  }

  bootLog('calling createWindow()…');
  await createWindow();

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
