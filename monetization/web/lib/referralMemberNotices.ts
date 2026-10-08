import { createServiceClient } from './supabase/server';
import { sendResendEmail } from './supportEmail';

export type EarlyReleaseNoticeResult = 'sent' | 'dry-run' | 'no-email' | 'failed';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

async function memberEmail(userId: string): Promise<string | null> {
  const svc = createServiceClient();
  const { data: profile } = await svc
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();
  if (profile?.email) return String(profile.email).trim().toLowerCase();

  const { data } = await svc.auth.admin.getUserById(userId);
  return data?.user?.email ? data.user.email.trim().toLowerCase() : null;
}

/**
 * Notify a referrer when the owner releases a reward before the normal hold.
 *
 * The approval row is immutable and unique per attribution, so the attribution
 * id is also a stable provider idempotency key. Email is best-effort: a mail
 * outage can never roll back the financial approval, and the same notice is
 * also shown persistently in the member's Rewards Hub.
 */
export async function sendEarlyReleaseNotice(input: {
  attributionId: string;
  referrerUserId: string;
  amountCents: number;
  bankReady: boolean;
  payoutSubmitted: boolean;
}): Promise<EarlyReleaseNoticeResult> {
  if (process.env.NODE_ENV !== 'production' || !process.env.RESEND_API_KEY) {
    console.log(`[REFERRAL_MEMBER_NOTICE_DRY_RUN] kind=early-release attribution=${input.attributionId}`);
    return 'dry-run';
  }

  try {
    const email = await memberEmail(input.referrerUserId);
    if (!email) {
      console.warn(`[REFERRAL_MEMBER_NOTICE_NO_EMAIL] referrer=${input.referrerUserId}`);
      return 'no-email';
    }

    const nextStep = input.bankReady
      ? input.payoutSubmitted
        ? 'Your bank deposit has been submitted through Stripe. Bank processing time may vary.'
        : 'Your reward is available for payout. No action is required unless your Rewards Hub asks you to update your bank setup.'
      : 'To receive this reward, open StatfloBot, go to Account → Referral Rewards, and complete the secure Stripe bank setup.';

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;font-weight:600">StatfloBot Referral Rewards</p>
  <h1 style="margin:0 0 20px;font-size:22px;font-weight:700">Your referral reward was approved early</h1>
  <p style="margin:0 0 16px;color:#334155;line-height:1.6">The StatfloBot owner approved your <strong>${escapeHtml(money(input.amountCents))}</strong> referral reward for early payout instead of requiring the remainder of the standard 30-day clearing period.</p>
  <div style="margin:0 0 20px;padding:16px 18px;background:#f8fafc;border-left:3px solid #6366f1;border-radius:6px">
    <p style="margin:0;color:#0f172a;line-height:1.6">${escapeHtml(nextStep)}</p>
  </div>
  ${!input.bankReady ? `<p style="margin:0 0 20px"><a href="https://statflobot.store/dashboard" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600">Complete bank setup</a></p>` : ''}
  <p style="margin:0 0 16px;color:#475569;font-size:13px;line-height:1.6"><strong>Important:</strong> If the referred purchase is later refunded or charged back, its reward is reversed. If that reward has already been paid, your referral balance may become negative. Future referral rewards first offset that balance, and no additional payout can be sent until the balance is positive and meets the payout threshold.</p>
  <p style="margin:0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">This notice is private to your StatfloBot account. Stripe securely handles bank details; StatfloBot does not see or store your bank account or routing numbers.</p>
</div>`.trim();

    const sent = await sendResendEmail({
      to: email,
      subject: `Your ${money(input.amountCents)} StatfloBot referral reward was approved early`,
      html,
      idempotencyKey: `referral-early-release-${input.attributionId}`,
    });
    if (!sent.ok) {
      console.error(`[REFERRAL_MEMBER_NOTICE_FAILED] attribution=${input.attributionId} error=${sent.error}`);
      return 'failed';
    }
    console.log(`[REFERRAL_MEMBER_NOTICE_SENT] kind=early-release attribution=${input.attributionId}`);
    return 'sent';
  } catch (err: any) {
    console.error('[REFERRAL_MEMBER_NOTICE_FAILED]', String(err?.message ?? err));
    return 'failed';
  }
}
