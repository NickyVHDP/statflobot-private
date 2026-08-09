/**
 * The run loop's contract with processClient().
 *
 * Regression cover for the stall that shipped before: 'cooldown-skipped'
 * matched no case in main.js's switch, so it fell through — nothing counted the
 * client and clientIndex never advanced, and the loop re-opened the same client
 * indefinitely.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const { normalizeClientOutcome, KNOWN_RESULTS } = require('../src/runOutcome');

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const STATFLO_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statflo.js'), 'utf8');

test('normalizeClientOutcome accepts a bare string verdict', () => {
  assert.deepEqual(normalizeClientOutcome('messaged'), { result: 'messaged', reason: null });
});

test('normalizeClientOutcome keeps the reason from an object verdict', () => {
  assert.deepEqual(
    normalizeClientOutcome({ result: 'skipped', reason: 'SKIPPED_ALL_LINES_DNC' }),
    { result: 'skipped', reason: 'SKIPPED_ALL_LINES_DNC' },
  );
});

test('normalizeClientOutcome defaults a missing reason to null', () => {
  assert.deepEqual(normalizeClientOutcome({ result: 'failed' }), { result: 'failed', reason: null });
});

test('normalizeClientOutcome treats a missing return as a failure, never a send', () => {
  for (const empty of [null, undefined, {}, 42, { reason: 'x' }]) {
    const outcome = normalizeClientOutcome(empty);
    assert.equal(outcome.result, 'failed', `${JSON.stringify(empty)} must not be treated as a send`);
    assert.equal(outcome.reason, 'no-result-returned');
  }
});

test('the run loop handles every verdict processClient can produce', () => {
  // Collect the literal verdicts statflo.js actually returns.
  const produced = new Set();
  for (const m of STATFLO_SRC.matchAll(/return\s+'([a-z_-]+)'/g))            produced.add(m[1]);
  for (const m of STATFLO_SRC.matchAll(/return\s*\{\s*result:\s*'([a-z_-]+)'/g)) produced.add(m[1]);

  // Verdicts the loop understands: switch cases plus the pre-switch break-out.
  const handled = new Set();
  for (const m of MAIN_SRC.matchAll(/case\s+'([a-z_-]+)'\s*:/g)) handled.add(m[1]);
  if (/result === 'browser_closed'/.test(MAIN_SRC)) handled.add('browser_closed');

  // Only verdicts that reach the run loop matter; statflo.js also returns
  // internal signal strings from helpers (e.g. 'holdOn', 'topPremade').
  const loopVerdicts = [...produced].filter(v => KNOWN_RESULTS.includes(v));

  assert.ok(loopVerdicts.length >= 5, `expected to find the real verdicts, found ${JSON.stringify(loopVerdicts)}`);

  for (const verdict of loopVerdicts) {
    assert.ok(
      handled.has(verdict),
      `main.js has no case for '${verdict}' — it would fall through without advancing clientIndex`,
    );
  }
});

test('the run loop has a default branch so an unknown verdict cannot stall it', () => {
  assert.match(
    MAIN_SRC,
    /default:[\s\S]{0,600}clientIndex\+\+/,
    'main.js switch needs a default branch that advances clientIndex',
  );
});

test('every skip branch in the run loop advances past the client', () => {
  // Isolate the switch body and assert the skip cases increment clientIndex.
  const switchStart = MAIN_SRC.indexOf('switch (result)');
  assert.ok(switchStart !== -1, 'could not locate the run loop switch');
  const body = MAIN_SRC.slice(switchStart, switchStart + 2500);

  const skipBlock = body.slice(body.indexOf("case 'cooldown-skipped'"), body.indexOf("case 'duplicate-skipped'"));
  assert.ok(skipBlock.includes('clientIndex++'), "the skipped branch must advance clientIndex");
  assert.ok(skipBlock.includes('stats.skipped++'), 'the skipped branch must count the skip');
});
