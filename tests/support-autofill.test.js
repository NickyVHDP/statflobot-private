'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'ui/client/src/App.jsx'), 'utf8');
const support = fs.readFileSync(path.join(root, 'ui/client/src/screens/SupportScreen.jsx'), 'utf8');

test('support receives the authenticated account profile', () => {
  assert.match(app, /<SupportScreen user=\{user\} account=\{account\} \/>/);
});

test('support autofills name from profile or signup metadata and email from the account', () => {
  assert.match(support, /account\?\.profile\?\.full_name/);
  assert.match(support, /user\?\.user_metadata\?\.full_name/);
  assert.match(support, /user\?\.user_metadata\?\.name/);
  assert.match(support, /account\?\.profile\?\.email \?\? user\?\.email/);
  assert.match(support, /useState\(initialContact\.name\)/);
  assert.match(support, /useState\(initialContact\.email\)/);
});

test('late account loading fills blanks without overwriting customer edits', () => {
  assert.match(support, /if \(contact\.name && !name\) setName\(contact\.name\)/);
  assert.match(support, /if \(contact\.email && !email\) setEmail\(contact\.email\)/);
  assert.match(support, /onChange=\{e => setName\(e\.target\.value\)\}/);
  assert.match(support, /onChange=\{e => \{[\s\S]*setEmail\(e\.target\.value\)/);
});
