/**
 * DNC vs "recently messaged" classification.
 *
 * The rule under test: a line blocked for a business reason is a SKIP with an
 * accurate reason. A cooldown must never be reported as DNC, a DNC must never
 * be reported as a cooldown, and neither may be counted as a bot failure.
 */

'use strict';

const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

// Point the bot logger at a scratch directory before requiring it.
process.env.LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'statflobot-test-logs-'));

const test   = require('node:test');
const assert = require('node:assert/strict');

const { SKIP_REASONS, resolveSkipReason, detectSmsBlockedOrCooldownState } = require('../src/statflo');

/**
 * Minimal page double. detectSmsBlockedOrCooldownState() calls page.evaluate()
 * three times: visible text, then composer state, then the SMS button list.
 */
function fakePage(visibleText) {
  let call = 0;
  return {
    evaluate: async () => {
      call += 1;
      if (call === 1) return visibleText;
      if (call === 2) return { found: false };
      return [];
    },
  };
}

// ── resolveSkipReason ───────────────────────────────────────────────────────

test('a single cooldown line reports the single-line cooldown reason', () => {
  assert.equal(
    resolveSkipReason({ totalLines: 1, cooldownCount: 1, dncCount: 0, noComposeCount: 0 }),
    SKIP_REASONS.RECENTLY_MESSAGED_SINGLE_LINE,
  );
});

test('all lines in cooldown reports the all-lines cooldown reason, never DNC', () => {
  const reason = resolveSkipReason({ totalLines: 3, cooldownCount: 3, dncCount: 0, noComposeCount: 0 });
  assert.equal(reason, SKIP_REASONS.ALL_LINES_RECENTLY_MESSAGED);
  assert.notEqual(reason, SKIP_REASONS.ALL_LINES_DNC);
});

test('all lines DNC reports the DNC reason, never a cooldown', () => {
  const reason = resolveSkipReason({ totalLines: 2, cooldownCount: 0, dncCount: 2, noComposeCount: 0 });
  assert.equal(reason, SKIP_REASONS.ALL_LINES_DNC);
  assert.notEqual(reason, SKIP_REASONS.ALL_LINES_RECENTLY_MESSAGED);
});

test('a mix of DNC and cooldown does not claim either as the sole cause', () => {
  const reason = resolveSkipReason({ totalLines: 2, cooldownCount: 1, dncCount: 1, noComposeCount: 0 });
  assert.notEqual(reason, SKIP_REASONS.ALL_LINES_DNC);
  assert.notEqual(reason, SKIP_REASONS.ALL_LINES_RECENTLY_MESSAGED);
  assert.ok(typeof reason === 'string' && reason.startsWith('SKIPPED_'));
});

test('every skip reason is a SKIPPED_* code, so skips never read as failures', () => {
  for (const [name, code] of Object.entries(SKIP_REASONS)) {
    assert.ok(code.startsWith('SKIPPED_'), `${name} = ${code} should be a SKIPPED_* code`);
  }
});

// ── text classification ─────────────────────────────────────────────────────

test('a genuine do-not-contact banner classifies as DNC', async () => {
  const res = await detectSmsBlockedOrCooldownState(fakePage('This contact is marked Do Not Contact'), 'test');
  assert.equal(res.blocked, true);
  assert.equal(res.kind, 'dnc');
});

test('an opted-out banner classifies as DNC', async () => {
  const res = await detectSmsBlockedOrCooldownState(fakePage('Customer has opted out of messaging'), 'test');
  assert.equal(res.blocked, true);
  assert.equal(res.kind, 'dnc');
});

test('a cooldown banner classifies as cooldown, not DNC', async () => {
  const res = await detectSmsBlockedOrCooldownState(fakePage('You messaged this contact too recently'), 'test');
  assert.equal(res.blocked, true);
  assert.equal(res.kind, 'cooldown');
});

test('outbound "Reply STOP to unsubscribe" copy is not treated as DNC', async () => {
  // Regression: a bare /unsubscrib/ pattern matched ordinary marketing copy
  // sitting in the message thread, so cooldown skips were logged as DNC.
  const thread = 'Hi Alex, your upgrade is ready. Reply STOP to unsubscribe. '
               + 'You messaged this contact too recently — please wait before texting again.';
  const res = await detectSmsBlockedOrCooldownState(fakePage(thread), 'test');
  assert.equal(res.blocked, true);
  assert.equal(res.kind, 'cooldown', 'thread copy containing "unsubscribe" must not override a real cooldown');
});

test('a contact who actually unsubscribed still classifies as DNC', async () => {
  const res = await detectSmsBlockedOrCooldownState(fakePage('This contact has unsubscribed from SMS'), 'test');
  assert.equal(res.blocked, true);
  assert.equal(res.kind, 'dnc');
});

test('an ordinary page with no block message is not classified as blocked', async () => {
  const res = await detectSmsBlockedOrCooldownState(fakePage('Account overview. Recent activity. Send a message.'), 'test');
  assert.equal(res.blocked, false);
  assert.equal(res.kind, 'none');
});
