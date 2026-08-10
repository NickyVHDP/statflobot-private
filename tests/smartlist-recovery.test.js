/**
 * Smart Lists recovery after a confirmed 2nd/3rd Attempt outcome.
 *
 * Production regression: a Windows run confirmed its second send, then failed
 * to reopen Smart Lists from the account profile. The restore exception escaped
 * into the customer catch, changing the confirmed send into a failed customer;
 * a later failed restore was swallowed and zero cards were called exhaustion.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const STATFLO_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statflo.js'), 'utf8');
const MAIN_SRC    = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

function functionBody(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = nextName ? source.indexOf(`async function ${nextName}`, start + 1) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

test('next-action navigation has a trusted direct-route fallback', () => {
  const body = functionBody(STATFLO_SRC, 'navigateToSmartList', 'openSmartListClient');
  assert.match(body, /new URL\('\/t\/conversations', config\.accountsUrl\)/);
  assert.match(body, /page\.goto\(conversationsUrl/);
  assert.match(body, /CONVERSATIONS_NAV_ROUTE_FALLBACK_SUCCESS/);
});

test('a confirmed outcome is counted before Smart Lists restoration', () => {
  const body = functionBody(STATFLO_SRC, 'runNextActionList');
  const processed = body.indexOf('stats.processed++');
  const messaged  = body.indexOf("if (reportOutcome === 'messaged') stats.messaged++");
  const finalLog  = body.indexOf('[CLIENT_FINAL_DECISION]');
  const guardedRestore = body.indexOf("stats._runError = 'smartlist-recovery-failed-after-outcome'");

  assert.ok(processed !== -1 && messaged !== -1 && finalLog !== -1 && guardedRestore !== -1);
  assert.ok(processed < guardedRestore, 'processed outcome must be final before restore can fail');
  assert.ok(messaged < guardedRestore, 'confirmed send count must be final before restore can fail');
  assert.ok(finalLog < guardedRestore, 'customer decision must be logged before run-level recovery handling');
});

test('processed-client memory is written before post-outcome recovery', () => {
  const body = functionBody(STATFLO_SRC, 'runNextActionList');
  const remembered = body.indexOf('runConfig.processedClients?.add(cardClientName)');
  const guardedRestore = body.indexOf("stats._runError = 'smartlist-recovery-failed-after-outcome'");
  assert.ok(remembered !== -1 && remembered < guardedRestore);
});

test('a restarted next-action run still checks for a duplicate before Send', () => {
  const body = functionBody(STATFLO_SRC, 'runNextActionAttemptShared', 'processNextActionClient');
  const duplicateCheck = body.indexOf('await checkForDuplicateMessage(page, listConfig.text)');
  const sendClick = body.indexOf('await clickSend(page)');
  assert.ok(duplicateCheck !== -1, 'direct-message flow lost its cross-run duplicate check');
  assert.ok(sendClick !== -1 && duplicateCheck < sendClick, 'duplicate check must happen before clicking Send');
});

test('recovery failure before exhaustion is not swallowed as an empty list', () => {
  const body = functionBody(STATFLO_SRC, 'runNextActionList');
  assert.match(body, /smartlist-recovery-failed-before-exhaustion/);
  assert.doesNotMatch(body, /RESTORE_PRE_EXHAUSTION_WARN/);
  assert.match(body, /RUN_ABORT_NAVIGATION_RECOVERY_FAILED/);
});

test('a run-level navigation failure exits nonzero without inventing a failed customer', () => {
  assert.match(MAIN_SRC, /const runLevelFailed = Boolean\(stats\._runError\)/);
  assert.match(MAIN_SRC, /runLevelFailed \? 'failed'/);
  assert.match(MAIN_SRC, /process\.exit\(allFailed \|\| runLevelFailed \? 1 : 0\)/);
});
