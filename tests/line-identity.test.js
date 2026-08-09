/**
 * Exercises keySmsLineHandles() itself, against DOM shapes that previously
 * produced unsafe behaviour. The earlier tests used already-stable synthetic
 * keys and never called the extractor, so they could not catch a key scheme
 * that collapses two distinct lines into one identity.
 */

'use strict';

const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

process.env.LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'statflobot-test-logs-'));

const test   = require('node:test');
const assert = require('node:assert/strict');

const { keySmsLineHandles, hasAmbiguousLineKeys } = require('../src/statflo');

/**
 * Stand-in for a Playwright element handle. `attrs` and `text` describe the
 * button; `rowText` is the surrounding row the extractor also inspects.
 */
function fakeHandle({ attrs = {}, text = '', value, rowText = null }) {
  const el = {
    getAttribute: name => (name in attrs ? attrs[name] : null),
    textContent: text,
    value,
    closest: selector => {
      if (selector === '[data-phone]') return attrs['data-phone'] ? el : null;
      if (rowText === null) return null;
      return { textContent: rowText, getAttribute: () => null };
    },
  };
  return { evaluate: async fn => fn(el) };
}

test('a phone number in the button text produces a stable tel: key', async () => {
  const lines = await keySmsLineHandles([
    fakeHandle({ text: 'Send SMS (555) 111-0000' }),
    fakeHandle({ text: 'Send SMS 555.222.0000' }),
  ]);
  assert.deepEqual(lines.map(l => l.key), ['tel:5551110000', 'tel:5552220000']);
  assert.equal(hasAmbiguousLineKeys(lines), false);
});

test('a generic aria-label does not mask a number in the text', async () => {
  // The regression: preferring aria-label made both of these 'label:send sms',
  // and once keys collide the positional tie-break is unstable across a reorder
  // — which in Everyone Mode could re-send to a line already messaged.
  const lines = await keySmsLineHandles([
    fakeHandle({ attrs: { 'aria-label': 'Send SMS' }, text: '+1 555 111 0000' }),
    fakeHandle({ attrs: { 'aria-label': 'Send SMS' }, text: '+1 555 222 0000' }),
  ]);
  assert.deepEqual(lines.map(l => l.key), ['tel:5551110000', 'tel:5552220000']);
  assert.equal(hasAmbiguousLineKeys(lines), false, 'distinct numbers must not be flagged ambiguous');
});

test('a number on the surrounding row is found when the button carries none', async () => {
  const lines = await keySmsLineHandles([
    fakeHandle({ attrs: { 'aria-label': 'Send SMS' }, text: 'Text', rowText: 'Mobile (555) 333-0000 Send SMS' }),
  ]);
  assert.deepEqual(lines.map(l => l.key), ['tel:5553330000']);
});

test('formatting differences resolve to the same key', async () => {
  const a = await keySmsLineHandles([fakeHandle({ text: '(555) 444-0000' })]);
  const b = await keySmsLineHandles([fakeHandle({ text: '+1 555-444-0000' })]);
  assert.equal(a[0].key, b[0].key, 'the same number formatted differently must key identically');
});

test('a key survives DOM reordering', async () => {
  const first  = await keySmsLineHandles([
    fakeHandle({ text: 'Send SMS (555) 111-0000' }),
    fakeHandle({ text: 'Send SMS (555) 222-0000' }),
  ]);
  const reordered = await keySmsLineHandles([
    fakeHandle({ text: 'Send SMS (555) 222-0000' }),
    fakeHandle({ text: 'Send SMS (555) 111-0000' }),
  ]);
  assert.deepEqual([...first.map(l => l.key)].sort(), [...reordered.map(l => l.key)].sort());
  assert.equal(reordered[0].key, first[1].key, 'the moved line keeps its identity');
});

test('genuinely indistinguishable lines are flagged ambiguous', async () => {
  const lines = await keySmsLineHandles([
    fakeHandle({ attrs: { 'aria-label': 'Send SMS' }, text: 'Send SMS' }),
    fakeHandle({ attrs: { 'aria-label': 'Send SMS' }, text: 'Send SMS' }),
  ]);
  assert.equal(hasAmbiguousLineKeys(lines), true, 'identical buttons must be reported as ambiguous');
  assert.equal(lines[1].ambiguous, true, 'the colliding occurrence must be flagged');
});

test('an unlabelled button never claims a confident identity', async () => {
  const lines = await keySmsLineHandles([fakeHandle({}), fakeHandle({})]);
  assert.match(lines[0].key, /^pos:/);
  assert.equal(hasAmbiguousLineKeys(lines), true);
});

// ── Guards on how ambiguity is used ─────────────────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'statflo.js'), 'utf8');

test('Everyone Mode only walks multiple lines with phone-number identity', () => {
  for (const engine of ['runFirstAttemptEveryoneMode', 'runNextActionEveryoneMode']) {
    const start = SRC.indexOf(`async function ${engine}`);
    assert.ok(start !== -1, `${engine} not found`);
    const body = SRC.slice(start, start + 6000);
    assert.match(
      body,
      /!hasLineBoundIdentity\(/,
      `${engine} must require line-bound (tel:) identity — a unique but positional label like "Line 2" can resolve to the line already messaged after a reorder`,
    );
    assert.match(
      body,
      /slice\(0,\s*1\)/,
      `${engine} must restrict itself to a single line when identity is not line-bound — otherwise a reorder can text one customer twice`,
    );
  }
});

test('hasLineBoundIdentity accepts only phone-number keys', () => {
  const { hasLineBoundIdentity } = require('../src/statflo');
  assert.equal(hasLineBoundIdentity([{ key: 'tel:5551110000', ambiguous: false },
                                     { key: 'tel:5552220000', ambiguous: false }]), true);
  assert.equal(hasLineBoundIdentity([{ key: 'tel:5551110000', ambiguous: false },
                                     { key: 'label:line 2',   ambiguous: false }]), false,
    'a positional-looking label is not a line-bound identity');
  assert.equal(hasLineBoundIdentity([{ key: 'pos:0', ambiguous: true }]), false);
  assert.equal(hasLineBoundIdentity([]), false, 'an empty set is not a walkable identity set');
});

test('every re-key in the fallback engine carries ambiguity forward', () => {
  const start = SRC.indexOf('async function handleNextActionMultiLineFallback');
  const body  = SRC.slice(start, SRC.indexOf('\nasync function', start + 10));
  const rekeys = [...body.matchAll(/enabledLines = await keySmsLineHandles\([^\n]*\n/g)];
  assert.ok(rekeys.length >= 5, `expected several re-key sites, found ${rekeys.length}`);

  for (const m of rekeys) {
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 700);
    assert.match(
      after,
      /lineIdentityAmbiguous = lineIdentityAmbiguous \|\| hasAmbiguousLineKeys/,
      'a re-key that does not carry ambiguity forward lets colliding keys count one physical line twice and release the DNC write',
    );
  }
});

test('a line counts as tried only on positive evidence it opened', () => {
  const start = SRC.indexOf('async function handleNextActionMultiLineFallback');
  const body  = SRC.slice(start, SRC.indexOf('\nasync function', start + 10));

  const adds = [...body.matchAll(/enteredKeys\.add\(/g)];
  assert.equal(adds.length, 1, 'enteredKeys should be added to in exactly one place');

  const context = body.slice(Math.max(0, adds[0].index - 400), adds[0].index);
  assert.match(
    context,
    /composerResult\.found \|\| composerResult\.blockedByRecentContact/,
    'a dispatched click is not evidence the line opened — require a composer or a block verdict',
  );
  assert.doesNotMatch(context.slice(-200), /clickOk = true/,
    'enteredKeys must no longer be tied to the click succeeding');
});

test('the DNC guard counts lines actually opened, not lines merely selected', () => {
  const start = SRC.indexOf('async function handleNextActionMultiLineFallback');
  const body  = SRC.slice(start);
  const guard = body.indexOf('SMS_LINE_INCOMPLETE_NO_DNC');
  assert.ok(guard !== -1);

  const condition = body.slice(guard - 500, guard);
  assert.match(condition, /enteredKeys\.size < initialTotalLines/,
    'a click that threw on a stale handle must not count as a line attempted');
  assert.match(condition, /lineIdentityAmbiguous/,
    'tallies built from colliding keys must not authorise a DNC write');
  // What counts as "opened" is asserted separately, in
  // 'a line counts as tried only on positive evidence it opened'.
});
