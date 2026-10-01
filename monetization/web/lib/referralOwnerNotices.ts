import { createHash } from 'crypto';
import { createServiceClient } from './supabase/server';
import { ownerNotificationEmail } from './admin';
import { sendResendEmail } from './supportEmail';
import {
  AUTO_PAYOUT_FUNDING_WINDOW_DAYS,
  OWNER_NOTICE_REMINDER_HOURS,
  formatCents,
} from './referralAutoPayoutPolicy';

/**
 * lib/referralOwnerNotices.ts
 *
 * Owner-facing email about referral rewards and the money needed to pay them.
 *
 * The automatic payout run re-evaluates every recipient every day. Without
 * deduplication that would mean an identical "add $12.00" email every morning
 * until the owner funded the account, which trains the owner to ignore exactly
 * the message that matters. So:
 *
 *   - every notice carries a stable key;
 *   - claim_referral_owner_notice() decides whether it may be sent;
 *   - a CHANGED state always sends immediately;
 *   - an UNCHANGED state waits out the reminder interval, or never repeats at
 *     all when the notice is inherently once-per-reward.
 *
 * The claim is taken before the send. A lost email is recoverable; a mailbox
 * full of duplicates is how a funding alert gets filtered away.
 */

export type OwnerNoticeKind =
  | 'referral-reward-recorded'
  | 'funding-reminder'
  | 'awaiting-funding'
  | 'bank-not-ready'
  | 'daily-cap-reached'
  | 'tax-review-ceiling'
  | 'limits-not-configured'
  | 'auto-payouts-blocked';

export type OwnerNoticeResult = 'sent' | 'suppressed' | 'dry-run' | 'failed';

/**
 * Owner email is off unless this is a real production deployment.
 *
 * Mirrors customerEmailMode() in lib/supportEmail.ts. A developer running the
 * cron locally against production credentials must not be able to mail the
 * owner, and REFERRAL_OWNER_NOTICE_MODE=dry-run is the production kill switch.
 */
export function ownerNoticeMode(): 'live' | 'dry-run' {
  const override = String(process.env.REFERRAL_OWNER_NOTICE_MODE ?? '').trim().toLowerCase();
  if (override === 'dry-run') return 'dry-run';
  if (process.env.NODE_ENV !== 'production') return 'dry-run';
  if (!process.env.RESEND_API_KEY) return 'dry-run';
  return 'live';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Stable per-state idempotency key for the mail provider.
 *
 * Derived from the notice key and the state it describes, never from the
 * attempt: a retry after a lost provider response must collapse into the same
 * email, while a genuinely new shortfall must be allowed through as a new one.
 */
function providerIdempotencyKey(noticeKey: string, payload: Record<string, unknown>): string {
  const digest = createHash('sha256')
    .update(`${noticeKey}\n${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 32);
  return `referral-owner-notice-${digest}`;
}

function renderHtml(args: {
  heading: string;
  paragraphs: string[];
  facts: Array<[string, string]>;
  action: string | null;
}): string {
  const facts = args.facts.length === 0 ? '' : `
  <table style="margin:0 0 20px;border-collapse:collapse;font-size:14px">
    ${args.facts.map(([label, value]) => `
    <tr>
      <td style="padding:4px 16px 4px 0;color:#64748b">${escapeHtml(label)}</td>
      <td style="padding:4px 0;color:#0f172a;font-weight:600">${escapeHtml(value)}</td>
    </tr>`).join('')}
  </table>`;

  const action = args.action ? `
  <div style="margin:0 0 20px;padding:14px 16px;background:#f8fafc;border-left:3px solid #6366f1;border-radius:6px">
    <p style="margin:0;color:#0f172a;line-height:1.6">${escapeHtml(args.action)}</p>
  </div>` : '';

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <p style="margin:0 0 4px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#6366f1;font-weight:600">StatfloBot Referral Program</p>
  <h1 style="margin:0 0 20px;font-size:21px;font-weight:700">${escapeHtml(args.heading)}</h1>
  ${args.paragraphs.map((p) => `<p style="margin:0 0 16px;color:#334155;line-height:1.6">${escapeHtml(p)}</p>`).join('')}
  ${facts}
  ${action}
  <p style="margin:0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
    Automatic owner notice. No money moves from this email — payouts only run from the daily job, and only when every safety check passes.
  </p>
</div>`.trim();
}

/**
 * Claim, render and send one owner notice.
 *
 * Never throws: a notification problem must not fail a payout run or a Stripe
 * webhook. Callers log the returned outcome and carry on.
 */
export async function sendOwnerNotice(input: {
  noticeKey: string;
  kind: OwnerNoticeKind;
  referrerUserId?: string | null;
  /** The state being described. A change here always re-sends. */
  payload: Record<string, unknown>;
  /** null → send exactly once, ever. */
  minIntervalHours: number | null;
  subject: string;
  heading: string;
  paragraphs: string[];
  facts?: Array<[string, string]>;
  action?: string | null;
}): Promise<OwnerNoticeResult> {
  try {
    if (ownerNoticeMode() === 'dry-run') {
      console.log(`[REFERRAL_OWNER_NOTICE_DRY_RUN] kind=${input.kind} key=${input.noticeKey}`);
      return 'dry-run';
    }

    const svc = createServiceClient();
    const { data: claimed, error } = await svc.rpc('claim_referral_owner_notice', {
      p_notice_key: input.noticeKey,
      p_kind: input.kind,
      p_referrer_user_id: input.referrerUserId ?? null,
      p_payload: input.payload,
      p_min_interval: input.minIntervalHours === null
        ? null
        : `${input.minIntervalHours} hours`,
    });
    if (error) {
      console.error('[REFERRAL_OWNER_NOTICE_CLAIM_FAILED]', error.code, error.message);
      return 'failed';
    }
    if (claimed !== true) return 'suppressed';

    const send = await sendResendEmail({
      to: ownerNotificationEmail(),
      subject: input.subject,
      html: renderHtml({
        heading: input.heading,
        paragraphs: input.paragraphs,
        facts: input.facts ?? [],
        action: input.action ?? null,
      }),
      idempotencyKey: providerIdempotencyKey(input.noticeKey, input.payload),
    });
    if (!send.ok) {
      console.error(`[REFERRAL_OWNER_NOTICE_SEND_FAILED] kind=${input.kind} error=${send.error}`);
      return 'failed';
    }
    console.log(`[REFERRAL_OWNER_NOTICE_SENT] kind=${input.kind} key=${input.noticeKey}`);
    return 'sent';
  } catch (err: any) {
    console.error('[REFERRAL_OWNER_NOTICE_FAILED]', String(err?.message ?? err));
    return 'failed';
  }
}

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

/**
 * A qualifying lifetime purchase recorded a reward.
 *
 * Sent once per reward, the moment it is earned — the owner's 30-day notice to
 * have the money in the Financial Account before it becomes payable.
 */
export function noticeRewardRecorded(input: {
  attributionId: string;
  referrerUserId: string;
  rewardCents: number;
  rewardTierCents: number;
  eligibleAt: string;
  qualifiedPosition: number;
}) {
  return {
    noticeKey: `reward-recorded:${input.attributionId}`,
    kind: 'referral-reward-recorded' as const,
    referrerUserId: input.referrerUserId,
    payload: { rewardCents: input.rewardCents, eligibleAt: input.eligibleAt },
    minIntervalHours: null,
    subject: `Referral reward recorded: ${formatCents(input.rewardCents)} payable ${dateLabel(input.eligibleAt)}`,
    heading: 'A referral reward was recorded',
    paragraphs: [
      `A qualifying lifetime purchase earned a referral reward of ${formatCents(input.rewardCents)}.`,
      `It clears the ${AUTO_PAYOUT_FUNDING_WINDOW_DAYS}-day hold on ${dateLabel(input.eligibleAt)}. ` +
      `You have until then to fund the Global Payouts Financial Account.`,
    ],
    facts: [
      ['Reward', formatCents(input.rewardCents)],
      ['Tier rate', formatCents(input.rewardTierCents)],
      ['Referral number', String(input.qualifiedPosition)],
      ['Payable from', dateLabel(input.eligibleAt)],
    ] as Array<[string, string]>,
    action: `Fund the Financial Account with at least ${formatCents(input.rewardCents)} plus the estimated bank fee and your protected reserve before ${dateLabel(input.eligibleAt)}.`,
  };
}

/** 7-day and 1-day warnings, sent only when the projected funding is short. */
export function noticeFundingReminder(input: {
  attributionId: string;
  referrerUserId: string;
  reminder: 'seven-day' | 'one-day';
  rewardCents: number;
  eligibleAt: string;
  shortfallCents: number;
  requiredCents: number;
  availableCents: number;
}) {
  const window = input.reminder === 'one-day' ? '1 day' : '7 days';
  return {
    noticeKey: `funding-reminder:${input.reminder}:${input.attributionId}`,
    kind: 'funding-reminder' as const,
    referrerUserId: input.referrerUserId,
    payload: { shortfallCents: input.shortfallCents },
    minIntervalHours: null,
    subject: `${window} until a ${formatCents(input.rewardCents)} referral reward is payable — ${formatCents(input.shortfallCents)} short`,
    heading: `Funding is short with ${window} to go`,
    paragraphs: [
      `A referral reward of ${formatCents(input.rewardCents)} becomes payable on ${dateLabel(input.eligibleAt)}.`,
      'On today\'s balance the automatic payout would be skipped for want of funds. Nothing is pulled or transferred automatically — the reward simply waits.',
    ],
    facts: [
      ['Reward', formatCents(input.rewardCents)],
      ['Payable from', dateLabel(input.eligibleAt)],
      ['Available now', formatCents(input.availableCents)],
      ['Needed', formatCents(input.requiredCents)],
      ['Shortfall', formatCents(input.shortfallCents)],
    ] as Array<[string, string]>,
    action: `Add ${formatCents(input.shortfallCents)} to the Global Payouts Financial Account.`,
  };
}

/** A matured reward that cannot be paid today. Repeats only every 3 days. */
export function noticeAwaitingFunding(input: {
  referrerUserId: string;
  amountCents: number;
  requiredCents: number;
  availableCents: number;
  shortfallCents: number;
}) {
  return {
    noticeKey: `awaiting-funding:${input.referrerUserId}`,
    kind: 'awaiting-funding' as const,
    referrerUserId: input.referrerUserId,
    payload: { shortfallCents: input.shortfallCents, amountCents: input.amountCents },
    minIntervalHours: OWNER_NOTICE_REMINDER_HOURS,
    subject: `Referral payout waiting on ${formatCents(input.shortfallCents)}`,
    heading: 'A matured referral reward is waiting for funds',
    paragraphs: [
      `${formatCents(input.amountCents)} has cleared its hold and is ready to send, but the Financial Account cannot cover it together with the estimated bank fee and your protected reserve.`,
      'The payout was not attempted. It retries every day, and this reminder repeats only when the amount changes or a few days pass.',
    ],
    facts: [
      ['Ready to pay', formatCents(input.amountCents)],
      ['Available now', formatCents(input.availableCents)],
      ['Needed', formatCents(input.requiredCents)],
      ['Shortfall', formatCents(input.shortfallCents)],
    ] as Array<[string, string]>,
    action: `Add ${formatCents(input.shortfallCents)} to the Global Payouts Financial Account.`,
  };
}

/** A matured reward whose recipient never finished Stripe bank enrollment. */
export function noticeBankNotReady(input: {
  referrerUserId: string;
  amountCents: number;
  detail: string;
}) {
  return {
    noticeKey: `bank-not-ready:${input.referrerUserId}`,
    kind: 'bank-not-ready' as const,
    referrerUserId: input.referrerUserId,
    payload: { amountCents: input.amountCents, detail: input.detail },
    minIntervalHours: OWNER_NOTICE_REMINDER_HOURS,
    subject: `Referral payout blocked: bank setup incomplete (${formatCents(input.amountCents)})`,
    heading: 'A reward is ready but the recipient\'s bank is not',
    paragraphs: [
      `${formatCents(input.amountCents)} has matured for a referrer whose Stripe-hosted bank enrollment is not active, so no payout was attempted.`,
      'The referrer finishes this themselves from their Rewards Hub. Nothing is required from you unless they ask for help.',
    ],
    facts: [['Ready to pay', formatCents(input.amountCents)], ['Blocker', input.detail]] as Array<[string, string]>,
    action: null,
  };
}

/** A safety cap held a payout back for the rest of the UTC day. */
export function noticeDailyCap(input: {
  referrerUserId: string;
  scope: 'recipient' | 'global';
  amountCents: number;
  capCents: number;
  runDate: string;
}) {
  return {
    noticeKey: `daily-cap:${input.scope}:${input.referrerUserId}:${input.runDate}`,
    kind: 'daily-cap-reached' as const,
    referrerUserId: input.referrerUserId,
    payload: { amountCents: input.amountCents, capCents: input.capCents },
    minIntervalHours: null,
    subject: `Referral payout deferred by the ${input.scope === 'global' ? 'daily total' : 'per-recipient'} safety cap`,
    heading: 'A safety cap deferred a payout',
    paragraphs: [
      `A payout of ${formatCents(input.amountCents)} would have passed the ${formatCents(input.capCents)} ${input.scope === 'global' ? 'total for all automatic payouts today' : 'daily limit for one recipient'}, so it was not sent.`,
      'The reward is untouched and the run tries again tomorrow. Raise the cap only if this amount is genuinely expected.',
    ],
    facts: [['Deferred amount', formatCents(input.amountCents)], ['Cap', formatCents(input.capCents)]] as Array<[string, string]>,
    action: 'No action needed unless this repeats. You can still pay it by hand from the admin Referrals page.',
  };
}

/** The annual per-recipient ceiling that hands the decision back to the owner. */
export function noticeTaxReviewCeiling(input: {
  referrerUserId: string;
  amountCents: number;
  paidThisYearCents: number;
  ceilingCents: number;
  year: number;
}) {
  return {
    noticeKey: `tax-review-ceiling:${input.referrerUserId}:${input.year}`,
    kind: 'tax-review-ceiling' as const,
    referrerUserId: input.referrerUserId,
    payload: { paidThisYearCents: input.paidThisYearCents, amountCents: input.amountCents },
    minIntervalHours: OWNER_NOTICE_REMINDER_HOURS,
    subject: `Annual tax-review ceiling reached for a referral recipient (${input.year})`,
    heading: 'Automatic payouts stopped for tax review',
    paragraphs: [
      `Paying ${formatCents(input.amountCents)} would take this recipient to ${formatCents(input.ceilingCents)} or more in automatic referral payouts for ${input.year}, so it was not sent.`,
      'This is the deliberate stop before annual reporting obligations. The reward remains payable by hand once you have settled the paperwork.',
    ],
    facts: [
      ['Paid automatically this year', formatCents(input.paidThisYearCents)],
      ['Held back', formatCents(input.amountCents)],
      ['Ceiling', formatCents(input.ceilingCents)],
    ] as Array<[string, string]>,
    action: 'Review this recipient\'s annual total and pay the remainder manually if the paperwork allows.',
  };
}

/** A money limit the owner has not validly configured. Nothing may pay. */
export function noticeLimitsNotConfigured(input: { invalid: string[] }) {
  return {
    noticeKey: 'limits-not-configured',
    kind: 'limits-not-configured' as const,
    referrerUserId: null,
    payload: { invalid: [...input.invalid].sort() },
    minIntervalHours: OWNER_NOTICE_REMINDER_HOURS,
    subject: 'Automatic referral payouts are stopped: limits are not configured',
    heading: 'Automatic payouts cannot run',
    paragraphs: [
      'One or more automatic payout limits are unset or malformed, so the run stopped before evaluating anyone. No payout was attempted and no Stripe call was made.',
      'These values have no defaults in code on purpose — an automatic payment must never run on a limit nobody chose.',
    ],
    facts: input.invalid.map((name) => [name, 'unset or malformed']) as Array<[string, string]>,
    action: 'Set each variable above to a whole number of cents in the Vercel project environment, then redeploy.',
  };
}

/** A failed or returned automatic payout locked a recipient out of automation. */
export function noticeAutoPayoutsBlocked(input: {
  referrerUserId: string;
  payoutId: string;
  amountCents: number;
  reason: string;
}) {
  return {
    noticeKey: `auto-payouts-blocked:${input.payoutId}`,
    kind: 'auto-payouts-blocked' as const,
    referrerUserId: input.referrerUserId,
    payload: { payoutId: input.payoutId, amountCents: input.amountCents },
    minIntervalHours: null,
    subject: `Automatic payouts paused for one recipient after a ${formatCents(input.amountCents)} failure`,
    heading: 'An automatic payout failed and was paused',
    paragraphs: [
      `Stripe did not complete a ${formatCents(input.amountCents)} automatic payout. The referral balance was restored, so no money left the account and nothing was lost.`,
      'Automatic payouts for this recipient are now paused. They will not be retried tomorrow, because repeating a payment into an unknown failure is how one failure becomes many.',
    ],
    facts: [
      ['Amount', formatCents(input.amountCents)],
      ['Payout', input.payoutId],
      ['Reported reason', input.reason],
    ] as Array<[string, string]>,
    action: 'Check the recipient\'s bank enrollment in Stripe, then clear the pause from the admin Referrals page when it is safe to resume.',
  };
}
