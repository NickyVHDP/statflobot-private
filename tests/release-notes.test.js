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

test('the maintenance release stays silent while prior customer guidance is preserved', () => {
  assert.doesNotMatch(notes, /'1\.5\.84':/,
    'background recovery fixes must not create a new-feature launch popup');
  assert.match(notes, /'1\.5\.80':[\s\S]*customerFacing:\s*true/);
  assert.match(notes, /Private help for a specific run/i);
  assert.match(notes, /Reply inside StatfloBot/i);
  assert.match(notes, /'1\.5\.79':[\s\S]*customerFacing:\s*true/);
  assert.match(notes, /Clear skip reasons and safer rerun guidance/i);
  assert.match(notes, /No-send runs are no longer marked healthy/i);
  assert.match(notes, /'1\.5\.75':[\s\S]*customerFacing:\s*true/);
  assert.match(notes, /More reliable multi-line runs and support diagnostics/i);
  assert.match(notes, /Remaining phone lines stay available/i);
  assert.match(notes, /Private support diagnostics for the owner/i);
});

test('the next update shows the creator reminder once for every account type', async t => {
  const { pathToFileURL } = require('node:url');
  const release = await import(pathToFileURL(path.join(root, 'ui/client/src/lib/releaseNotes.js')).href);
  const oldStorage = global.localStorage;
  const values = new Map([[release.releaseNotesStorageKey('1.5.85'), '1']]);
  global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => { global.localStorage = oldStorage; });
  assert.equal(desktopPackage.version, '1.5.86');
  for (const context of [{}, { isLifetime: false }, { isLifetime: true }, { isAdmin: true }]) {
    const entry = release.getReleaseNotes(desktopPackage.version, context);
    assert.ok(entry);
    assert.match(entry.intro, /Hey everyone!/);
    assert.match(entry.intro, /stack some vaps ;\)/);
    assert.equal(entry.changes.length, 1);
    assert.equal(entry.changes[0].title, 'Tell me what you saw');
    assert.doesNotMatch(JSON.stringify(entry), /right version|recorded version|version installed|marked unknown/i);
    assert.equal(release.shouldShowReleaseNotes(desktopPackage.version, context), true);
  }
  release.markReleaseNotesSeen(desktopPackage.version);
  assert.equal(release.shouldShowReleaseNotes(desktopPackage.version), false);
  assert.ok(release.getReleaseNotes(desktopPackage.version), 'the reminder can still be reopened from Account');
  assert.equal(release.shouldShowReleaseNotes('1.5.84'), false);
});

test('release notes are shown once per version and maintenance-only releases stay silent', () => {
  assert.match(notes, /statflobot_whats_new_seen_v\$\{version\}/);
  assert.match(notes, /release\?\.customerFacing/);
  assert.match(notes, /localStorage\.getItem/);
  assert.match(notes, /localStorage\.setItem/);
  assert.match(app, /shouldShowReleaseNotes\(version, context\)/);
  assert.match(account, /getReleaseNotes\(appVersion, \{/);
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
