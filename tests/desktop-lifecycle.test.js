const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute the shipped startup/lock/lifecycle code, without starting Electron,
// writing logs, spawning children, or contacting an update server.
const source = fs.readFileSync(path.join(__dirname, '../desktop/electron/main.js'), 'utf8');
const startup = source.slice(0, source.indexOf('function resolveRendererUrl()'));
function boot(platform, ownsLock) {
  const app = new EventEmitter();
  const state = { quits: 0, stops: 0, timers: 0 };
  app.setName = () => {};
  app.requestSingleInstanceLock = () => ownsLock;
  app.quit = () => { state.quits++; app.emit('before-quit'); app.emit('will-quit'); app.emit('quit', {}, 0); };
  const electron = { app, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {} };
  const context = {
    __dirname: '/fixture/desktop/electron',
    process: { platform, env: {}, pid: 123, execPath: '/fixture/app', version: 'fixture', stdout: { write() {} }, on() {}, exit() { throw new Error('Unexpected forced exit'); } },
    setTimeout() { state.timers++; return { unref() {} }; },
    require(name) {
      if (name === 'fs') return { mkdirSync() {}, appendFileSync() {} };
      if (name === 'electron') return electron;
      if (name === './server-manager') return { stop() { state.stops++; } };
      if (name === 'electron-updater') return { autoUpdater: { setFeedURL() {} } };
      return require(name);
    },
  };
  vm.runInNewContext(`(function () { ${startup}\n})();`, context);
  return { app, state };
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: duplicate/update relaunch exits without an uninitialized lifecycle variable`, () => {
    const { state } = boot(platform, false);
    assert.equal(state.quits, 1);
    assert.equal(state.stops, 1);
    assert.equal(state.timers, platform === 'win32' ? 1 : 0);
  });
  test(`${platform}: primary instance stays open and later quits cleanly`, () => {
    const { app, state } = boot(platform, true);
    assert.equal(state.quits, 0);
    assert.doesNotThrow(() => app.emit('window-all-closed'));
    if (platform === 'darwin') app.quit();
    assert.equal(state.quits, 1);
  });
}
