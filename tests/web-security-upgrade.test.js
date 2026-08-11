const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('web uses the patched Next.js maintenance line and patched build dependencies', () => {
  const pkg = JSON.parse(read('monetization', 'web', 'package.json'));
  assert.equal(pkg.dependencies.next, '15.5.23');
  assert.equal(pkg.overrides.postcss, '8.5.26');
  assert.equal(pkg.overrides.sharp, '0.35.3');
});

test('Next.js 15 asynchronous request APIs are awaited', () => {
  const supabase = read('monetization', 'web', 'lib', 'supabase', 'server.ts');
  const landing = read('monetization', 'web', 'app', 'page.tsx');
  const dashboard = read('monetization', 'web', 'app', 'dashboard', 'page.tsx');
  const checkout = read('monetization', 'web', 'app', 'checkout', 'success', 'page.tsx');

  assert.match(supabase, /export async function createClient\(\)/);
  assert.match(supabase, /const cookieStore = await cookies\(\)/);
  for (const page of [landing, dashboard, checkout]) {
    assert.match(page, /searchParams: Promise</);
    assert.match(page, /await searchParams/);
  }
});
