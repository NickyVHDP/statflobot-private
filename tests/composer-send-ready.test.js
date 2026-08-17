'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STATFLO_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statflo.js'), 'utf8');

test('composer recovery helper emits richer typing signals before giving up on Send', () => {
  assert.match(STATFLO_SRC, /async function refreshComposerInputSignals/);
  assert.match(STATFLO_SRC, /new KeyboardEvent\('keydown'/);
  assert.match(STATFLO_SRC, /new KeyboardEvent\('keyup'/);
  assert.match(STATFLO_SRC, /fireInput\('beforeinput', ch\)/);
  assert.match(STATFLO_SRC, /fireInput\('input', ch\)/);
});

test('next-action shared flow retries composer signals before classifying an uncertain blocked Send state', () => {
  const refreshIndex = STATFLO_SRC.indexOf('const recoveredSendReady = await retrySendReadyAfterComposerRefresh(page, lineNum, listConfig.text);');
  const uncertainIndex = STATFLO_SRC.indexOf('[SMS_SEND_BLOCKED_SELECTOR_UNCERTAIN]');
  assert.ok(refreshIndex !== -1, 'expected a send-ready recovery retry in the next-action shared flow');
  assert.ok(uncertainIndex !== -1 && refreshIndex < uncertainIndex, 'send-ready recovery must happen before uncertain blocked classification');
});

test('composer refresh fails closed if the final text does not match exactly', () => {
  assert.match(STATFLO_SRC, /COMPOSER_SIGNAL_REFRESH_MISMATCH/);
  assert.match(STATFLO_SRC, /finalValue !== String\(messageText\)/);
  assert.match(STATFLO_SRC, /composer signal refresh failed or changed message text/);
});

test('everyone mode retries composer signals before classifying disabled Send as cooldown', () => {
  const everyoneRefreshIndex = STATFLO_SRC.indexOf('sendReady = await retrySendReadyAfterComposerRefresh(page, lineIdx + 1, listConfig.text);');
  const everyoneCooldownIndex = STATFLO_SRC.indexOf('detectSmsBlockedOrCooldownState(page, `everyone-send-line${lineIdx + 1}`)');
  assert.ok(everyoneRefreshIndex !== -1, 'expected Everyone Mode send-ready recovery retry');
  assert.ok(everyoneCooldownIndex !== -1 && everyoneRefreshIndex < everyoneCooldownIndex, 'Everyone Mode must retry composer signals before cooldown classification');
});

test('direct smart-list composer skips safely instead of clicking a disabled Send button', () => {
  const directRefreshIndex = STATFLO_SRC.indexOf('sendReady = await retrySendReadyAfterComposerRefresh(page, rowIndex + 1, listConfig.text, matchedSelector);');
  const directSkipIndex = STATFLO_SRC.indexOf("throw new HoldOnBlockError('SEND_DISABLED_AFTER_COMPOSER_REFRESH');");
  const directClickIndex = STATFLO_SRC.indexOf('await clickSend(page);', directSkipIndex);
  assert.ok(directRefreshIndex !== -1, 'expected direct composer send-ready recovery retry');
  assert.ok(directSkipIndex !== -1 && directRefreshIndex < directSkipIndex, 'direct composer should skip safely only after recovery fails');
  assert.ok(directClickIndex !== -1 && directSkipIndex < directClickIndex, 'disabled-send guard must appear before direct clickSend');
});
