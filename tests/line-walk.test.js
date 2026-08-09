/**
 * Multi-line walking: identity and selection.
 *
 * The defect these cover: lines were addressed by position in a list that is
 * re-read after every profile reload. When the line just attempted dropped out
 * of the enabled set, the ones behind it shifted down a slot, the old index ran
 * past the end, and an eligible line was never tried. In the next-action engine
 * that then fell through to logging a DNC on the customer's record.
 */

'use strict';

const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

process.env.LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'statflobot-test-logs-'));

const test   = require('node:test');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statflo.js'), 'utf8');

/**
 * Mirror of the selection rule the engines use: re-read the live list each pass
 * and take the first line whose key has not been attempted.
 */
function walk(livePerPass, totalLines) {
  const attempted = new Set();
  const order = [];
  for (let pass = 0; pass < totalLines * 2 + 2; pass++) {
    const live = livePerPass(pass, attempted);
    const target = live.find(l => !attempted.has(l.key));
    if (!target) break;
    attempted.add(target.key);
    order.push(target.key);
  }
  return order;
}

const A = { key: 'tel:5551110000' };
const B = { key: 'tel:5552220000' };
const C = { key: 'tel:5553330000' };

test('an eligible line is still tried after the previous line disappears', () => {
  // The exact regression: [A,B] → A blocked → reload → only [B] remains.
  const order = walk(pass => (pass === 0 ? [A, B] : [B]), 2);
  assert.deepEqual(order, [A.key, B.key], 'B must be attempted, not reported as "line disappeared"');
});

test('reordering after a reload does not re-attempt or skip a line', () => {
  const order = walk(pass => (pass === 0 ? [A, B] : [B, A]), 2);
  assert.deepEqual(order, [A.key, B.key]);
});

test('every line is attempted exactly once when the list is stable', () => {
  const order = walk(() => [A, B, C], 3);
  assert.deepEqual(order, [A.key, B.key, C.key]);
  assert.equal(new Set(order).size, order.length, 'no line may be attempted twice');
});

test('a list that keeps returning one already-attempted line terminates', () => {
  const order = walk(() => [A], 1);
  assert.deepEqual(order, [A.key], 'must stop rather than re-open the same line forever');
});

test('identically labelled lines are treated as distinct lines', () => {
  const D1 = { key: 'label:send sms#1' };
  const D2 = { key: 'label:send sms#2' };
  const order = walk(() => [D1, D2], 2);
  assert.deepEqual(order, [D1.key, D2.key]);
});

// ── Source-level guards on the engines themselves ───────────────────────────

test('no line engine addresses lines by array position any more', () => {
  for (const banned of ['enabledButtons[', 'freshButtons[', 'initialButtons[', 'retryBtns[']) {
    assert.ok(
      !SRC.includes(banned),
      `src/statflo.js still indexes lines positionally via ${banned} — this strands eligible lines after a reload`,
    );
  }
});

test('all four line engines select by key', () => {
  const engines = [
    'runFirstAttemptShared',
    'handleNextActionMultiLineFallback',
    'runFirstAttemptEveryoneMode',
    'runNextActionEveryoneMode',
  ];
  for (const name of engines) {
    const start = SRC.indexOf(`async function ${name}`);
    assert.ok(start !== -1, `${name} not found`);
    const body = SRC.slice(start, start + 12000);
    assert.match(body, /\.key\b/, `${name} does not appear to select lines by key`);
  }
});

test('DNC is never logged when a detected line went untried', () => {
  const start = SRC.indexOf('async function handleNextActionMultiLineFallback');
  assert.ok(start !== -1);
  const body = SRC.slice(start);
  const guard = body.indexOf('SMS_LINE_INCOMPLETE_NO_DNC');
  const dncWrite = body.indexOf('await logDncActivity(page)');

  assert.ok(guard !== -1, 'the incomplete-attempt guard is missing');
  assert.ok(dncWrite !== -1, 'expected a DNC write in this engine');
  assert.ok(
    guard < dncWrite,
    'the untried-line guard must run BEFORE logDncActivity — otherwise a client with an eligible line can be marked Do Not Contact',
  );

  // The guard counts lines actually OPENED, not lines merely selected — a click
  // that threw on a stale handle used to count, which let two failed clicks
  // satisfy "attempted === detected" and release the DNC write.
  assert.match(
    body.slice(guard - 500, guard),
    /enteredKeys\.size < initialTotalLines/,
    'the guard must compare successfully-opened lines against the number detected',
  );
});
