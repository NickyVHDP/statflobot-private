'use strict';

// Only recorded run metadata can identify an older run's version. Never infer
// it from the installed app or from a version mentioned in a customer's note.
function normalizeAppVersion(value) {
  if (typeof value !== 'string') return null;
  const version = value.trim().replace(/^v/, '');
  return version.length <= 50 && /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function readRunVersion(content) {
  for (const line of String(content ?? '').split('\n')) {
    let recorded = null;
    try { recorded = normalizeAppVersion(JSON.parse(line).appVersion); } catch {}
    if (recorded) return recorded;
    const marker = line.match(/^\[INFO\]\s+\[RUN_VERSION\] appVersion=(\S+)\s*$/);
    recorded = normalizeAppVersion(marker?.[1]);
    if (recorded) return recorded;
  }
  return null;
}

module.exports = { normalizeAppVersion, readRunVersion };
