'use strict';

/**
 * src/identity.js
 * Statflo username lock — account-sharing protection.
 *
 * Each paid StatfloBot account is locked to one Statflo email address after
 * the first successful login.  Subsequent runs on the same account must be
 * for the same Statflo user; mismatches are blocked before any messages are sent.
 *
 * Check order:
 *   1. Dashboard server  (/api/internal/check-identity)  — uses the JWT from
 *      the current run to call the cloud API and update the cloud-side lock.
 *   2. Local file        (botDataDir/statflo-identity.json)  — fallback when
 *      the dashboard is unreachable (rare edge case).
 */

const fs   = require('fs');
const path = require('path');

const logger = require('./logger');

// ─── Local persistence ────────────────────────────────────────────────────────

function readLocalIdentity(botDataDir) {
  if (!botDataDir) return null;
  try {
    const raw  = fs.readFileSync(path.join(botDataDir, 'statflo-identity.json'), 'utf8');
    const data = JSON.parse(raw);
    const email = (data?.statfloEmail || '').trim().toLowerCase();
    return email.includes('@') ? email : null;
  } catch { return null; }
}

function writeLocalIdentity(botDataDir, email) {
  if (!botDataDir) return;
  try {
    fs.mkdirSync(botDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDataDir, 'statflo-identity.json'),
      JSON.stringify({ statfloEmail: email, lockedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (err) {
    logger.warn(`[IDENTITY] failed to write local identity file: ${err.message}`);
  }
}

// ─── Main check ───────────────────────────────────────────────────────────────

/**
 * Check the detected Statflo email against the locked identity for this account.
 *
 * Returns:
 *   { allowed: true,  action, lockedEmail }
 *   { allowed: false, reason, lockedEmail }
 */
async function checkAndLockIdentity(detectedEmail, { dashboardPort, botDataDir } = {}) {
  if (!detectedEmail || !String(detectedEmail).includes('@')) {
    logger.warn('[STATFLO_IDENTITY_UNKNOWN_BLOCKED] Could not detect Statflo username — blocking run for security.');
    return { allowed: false, reason: 'no-email-detected' };
  }

  const normalized = String(detectedEmail).trim().toLowerCase();
  logger.info(`[STATFLO_IDENTITY_CHECK] detected=${normalized} port=${dashboardPort ?? 'n/a'}`);

  // 1. Try dashboard server (has the JWT, can call cloud API)
  if (dashboardPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/internal/check-identity`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ detectedEmail: normalized }),
        signal:  AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 || data.allowed === false) {
        logger.warn(`[STATFLO_IDENTITY_MISMATCH_BLOCKED] locked=${data.lockedEmail ?? '?'} current=${normalized}`);
        return { allowed: false, reason: data.reason ?? 'mismatch', lockedEmail: data.lockedEmail };
      }

      if (res.ok && data.allowed !== false) {
        const action = data.action ?? 'matched';
        logger.info(`[STATFLO_IDENTITY_CHECK] server result: action=${action} lockedEmail=${data.lockedEmail ?? normalized}`);
        if (action === 'locked' || action === 'local-lock') {
          logger.info(`[STATFLO_IDENTITY_LOCK_CREATED] username=${normalized}`);
        }
        // Keep local copy in sync
        writeLocalIdentity(botDataDir, normalized);
        return { allowed: true, action, lockedEmail: data.lockedEmail ?? normalized };
      }

      logger.warn(`[IDENTITY] dashboard returned unexpected status=${res.status} — falling back to local`);
    } catch (err) {
      logger.warn(`[IDENTITY] dashboard check failed: ${err.message} — falling back to local`);
    }
  }

  // 2. Local fallback
  const localIdentity = readLocalIdentity(botDataDir);

  if (!localIdentity) {
    writeLocalIdentity(botDataDir, normalized);
    logger.info(`[STATFLO_IDENTITY_LOCK_CREATED] username=${normalized} (local fallback)`);
    return { allowed: true, action: 'local-lock', lockedEmail: normalized };
  }

  if (localIdentity === normalized) {
    logger.info(`[STATFLO_IDENTITY_CHECK] matched local identity=${normalized}`);
    return { allowed: true, action: 'local-match', lockedEmail: normalized };
  }

  logger.warn(`[STATFLO_IDENTITY_MISMATCH_BLOCKED] locked=${localIdentity} current=${normalized}`);
  return { allowed: false, reason: 'local-mismatch', lockedEmail: localIdentity };
}

module.exports = { checkAndLockIdentity, readLocalIdentity, writeLocalIdentity };
