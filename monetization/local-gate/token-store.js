'use strict';

/**
 * monetization/local-gate/token-store.js
 *
 * Stores the last-verified license result on disk so the bot doesn't
 * hit the API on every single run.
 *
 * Cache TTL:
 *   - lifetime plans: 7 days  (server also returns recheckSeconds)
 *   - monthly plans:  6 hours (server also returns recheckSeconds)
 *
 * Storage location: ~/.ruflo-bot/license-cache.json
 * (User's home directory — never inside the repo.)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STORE_DIR  = path.join(os.homedir(), '.ruflo-bot');
const STORE_FILE = path.join(STORE_DIR, 'license-cache.json');

function ensureDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * Read the cached verification result.
 * Returns null if absent, expired, or corrupt.
 */
function read() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (!data || !data.cachedAt || !data.result) return null;

    const recheckMs = (data.recheckSeconds ?? 21600) * 1000;
    const age       = Date.now() - data.cachedAt;

    if (age > recheckMs) return null;   // expired

    return data.result;
  } catch {
    return null;
  }
}

/**
 * Write a verification result to the cache.
 * @param {object} result — the full response from /api/licenses/verify
 */
function write(result) {
  ensureDir();
  const payload = {
    cachedAt:       Date.now(),
    recheckSeconds: result.recheckSeconds ?? 21600,
    result,
  };
  fs.writeFileSync(STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

/** Clear the cache (e.g. after a failed re-verify). */
function clear() {
  try { fs.unlinkSync(STORE_FILE); } catch { /* ok */ }
}

module.exports = { read, write, clear };
