const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'release-desktop.yml'),
  'utf8',
);

test('Mac release verifies the exact apps extracted from both update ZIPs', () => {
  const start = workflow.indexOf('Verify signed and notarized Mac update archives');
  assert.notEqual(start, -1, 'missing Mac signature/notarization release gate');

  const end = workflow.indexOf('\n      - name:', start + 10);
  const step = workflow.slice(start, end === -1 ? undefined : end);

  assert.match(step, /set -euo pipefail/);
  assert.match(step, /-z "\$\{EXPECTED_TEAM_ID:-\}"/);
  assert.match(step, /APPLE_TEAM_ID is not configured/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /continue-on-error:\s*true/);
  assert.match(step, /StatfloBot-\$\{VERSION\}-mac\.zip/);
  assert.match(step, /StatfloBot-\$\{VERSION\}-arm64-mac\.zip/);
  assert.equal((step.match(/ditto -x -k/g) || []).length, 2);
  assert.match(step, /codesign --verify --deep --strict/);
  assert.match(step, /TeamIdentifier=/);
  assert.match(step, /xcrun stapler validate/);
  assert.match(step, /spctl --assess --type execute/);
});

test('signature verification runs before release publication', () => {
  const macJob = workflow.indexOf('\n  release-mac:');
  const signatureGate = workflow.indexOf('Verify signed and notarized Mac update archives');
  const windowsJob = workflow.indexOf('\n  release-win:');
  const publishJob = workflow.indexOf('\n  publish-release:');

  assert.ok(macJob > -1 && signatureGate > macJob, 'gate must be in the Mac release job');
  assert.ok(windowsJob > signatureGate, 'gate must complete before the next release job');
  assert.ok(publishJob > windowsJob, 'publication must happen after artifact jobs');
  assert.match(workflow.slice(publishJob), /needs: \[release-mac, release-win\]/);
});
