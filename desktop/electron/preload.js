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
});
