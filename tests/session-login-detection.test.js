'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../src/session.js'), 'utf8');

test('embedded login wait prefers document.location.href for SPA redirects', () => {
  assert.match(source, /const effectiveUrl = liveHref \|\| currentUrl/);
  assert.match(source, /effectiveUrl\.includes\('\/accounts'\)/);
  assert.match(source, /effectiveUrl\.includes\('\/t\/conversations'\)/);
});

test('authenticated-page guard uses the live embedded URL too', () => {
  assert.match(source, /const liveHref = await page\.evaluate\(\(\) => document\.location\.href\)/);
  assert.match(source, /const url = liveHref \|\| cachedUrl/);
});
