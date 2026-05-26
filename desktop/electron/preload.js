'use strict';

// shell is NOT available in preload scripts in Electron 29+ — it was removed
// from the renderer/preload context. Use IPC to ask the main process instead.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Safe API exposed to the renderer (React app).
 * Nothing sensitive leaks through — only explicit, named operations.
 */
contextBridge.exposeInMainWorld('electron', {
  /** Open a URL in the system default browser (for Stripe portal / checkout). */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  /** Embedded automation browser (v1.3.0) */
  embeddedBrowser: {
    setBounds:            (bounds) => ipcRenderer.send('embedded-browser:set-bounds', bounds),
    hide:                 ()       => ipcRenderer.send('embedded-browser:hide'),
    getStatus:            ()       => ipcRenderer.invoke('embedded-browser:get-status'),
    onStatus:             (cb)     => ipcRenderer.on('embedded-browser:status', (_e, data) => cb(data)),
    removeStatusListener: ()       => ipcRenderer.removeAllListeners('embedded-browser:status'),
    /** Send raw renderer rect measurements to main-process boot log for diagnosis */
    sendDebug:            (data)   => ipcRenderer.send('embedded-browser:debug', data),
    /** Notify main process when a run starts (active=true) or ends (active=false, result='complete'|'stopped'|'error') */
    notifyRunActive:      (active, result) => ipcRenderer.send('run:active-changed', { active, result }),
    /** Main process triggers this when the window is resized/maximized/fullscreen so renderer reapplies bounds */
    onBoundsRefresh:             (cb) => ipcRenderer.on('embedded-browser:request-bounds-refresh', (_e) => cb()),
    removeBoundsRefreshListener: ()   => ipcRenderer.removeAllListeners('embedded-browser:request-bounds-refresh'),
  },

  /** Read a run log file (path must be inside userData) */
  readRunLog: (filePath) => ipcRenderer.invoke('run-log:read', filePath),

  /** App metadata */
  getVersion:   () => ipcRenderer.invoke('app:version'),
  getPlatform:  () => process.platform,
  isElectron:   true,

  /** Window controls */
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  /** Listen for server-ready signal from main process */
  onServerReady: (cb) => ipcRenderer.on('server:ready', cb),

  /** Notify main process that auth state changed (for native menu updates) */
  notifyAuthChange: (isSignedIn) => ipcRenderer.send('auth:changed', isSignedIn),

  /** Auto-update controls */
  checkForUpdates:         ()   => ipcRenderer.invoke('updater:check'),
  installUpdate:           ()   => ipcRenderer.invoke('updater:install'),
  onUpdateStatus:          (cb) => ipcRenderer.on('updater:status', (_e, data) => cb(data)),
  removeUpdateStatusListener: () => ipcRenderer.removeAllListeners('updater:status'),

  /** Backend restart — stops and restarts the server-manager child process in-place */
  restartBackend: () => ipcRenderer.invoke('backend:restart'),

  /** Get info about what process (if any) owns port 3001 */
  getPortStatus: () => ipcRenderer.invoke('backend:port-status'),

  /** Kill the stale process on port 3001 (if safe) then restart the backend */
  killStaleAndRestart: () => ipcRenderer.invoke('backend:kill-stale-and-restart'),
});
