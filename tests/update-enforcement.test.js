'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const accountRoute = read('monetization', 'web', 'app', 'api', 'account', 'route.ts');
const server = read('ui', 'server', 'index.js');
const main = read('desktop', 'electron', 'main.js');
const preload = read('desktop', 'electron', 'preload.js');
const app = read('ui', 'client', 'src', 'App.jsx');
const licenseClient = read('monetization', 'local-gate', 'license-client.js');

test('cloud account gate blocks legacy and outdated desktop builds', () => {
  assert.match(accountRoute, /getPublicAppVersion\(\)/);
  assert.match(accountRoute, /x-statflobot-version/);
  assert.match(accountRoute, /comparison === null \|\| comparison < 0/);
  assert.match(accountRoute, /reason: 'update-required'/);
  assert.match(accountRoute, /status: 426/);
});

test('every current desktop account verification identifies its release version', () => {
  const headerCount = server.match(/'X-StatfloBot-Version': SERVER_VERSION/g)?.length ?? 0;
  assert.ok(headerCount >= 2, 'run access checks and account refreshes must both identify the desktop release');
  assert.match(server, /res\.status === 426[\s\S]*reason: 'update-required'/);
  assert.match(licenseClient, /desktop\/package\.json/);
  assert.doesNotMatch(licenseClient, /\.\.\/\.\.\/package\.json/);
});

test('renderer checks the signed updater feed before subscription and identity gates', () => {
  assert.match(main, /updater:require-current/);
  assert.match(main, /RUN_BLOCKED_UPDATE_REQUIRED/);
  assert.match(preload, /requireCurrentVersion/);
  const updateGate = app.indexOf('window.electron?.requireCurrentVersion');
  const accountGate = app.indexOf('const fresh = await refreshAccount()', updateGate);
  const identityGate = app.indexOf('if (!lockedStatfloIdentity)', updateGate);
  assert.ok(updateGate > -1 && accountGate > updateGate && identityGate > accountGate);
});
