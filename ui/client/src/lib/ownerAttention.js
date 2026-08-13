/**
 * lib/ownerAttention.js
 *
 * Pure derivations behind the Owner Command Center's attention summary.
 *
 * Every input here is data one of the three owner panels *already* fetched for
 * its own rendering, handed up through an `onLoaded` callback. Nothing in this
 * module performs I/O, and no new field is requested from the cloud to feed it:
 * the summary is a second reading of what is on screen anyway, which is why it
 * can never disagree with the section it points at.
 *
 * Kept free of React so it stays directly unit-testable.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const money = cents => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;

/** Coarse age, because "2 days" is the decision and "2d 4h 11m" is noise. */
export function ageLabel(iso, now = Date.now()) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return 'unknown age';
  const hours = Math.max(0, Math.round((now - at) / HOUR_MS));
  if (hours < 1) return 'under an hour old';
  if (hours < 24) return `${hours}h old`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

const isFailedDelivery = status => status === 'failed' || status === 'error';

/**
 * Support queue health: who is waiting, for how long, and whether anything we
 * believe we already told a customer actually reached them.
 */
export function summarizeSupportReports(reports) {
  if (!Array.isArray(reports)) return null;
  const open = reports.filter(r => r.status !== 'resolved');
  const oldestOpenAt = open.reduce((oldest, r) => {
    if (!r.created_at) return oldest;
    return !oldest || r.created_at < oldest ? r.created_at : oldest;
  }, null);

  return {
    openCount: open.length,
    oldestOpenAt,
    emailFailures: reports.filter(
      r => isFailedDelivery(r.support_email_status) || isFailedDelivery(r.resolution_email_status),
    ).length,
  };
}

/**
 * Release health from the failure set the reliability panel already holds.
 *
 * The comparison is "last 24h vs the average day before it" rather than "vs
 * yesterday": one quiet or busy day should not read as a regression. Versions
 * are ranked so a spike concentrated in a single build — the shape of a bad
 * release — is visible without opening the run list. Everything is derived from
 * the returned (bounded) run set, so a truncated response reports on what it
 * actually received rather than implying fleet-wide totals.
 */
export function summarizeReliability(data, now = Date.now()) {
  if (!data) return null;
  const runs = data.runs || [];
  const retentionDays = data.retentionDays || 30;
  const cutoff = now - DAY_MS;
  const timestamps = runs
    .map(run => Date.parse(run.created_at ?? ''))
    .filter(Number.isFinite);

  const last24h = runs.filter(run => {
    const at = Date.parse(run.created_at ?? '');
    return Number.isFinite(at) && at >= cutoff;
  }).length;
  const earliestAt = timestamps.length ? Math.min(...timestamps) : now;
  const observedDays = Math.min(
    retentionDays,
    Math.max(1, Math.ceil((now - earliestAt) / DAY_MS)),
  );
  const priorDays = Math.max(1, observedDays - 1);
  const priorDailyAverage = (runs.length - last24h) / priorDays;
  const truncated = Boolean(data.truncated);

  const versions = Object.entries(data.versions || {})
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => ({
      version,
      count,
      share: runs.length ? count / runs.length : 0,
    }));

  return {
    retentionDays,
    windowCount: runs.length,
    truncated,
    observedDays,
    last24h,
    priorDailyAverage,
    // null rather than Infinity when there is no history to compare against.
    trendRatio: !truncated && priorDailyAverage > 0 ? last24h / priorDailyAverage : null,
    trendReason: truncated
      ? 'History limit reached; trend comparison unavailable'
      : 'No prior history to compare',
    unclassified: data.categories?.unclassified ?? 0,
    versions,
    topVersion: versions[0] ?? null,
  };
}

/**
 * The two questions an owner actually has about referrals: what do I owe, and
 * what is stuck?
 *
 * Outstanding liability is money promised but not yet out the door — clearing +
 * eligible + in transit. Paid and reversed are settled and deliberately
 * excluded, so the headline number is what the business still owes.
 */
export function summarizeReferrals(data) {
  if (!data) return null;
  const queue = data.queue ?? [];
  const totals = queue.reduce((sum, row) => ({
    applied: sum.applied + (row.awaitingPayment || 0),
    clearing: sum.clearing + (row.pendingCents || 0),
    eligible: sum.eligible + (row.eligibleCents || 0),
    transit: sum.transit + (row.processingCents || 0),
    paid: sum.paid + (row.paidCents || 0),
    reversed: sum.reversed + (row.reversedCents || 0),
  }), { applied: 0, clearing: 0, eligible: 0, transit: 0, paid: 0, reversed: 0 });

  return {
    totals,
    // Never net one member's negative balance against money owed to another.
    // Each account is settled independently, so the owner liability is the sum
    // of positive balances plus money already clearing/in transit.
    outstandingCents: queue.reduce(
      (sum, row) => sum
        + Math.max(0, row.pendingCents || 0)
        + Math.max(0, row.eligibleCents || 0)
        + Math.max(0, row.processingCents || 0),
      0,
    ),
    negativeBalances: queue.filter(row => row.isNegative).length,
    unconvertedApplications: totals.applied,
    codeCount: queue.length,
    payoutsEnabled: Boolean(data.config?.payoutsEnabled),
  };
}

const TONE_RANK = { critical: 0, warn: 1, info: 2 };

/**
 * Rank the three summaries into the short list at the top of the screen.
 *
 * A missing summary (the panel is still loading, or its request failed)
 * contributes nothing rather than a misleading zero — "0 open reports" when the
 * queue simply did not load would be worse than saying nothing.
 */
export function buildAttentionItems({ support, reliability, referrals } = {}, now = Date.now()) {
  const items = [];

  if (support) {
    if (support.openCount > 0) {
      items.push({
        id: 'support-open',
        tone: support.openCount > 3 ? 'critical' : 'warn',
        label: `${support.openCount} open support report${support.openCount === 1 ? '' : 's'}`,
        detail: support.oldestOpenAt
          ? `Oldest is ${ageLabel(support.oldestOpenAt, now)}`
          : 'Awaiting your reply',
      });
    }
    if (support.emailFailures > 0) {
      items.push({
        id: 'support-email',
        tone: 'critical',
        label: `${support.emailFailures} support email${support.emailFailures === 1 ? '' : 's'} failed to send`,
        detail: 'A customer was not told what you already fixed',
      });
    }
  }

  if (reliability) {
    if (!reliability.truncated && reliability.trendRatio !== null && reliability.trendRatio >= 1.5 && reliability.last24h > 0) {
      items.push({
        id: 'reliability-spike',
        tone: reliability.trendRatio >= 3 ? 'critical' : 'warn',
        label: `${reliability.last24h} failures in the last 24h`,
        detail: `${reliability.trendRatio.toFixed(1)}× the prior daily average of ${reliability.priorDailyAverage.toFixed(1)}`,
      });
    }
    if (reliability.unclassified > 0) {
      items.push({
        id: 'reliability-unclassified',
        tone: 'warn',
        label: `${reliability.unclassified} unclassified failure${reliability.unclassified === 1 ? '' : 's'}`,
        detail: 'No known marker matched — needs a manual look',
      });
    }
    const top = reliability.topVersion;
    if (top && top.share >= 0.6 && reliability.versions.length > 1) {
      items.push({
        id: 'reliability-version',
        tone: 'warn',
        label: `${Math.round(top.share * 100)}% of failures are on ${top.version}`,
        detail: 'Concentrated in one build — likely a release regression',
      });
    }
  }

  if (referrals) {
    if (referrals.outstandingCents > 0) {
      items.push({
        id: 'referrals-liability',
        tone: 'info',
        label: `${money(referrals.outstandingCents)} outstanding referral liability`,
        detail: 'Clearing, eligible and in transit — not yet paid out',
      });
    }
    if (referrals.negativeBalances > 0) {
      items.push({
        id: 'referrals-negative',
        tone: 'critical',
        label: `${referrals.negativeBalances} negative referral balance${referrals.negativeBalances === 1 ? '' : 's'}`,
        detail: 'Reversals exceed earnings — review before any payout',
      });
    }
    if (referrals.unconvertedApplications > 0) {
      items.push({
        id: 'referrals-unconverted',
        tone: 'info',
        label: `${referrals.unconvertedApplications} referral code${referrals.unconvertedApplications === 1 ? '' : 's'} applied, not purchased`,
        detail: 'Applied at checkout without a completed purchase',
      });
    }
  }

  return items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}
