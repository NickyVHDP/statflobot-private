'use strict';

const {
  app, BrowserWindow, ipcMain, Menu, shell, nativeTheme,
} = require('electron');
const path          = require('path');
const serverManager = require('./server-manager');

// ── Constants ─────────────────────────────────────────────────────────────────

const APP_NAME   = 'StatfloBot';
const WIN_WIDTH  = 1280;
const WIN_HEIGHT = 860;
const DEV_URL    = 'http://localhost:5173';   // Vite dev server (ui/client)
const SERVER_URL = 'http://localhost:3001';   // Express server (ui/server serving static build)

// isDev = true only when explicitly launched with ELECTRON_DEV=true (desktop:dev script).
// Unpackaged desktop:start and packaged builds both use server-manager + port 3001.
const isDev = process.env.ELECTRON_DEV === 'true';

app.setName(APP_NAME);
nativeTheme.themeSource = 'dark';

// ── Single-instance lock ───────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWindow = null;

function resolveRendererPath() {
  // Both dev and production serve from localhost — Next.js is always the HTTP server.
  return isDev ? DEV_URL : SERVER_URL;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width:          WIN_WIDTH,
    height:         WIN_HEIGHT,
    minWidth:       900,
    minHeight:      640,
    title:          APP_NAME,
    backgroundColor: '#0a0a0f',
    titleBarStyle:  'hiddenInset',   // macOS traffic lights inset
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      webSecurity:          true,
      allowRunningInsecureContent: false,
    },
    show: false,   // shown after ready-to-show
  });

  // Gracefully reveal once painted
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Open links that target _blank in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Load the renderer
  const rendererUrl = resolveRendererPath();
  console.log(`[main] Loading renderer: ${rendererUrl}`);

  await mainWindow.loadURL(rendererUrl);
}

// ── Build native menu ─────────────────────────────────────────────────────────

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

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.on('auth:changed', (_e, isSignedIn) => {
  console.log(`[main] Auth state changed — signed in: ${isSignedIn}`);
  // Future: update dock badge, menu state, etc.
});

// ── Readiness poll ────────────────────────────────────────────────────────────

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

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();

  if (isDev) {
    // Vite + ui/server are started externally by the desktop:dev script.
    // Poll until Vite responds before opening the window.
    console.log('[main] Waiting for Vite dev server at', DEV_URL);
    try {
      await waitForUrl(DEV_URL);
      console.log('[main] Vite ready — opening window');
    } catch (err) {
      console.error('[main] Vite did not start in time:', err.message);
    }
  } else {
    // desktop:start or packaged build: launch ui/server (which serves the static
    // React build + Socket.io + bot API) and wait for it on port 3001.
    try {
      console.log('[main] Starting bot server…');
      await serverManager.start(app);
      console.log('[main] Server ready — opening window');
    } catch (err) {
      console.error('[main] Failed to start server:', err.message);
    }
  }

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  serverManager.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  serverManager.stop();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
