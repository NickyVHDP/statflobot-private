'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const notes = fs.readFileSync(path.join(root, 'ui/client/src/lib/releaseNotes.js'), 'utf8');
const modal = fs.readFileSync(path.join(root, 'ui/client/src/components/WhatsNewModal.jsx'), 'utf8');
const app = fs.readFileSync(path.join(root, 'ui/client/src/App.jsx'), 'utf8');
const account = fs.readFileSync(path.join(root, 'ui/client/src/screens/AccountScreen.jsx'), 'utf8');
const desktopPackage = require('../desktop/package.json');

test('the current desktop version may stay silent when it has no customer-facing changes', () => {
  const versionPattern = new RegExp(`'${desktopPackage.version.replace(/\./g, '\\.')}'`);

  if (versionPattern.test(notes)) {
    assert.match(notes, /customerFacing:\s*(?:true|false)/);
  }
  assert.match(notes, /if \(!release\) return false/);
});

test('automatic referral payouts are explained in the current customer release', () => {
  assert.equal(desktopPackage.version, '1.5.66');
  assert.match(notes, /'1\.5\.66':[\s\S]*customerFacing:\s*true/);
  assert.match(notes, /automatic bank deposit/i);
  assert.match(notes, /30-day qualification period/i);
  assert.match(notes, /Account → Referral Rewards/);
});

test('release notes are shown once per version and maintenance-only releases stay silent', () => {
  assert.match(notes, /statflobot_whats_new_seen_v\$\{version\}/);
  assert.match(notes, /release\?\.customerFacing/);
  assert.match(notes, /localStorage\.getItem/);
  assert.match(notes, /localStorage\.setItem/);
  assert.match(app, /shouldShowReleaseNotes\(version\)/);
  assert.match(account, /getReleaseNotes\(appVersion\)/);
  assert.match(account, /onShowWhatsNew && hasWhatsNew/);
});

test('the paid-only popup presents changes without redundant audience labels', () => {
  assert.doesNotMatch(modal, /For everyone|For paying users|For new users|AUDIENCES/);
  assert.match(modal, /Account → App &amp; Updates/);
  assert.match(account, /View What’s New in v/);
  assert.match(app, /onShowWhatsNew=\{\(\) => openWhatsNew\(true\)\}/);
});

test('first-time onboarding is shown before release notes', () => {
  const welcomeDecision = app.indexOf('shouldShowWelcome()');
  const releaseDecision = app.indexOf('openWhatsNew();', welcomeDecision);
  assert.ok(welcomeDecision > -1 && releaseDecision > welcomeDecision);
  assert.match(app, /setTimeout\(\(\) => openWhatsNew\(\), 250\)/);
});
