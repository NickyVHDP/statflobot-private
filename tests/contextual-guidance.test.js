'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const app = read('ui', 'client', 'src', 'App.jsx');
const control = read('ui', 'client', 'src', 'components', 'ControlCard.jsx');
const referral = read('ui', 'client', 'src', 'components', 'ReferralPanel.jsx');
const account = read('ui', 'client', 'src', 'screens', 'AccountScreen.jsx');
const modal = read('ui', 'client', 'src', 'components', 'ContextualGuideModal.jsx');
const guides = read('ui', 'client', 'src', 'lib', 'contextualGuides.js');
const releaseNotes = read('ui', 'client', 'src', 'lib', 'releaseNotes.js');
const webReferral = read('monetization', 'web', 'components', 'ReferralPanel.tsx');
const landing = read('monetization', 'web', 'app', 'page.tsx');

test('referral guidance clearly makes participation optional', () => {
  assert.match(guides, /Referral Rewards are completely optional/);
  assert.match(guides, /never need to refer anyone to keep your Lifetime access/);
  assert.match(referral, /Completely optional/);
  assert.match(referral, /How Referral Rewards works/);
  assert.match(webReferral, /Completely optional/);
  assert.match(webReferral, /How Referral Rewards works/);
  assert.match(landing, /Referrals are never required to keep Lifetime access or features/);
});

test('lifetime members can reopen an accurate plan explanation', () => {
  assert.match(guides, /one-time StatfloBot purchase with no monthly renewal/);
  assert.match(guides, /Future StatfloBot app updates are included/);
  assert.match(guides, /final and non-refundable except where required by law/);
  assert.match(account, /What Lifetime means/);
  assert.match(account, /LIFETIME_GUIDE/);
  assert.ok((account.match(/What Lifetime means/g) ?? []).length >= 2, 'both lifetime account shapes must expose the guide');
});

test('Everyone Mode uses a versioned first-use guide and remains reopenable', () => {
  assert.match(guides, /statflobot_guide_\$\{id\}_seen_v\$\{version/);
  assert.match(app, /shouldShowContextualGuide\('everyone-mode'\)/);
  assert.match(app, /getEveryoneModeGuide\(everyoneModeGuide\.mode\)/);
  assert.match(control, /How Everyone Mode works/);
  assert.match(guides, /One client may receive more than one message/);
  assert.match(guides, /restricts the line walk to reduce duplicate-send risk/);
  assert.match(app, /remaining safely identifiable, eligible SMS lines/);
  assert.match(app, /aria-labelledby="everyone-mode-confirm-title"/);
});

test('the shared guide modal is accessible and dismissible', () => {
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-labelledby/);
  assert.match(modal, /aria-describedby/);
  assert.match(modal, /event\.key === 'Escape'/);
  assert.match(modal, /confirmRef\.current\?\.focus/);
});

test('the next customer update announces the guidance only to lifetime members', () => {
  assert.match(releaseNotes, /'1\.5\.67':[\s\S]*audience:\s*'lifetime'/);
  assert.match(releaseNotes, /'1\.5\.71':[\s\S]*customerFacing:\s*true/);
  assert.match(releaseNotes, /Referral Rewards are clearly optional/);
  assert.match(releaseNotes, /A safer first step into Everyone Mode/);
  assert.match(releaseNotes, /release\?\.audience === 'lifetime' && !context\.isLifetime/);
  assert.match(app, /shouldShowReleaseNotes\(version, context\)/);
});
