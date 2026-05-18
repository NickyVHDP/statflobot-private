'use strict';

/**
 * src/run-reporter.js
 *
 * Fire-and-forget uploader for sanitized run summaries → cloud /api/runs endpoint.
 *
 * Rules:
 *  - Never throws, never blocks the bot process.
 *  - Reads env vars RUFLO_ACCESS_TOKEN and RUFLO_CLOUD_URL (set by ui/server).
 *  - Sanitizes the log file: strips debug lines, credential-adjacent lines,
 *    and absolute paths; caps at MAX_LOG_CHARS.
 *  - Times out after 8 s so a slow network doesn't delay process.exit().
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Sanitization ──────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 100;
const MAX_LOG_CHARS = 8_000;

// Safe log levels to include in the sanitized output
const SAFE_LEVELS = new Set(['info', 'warn', 'error', 'success', 'summary', 'banner']);

// Patterns in msg/data that indicate sensitive content — skip these lines
const SENSITIVE_PATTERNS = [
  /\bcookie\b/i,
  /\bbearer\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\bapi[_\s-]?key\b/i,
  /RUFLO-[A-Z0-9]{4,}/,        // license key format
  /access_?token/i,
  /refresh_?token/i,
  /supabase.*key/i,
];

// Replace absolute paths with just the last segment to avoid leaking filesystem layout
function sanitizePaths(str) {
  return str
    .replace(/(?:\/[^\s"'\\]+){3,}\/([^/\s"'\\]+)/g,   '[.../$1]')
    .replace(/(?:[A-Z]:\\[^\s"'\\]+\\){2,}([^\\\s"']+)/g, '[...\\$1]');
}

function isSafe(line) {
  if (!SAFE_LEVELS.has(line.level)) return false;
  const haystack = [line.msg, JSON.stringify(line.data ?? '')].join(' ');
  return !SENSITIVE_PATTERNS.some(re => re.test(haystack));
}

/**
 * Read the run log file, sanitize it, and return a capped text string.
 * Returns null if the file is missing or unreadable.
 */
function sanitizeLog(logFilePath) {
  if (!logFilePath) return null;
  try {
    const raw   = fs.readFileSync(logFilePath, 'utf8');
    const lines = raw.trim().split('\n');
    const safe  = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!isSafe(parsed)) continue;
        const text = sanitizePaths(`[${parsed.level.toUpperCase()}] ${parsed.msg}`);
        safe.push(text);
      } catch {
        // skip malformed JSON lines
      }
    }
    const kept = safe.slice(-MAX_LOG_LINES).join('\n');
    return kept.slice(-MAX_LOG_CHARS) || null;
  } catch {
    return null;
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload a sanitized run summary to the cloud dashboard.
 *
 * @param {object} stats
 *   { list, mode, messaged, dnc, skipped, failed, processed }
 * @param {object} [opts]
 *   { logFilePath?: string, status?: 'completed'|'completed_with_errors'|'failed'|'stopped' }
 */
async function report(stats, opts = {}) {
  const cloudUrl = (process.env.RUFLO_CLOUD_URL ?? '').replace(/\/$/, '');
  const token    = process.env.RUFLO_ACCESS_TOKEN;

  if (!cloudUrl || !token) {
    // Not configured (e.g. dev mode without credentials) — silently skip
    return;
  }

  const status = opts.status ?? (stats.failed > 0 ? 'completed_with_errors' : 'completed');

  let appVersion = null;
  try { appVersion = require('../package.json').version; } catch { /* ignore */ }

  const payload = {
    list_name:         stats.list    ?? null,
    mode:              stats.mode    ?? null,
    status,
    sent_count:        Math.max(0, stats.messaged  ?? 0),
    skipped_count:     Math.max(0, (stats.skipped  ?? 0) + (stats.dnc ?? 0)),
    failed_count:      Math.max(0, stats.failed    ?? 0),
    raw_log_sanitized: sanitizeLog(opts.logFilePath ?? null),
    app_version:       appVersion,
    platform:          os.platform(),
  };

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(`${cloudUrl}/api/runs`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body:   JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      console.log('[run-reporter] run summary saved');
    } else {
      console.log(`[run-reporter] upload failed: HTTP ${res.status}`);
    }
  } catch (err) {
    // Network error, timeout, etc. — log and continue
    console.log(`[run-reporter] upload skipped (${err.message})`);
  }
}

module.exports = { report };
