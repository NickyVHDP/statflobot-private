'use strict';

/**
 * src/identity.js
 * Statflo username lock — account-sharing protection.
 *
 * Each paid StatfloBot account is locked to one Statflo identity key after
 * the first successful login.  Subsequent runs must be for the same Statflo user.
 *
 * Normalization rules:
 *   1. lowercase
 *   2. trim whitespace
 *   3. strip @cellularsales.com domain if present
 *   4. compare final first.last key
 *
 * Examples:
 *   John.Smith@cellularsales.com  →  john.smith
 *   JOHN.SMITH                    →  john.smith
 *   jane.doe@cellularsales.com    →  jane.doe
 *
 * Check order:
 *   1. Dashboard server  (/api/internal/check-identity)  — uses the JWT from
 *      the current run to call the cloud API and update the cloud-side lock.
 *   2. Local file        (botDataDir/statflo-identity.json)  — fallback when
 *      the dashboard is unreachable.
 */

const fs   = require('fs');
const path = require('path');

const logger = require('./logger');

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize a raw Statflo identity value to a comparable key.
 * Strips @cellularsales.com domain; lowercases and trims everything.
 *
 * Does NOT strip other domains — first.last@gmail.com stays as-is so it
 * never accidentally matches a different user's first.last@cellularsales.com.
 *
 * Returns null for empty or invalid values.
 */
function normalizeStatfloIdentity(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let val = raw.trim().toLowerCase();
  val = val.replace(/@cellularsales\.com$/, '');
  return val.length > 0 ? val : null;
}

// ─── Local persistence ────────────────────────────────────────────────────────

function readLocalIdentity(botDataDir) {
  if (!botDataDir) return null;
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(botDataDir, 'statflo-identity.json'), 'utf8')
    );
    // Support both old schema (statfloEmail) and new schema (identityKey)
    const key = (data?.identityKey || data?.statfloEmail || '').trim().toLowerCase();
    return key.length > 0 ? key : null;
  } catch { return null; }
}

function writeLocalIdentity(botDataDir, raw, identityKey) {
  if (!botDataDir) return;
  try {
    fs.mkdirSync(botDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDataDir, 'statflo-identity.json'),
      JSON.stringify({
        raw:         raw,
        identityKey: identityKey,
        lockedAt:    new Date().toISOString(),
      }, null, 2),
      'utf8'
    );
  } catch (err) {
    logger.warn(`[IDENTITY] failed to write local identity file: ${err.message}`);
  }
}

// ─── Main check ───────────────────────────────────────────────────────────────

/**
 * Check the detected Statflo identity against the locked identity for this account.
 *
 * Returns:
 *   { allowed: true,  action, lockedKey }
 *   { allowed: false, reason, lockedKey }
 */
async function checkAndLockIdentity(detectedRaw, { dashboardPort, botDataDir } = {}) {
  const identityKey = normalizeStatfloIdentity(detectedRaw);

  if (!identityKey) {
    logger.warn('[STATFLO_IDENTITY_UNKNOWN_BLOCKED] Could not detect Statflo username — blocking run for security.');
    return { allowed: false, reason: 'no-email-detected' };
  }

  logger.info(`[STATFLO_IDENTITY_CHECK] raw="${detectedRaw}" key="${identityKey}" port=${dashboardPort ?? 'n/a'}`);

  // 1. Try dashboard server (has the JWT, can call cloud API)
  if (dashboardPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/internal/check-identity`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ detectedRaw, identityKey }),
        signal:  AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 || data.allowed === false) {
        logger.warn(`[STATFLO_IDENTITY_MISMATCH_BLOCKED] locked="${data.lockedKey ?? '?'}" current="${identityKey}"`);
        return { allowed: false, reason: data.reason ?? 'mismatch', lockedKey: data.lockedKey };
      }

      if (res.ok && data.allowed !== false) {
        const action = data.action ?? 'matched';
        logger.info(`[STATFLO_IDENTITY_CHECK] server result: action=${action} lockedKey=${data.lockedKey ?? identityKey}`);
        if (action === 'locked' || action === 'local-lock') {
          logger.info(`[STATFLO_IDENTITY_LOCK_CREATED] username=${identityKey}`);
        }
        writeLocalIdentity(botDataDir, detectedRaw, identityKey);
        return { allowed: true, action, lockedKey: data.lockedKey ?? identityKey };
      }

      logger.warn(`[IDENTITY] dashboard returned unexpected status=${res.status} — falling back to local`);
    } catch (err) {
      logger.warn(`[IDENTITY] dashboard check failed: ${err.message} — falling back to local`);
    }
  }

  // 2. Local fallback
  const localKey = readLocalIdentity(botDataDir);

  if (!localKey) {
    writeLocalIdentity(botDataDir, detectedRaw, identityKey);
    logger.info(`[STATFLO_IDENTITY_LOCK_CREATED] username=${identityKey} (local fallback)`);
    return { allowed: true, action: 'local-lock', lockedKey: identityKey };
  }

  if (localKey === identityKey) {
    logger.info(`[STATFLO_IDENTITY_CHECK] matched local key=${identityKey}`);
    return { allowed: true, action: 'local-match', lockedKey: identityKey };
  }

  logger.warn(`[STATFLO_IDENTITY_MISMATCH_BLOCKED] locked="${localKey}" current="${identityKey}"`);
  return { allowed: false, reason: 'local-mismatch', lockedKey: localKey };
}

module.exports = { checkAndLockIdentity, normalizeStatfloIdentity, readLocalIdentity, writeLocalIdentity };
