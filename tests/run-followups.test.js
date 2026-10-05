const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('run follow-up storage is private, bounded, and tied to account-owned runs', () => {
  const migration = read('supabase/migrations/20261005170000_run_followup_messages.sql');
  const customer = read('monetization/web/app/api/run-followups/route.ts');
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all .* anon, authenticated/i);
  assert.match(migration, /char_length\(body\) between 1 and 2000/i);
  assert.match(customer, /\.eq\('user_id', user\.id\)/);
  assert.match(customer, /\.eq\('sender_role', 'owner'\)/);
  assert.match(customer, /No owner follow-up exists for this run/);
});

test('only the verified owner can initiate a run follow-up', () => {
  const owner = read('monetization/web/app/api/admin/run-followups/route.ts');
  assert.match(owner, /isAdminEmail\(owner\.email\)/);
  assert.match(owner, /from\('bot_runs'\).*select\('id, user_id'\)/s);
  assert.match(owner, /user_id: run\.user_id/);
});

test('desktop surfaces private run questions and requires confirmation before owner send', () => {
  const thread = read('ui/client/src/components/RunFollowupThread.jsx');
  const inbox = read('ui/client/src/components/RunFollowupInbox.jsx');
  const review = read('ui/client/src/components/ReliabilityReview.jsx');
  const account = read('ui/client/src/screens/AccountScreen.jsx');
  const proxy = read('ui/server/index.js');
  assert.match(thread, /window\.confirm/);
  assert.match(thread, /Use suggested question for this run/);
  assert.match(review, /<RunFollowupThread run=\{selected\} owner/);
  assert.match(account, /<RunFollowupInbox/);
  assert.match(inbox, /replyToRunFollowup/);
  assert.match(proxy, /api\/proxy\/admin\/run-followups/);
  assert.match(proxy, /api\/proxy\/run-followups/);
});
