'use strict';

/**
 * monetization/local-gate/license-client.js
 *
 * HTTP client for the Ruflo license verification API.
 * Uses only Node.js built-ins (https/http) — no extra dependencies.
 */

const https    = require('https');
const http     = require('http');
const os       = require('os');
const crypto   = require('crypto');

/**
 * Generate a stable device fingerprint from machine-level attributes.
 * SHA-256 of: hostname + first CPU model + OS architecture.
 * Does NOT use MAC addresses (they can change with VPNs/docker).
 */
function deviceFingerprint() {
  const parts = [
    os.hostname(),
    (os.cpus()[0] || {}).model || 'unknown',
    os.arch(),
    os.platform(),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function deviceName() {
  return `${os.hostname()} (${os.platform()}/${os.arch()})`;
}

/**
 * Call POST /api/licenses/verify on the cloud dashboard.
 *
 * @param {string} apiUrl  — e.g. https://your-app.vercel.app
 * @param {string} licenseKey
 * @returns {Promise<object>} — { valid, plan, status, reason, recheckSeconds, user }
 */
function verifyLicense(apiUrl, licenseKey) {
  return new Promise((resolve, reject) => {
    const fingerprint = deviceFingerprint();
    const payload     = JSON.stringify({
      licenseKey,
      deviceFingerprint: fingerprint,
      deviceName:        deviceName(),
      appVersion:        require('../../package.json').version,
    });

    const parsedUrl = new URL(`${apiUrl}/api/licenses/verify`);
    const useHttps  = parsedUrl.protocol === 'https:';
    const transport = useHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (useHttps ? 443 : 80),
      path:     parsedUrl.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'ruflo-bot/local-gate',
      },
    };

    const req = transport.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from license API: ${body.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('License API request timed out (10s)'));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { verifyLicense, deviceFingerprint };
