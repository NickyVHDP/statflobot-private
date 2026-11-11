'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const completion = fs.readFileSync(path.join(root, 'ui/client/src/components/CompletionModal.jsx'), 'utf8');
const app = fs.readFileSync(path.join(root, 'ui/client/src/App.jsx'), 'utf8');
const support = fs.readFileSync(path.join(root, 'ui/client/src/screens/SupportScreen.jsx'), 'utf8');

test('the newest run prompts for a report only when it actually needs attention', () => {
  assert.match(completion, /status === 'error' \|\| Number\(stats\?\.failed \?\? 0\) > 0/);
  assert.match(completion, /Would you like to send this run to support\?/);
  assert.match(completion, /Review &amp; Send Report/);
  assert.doesNotMatch(completion, /stats\?\.dnc.*hasFailures|stats\?\.skipped.*hasFailures/);
});

test('the prompt opens the private latest-run report flow with useful prefill', () => {
  assert.match(app, /attachLatestLog=1&failedRunPrompt=1&runStatus=/);
  assert.match(app, /completed_with_errors/);
  assert.match(support, /StatfloBot failed run report/);
  assert.match(support, /StatfloBot run completed with errors/);
  assert.match(support, /Technical details stay private/);
});

test('customers can dismiss the prompt without sending or exposing diagnostics', () => {
  assert.match(completion, /Not now — start a new run/);
  assert.match(completion, /Technical details stay hidden and are attached securely/);
  assert.doesNotMatch(completion, /raw_log_sanitized|logContent/);
});

test('in-app failed and historical run reports invite an optional customer explanation', async () => {
  const { pathToFileURL } = require('node:url');
  const { supportReportDescription } = await import(pathToFileURL(path.join(root, 'ui/client/src/lib/supportReportDetails.js')).href);
  assert.equal(supportReportDescription(' Send never lit up. ', true, 'failed'), 'Send never lit up.');
  assert.match(supportReportDescription('', true, 'failed'), /No additional explanation was provided/);
  assert.match(supportReportDescription('', true, 'completed_with_errors'), /one or more clients failed/);
  assert.equal(supportReportDescription('', false, null), '', 'manual reports still require an explanation');
  assert.match(support, /const isRunReport = attachLatestLog \|\| attachHistoryRun/);
  assert.match(support, /description:\s*supportReportDescription\(description, isRunReport, logStatus\)/);
  assert.match(support, /if \(!isRunReport && !description\.trim\(\)\)/);
  assert.match(support, /htmlFor="support-description"/);
  assert.match(support, /id="support-description"/);
  assert.match(support, /<span>\(optional\)<\/span>/);
  assert.match(support, /value=\{description\}/);
  assert.match(support, /setDescription\(e\.target\.value\)/);
  assert.doesNotMatch(support, /setDescription\('Please review|setDescription\(\s*partialFailure/);
});
