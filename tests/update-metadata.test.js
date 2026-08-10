/**
 * The release guard that stands between a bad artifact set and every installed
 * copy of the app. These are the failures it must catch, because each one only
 * surfaces on the customer's machine otherwise:
 *   - a missing architecture (that machine can never download an update),
 *   - a wrong sha512 (electron-updater rejects the download),
 *   - a wrong size.
 */

'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const crypto  = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-update-metadata.js');

function sha512Base64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

/** Build a throwaway dist directory with real files and matching metadata. */
function makeDist({ armBody = 'arm64-payload', x64Body = 'x64-payload', mutate = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statflobot-meta-'));

  const arm = { name: 'StatfloBot-1.5.51-arm64-mac.zip', body: Buffer.from(armBody) };
  const x64 = { name: 'StatfloBot-1.5.51-mac.zip',       body: Buffer.from(x64Body) };

  for (const f of [arm, x64]) fs.writeFileSync(path.join(dir, f.name), f.body);

  const entries = [arm, x64].map(f => ({
    url: f.name,
    sha512: sha512Base64(f.body),
    size: f.body.length,
  }));

  const meta = { version: '1.5.51', files: entries, path: arm.name };
  if (mutate) mutate(meta);

  const yml = [
    `version: ${meta.version}`,
    'files:',
    ...meta.files.flatMap(f => [
      `  - url: ${f.url}`,
      `    sha512: ${f.sha512}`,
      `    size: ${f.size}`,
    ]),
    `path: ${meta.path}`,
    `sha512: ${meta.files[0].sha512}`,
    "releaseDate: '2026-08-08T20:40:00.546Z'",
    '',
  ].join('\n');

  const ymlPath = path.join(dir, 'latest-mac.yml');
  fs.writeFileSync(ymlPath, yml);
  return ymlPath;
}

function run(ymlPath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ymlPath, '--platform', 'mac'], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a correct two-architecture metadata file passes', () => {
  const res = run(makeDist());
  assert.equal(res.code, 0, res.output);
  assert.match(res.output, /all hashes and sizes match/);
  assert.match(res.output, /arch ok/);
});

test('a metadata file missing the Intel zip is rejected', () => {
  const ymlPath = makeDist({ mutate: m => { m.files = m.files.filter(f => f.url.includes('arm64')); } });
  const res = run(ymlPath);
  assert.equal(res.code, 1);
  assert.match(res.output, /expected exactly 1 Intel zip/);
});

test('a metadata file missing the arm64 zip is rejected', () => {
  const ymlPath = makeDist({ mutate: m => { m.files = m.files.filter(f => !f.url.includes('arm64')); m.path = m.files[0].url; } });
  const res = run(ymlPath);
  assert.equal(res.code, 1);
  assert.match(res.output, /expected exactly 1 arm64 zip/);
});

test('a stale sha512 is rejected', () => {
  const ymlPath = makeDist({ mutate: m => { m.files[0].sha512 = sha512Base64(Buffer.from('a different build')); } });
  const res = run(ymlPath);
  assert.equal(res.code, 1);
  assert.match(res.output, /HASH MISMATCH/);
});

test('a wrong size is rejected', () => {
  const ymlPath = makeDist({ mutate: m => { m.files[1].size = m.files[1].size + 999; } });
  const res = run(ymlPath);
  assert.equal(res.code, 1);
  assert.match(res.output, /SIZE MISMATCH/);
});

test('a referenced file that was never built is rejected', () => {
  const ymlPath = makeDist({ mutate: m => { m.files[0].url = 'StatfloBot-1.5.51-arm64-mac.zip.notbuilt'; } });
  const res = run(ymlPath);
  assert.equal(res.code, 1);
  assert.match(res.output, /MISSING/);
});

test('a missing metadata file is rejected rather than silently skipped', () => {
  const res = run(path.join(os.tmpdir(), 'definitely-not-here-latest-mac.yml'));
  assert.equal(res.code, 1);
  assert.match(res.output, /was not generated/);
});
