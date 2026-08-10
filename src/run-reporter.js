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

// These diagnostic markers may be derived from live Statflo page content.
// Even though the runtime logger no longer includes that content, exclude old
// and future variants defensively so customer conversations never reach cloud
// history or support email attachments.
const CUSTOMER_CONTENT_MARKERS = [
  /\bDEBUG_VISIBLE_TEXT\b/i,
  /\bDEBUG_COMPOSER_STATE\b/i,
  /\bDEBUG_CLICKABLE_SMS_LINES\b/i,
];

// Replace absolute paths with just the last segment to avoid leaking filesystem layout
function sanitizePaths(str) {
  return str
    .replace(/(?:\/[^\s"'\\]+){3,}\/([^/\s"'\\]+)/g,   '[.../$1]')
    .replace(/(?:[A-Z]:\\[^\s"'\\]+\\){2,}([^\\\s"']+)/g, '[...\\$1]');
}

function sanitizeCustomerData(str) {
  return str
    .replace(/\bclient=(['"])[\s\S]*?\1/gi, 'client="[REDACTED]"')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[REDACTED_PHONE]')
    .replace(/(?<!\d)(?:\+?1)?\d{10}(?!\d)/g, '[REDACTED_PHONE]');
}

function isSafe(line) {
  if (!SAFE_LEVELS.has(line.level)) return false;
  const haystack = [line.msg, JSON.stringify(line.data ?? '')].join(' ');
  return !SENSITIVE_PATTERNS.some(re => re.test(haystack)) &&
    !CUSTOMER_CONTENT_MARKERS.some(re => re.test(haystack));
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
        const text = sanitizeCustomerData(sanitizePaths(`[${parsed.level.toUpperCase()}] ${parsed.msg}`));
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
  const dashboardPort = process.env.RUFLO_DASHBOARD_PORT;
  const reportToken = process.env.RUFLO_REPORT_TOKEN;

  console.log(
    `[RUN_REPORT_START] list=${stats.list ?? 'none'} mode=${stats.mode ?? 'none'} ` +
    `status=${opts.status ?? 'auto'} messaged=${stats.messaged ?? 0} ` +
    `skipped=${(stats.skipped ?? 0) + (stats.dnc ?? 0)} failed=${stats.failed ?? 0}`
  );

  const canUseLocal = Boolean(dashboardPort && reportToken);
  const canUseCloud = Boolean(cloudUrl && token);
  if (!canUseLocal && !canUseCloud) {
    console.log(
      `[RUN_REPORT_ENV_MISSING] RUFLO_CLOUD_URL=${cloudUrl ? 'set' : 'MISSING'} ` +
      `RUFLO_ACCESS_TOKEN=${token ? `set(len=${token.length})` : 'MISSING'} ` +
      `RUFLO_DASHBOARD_PORT=${dashboardPort ? 'set' : 'MISSING'} ` +
      `RUFLO_REPORT_TOKEN=${reportToken ? `set(len=${reportToken.length})` : 'MISSING'} — upload skipped`
    );
    return;
  }

  const status = opts.status ?? (stats.failed > 0 ? 'completed_with_errors' : 'completed');

  let appVersion = null;
  try {
    // Customers install the Electron app, whose release version differs from
    // the legacy root package version. Store the version they actually ran.
    appVersion = require('../desktop/package.json').version;
  } catch {
    try { appVersion = require('../package.json').version; } catch { /* ignore */ }
  }

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

  console.log(`[RUN_REPORT_POSTING] route=${canUseLocal ? 'local-refresh-proxy' : 'direct-cloud'} sent=${payload.sent_count} skipped=${payload.skipped_count} failed=${payload.failed_count}`);

  async function post(endpoint, headers) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8_000);
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    let res = null;
    if (canUseLocal) {
      try {
        res = await post(`http://127.0.0.1:${dashboardPort}/api/internal/run-report`, {
          'X-Ruflo-Report-Token': reportToken,
        });
      } catch (localErr) {
        // Fall back only when the local server cannot be reached. Retrying an
        // HTTP failure could duplicate a row if the cloud insert succeeded but
        // its response was interrupted.
        if (localErr?.name === 'AbortError') throw localErr;
        if (!canUseCloud) throw localErr;
        console.log(`[RUN_REPORT_LOCAL_UNREACHABLE] ${localErr.message} — trying direct cloud`);
        res = await post(`${cloudUrl}/api/runs`, { Authorization: `Bearer ${token}` });
      }
    } else if (canUseCloud) {
      res = await post(`${cloudUrl}/api/runs`, { Authorization: `Bearer ${token}` });
    }
    if (res?.ok) return console.log(`[RUN_REPORT_SUCCESS] status=${res.status} run summary saved`);
    let body = '';
    try { body = res ? (await res.text()).slice(0, 300) : 'no available route'; } catch { /* ignore */ }
    console.log(`[RUN_REPORT_FAILED] status=${res?.status ?? 'none'} body=${body}`);
  } catch (err) {
    console.log(`[RUN_REPORT_FAILED] err=${err.message}`);
  }
}

module.exports = { report, sanitizeLog };
