'use strict';

// ── Boot logging ───────────────────────────────────────────────────────────────
// Runs before ANY Electron lifecycle code so we capture crashes that happen
// before app.whenReady() — including the silent single-instance exit path.

const fs                      = require('fs');
const os                      = require('os');
const path                    = require('path');
const { spawn }               = require('child_process');

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
// Log the .app bundle path so we can confirm it matches /Applications on every launch
if (process.platform === 'darwin' && process.execPath) {
  bootLog(`app bundle (derived): ${require('path').resolve(process.execPath, '..', '..', '..')}`);
}

// ── Global error traps ─────────────────────────────────────────────────────────
// Catch anything that escapes normal try/catch — including errors in
// app.whenReady callbacks and async chains.

let _lastCrashDialogTime = 0;

process.on('uncaughtException', (err) => {
  bootLog(`[MAIN_PROCESS_UNCAUGHT_EXCEPTION] ${err.message}`);
  bootLog(err.stack || '(no stack)');
  // Show recovery dialog at most once every 30 s — avoids dialog spam on repeated crashes
  const now = Date.now();
  if ((now - _lastCrashDialogTime) > 30_000) {
    _lastCrashDialogTime = now;
    try {
      const { dialog: _d } = require('electron');
      _d.showErrorBox('StatfloBot — unexpected error', `${err.message}\n\nThe app may need to be restarted.`);
    } catch { /* dialog unavailable before app.whenReady */ }
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  bootLog(`[MAIN_PROCESS_UNHANDLED_REJECTION] ${msg}`);
});

// ── Electron imports ───────────────────────────────────────────────────────────

const {
  app, BrowserWindow, BrowserView, session, ipcMain, Menu, shell, nativeTheme, dialog,
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

// Legacy constants — kept so existing references compile; no longer used for setBounds.
const AUTOMATION_VIEWPORT_WIDTH  = 1920;
const AUTOMATION_VIEWPORT_HEIGHT = 1080;
// Target layout size used for dynamic zoom calculation in set-bounds.
// Statflo's Smart Lists page was designed for ~1440×900; we zoom to fit whatever
// panel size the renderer gives us so the site is always fully visible.
const TARGET_SITE_WIDTH  = 1440;
const TARGET_SITE_HEIGHT = 900;
// Unique data-URL that Playwright uses to deterministically locate the automation BrowserView.
// session.js matches against the 'statflobot-automation-view' token in the URL.
const AUTOMATION_SENTINEL_URL = 'data:text/html,<title>statflobot-automation-view</title>';
// Port for the native Electron automation bridge (REST HTTP). Replaces the CDP WebSocket proxy.
const AUTOMATION_BRIDGE_PORT = 9225;

const isDev = process.env.ELECTRON_DEV === 'true';

// remote-debugging-port intentionally NOT set here.
// Setting it exposes ALL Electron contexts (including the main renderer) to any
// process that connects via CDP — the bot subprocess selected the wrong context
// and destroyed mainWindow. Re-add only with a per-BrowserView isolated endpoint.

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
  bootLog('[LIFECYCLE:window-all-closed]');
  bootLog(`[LIFECYCLE] platform=${process.platform} totalWindows=${BrowserWindow.getAllWindows().length}`);
  bootLog(`[LIFECYCLE] mainWindow=${mainWindow ? 'alive' : 'null'} automationView=${automationView ? 'alive' : 'null'}`);
  if (isInstallingUpdate) {
    bootLog('[UPDATE_INSTALL] install mode active — suppressing window recreation');
    return;
  }
  if (process.platform !== 'darwin') {
    bootLog('[LIFECYCLE] non-darwin: stopping server + quitting');
    serverManager.stop();
    app.quit();
  } else {
    bootLog('[LIFECYCLE] darwin: keeping server alive for dock re-open');
  }
});

app.on('before-quit', () => {
  _quitting = true;
  bootLog(`before-quit t=${Date.now()}`);
  serverManager.stop();
  bootLog(`[BEFORE_QUIT] serverManager.stop() returned t=${Date.now()}`);

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

let mainWindow       = null;
let isInstallingUpdate = false;
let automationView   = null;
// Run-state tracking for close interception
let _quitting  = false;
let _runActive = false;
// Automation bridge HTTP server for the BrowserView (v1.3.9)
let _automationBridge = null;
// Lock: true while a run is starting/running — prevents stopAutomationBridge from firing.
// Set by ensureEmbeddedAutomationReady, released by run:active-changed {active:false}.
let _bridgeLocked = false;

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
  mainWindow.once('show', () => {
    clearTimeout(showTimer);
    // Log coordinate spaces immediately after the window is visible so we
    // can compare against BrowserView bounds sent from the renderer.
    const cb = mainWindow.getContentBounds();
    const wb = mainWindow.getBounds();
    bootLog(`[DIAG:WIN_CONTENT_BOUNDS] ${JSON.stringify(cb)}`);
    bootLog(`[DIAG:WIN_BOUNDS]         ${JSON.stringify(wb)}`);
  });

  // Retry counter for loadURL back-off (reset on successful load)
  let _loadRetryCount = 0;
  mainWindow.webContents.on('did-finish-load', () => {
    _loadRetryCount = 0;
    bootLog('renderer did-finish-load');
  });

  mainWindow.webContents.on('dom-ready', () => {
    bootLog('renderer dom-ready');
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog(`RENDERER_FAIL_LOAD: code=${code} desc="${desc}" url="${url}" retries=${_loadRetryCount}`);

    // ERR_CONNECTION_REFUSED(-102) / ERR_ADDRESS_UNREACHABLE(-109): server not ready yet.
    // Retry with back-off before showing the error page — this is the primary cause
    // of the blank screen on Windows after an auto-update relaunch.
    const isConnError = (code === -102 || code === -109) && url.startsWith(SERVER_URL);
    if (isConnError && _loadRetryCount < 4 && mainWindow && !mainWindow.isDestroyed()) {
      _loadRetryCount++;
      const delay = _loadRetryCount * 2000; // 2 s, 4 s, 6 s, 8 s
      bootLog(`[LOAD_RETRY] attempt ${_loadRetryCount}/4 — retrying in ${delay} ms`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(SERVER_URL).catch(() => {});
        }
      }, delay);
      return;
    }

    // All retries exhausted (or non-connection error) — show diagnostic page.
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bg = '#0a0a0f'; const fg = '#f87171'; const dim = '#475569';
      mainWindow.webContents.loadURL(
        `data:text/html,<html style="background:${bg};font-family:monospace;padding:40px"><body>` +
        `<p style="color:${fg};font-size:14px">StatfloBot failed to load (${code}: ${desc})</p>` +
        `<p style="color:${dim};font-size:12px">URL: ${url}</p>` +
        `<p style="color:${dim};font-size:12px">isPackaged: ${app.isPackaged} | resourcesPath: ${process.resourcesPath || 'n/a'}</p>` +
        `<p style="color:${dim};font-size:12px">Log: ${LOG_FILE}</p>` +
        `</body></html>`
      ).catch(() => {});
    }
  });

  mainWindow.webContents.on('crashed', (_e, killed) => {
    bootLog(`renderer crashed (killed=${killed})`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    bootLog(`[RENDERER_PROCESS_GONE] reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    bootLog('[RENDERER_UNRESPONSIVE] renderer is unresponsive');
  });

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // Only log errors/warnings to avoid flooding; level 3=error, 2=warning
    if (level >= 2) {
      bootLog(`[RENDERER_CONSOLE level=${level}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Intercept close to prevent accidental window destruction during a run.
  // Cmd+Q / app.quit() sets _quitting=true before this fires, so normal quit
  // is never blocked. Only the window's own close button is intercepted.
  mainWindow.on('close', (event) => {
    bootLog('[MAIN_WINDOW_CLOSE_REQUESTED]');
    bootLog(`[MAIN_WINDOW_CLOSE_REQUESTED] _quitting=${_quitting} _runActive=${_runActive} isInstallingUpdate=${isInstallingUpdate}`);
    if (_runActive && !_quitting && !isInstallingUpdate) {
      bootLog('[MAIN_WINDOW_CLOSE_INTERCEPTED] run active — hiding window instead of closing');
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    bootLog('[MAIN_WINDOW_CLOSED]');
    _runActive = false;
    _bridgeLocked = false;
    stopAutomationBridge({ force: true });
    if (automationView) {
      try { automationView.webContents?.destroy(); } catch { /* non-fatal */ }
      automationView = null;
    }
    mainWindow = null;
  });

  // Ask renderer to reapply BrowserView position after any window geometry change.
  // Automation viewport SIZE stays locked at AUTOMATION_VIEWPORT_WIDTH x AUTOMATION_VIEWPORT_HEIGHT
  // regardless of window dimensions — only the panel position (x,y) may shift.
  const requestBoundsRefresh = (label) => {
    if (_runActive) {
      bootLog(`[AUTOMATION_VIEWPORT_IGNORE_WINDOW_RESIZE] run active — viewport size locked; window ${label} ignored`);
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      bootLog(`[EMBEDDED_FULLSCREEN_REFLOW] ${label} — requesting bounds refresh from renderer`);
      mainWindow.webContents.send('embedded-browser:request-bounds-refresh');
    }
  };
  mainWindow.on('resize',            () => requestBoundsRefresh('resize'));
  mainWindow.on('maximize',          () => requestBoundsRefresh('maximize'));
  mainWindow.on('unmaximize',        () => requestBoundsRefresh('unmaximize'));
  mainWindow.on('enter-full-screen', () => {
    bootLog('[EMBEDDED_LAYOUT_FULLSCREEN] window entered fullscreen — bounds refresh triggered');
    requestBoundsRefresh('enter-full-screen');
  });
  mainWindow.on('leave-full-screen', () => {
    bootLog('[EMBEDDED_LAYOUT_FULLSCREEN] window left fullscreen — bounds refresh triggered');
    requestBoundsRefresh('leave-full-screen');
  });

  // Create the embedded automation browser view (v1.3.0)
  // Uses BrowserView — the stable Electron 29 API (deprecated in Electron 30; migrate to
  // WebContentsView when upgrading to electron@^30). BrowserView is fully supported here.
  // Positioned over the right panel area by the renderer via IPC set-bounds calls.
  // Playwright connects to this view via CDP rather than launching a separate window.
  automationView = createAutomationView();
  if (automationView) {
    bootLog('[EMBEDDED_BROWSER] automation BrowserView created and attached (hidden at 0,0,0,0)');
    bootLog('[EMBEDDED_BROWSER] zoom factor set to 0.8 for better content fit');
    bootLog(`[EMBEDDED_BROWSER] sentinel URL: ${AUTOMATION_SENTINEL_URL}`);
    // Start the native automation bridge so the bot can control this view directly.
    // Bridge runs for the entire app lifetime — destroyed only when mainWindow closes.
    _automationBridge = startAutomationBridge(automationView.webContents);
  }

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

// ── Embedded browser status broadcast (v1.3.0) ────────────────────────────────
function sendEmbeddedStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('embedded-browser:status', payload);
    }
  } catch { /* window may be closing */ }
}

// ── BrowserView lifecycle helpers ─────────────────────────────────────────────

function createAutomationView() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    bootLog('[EMBEDDED_BROWSER] cannot createAutomationView — no mainWindow');
    return null;
  }
  try {
    const view = new BrowserView({
      webPreferences: {
        session:          session.fromPartition('persist:automation'),
        nodeIntegration:  false,
        contextIsolation: true,
        webSecurity:      true,
        sandbox:          false,
      },
    });
    mainWindow.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    // Scale content so Statflo fits within the panel without excessive scrolling.
    // 0.8 = 80% zoom — shows ~25% more content than 1:1; adjustable via /api/embedded/zoom.
    view.webContents.setZoomFactor(0.8);
    view.webContents.loadURL(AUTOMATION_SENTINEL_URL);

    view.webContents.on('did-navigate', (_e, url) => {
      bootLog(`[EMBEDDED_BROWSER] navigated: ${url}`);
      sendEmbeddedStatus({ url, loading: false });
    });
    view.webContents.on('did-start-loading', () => sendEmbeddedStatus({ loading: true }));
    view.webContents.on('did-stop-loading', () => {
      const current = automationView?.webContents?.getURL() ?? 'about:blank';
      sendEmbeddedStatus({ url: current, loading: false });
    });
    view.webContents.on('render-process-gone', (_e, details) => {
      bootLog(`[EMBEDDED_BROWSER] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
      sendEmbeddedStatus({ url: 'about:blank', loading: false });
    });
    view.webContents.on('destroyed', () => {
      bootLog('[EMBEDDED_BROWSER] webContents destroyed — clearing reference');
      automationView = null;
      try {
        if (mainWindow && !mainWindow.isDestroyed()) sendEmbeddedStatus({ url: 'about:blank', loading: false });
      } catch { /* main window may also be closing */ }
    });
    return view;
  } catch (err) {
    bootLog(`[EMBEDDED_BROWSER] failed to create BrowserView: ${err.message}`);
    return null;
  }
}

/**
 * Fully destroy the automation BrowserView and stop the bridge.
 * A fresh view + bridge are recreated on the next embedded-browser:set-bounds call.
 *
 * When _bridgeLocked (run in progress): only hide the view — do NOT destroy the
 * webContents or null automationView. The bridge keeps serving the live bot.
 * Full teardown happens when the lock is released (run:active-changed active=false).
 */
function destroyAutomationView() {
  if (!automationView) return;
  bootLog('[EMBEDDED_BROWSER_DESTROY_START]');

  if (_bridgeLocked) {
    // Run in progress — hide only. Preserve webContents so the bridge stays usable.
    bootLog('[EMBEDDED_BROWSER_HIDE_ONLY] bridge locked — removing from window without destroying');
    try {
      if (!automationView.webContents?.isDestroyed()) automationView.webContents.stopLoading();
    } catch { /* ignore */ }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(automationView);
    } catch { /* ignore */ }
    return;
  }

  // Full cleanup (lock not held)
  // Step 1: stop loading
  try {
    if (!automationView.webContents?.isDestroyed()) {
      automationView.webContents.stopLoading();
      bootLog('[EMBEDDED_BROWSER_STOP_LOADING]');
    }
  } catch { /* ignore */ }
  // Step 2: remove from window
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeBrowserView(automationView);
      bootLog('[EMBEDDED_BROWSER_REMOVE_FROM_WINDOW]');
    }
  } catch { /* ignore */ }
  // Step 3: destroy webContents
  try {
    if (!automationView.webContents?.isDestroyed()) {
      automationView.webContents.destroy();
      bootLog('[EMBEDDED_BROWSER_WEBCONTENTS_DESTROY]');
    }
  } catch { /* ignore */ }
  // Step 4: clear view reference
  automationView = null;
  // Step 5 & 6: stop bridge + clear ref
  stopAutomationBridge();
  // Step 7: repaint main window
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.invalidate?.();
  } catch { /* ignore */ }
  bootLog('[EMBEDDED_BROWSER_DESTROY_DONE]');
}

// ── Automation bridge (v1.3.9) ────────────────────────────────────────────────
// Exposes the automation BrowserView via a local REST HTTP server on port 9225.
// The bot uses src/embedded-page.js (EmbeddedPage) instead of Playwright to drive it.
// No WebSocket or CDP — all commands go through webContents native Electron APIs.

function startAutomationBridge(wc) {
  const http = require('http');

  bootLog(`[AUTOMATION_BRIDGE] startAutomationBridge — wc.id=${wc.id} destroyed=${wc.isDestroyed()}`);

  async function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', d => { raw += d.toString(); });
      req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
  }

  function navigateAndWait(url, waitUntil, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        wc.removeListener('did-finish-load', onLoad);
        wc.removeListener('dom-ready', onDom);
        resolve();
      };
      const t = setTimeout(done, timeoutMs);
      const onLoad = () => { if (waitUntil !== 'domcontentloaded') done(); };
      const onDom  = () => { if (waitUntil === 'domcontentloaded') done(); };
      wc.on('did-finish-load', onLoad);
      wc.on('dom-ready', onDom);
      wc.loadURL(url).catch(() => {});
    });
  }

  // Endpoints that are polled at high frequency (every 2 s during login wait) —
  // omit from the boot log to avoid flooding with noise.
  const SILENT_PATHS = new Set(['/api/embedded/url', '/api/embedded/evaluate']);

  // Extract handler so it can be shared by initial server and EADDRINUSE retry server.
  const handler = async (req, res) => {
    const p = req.url.split('?')[0];
    if (!SILENT_PATHS.has(p)) bootLog(`[BRIDGE] ${req.method} ${p}`);

    const ok = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const err = (code, msg) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    };

    if (wc.isDestroyed() && p !== '/json/version') return err(500, 'automationView destroyed');

    try {
      if (p === '/json/version') {
        return ok({ ok: true, url: wc.isDestroyed() ? 'destroyed' : wc.getURL(), bridge: 'electron-native' });
      }
      if (p === '/api/embedded/health') {
        // Lightweight health check — no JS execution, no navigation.
        // Returns 200 only when wc is alive (the isDestroyed guard above already
        // returns 500 when wc is dead). Used by readiness probes so they don't
        // depend on executeJavaScript being available on a freshly loaded view.
        return ok({ ok: true, alive: true, url: wc.getURL() });
      }
      if (p === '/api/embedded/url') {
        // Use document.location.href rather than wc.getURL() — the Chromium-level
        // URL (wc.getURL) does not update when Statflo SPA uses history.pushState()
        // after processing the Okta OAuth callback. document.location.href always
        // reflects the live browser URL including SPA route changes.
        let url = wc.getURL();
        try {
          const href = await wc.executeJavaScript('document.location.href', true);
          if (typeof href === 'string' && href && href !== 'about:blank') url = href;
        } catch { /* navigation in progress — fall back to wc.getURL() */ }
        return ok({ url });
      }
      if (p === '/api/embedded/navigate' && req.method === 'POST') {
        const { url, waitUntil = 'domcontentloaded', timeout = 30000 } = await readBody(req);
        bootLog(`[BRIDGE] navigate → ${url}`);
        await navigateAndWait(url, waitUntil, timeout);
        bootLog(`[BRIDGE] navigate done → ${wc.getURL()}`);
        return ok({ ok: true, url: wc.getURL() });
      }
      if (p === '/api/embedded/evaluate' && req.method === 'POST') {
        const { fn, args = [] } = await readBody(req);
        const code = `(${fn})(...${JSON.stringify(args)})`;
        const result = await wc.executeJavaScript(code, true);
        return ok({ result: result ?? null });
      }
      if (p === '/api/embedded/cookies/clear' && req.method === 'POST') {
        await wc.session.clearStorageData({ storages: ['cookies'] });
        bootLog('[BRIDGE] cookies cleared');
        return ok({ ok: true });
      }
      if (p === '/api/embedded/keyboard/press' && req.method === 'POST') {
        const { key } = await readBody(req);
        const MAP = {
          Enter: 'Return', Return: 'Return', Tab: 'Tab', Escape: 'Escape',
          Backspace: 'Back', Delete: 'Delete',
          ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right',
        };
        const kc = MAP[key] || key;
        wc.sendInputEvent({ type: 'keyDown', keyCode: kc });
        if (kc.length === 1) wc.sendInputEvent({ type: 'char', keyCode: kc });
        wc.sendInputEvent({ type: 'keyUp', keyCode: kc });
        await new Promise(r => setTimeout(r, 50));
        return ok({ ok: true });
      }
      if (p === '/api/embedded/zoom' && req.method === 'POST') {
        const { factor } = await readBody(req);
        const f = Math.max(0.5, Math.min(2.0, Number(factor) || 0.8));
        wc.setZoomFactor(f);
        bootLog(`[BRIDGE] zoom factor set to ${f}`);
        return ok({ ok: true, factor: f });
      }
      err(404, `unknown: ${p}`);
    } catch (e) {
      bootLog(`[BRIDGE_ERR] ${p}: ${e.message}`);
      err(500, e.message);
    }
  };

  const server = http.createServer(handler);
  server.listen(AUTOMATION_BRIDGE_PORT, '127.0.0.1', () => {
    bootLog(`[AUTOMATION_BRIDGE] ready → http://127.0.0.1:${AUTOMATION_BRIDGE_PORT}`);
  });
  server.on('error', (e) => {
    bootLog(`[AUTOMATION_BRIDGE] server error: ${e.code ?? e.message}`);
    if (e.code === 'EADDRINUSE') {
      // Do NOT retry server.listen() on the same object — after close() it may be
      // destroyed and Node throws ERR_SERVER_DESTROYED on a second listen call.
      // Instead: close this server and after 400 ms create a FRESH server object.
      bootLog('[AUTOMATION_BRIDGE_RESTART_START] port in use — closing and retrying with fresh server in 400 ms');
      try { server.close(); } catch {}
      setTimeout(() => {
        // If stopAutomationBridge() was called in the meantime, _automationBridge is
        // null or points to a newer server — skip the retry to avoid a zombie server.
        if (_automationBridge !== server) {
          bootLog('[AUTOMATION_BRIDGE] EADDRINUSE retry skipped — bridge already replaced or stopped');
          return;
        }
        const retryServer = http.createServer(handler);
        _automationBridge = retryServer;
        retryServer.listen(AUTOMATION_BRIDGE_PORT, '127.0.0.1', () => {
          bootLog('[AUTOMATION_BRIDGE_RESTART_OK] retry server ready on port ' + AUTOMATION_BRIDGE_PORT);
        });
        retryServer.on('error', (e2) => {
          bootLog(`[AUTOMATION_BRIDGE] retry server error: ${e2.code ?? e2.message}`);
          if (_automationBridge === retryServer) _automationBridge = null;
        });
      }, 400);
    }
  });

  return server;
}

function stopAutomationBridge({ force = false } = {}) {
  bootLog('[BRIDGE_SERVER_CLOSE_CALLED]');
  if (_bridgeLocked && !force) {
    bootLog('[BRIDGE_SERVER_CLOSE_SUPPRESSED] bridge locked during active run — close deferred');
    return;
  }
  if (!_automationBridge) return;
  const srv = _automationBridge;
  _automationBridge = null;
  try { srv.close(); } catch {}
  bootLog('[AUTOMATION_BRIDGE_STOPPED]');
}

// Probe the bridge with /api/embedded/health — lightweight check: 200 only when wc is alive.
// /json/version always returns 200 even with a destroyed wc; /api/embedded/url requires
// executeJavaScript which can hang on a freshly loaded view. Health is the safest probe.
function _waitForBridgeReady(endpoint, timeoutMs) {
  const http = require('http');
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let _settled = false;
    function done(val) { if (!_settled) { _settled = true; resolve(val); } }
    function probe() {
      if (_settled) return;
      const req = http.get(`${endpoint}/api/embedded/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) { done(true); return; }
        bootLog(`[AUTOMATION_BRIDGE_PROBE] /api/embedded/health → ${res.statusCode} — not ready`);
        if (Date.now() < deadline) setTimeout(probe, 200); else done(false);
      });
      req.on('error', (e) => {
        bootLog(`[AUTOMATION_BRIDGE_PROBE] error: ${e.code ?? e.message}`);
        if (Date.now() < deadline) setTimeout(probe, 200); else done(false);
      });
      req.setTimeout(1000, () => { req.destroy(); });
    }
    probe();
  });
}

// Run the exact sequence the bot executes on connect — both must return 200:
//   POST /api/embedded/cookies/clear  (clearCookies — first bot operation)
//   GET  /api/embedded/url            (getCurrentUrl — second bot operation)
// Returns true only when both succeed. A passing health-check is NOT sufficient:
// the bridge can accept TCP connections but still fail on these actual operations.
async function _preflightBridge(endpoint) {
  const http = require('http');

  bootLog('[EMBEDDED_PREFLIGHT_COOKIES_CLEAR_START]');
  const clearOk = await new Promise((resolve) => {
    const body = '{}';
    const req = http.request(`${endpoint}/api/embedded/cookies/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      if (res.statusCode !== 200) bootLog(`[EMBEDDED_PREFLIGHT_FAILED] cookies/clear → ${res.statusCode}`);
      resolve(res.statusCode === 200);
    });
    req.on('error', (e) => {
      bootLog(`[EMBEDDED_PREFLIGHT_FAILED] cookies/clear error: ${e.code ?? e.message}`);
      resolve(false);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });

  if (!clearOk) return false;
  bootLog('[EMBEDDED_PREFLIGHT_COOKIES_CLEAR_OK]');

  const urlOk = await new Promise((resolve) => {
    const req = http.get(`${endpoint}/api/embedded/url`, (res) => {
      res.resume();
      if (res.statusCode !== 200) bootLog(`[EMBEDDED_PREFLIGHT_FAILED] url → ${res.statusCode}`);
      resolve(res.statusCode === 200);
    });
    req.on('error', (e) => {
      bootLog(`[EMBEDDED_PREFLIGHT_FAILED] url error: ${e.code ?? e.message}`);
      resolve(false);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });

  if (!urlOk) return false;
  bootLog('[EMBEDDED_PREFLIGHT_URL_OK]');
  return true;
}

/**
 * Ensure the automation BrowserView and bridge (port 9225) are alive AND genuinely usable.
 * Called by the server before spawning the bot so embedded mode is always ready.
 * Async — waits for the bridge to pass a real probe before returning ok:true.
 */
async function ensureEmbeddedAutomationReady() {
  bootLog('[EMBEDDED_READY_ENTER]');
  _bridgeLocked = true;
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      _bridgeLocked = false;
      bootLog('[EMBEDDED_READY_RETURN_FAIL] no-window');
      return { ok: false, reason: 'no-window', endpoint: `http://127.0.0.1:${AUTOMATION_BRIDGE_PORT}` };
    }

    // Recreate BrowserView if null or destroyed
    let _viewRecreated = false;
    if (!automationView || automationView.webContents?.isDestroyed()) {
      stopAutomationBridge({ force: true });
      automationView = createAutomationView();
      if (!automationView) {
        _bridgeLocked = false;
        bootLog('[EMBEDDED_READY_RETURN_FAIL] view-creation-failed');
        return { ok: false, reason: 'view-creation-failed', endpoint: `http://127.0.0.1:${AUTOMATION_BRIDGE_PORT}` };
      }
      _viewRecreated = true;
      bootLog('[EMBEDDED_READY_VIEW_OK] fresh BrowserView created for next run');
    } else {
      bootLog('[EMBEDDED_READY_VIEW_OK] existing BrowserView is alive');
    }

    // Ensure view is attached to the window
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.getBrowserViews().includes(automationView)) {
        mainWindow.addBrowserView(automationView);
      }
    } catch { /* ignore */ }

    bootLog('[EMBEDDED_READY_BRIDGE_START_ATTEMPT]');
    if (!_automationBridge || _viewRecreated) {
      if (_automationBridge) stopAutomationBridge({ force: true });
      _automationBridge = startAutomationBridge(automationView.webContents);
      bootLog('[EMBEDDED_READY_BRIDGE_STARTED] automation bridge (re)started on port ' + AUTOMATION_BRIDGE_PORT);
    }

    const _endpoint = `http://127.0.0.1:${AUTOMATION_BRIDGE_PORT}`;

    // Stage 1: wait for TCP connectivity (handles EADDRINUSE retry window of ~400ms)
    bootLog('[EMBEDDED_READY_BRIDGE_PROBE_ATTEMPT] waiting for bridge TCP readiness');
    const _tcpOk = await _waitForBridgeReady(_endpoint, 3000);
    if (!_tcpOk) {
      bootLog('[EMBEDDED_READY_BRIDGE_PROBE_FAIL] bridge not accepting connections — restarting');
      bootLog('[EMBEDDED_BRIDGE_RESTART_START]');
      stopAutomationBridge({ force: true });
      _automationBridge = startAutomationBridge(automationView.webContents);
      await new Promise(r => setTimeout(r, 500));
      const _tcpRetryOk = await _waitForBridgeReady(_endpoint, 2500);
      if (!_tcpRetryOk) {
        _bridgeLocked = false;
        bootLog('[EMBEDDED_READY_BRIDGE_PROBE_FAIL] bridge still not accepting connections after restart');
        bootLog('[EMBEDDED_READY_RETURN_FAIL] bridge-not-usable');
        return { ok: false, reason: 'bridge-not-usable', endpoint: _endpoint };
      }
      bootLog('[EMBEDDED_BRIDGE_RESTART_OK] bridge accepting connections after restart');
    }
    bootLog('[EMBEDDED_READY_BRIDGE_PROBE_OK] bridge accepting connections');

    // Stage 2: preflight — run exact bot operations; if health gave a false-positive this catches it
    const _preflightOk = await _preflightBridge(_endpoint);
    if (!_preflightOk) {
      bootLog('[EMBEDDED_PREFLIGHT_RESTART_BRIDGE]');
      stopAutomationBridge({ force: true });
      _automationBridge = startAutomationBridge(automationView.webContents);
      await new Promise(r => setTimeout(r, 500));
      const _preflightRetryOk = await _preflightBridge(_endpoint);
      if (!_preflightRetryOk) {
        _bridgeLocked = false;
        bootLog('[EMBEDDED_PREFLIGHT_FAILED] bridge operations still failing after restart');
        bootLog('[EMBEDDED_READY_RETURN_FAIL] preflight-failed');
        return { ok: false, reason: 'preflight-failed', endpoint: _endpoint };
      }
    }
    bootLog('[EMBEDDED_PREFLIGHT_READY_OK]');
    bootLog('[EMBEDDED_READY_RETURN_OK]');
    return { ok: true, endpoint: _endpoint };
  } catch (err) {
    _bridgeLocked = false;
    bootLog(`[EMBEDDED_READY_RETURN_FAIL] unexpected error: ${err.message}`);
    bootLog(err.stack ?? '(no stack)');
    return { ok: false, reason: 'unexpected-error', detail: err.message, endpoint: `http://127.0.0.1:${AUTOMATION_BRIDGE_PORT}` };
  }
}

// ── Updater status broadcast ───────────────────────────────────────────────────
function sendUpdaterStatus(payload) {
  bootLog(`[UPDATER_UI_STATE] state=${payload.state} version=${payload.version ?? 'n/a'} percent=${payload.percent ?? 'n/a'}`);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', payload);
    }
  } catch { /* window may be closing */ }
}

// ── Install helper (shared by IPC handler and auto-install on update-downloaded) ──
async function triggerInstall() {
  if (!autoUpdater) return;

  const exePath = app.getPath('exe');
  bootLog(`[UPDATE_INSTALL] triggered t=${Date.now()}`);
  bootLog(`[UPDATE_INSTALL] process.execPath   = ${process.execPath}`);
  bootLog(`[UPDATE_INSTALL] app.getPath('exe') = ${exePath}`);
  bootLog(`[UPDATE_INSTALL] app.isPackaged     = ${app.isPackaged}`);
  bootLog(`[UPDATE_INSTALL] platform           = ${process.platform}`);

  if (process.platform === 'darwin') {
    const appBundle = path.resolve(exePath, '..', '..', '..');
    bootLog(`[UPDATE_INSTALL] computed app bundle = ${appBundle}`);
    if (!appBundle.startsWith('/Applications/')) {
      bootLog('[UPDATE_INSTALL] WARN: app is not inside /Applications — blocking install');
      sendUpdaterStatus({ state: 'move-required' });
      return;
    }
  }

  isInstallingUpdate = true;

  bootLog(`[UPDATER_INSTALL_START] platform=${process.platform} t=${Date.now()}`);
  // Notify UI of installing state before stopping the server.
  // On Windows the window stays alive until NSIS kills the process, so the
  // overlay remains visible throughout the install — no destroy() before quitAndInstall.
  sendUpdaterStatus({ state: 'installing' });

  bootLog(`[UPDATE_INSTALL] stopping server manager t=${Date.now()}`);
  serverManager.stop();
  bootLog(`[UPDATE_INSTALL] serverManager.stop() returned t=${Date.now()}`);
  // Give taskkill /F /T time to terminate the full process tree (server +
  // bot subprocess + Playwright/Chromium).  1 s was sometimes insufficient
  // on buyer machines — 2.5 s ensures all file handles are released before
  // NSIS starts replacing the exe.
  await new Promise(r => setTimeout(r, 2500));
  bootLog(`[UPDATE_INSTALL] post-stop delay done t=${Date.now()}`);

  if (process.platform === 'darwin') {
    // macOS: destroy window then quitAndInstall replaces the whole .app bundle.
    bootLog(`[UPDATE_INSTALL] destroying main window (macOS) t=${Date.now()}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      bootLog(`[UPDATE_INSTALL] mainWindow.destroy() called`);
    } else {
      bootLog(`[UPDATE_INSTALL] mainWindow already gone`);
    }
    await new Promise(r => setTimeout(r, 300));

    bootLog('[UPDATE_INSTALL] removing all app listeners (macOS)');
    app.removeAllListeners('window-all-closed');
    app.removeAllListeners('activate');
    // Write a flag so the next boot can log [MAC_LAUNCHED_AFTER_UPDATE]
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), '.update-pending'), app.getVersion(), 'utf8');
    } catch { /* non-fatal */ }
    bootLog('[UPDATER_FINAL_OVERLAY] sending final installing state before quitAndInstall (macOS)');
    sendUpdaterStatus({ state: 'installing' });
    bootLog('[UPDATE_INSTALL] calling quitAndInstall(false,true) (macOS)');
    autoUpdater.quitAndInstall(false, true);
  } else {
    // Windows: do NOT destroy the window before quitAndInstall.
    // Keeping the window alive lets the "Installing update…" overlay stay
    // visible until NSIS kills the process — avoids the blank-window gap.
    bootLog(`[WIN_UPDATER_OVERLAY_VISIBLE] window kept alive for overlay t=${Date.now()}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      bootLog(`[WIN_UPDATER_OVERLAY_VISIBLE] mainWindow.show/focus() called`);
      bootLog(`[WIN_UPDATER_OVERLAY_SHOWN] overlay window is visible and focused t=${Date.now()}`);
    }

    // Send installing state BEFORE spawning relaunch helper and BEFORE quitAndInstall.
    // Give React 1.5 s to render the overlay so the user sees it before NSIS starts.
    bootLog('[WIN_UPDATER_INSTALLING_OVERLAY_SENT] sending installing state to renderer');
    sendUpdaterStatus({ state: 'installing' });
    bootLog(`[WIN_UPDATER_OVERLAY_STATE] state=installing t=${Date.now()}`);

    // Write post-update marker so the next boot logs [APP_LAUNCHED_AFTER_UPDATE].
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), '.update-pending'), app.getVersion(), 'utf8');
      bootLog(`[WIN_UPDATER_MARKER_WRITTEN] .update-pending written version=${app.getVersion()}`);
    } catch { /* non-fatal */ }

    // 1.5 s overlay render window — gives React time to paint before NSIS kills the process.
    bootLog(`[WIN_UPDATER_OVERLAY_DELAY_START] waiting 1500ms for overlay render t=${Date.now()}`);
    await new Promise(r => setTimeout(r, 1500));
    bootLog(`[WIN_UPDATER_OVERLAY_DELAY_DONE] overlay delay complete t=${Date.now()}`);

    // Hidden PowerShell relaunch after NSIS finishes.
    // IMPORTANT: Do NOT relaunch process.execPath — it is the exe NSIS is
    // replacing, which causes a file-lock conflict and "unable to uninstall" errors.
    // Instead relaunch from the standard per-user NSIS install path.
    bootLog(`[WIN_UPDATE_INSTALL_START] t=${Date.now()}`);
    bootLog(`[WIN_UPDATE_KILL_CHILDREN] serverManager already stopped above; bot/browser processes terminated`);

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const installedExe = path.join(localAppData, 'Programs', 'StatfloBot', 'StatfloBot.exe');
    bootLog(`[WIN_UPDATE_RELAUNCH_PATH] installedExe=${installedExe}`);
    bootLog(`[WIN_UPDATE_RELAUNCH_PATH] process.execPath=${process.execPath} (NOT used for relaunch — avoids file-lock)`);

    // Escape single quotes for PowerShell single-quoted string literal
    const psExe = installedExe.replace(/'/g, "''");
    const psCmd = `Start-Sleep -Seconds 30; if (Test-Path '${psExe}') { Start-Process -FilePath '${psExe}' -ArgumentList '--relaunch' }`;

    try {
      const child = spawn('powershell.exe', [
        '-WindowStyle', 'Hidden',
        '-NonInteractive',
        '-NoProfile',
        '-Command', psCmd,
      ], {
        detached: true,
        stdio:    'ignore',
      });
      child.unref();
      bootLog(`[WIN_UPDATE_INSTALL_START] hidden PowerShell relaunch spawned pid=${child.pid ?? '(pending)'}`);
      bootLog(`[WIN_UPDATER_APP_RELAUNCH_EXPECTED] relaunch script queued — exe=${installedExe}`);
      bootLog(`[WIN_UPDATER_RELAUNCH_EXPECTED] relaunch script queued — exe=${installedExe}`);
    } catch (psErr) {
      bootLog(`[WIN_UPDATE_INSTALL_ERROR] failed to spawn PowerShell relaunch: ${psErr.message}`);
      // NSIS will still install silently; user can reopen manually
    }

    // quitAndInstall(isSilent=true, isForceRunAfter=true) — NSIS relaunches the
    // newly installed exe from the correct install path, avoiding the hardcoded
    // %LOCALAPPDATA% path issue when users changed the install directory.
    bootLog(`[WIN_UPDATER_INSTALL_STARTED] calling quitAndInstall(true,true) t=${Date.now()}`);
    bootLog(`[WIN_UPDATER_QUIT_AND_INSTALL_CALLED] calling quitAndInstall(true,true) t=${Date.now()}`);
    autoUpdater.quitAndInstall(true, true);
    bootLog('[WIN_UPDATER_QUIT_AND_INSTALL_CALLED] quitAndInstall returned (process exit imminent)');
  }
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
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('updater:install', async () => {
  return triggerInstall();
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

// Read a run log file — only files inside userData are allowed
ipcMain.handle('run-log:read', (_e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { error: 'no path' };
  const userData = app.getPath('userData');
  if (!filePath.startsWith(userData)) return { error: 'path not in userData' };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { content: raw.slice(-80000) }; // last ~80 KB
  } catch (e) {
    return { error: e.message };
  }
});

// ── Embedded browser IPC (v1.3.0) ─────────────────────────────────────────
// Debug channel: renderer sends raw getBoundingClientRect() measurements
ipcMain.on('embedded-browser:debug', (_e, data) => {
  bootLog(`[DIAG:RENDERER_RECT] ${JSON.stringify(data)}`);
});

ipcMain.on('embedded-browser:set-bounds', (_e, raw) => {
  bootLog(`[DIAG:BOUNDS_RECEIVED] raw=${JSON.stringify(raw)}`);

  if (!mainWindow || mainWindow.isDestroyed()) {
    bootLog('[DIAG:BOUNDS_RECEIVED] skip — no mainWindow');
    return;
  }

  // Recreate if destroyAutomationView() fully tore down the view (v1.5.3 full lifecycle).
  if (!automationView || automationView.webContents?.isDestroyed()) {
    bootLog('[EMBEDDED_BROWSER_RECREATE_ON_NEXT_RUN] automationView missing — creating fresh view');
    automationView = createAutomationView();
    if (!automationView) {
      bootLog('[DIAG:BOUNDS_RECEIVED] skip — could not recreate automationView');
      return;
    }
    bootLog('[FRESH_AUTOMATION_VIEW_READY] fresh BrowserView created');
    // Restart bridge only when not locked. If locked, the existing bridge is still
    // serving the active run — killing it here would cause ECONNREFUSED in the bot.
    if (!_bridgeLocked) {
      if (_automationBridge) stopAutomationBridge();
      _automationBridge = startAutomationBridge(automationView.webContents);
      bootLog('[AUTOMATION_BRIDGE_STARTED] bridge started on fresh view');
    } else {
      bootLog('[AUTOMATION_BRIDGE_KEEP] bridge locked — preserving existing bridge for active run');
    }
  } else {
    const attached = mainWindow.getBrowserViews().includes(automationView);
    if (!attached) {
      bootLog('[EMBEDDED_BROWSER_REATTACH] re-attaching live BrowserView');
      mainWindow.addBrowserView(automationView);
    }
  }

  const contentBounds = mainWindow.getContentBounds();
  const winBounds     = mainWindow.getBounds();
  const { width: winW, height: winH } = contentBounds;
  bootLog(`[DIAG:WIN_AT_SETBOUNDS] content=${JSON.stringify(contentBounds)} window=${JSON.stringify(winBounds)}`);

  const rx = Math.round(raw.x      ?? 0);
  const ry = Math.round(raw.y      ?? 0);
  const rw = Math.round(raw.width  ?? 0);
  const rh = Math.round(raw.height ?? 0);

  // Reject degenerate bounds (layout not yet settled)
  if (rw < 20 || rh < 20) {
    bootLog(`[EMBEDDED_BOUNDS_REJECTED] degenerate x=${rx} y=${ry} w=${rw} h=${rh}`);
    return;
  }
  // Reject full-overlay: never let the view start at the top-left and cover the whole window
  if (rx < 20 && ry < 60 && rw > winW * 0.85 && rh > winH * 0.85) {
    bootLog(`[EMBEDDED_BOUNDS_REJECTED] full-overlay x=${rx} y=${ry} w=${rw} h=${rh} win=${winW}x${winH}`);
    return;
  }

  // Fit BrowserView to the actual renderer-provided panel, clamped to the window.
  const x = Math.max(0, Math.min(rx, winW - 20));
  const y = Math.max(0, Math.min(ry, winH - 20));
  const w = Math.max(320, Math.min(rw, winW - x));
  const h = Math.max(240, Math.min(rh, winH - y));

  // Dynamic zoom: scale Statflo's target layout into the actual panel dimensions.
  // Clamp between 0.55 (very small window) and 0.85 (near full-size).
  const zoomW = w / TARGET_SITE_WIDTH;
  const zoomH = h / TARGET_SITE_HEIGHT;
  const zoom  = Math.max(0.55, Math.min(0.85, Math.min(zoomW, zoomH)));
  automationView.webContents.setZoomFactor(zoom);

  bootLog(`[AUTOMATION_VIEWPORT_FIT] panel=${w}x${h} zoom=${zoom.toFixed(3)}`);

  const isFS = mainWindow.isFullScreen();
  bootLog(`[EMBEDDED_BOUNDS_APPLIED${isFS ? '_FULLSCREEN' : ''}] x=${x} y=${y} w=${w} h=${h} fullscreen=${isFS}`);
  automationView.setBounds({ x, y, width: w, height: h });

  const actual = automationView.getBounds();
  bootLog(`[DIAG:BOUNDS_ACTUAL_AFTER_SET] ${JSON.stringify(actual)}`);
});
ipcMain.on('embedded-browser:hide', () => {
  bootLog('[STOP_REQUESTED_HIDE_BROWSER] embedded-browser:hide received — hard removing BrowserView');
  bootLog('[EMBEDDED_BROWSER_STOP_LOADING_BEFORE_HIDE]');
  destroyAutomationView();
  bootLog('[EMBEDDED_BROWSER_FORCE_HIDDEN_ON_STOP] BrowserView removed from window');
});
ipcMain.handle('embedded-browser:get-status', () => ({
  ready: !!automationView,
  url:   automationView?.webContents?.getURL() ?? 'about:blank',
}));

// Run active/idle state — sent by renderer when a run starts or stops.
// result field: 'complete'|'stopped'|'error'|null
// On error, keep BrowserView visible for 30 s so the user can inspect the embedded page.
ipcMain.on('run:active-changed', (_e, { active, result }) => {
  _runActive = !!active;
  bootLog(`[RUN_START_WINDOW_STATE] active=${_runActive} result=${result ?? 'none'} mainWindow=${mainWindow ? 'alive' : 'null'} visible=${mainWindow?.isVisible()}`);
  if (!active) {
    bootLog(`[EMBEDDED_BROWSER_RESET_AFTER_RUN_END] result=${result ?? 'none'} — removing BrowserView`);
    if (result === 'error')   bootLog('[EMBEDDED_BROWSER_RESET_AFTER_ERROR]');
    if (result === 'blocked') bootLog('[EMBEDDED_BROWSER_RESET_AFTER_BLOCKED_RUN]');
    _bridgeLocked = false;
    destroyAutomationView();
    bootLog('[EMBEDDED_BROWSER_HIDDEN_AFTER_RUN_END] BrowserView removed and reset');
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
  if (process.platform === 'win32') {
    bootLog(`[WIN_BOOT] argv: ${process.argv.join(' ')}`);
    bootLog(`[WIN_BOOT] execPath: ${process.execPath}`);
    bootLog(`[WIN_BOOT] appVersion: ${app.getVersion()}`);
    const isRelaunch = process.argv.includes('--relaunch');
    bootLog(`[WIN_BOOT] --relaunch flag: ${isRelaunch}`);
    if (isRelaunch) {
      bootLog(`[WIN_LAUNCHED_BY_RELAUNCH] post-update relaunch confirmed — version=${app.getVersion()}`);
      bootLog(`[WIN_LAUNCHED_AFTER_UPDATE] appVersion=${app.getVersion()}`);
      bootLog(`[WIN_UPDATER_APP_RELAUNCHED] appVersion=${app.getVersion()}`);
      bootLog(`[APP_LAUNCHED_AFTER_UPDATE] platform=win32 appVersion=${app.getVersion()}`);
    }
    // Also detect via marker file (covers NSIS-relaunch without --relaunch flag)
    const winUpdateFlagPath = path.join(app.getPath('userData'), '.update-pending');
    if (fs.existsSync(winUpdateFlagPath)) {
      const prevVersion = (() => { try { return fs.readFileSync(winUpdateFlagPath, 'utf8').trim(); } catch { return 'unknown'; } })();
      bootLog(`[WIN_UPDATER_APP_RELAUNCHED] marker file found — prevVersion=${prevVersion} newVersion=${app.getVersion()}`);
      bootLog(`[APP_LAUNCHED_AFTER_UPDATE] platform=win32 prevVersion=${prevVersion} appVersion=${app.getVersion()}`);
      try { fs.unlinkSync(winUpdateFlagPath); } catch { /* non-fatal */ }
    }
  } else if (process.platform === 'darwin') {
    bootLog(`[MAC_BOOT] appVersion=${app.getVersion()} execPath=${process.execPath}`);
    // Detect if this boot is right after an auto-update by checking a flag file
    // written before quitAndInstall. If present, log and remove it.
    const { app: electronApp } = require('electron');
    const updateFlagPath = path.join(electronApp.getPath('userData'), '.update-pending');
    if (fs.existsSync(updateFlagPath)) {
      bootLog(`[MAC_LAUNCHED_AFTER_UPDATE] appVersion=${app.getVersion()}`);
      try { fs.unlinkSync(updateFlagPath); } catch { /* non-fatal */ }
    }
  }

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
    if (process.platform === 'win32') {
      bootLog(`[WIN_RELAUNCH_SERVER_WAIT_START] t=${Date.now()}`);
    }
    try {
      await serverManager.start(app, bootLog, ensureEmbeddedAutomationReady);
      bootLog('server-manager: server ready');
      if (process.platform === 'win32') {
        bootLog(`[WIN_RELAUNCH_SERVER_READY] t=${Date.now()}`);
      }
    } catch (err) {
      bootLog(`server-manager ERROR: ${err.message}`);
      bootLog(err.stack ?? '(no stack)');
      if (process.platform === 'win32') {
        bootLog(`[WIN_RELAUNCH_SERVER_FAILED] t=${Date.now()} — window will retry loadURL`);
      }
      // Don't abort — createWindow will retry loadURL via did-fail-load back-off
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

    let shipItRetried = false;

    autoUpdater.on('checking-for-update', () => {
      bootLog('[AUTO_UPDATE] checking-for-update');
      if (process.platform === 'win32') bootLog('[WIN_UPDATER_CHECK_START] checking for update on Windows');
      sendUpdaterStatus({ state: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      const ver = info?.version ?? info?.updateInfo?.version ?? null;
      bootLog(`[AUTO_UPDATE] update-available version=${ver}`);
      bootLog(`[UPDATER_VERSION_FOUND] version=${ver}`);
      if (process.platform === 'win32') bootLog(`[WIN_UPDATER_VERSION_RESOLVED] version=${ver}`);
      if (info.files?.length) {
        info.files.forEach(f =>
          bootLog(`[AUTO_UPDATE] download file: ${f.url} (${Math.round((f.size ?? 0) / 1024 / 1024)}MB)`)
        );
      }
      sendUpdaterStatus({ state: 'available', version: ver });
    });
    autoUpdater.on('update-not-available', (info) => {
      const ver = info?.version ?? info?.updateInfo?.version ?? null;
      bootLog(`[AUTO_UPDATE] update-not-available version=${ver}`);
      sendUpdaterStatus({ state: 'uptodate', version: ver });
    });
    autoUpdater.on('download-progress', (p) => {
      const pct = Math.floor(p.percent ?? 0);
      bootLog(`[AUTO_UPDATE] download-progress ${pct}% — ${Math.round((p.bytesPerSecond ?? 0) / 1024)} KB/s`);
      bootLog(`[UPDATER_DOWNLOAD_PROGRESS] percent=${pct}`);
      sendUpdaterStatus({ state: 'downloading', percent: pct });
    });
    autoUpdater.on('update-downloaded', (info) => {
      const ver = info?.version ?? info?.updateInfo?.version ?? null;
      bootLog(`[AUTO_UPDATE] update-downloaded version=${ver}`);
      bootLog(`[UPDATER_RESTARTING] version=${ver}`);
      sendUpdaterStatus({ state: 'restarting', version: ver });
      // Auto-install after a short delay so the UI can show "Restarting…"
      setTimeout(() => {
        bootLog('[AUTO_UPDATE] auto-installing update now');
        triggerInstall().catch(err => bootLog(`[AUTO_UPDATE_INSTALL_ERROR] ${err.message}`));
      }, 3500);
    });
    autoUpdater.on('error', async (err) => {
      const msg = err?.message ?? String(err);
      bootLog(`[AUTO_UPDATE_ERROR] ${msg}`);
      bootLog(`[AUTO_UPDATE_ERROR_STACK] ${err?.stack ?? '(no stack)'}`);

      // ── ShipIt cache corruption recovery (macOS only) ──────────────────────
      // Symptom: "ditt ... com.statflobot.app.ShipIt/...Electron Framework:
      //           No such file or directory" after reinstall.
      // Fix: wipe the stale staging cache and retry once.
      const isShipItError = process.platform === 'darwin' && (
        /ShipIt|\.ShipIt/i.test(msg) ||
        (msg.includes('No such file or directory') && msg.includes('Electron Framework'))
      );

      if (isShipItError) {
        bootLog('[AUTO_UPDATE] ShipIt staging error detected');
        if (!shipItRetried) {
          shipItRetried = true;
          const shipItDir = path.join(os.homedir(), 'Library', 'Caches', 'com.statflobot.app.ShipIt');
          bootLog(`[AUTO_UPDATE] clearing ShipIt cache: ${shipItDir}`);
          try {
            if (fs.existsSync(shipItDir)) {
              fs.rmSync(shipItDir, { recursive: true, force: true });
              bootLog('[AUTO_UPDATE] ShipIt cache cleared — retrying');
            } else {
              bootLog('[AUTO_UPDATE] ShipIt cache dir not found — retrying anyway');
            }
            sendUpdaterStatus({ state: 'checking' });
            await autoUpdater.checkForUpdates();
          } catch (retryErr) {
            bootLog(`[AUTO_UPDATE] ShipIt retry failed: ${retryErr.message}`);
            sendUpdaterStatus({ state: 'error', message: 'Update staging error — please quit and reopen the app, then try again.' });
          }
        } else {
          bootLog('[AUTO_UPDATE] ShipIt retry already attempted — reporting persistent error');
          sendUpdaterStatus({ state: 'error', message: 'Update staging error — please quit and reopen the app, then try again.' });
        }
        return;
      }

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
    bootLog('[LIFECYCLE:activate]');
    bootLog(`[LIFECYCLE] totalWindows=${BrowserWindow.getAllWindows().length} mainWindow=${mainWindow ? 'alive' : 'null'}`);
    if (isInstallingUpdate) {
      bootLog('[UPDATE_INSTALL] install mode active — suppressing window recreation');
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      bootLog('[LIFECYCLE:activate] no windows — calling createWindow()');
      // Quick server health check before loading the renderer
      await new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:3001/api/status`, (res) => {
          bootLog(`[LIFECYCLE:activate] server health = HTTP ${res.statusCode}`);
          resolve();
        });
        req.on('error', (e) => {
          bootLog(`[LIFECYCLE:activate] server health error: ${e.message} — server may need restart`);
          resolve();
        });
        req.setTimeout(1500, () => { req.destroy(); resolve(); });
      });
      await createWindow();
    } else if (mainWindow) {
      bootLog('[LIFECYCLE:activate] window exists — focusing');
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
