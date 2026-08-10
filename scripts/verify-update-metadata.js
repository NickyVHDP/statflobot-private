#!/usr/bin/env node
/**
 * Verify electron-updater release metadata against the artifacts on disk.
 *
 * The previous CI guard only counted `sha512:` and `size:` lines and checked
 * that each referenced filename existed. Stale or mismatched metadata therefore
 * passed CI and failed on the customer's machine instead, where electron-updater
 * rejects the download during checksum verification — the update simply never
 * installs and the user sees a generic error.
 *
 * This checks the things that actually break an update:
 *   - the file named by every `url:` exists,
 *   - its byte count equals the recorded `size:`,
 *   - its base64 SHA-512 equals the recorded `sha512:`,
 *   - for macOS, exactly one arm64 zip and one non-arm64 (Intel) zip are listed,
 *     because electron-updater's MacUpdater filters candidates on whether the
 *     URL contains "arm64" and then picks a zip. A missing entry sends that
 *     architecture down the "ZIP file not provided" path.
 *
 * Usage:
 *   node scripts/verify-update-metadata.js <metadata.yml> [--platform mac|win]
 *
 * Exits non-zero with a specific message on the first real problem.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

/**
 * Minimal reader for the shape electron-builder emits. A YAML dependency is
 * deliberately avoided so this can run in CI before any install step.
 *
 * Recognised shape:
 *   version: 1.2.3
 *   files:
 *     - url: Name.zip
 *       sha512: <base64>
 *       size: 123
 *   path: Name.zip
 */
function parseMetadata(text) {
  const meta = { version: null, files: [], path: null, sha512: null };
  let current = null;
  let inFiles = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const topLevel = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (topLevel) {
      const [, key, value] = topLevel;
      inFiles = key === 'files';
      if (!inFiles) current = null;
      if (key === 'version') meta.version = value.trim();
      if (key === 'path')    meta.path    = value.trim().replace(/^['"]|['"]$/g, '');
      // Unindented, so this is the legacy top-level checksum, not a files[] entry.
      if (key === 'sha512')  meta.sha512  = value.trim().replace(/^['"]|['"]$/g, '');
      continue;
    }

    if (!inFiles) continue;

    const entryStart = line.match(/^\s+-\s+url:\s*(.+)$/);
    if (entryStart) {
      current = { url: entryStart[1].trim().replace(/^['"]|['"]$/g, ''), sha512: null, size: null };
      meta.files.push(current);
      continue;
    }

    if (!current) continue;
    const field = line.match(/^\s+([A-Za-z0-9_]+):\s*(.+)$/);
    if (!field) continue;
    const [, key, value] = field;
    const clean = value.trim().replace(/^['"]|['"]$/g, '');
    if (key === 'sha512') current.sha512 = clean;
    if (key === 'size')   current.size   = Number(clean);
  }

  return meta;
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function main() {
  const args = process.argv.slice(2);
  const ymlPath = args[0];
  const platformIdx = args.indexOf('--platform');
  const platform = platformIdx !== -1 ? args[platformIdx + 1] : null;

  if (!ymlPath) fail('usage: verify-update-metadata.js <metadata.yml> [--platform mac|win]');
  if (!fs.existsSync(ymlPath)) fail(`${ymlPath} was not generated`);

  const dir  = path.dirname(ymlPath);
  const meta = parseMetadata(fs.readFileSync(ymlPath, 'utf8'));

  console.log(`--- ${ymlPath} ---`);
  console.log(fs.readFileSync(ymlPath, 'utf8'));

  if (!meta.version) fail('no version field in metadata');
  if (meta.files.length === 0) fail('metadata lists no files');

  let problems = 0;

  for (const file of meta.files) {
    const artifact = path.join(dir, file.url);

    if (!fs.existsSync(artifact)) {
      console.error(`  MISSING: ${file.url} is referenced but was not built`);
      problems++;
      continue;
    }

    // Track per-file so a mismatched artifact is never also printed as "ok".
    let fileProblems = 0;

    const actualSize = fs.statSync(artifact).size;
    if (file.size == null || Number.isNaN(file.size)) {
      console.error(`  BAD SIZE: ${file.url} has no usable size entry`);
      fileProblems++;
    } else if (actualSize !== file.size) {
      console.error(`  SIZE MISMATCH: ${file.url} recorded=${file.size} actual=${actualSize}`);
      fileProblems++;
    }

    const actualHash = sha512Base64(artifact);
    if (!file.sha512) {
      console.error(`  BAD HASH: ${file.url} has no sha512 entry`);
      fileProblems++;
    } else if (actualHash !== file.sha512) {
      console.error(`  HASH MISMATCH: ${file.url}`);
      console.error(`    recorded: ${file.sha512}`);
      console.error(`    actual  : ${actualHash}`);
      fileProblems++;
    }

    if (fileProblems === 0) console.log(`  ok ${file.url} (${actualSize} bytes)`);
    problems += fileProblems;
  }

  if (meta.path) {
    const primary = meta.files.find(f => f.url === meta.path);
    if (!primary) {
      console.error(`  BAD PATH: top-level path "${meta.path}" is not one of the listed files`);
      problems++;
    } else if (meta.sha512) {
      // Older electron-updater releases read the top-level path/sha512 pair
      // instead of files[]. If it disagrees with the entry it names, those
      // clients would download a file whose checksum never validates.
      if (meta.sha512 !== primary.sha512) {
        console.error(`  TOP-LEVEL HASH MISMATCH: path "${meta.path}"`);
        console.error(`    top-level sha512: ${meta.sha512}`);
        console.error(`    files[] sha512  : ${primary.sha512}`);
        problems++;
      } else {
        console.log(`  ok top-level path/sha512 agree with files[]`);
      }
    }
  }

  if (platform === 'mac') {
    // electron-updater MacUpdater: filters on url containing "arm64", then
    // findFile(files, "zip", ["pkg","dmg"]). Both sides need exactly one zip.
    const zips     = meta.files.filter(f => f.url.endsWith('.zip'));
    const armZips  = zips.filter(f => f.url.includes('arm64'));
    const x64Zips  = zips.filter(f => !f.url.includes('arm64'));

    if (armZips.length !== 1) {
      console.error(`  ARCH: expected exactly 1 arm64 zip, found ${armZips.length} — Apple Silicon users would get the Intel build or no build`);
      problems++;
    }
    if (x64Zips.length !== 1) {
      console.error(`  ARCH: expected exactly 1 Intel zip, found ${x64Zips.length} — Intel users would fail with ERR_UPDATER_ZIP_FILE_NOT_FOUND`);
      problems++;
    }
    if (armZips.length === 1 && x64Zips.length === 1) {
      console.log(`  arch ok: arm64=${armZips[0].url} intel=${x64Zips[0].url}`);
    }
  }

  if (problems > 0) fail(`${problems} problem(s) in ${ymlPath} — refusing to publish`);

  console.log(`${ymlPath} verified: version=${meta.version}, ${meta.files.length} artifact(s), all hashes and sizes match`);
}

main();
