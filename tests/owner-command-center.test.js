'use strict';

/**
 * Owner Command Center — the desktop Admin tab redesign.
 *
 * Two kinds of check live here. The behavioural half exercises the pure
 * derivations in ui/client/src/lib/ownerAttention.js directly. The structural
 * half reads component source, because the guarantees that matter most for this
 * screen are about what it does *not* render: a laptop-resident owner view must
 * not carry licence keys, subscription identifiers, or a raw account dump.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const panel = read('ui', 'client', 'src', 'components', 'AdminPanel.jsx');
const referralsPanel = read('ui', 'client', 'src', 'components', 'AdminReferralsOverview.jsx');
const supportPanel = read('ui', 'client', 'src', 'components', 'AdminSupportReports.jsx');
const reviewPanel = read('ui', 'client', 'src', 'components', 'ReliabilityReview.jsx');
const app = read('ui', 'client', 'src', 'App.jsx');
const proxy = read('ui', 'server', 'index.js');
const supportReportsRoute = read('monetization', 'web', 'app', 'api', 'admin', 'support', 'reports', 'route.ts');
const supportHelpers = read('monetization', 'web', 'lib', 'supportReports.ts');

const attention = () => import(
  new URL('../ui/client/src/lib/ownerAttention.js', `file://${__filename}`).href
);

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const iso = hoursAgo => new Date(NOW - hoursAgo * HOUR).toISOString();

// ── Hierarchy ───────────────────────────────────────────────────────────────

test('the panel is the Owner Command Center, not an Admin Panel', () => {
  assert.match(panel, /Owner Command Center/);
  assert.doesNotMatch(panel, /Admin Panel/);
});

test('the attention summary comes first, above every data section', () => {
  const summary = panel.indexOf('<AttentionSummary');
  assert.ok(summary > 0, 'expected an attention summary');
  for (const section of ['<AdminSupportReports', '<ReliabilityReview', '<AdminReferralsOverview', 'Technical Tools']) {
    assert.ok(panel.indexOf(section) > summary, `${section} must render below the attention summary`);
  }
});

test('sections run support → reliability → referrals → collapsed technical tools', () => {
  const order = ['<AdminSupportReports', '<ReliabilityReview', '<AdminReferralsOverview', 'Technical Tools']
    .map(marker => panel.indexOf(marker));
  assert.ok(order.every(i => i > 0), 'every section must be present');
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `section ${i} is out of order`);
  }
});

test('technical tools are collapsed by default and hold the device + debug detail', () => {
  assert.match(panel, /useState\(false\)[\s\S]{0,80}showTechnical|const \[showTechnical, setShowTechnical\] = useState\(false\)/);
  assert.match(panel, /aria-expanded=\{showTechnical\}/);
  // DebugPanel and the device summary must sit inside the collapsed branch.
  const gate = panel.indexOf('{showTechnical && (');
  assert.ok(gate > 0, 'expected a conditional technical-tools body');
  assert.ok(panel.indexOf('<DebugPanel />') > gate, 'DebugPanel belongs inside Technical Tools');
  assert.ok(panel.indexOf('This device') > gate, 'the device summary belongs inside Technical Tools');
});

// ── Removals ────────────────────────────────────────────────────────────────

test('the owner view no longer renders licence, subscription or authenticated-user detail', () => {
  for (const gone of [
    /Authenticated user/i,
    /license_key/,
    /max_devices/,
    /stripe_customer_id/,
    /Subscription/,
    /account\?\.license/,
    /account\?\.subscription/,
    /profile\?\.email/,
  ]) {
    assert.doesNotMatch(panel, gone, `expected ${gone} to be removed from the owner view`);
  }
});

test('the raw account payload dump is gone', () => {
  assert.doesNotMatch(panel, /JSON\.stringify\(account/);
  assert.doesNotMatch(panel, /Raw account payload/);
  assert.doesNotMatch(panel, /<pre/);
});

test('the fabricated Socket status is gone and exactly one real cloud status remains', () => {
  assert.doesNotMatch(panel, /Socket/i, 'the hardcoded always-connected Socket row must not return');
  assert.equal(panel.match(/Cloud API/g)?.length, 1, 'expected exactly one cloud status row');
  assert.match(panel, /backendDown \? 'Unreachable' : 'Connected'/);
});

test('device and account information is stated once, not repeated across sections', () => {
  assert.doesNotMatch(panel, /Registered devices/);
  assert.doesNotMatch(panel, /device_fingerprint/);
  assert.doesNotMatch(panel, /Device registration/);
  assert.equal(panel.match(/Devices on account/g)?.length, 1);
});

test('the Welcome guide is no longer reachable from the owner view', () => {
  assert.doesNotMatch(panel, /Welcome guide/i);
  assert.doesNotMatch(panel, /onShowWelcome/);
  assert.doesNotMatch(panel, /shouldShowWelcome/);
  assert.doesNotMatch(app, /onShowWelcome/, 'App must stop passing the removed prop');
  // First-run onboarding itself is untouched.
  assert.match(app, /shouldShowWelcome\(\)/);
});

// ── Derived attention data, no extra requests ───────────────────────────────

test('attention data is derived from the panels via onLoaded, not a new endpoint', () => {
  assert.match(panel, /<AdminSupportReports onLoaded=\{onSupportLoaded\} refreshToken=\{refreshToken\} \/>/);
  assert.match(panel, /<ReliabilityReview onLoaded=\{onReliabilityLoaded\} refreshToken=\{refreshToken\} \/>/);
  assert.match(panel, /<AdminReferralsOverview onLoaded=\{onReferralsLoaded\} refreshToken=\{refreshToken\} \/>/);
  assert.match(panel, /setRefreshToken\(current => current \+ 1\)/,
    'the top Refresh button must refresh every owner data panel');
  // No fetch of its own, and no fourth proxy route added for the summary.
  assert.doesNotMatch(panel, /fetch\(|cloudApi/);
  assert.doesNotMatch(proxy, /attention|command-center|owner\/summary/i);

  for (const source of [supportPanel, reviewPanel, referralsPanel]) {
    assert.match(source, /onLoadedRef\.current\?\.\(/,
      'panels must report through a ref so the callback identity cannot restart the fetch');
    assert.match(source, /onLoadedRef\.current\?\.\(null\)/,
      'a failed load must clear the summary rather than leave a stale one');
  }
});

test('support summary counts open reports, oldest age, and delivery failures', async () => {
  const { summarizeSupportReports } = await attention();
  const summary = summarizeSupportReports([
    { status: 'open', created_at: iso(50), support_email_status: 'sent' },
    { status: 'open', created_at: iso(3), support_email_status: 'failed' },
    { status: 'resolved', created_at: iso(200), resolution_email_status: 'error' },
    { status: 'resolved', created_at: iso(10), resolution_email_status: 'sent' },
  ]);

  assert.equal(summary.openCount, 2);
  assert.equal(summary.oldestOpenAt, iso(50));
  assert.equal(summary.emailFailures, 2);
});

test('reliability summary compares the last 24h against the prior daily average', async () => {
  const { summarizeReliability } = await attention();
  const runs = [
    ...Array.from({ length: 6 }, () => ({ created_at: iso(2) })),
    ...Array.from({ length: 29 }, (_, i) => ({ created_at: iso(30 + i * 24) })),
  ];
  const summary = summarizeReliability({
    retentionDays: 30,
    runs,
    categories: { unclassified: 4, process_fatal: 2 },
    versions: { '1.5.60': 28, '1.5.59': 7 },
  }, NOW);

  assert.equal(summary.last24h, 6);
  assert.equal(summary.priorDailyAverage, 1);  // 29 prior failures over 29 days
  assert.equal(summary.trendRatio, 6);
  assert.equal(summary.unclassified, 4);
  assert.equal(summary.topVersion.version, '1.5.60');
  assert.ok(summary.topVersion.share > 0.6, 'expected the failing build to dominate');
});

test('reliability trend is null rather than infinite when there is no prior history', async () => {
  const { summarizeReliability } = await attention();
  const summary = summarizeReliability({ retentionDays: 30, runs: [{ created_at: iso(1) }] }, NOW);
  assert.equal(summary.priorDailyAverage, 0);
  assert.equal(summary.trendRatio, null);
});

test('truncated reliability history never claims a failure spike', async () => {
  const { summarizeReliability, buildAttentionItems } = await attention();
  const reliability = summarizeReliability({
    retentionDays: 30,
    truncated: true,
    runs: [
      ...Array.from({ length: 20 }, () => ({ created_at: iso(2) })),
      { created_at: iso(200) },
    ],
    categories: {},
    versions: { '1.5.63': 21 },
  }, NOW);

  assert.equal(reliability.trendRatio, null);
  assert.match(reliability.trendReason, /History limit reached/);
  assert.ok(!buildAttentionItems({ reliability }, NOW).some(item => item.id === 'reliability-spike'));
});

test('a failed owner section prevents a false all-clear', () => {
  assert.match(panel, /const unavailable = [\s\S]*s === null/);
  assert.match(panel, /Could not check \{unavailable\} owner section/);
  assert.match(panel, /no all-clear is being claimed/);
  assert.match(panel, /<AttentionSummary items=\{items\} pending=\{pending\} unavailable=\{unavailable\} \/>/);
});

test('referral summary reports outstanding liability, not settled money', async () => {
  const { summarizeReferrals } = await attention();
  const summary = summarizeReferrals({
    config: { payoutsEnabled: false },
    queue: [
      { referrerUserId: 'a', awaitingPayment: 2, pendingCents: 1000, eligibleCents: 2500, processingCents: 500, paidCents: 9000, reversedCents: 0 },
      { referrerUserId: 'b', awaitingPayment: 1, pendingCents: 0, eligibleCents: -1500, processingCents: 0, paidCents: 1500, reversedCents: 3000, isNegative: true },
    ],
  });

  // 1000 + 2500 + 500. A negative balance on member B must not reduce the
  // amount independently owed to member A.
  assert.equal(summary.outstandingCents, 4000);
  assert.equal(summary.negativeBalances, 1);
  assert.equal(summary.unconvertedApplications, 3);
  assert.equal(summary.codeCount, 2);
});

test('attention items rank critical first and stay silent about panels that failed', async () => {
  const { summarizeSupportReports, summarizeReliability, summarizeReferrals, buildAttentionItems } = await attention();

  const items = buildAttentionItems({
    support: summarizeSupportReports([
      { status: 'open', created_at: iso(72) },
      { status: 'open', created_at: iso(5), support_email_status: 'failed' },
    ]),
    reliability: summarizeReliability({
      retentionDays: 30,
      runs: [...Array.from({ length: 8 }, () => ({ created_at: iso(3) })), { created_at: iso(100) }],
      categories: { unclassified: 1 },
      versions: { '1.5.60': 9 },
    }, NOW),
    referrals: null,   // this panel failed to load
  }, NOW);

  const ids = items.map(i => i.id);
  assert.ok(ids.includes('support-email'));
  assert.equal(items[0].tone, 'critical', 'critical signals sort to the top');
  assert.ok(ids.every(id => !id.startsWith('referrals-')),
    'a panel that failed to load must not contribute a misleading zero');

  const oldest = items.find(i => i.id === 'support-open');
  assert.match(oldest.detail, /Oldest is 3 days old/);

  assert.deepEqual(buildAttentionItems({}), [], 'no summaries means no claims');
});

test('a clean fleet produces no attention items at all', async () => {
  const { summarizeSupportReports, summarizeReferrals, buildAttentionItems } = await attention();
  const items = buildAttentionItems({
    support: summarizeSupportReports([{ status: 'resolved', created_at: iso(5), resolution_email_status: 'sent' }]),
    referrals: summarizeReferrals({ config: {}, queue: [] }),
  }, NOW);
  assert.deepEqual(items, []);
  assert.match(panel, /Nothing needs your attention right now/);
});

// ── Referral panel simplification ───────────────────────────────────────────

test('referrals lead with liability and needs-attention, with the table behind a disclosure', () => {
  assert.match(referralsPanel, /Referral Liabilities/);
  assert.match(referralsPanel, /Outstanding liability/);
  assert.match(referralsPanel, /Unconverted applications/);
  assert.match(referralsPanel, /Negative balances/);
  assert.match(referralsPanel, /const \[showDetail, setShowDetail\] = useState\(false\)/,
    'the per-code table must start collapsed');
  assert.match(referralsPanel, /aria-expanded=\{showDetail\}/);
  assert.match(referralsPanel, /\{showDetail && \(/);
});

test('the desktop referral view stays read-only and identity-free', () => {
  assert.match(referralsPanel, /read-only/i);
  assert.match(referralsPanel, /cannot approve or send payouts/i);
  assert.doesNotMatch(referralsPanel, /referred_email|referred_user_id|referred customer/i);
  assert.doesNotMatch(referralsPanel, /api\/admin\/referrals\/payout|executeApprovedPayout/);
  assert.match(proxy, /api\/admin\/referrals\?view=overview/);
});

// ── Reliability release health ──────────────────────────────────────────────

test('the reliability review shows release health and the 24h vs prior-average comparison', () => {
  assert.match(reviewPanel, /Release health/);
  assert.match(reviewPanel, /Failures · last 24h/);
  assert.match(reviewPanel, /Prior daily average/);
  assert.match(reviewPanel, /the usual day/);
  assert.match(reviewPanel, /Failures by app version/);
  assert.match(reviewPanel, /summarizeReliability/);
});

// ── Narrowed desktop support projection ─────────────────────────────────────

test('DESKTOP_REPORT_COLUMNS omits identity, diagnostics pointers and provider internals', () => {
  const columns = supportHelpers.match(/export const DESKTOP_REPORT_COLUMNS =([\s\S]*?);\n/)?.[1] ?? '';
  assert.ok(columns, 'expected a DESKTOP_REPORT_COLUMNS projection');

  for (const forbidden of [
    'user_id', 'contact_email', 'bot_run_id', 'log_reference', 'log_unavailable_reason',
    'resolved_by_email', 'support_email_error', 'resolution_email_error',
    'resolution_email_provider_id', 'resolution_email_attempts',
  ]) {
    assert.doesNotMatch(columns, new RegExp(`\\b${forbidden}\\b`),
      `${forbidden} must not reach the desktop app`);
  }

  // Still enough to triage and to resolve a report from the desktop.
  for (const required of ['reference', 'status', 'subject', 'description', 'created_at',
    'support_email_status', 'resolution_email_status', 'resolution_message', 'fixed_in_version']) {
    assert.match(columns, new RegExp(`\\b${required}\\b`), `${required} is needed by the desktop panel`);
  }
});

test('the admin support route serves the narrow projection only for view=desktop', () => {
  assert.match(supportReportsRoute, /searchParams\.get\('view'\) === 'desktop'[\s\S]{0,80}DESKTOP_REPORT_COLUMNS/);
  assert.match(supportReportsRoute, /:\s*ADMIN_REPORT_COLUMNS/,
    'any other view must fall back to the full web-admin projection');
  assert.match(supportReportsRoute, /\.select\(columns\)/);
  // The owner gates are unchanged.
  assert.match(supportReportsRoute, /getAuthUser\(req\)/);
  assert.match(supportReportsRoute, /isAdminEmail\(user\.email\)[\s\S]*status: 403/);
});

test('the local proxy asks for the desktop view', () => {
  assert.match(proxy, /api\/proxy\/admin\/support\/reports[\s\S]{0,120}api\/admin\/support\/reports\?view=desktop/);
});

test('the full projection is still available to the web admin', () => {
  assert.match(supportHelpers, /export const ADMIN_REPORT_COLUMNS =[\s\S]*?user_id/);
  assert.match(supportHelpers, /export const ADMIN_REPORT_COLUMNS =[\s\S]*?contact_email/);
});
