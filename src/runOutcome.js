/**
 * src/runOutcome.js
 * Pure helpers for interpreting what processClient() returned.
 *
 * Kept out of main.js so the run loop's contract can be tested without a
 * browser: a mis-read verdict is how the loop previously stalled on one client
 * ('cooldown-skipped' matched no switch case, so nothing counted it and
 * clientIndex never advanced — the same client was re-opened forever).
 */

'use strict';

/**
 * processClient() returns either a plain string verdict or { result, reason }.
 * Normalize both into { result, reason } so callers never branch on the shape.
 *
 * A null/undefined return is treated as a failure rather than silently ignored:
 * an engine that returned nothing did not send, and must not look like a send.
 */
function normalizeClientOutcome(rawResult) {
  if (typeof rawResult === 'string') {
    return { result: rawResult, reason: null };
  }
  if (rawResult && typeof rawResult === 'object' && typeof rawResult.result === 'string') {
    return { result: rawResult.result, reason: rawResult.reason ?? null };
  }
  return { result: 'failed', reason: 'no-result-returned' };
}

/**
 * Every verdict the run loop must handle explicitly.
 * Kept here so a test can assert main.js's switch covers all of them.
 */
const KNOWN_RESULTS = Object.freeze([
  'messaged',
  'dnc',
  'skipped',
  'cooldown-skipped',
  'duplicate-skipped',
  'failed',
  'browser_closed',
]);

module.exports = { normalizeClientOutcome, KNOWN_RESULTS };
