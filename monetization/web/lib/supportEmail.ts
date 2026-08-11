/**
 * lib/supportEmail.ts
 *
 * Branded customer-facing email for a resolved support report.
 *
 * Server-only. The existing support-inbox send in app/api/support/report/route.ts
 * is deliberately left untouched — this module exists solely for the new
 * outbound-to-customer path, which has a different audience and a different
 * safety requirement: it must never fire from a developer's machine.
 */

const RESOLUTION_EMAIL_FROM_DEFAULT = 'StatfloBot Support <onboarding@resend.dev>';

export type CustomerEmailMode = 'live' | 'dry-run';

/**
 * Customer email is off unless this is a production deployment.
 *
 * `SUPPORT_CUSTOMER_EMAIL_MODE=dry-run` is a production kill switch. Non-
 * production environments are always dry-run even when a developer has a real
 * provider key, so tests and local previews cannot contact a customer.
 */
export function customerEmailMode(): CustomerEmailMode {
  const override = String(process.env.SUPPORT_CUSTOMER_EMAIL_MODE ?? '').trim().toLowerCase();
  if (override === 'dry-run') return 'dry-run';
  if (process.env.NODE_ENV !== 'production') return 'dry-run';
  if (!process.env.RESEND_API_KEY) return 'dry-run';
  return 'live';
}

export type SendResult =
  | { ok: true; providerId: string | null }
  | { ok: false; error: string };

/**
 * Send through Resend with a stable idempotency key.
 *
 * Exactly-once delivery is not achievable across the provider boundary: a
 * response can be lost after the provider has accepted. The key is what stops a
 * retry of a *lost response* from becoming a second email in the customer's
 * inbox, so it must be derived from the report, never from the attempt.
 */
export async function sendResendEmail(args: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  idempotencyKey: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'provider-not-configured' };

  const from = process.env.SUPPORT_EMAIL_FROM || RESOLUTION_EMAIL_FROM_DEFAULT;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': args.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
        subject: args.subject,
        html: args.html,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      // Provider detail stays server-side; callers surface a generic message.
      console.error(`[RESOLUTION_EMAIL_SEND_FAILED] status=${res.status} response=${JSON.stringify(body)}`);
      return { ok: false, error: `provider-http-${res.status}` };
    }
    return { ok: true, providerId: body?.id ?? null };
  } catch (err: any) {
    console.error(`[RESOLUTION_EMAIL_SEND_FAILED] reason=transport error=${err?.message ?? 'unknown'}`);
    return { ok: false, error: 'provider-unreachable' };
  }
}

function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Customer copy for a resolved report.
 *
 * Tone rules: calm, brief, no automation internals, and no claim that anything
 * shipped unless an owner tied the report to a version that is genuinely public
 * (`fixReleased`). Until then the message says a fix is coming, which stays true
 * whether or not the release lands this week.
 */
export function buildResolutionEmail(args: {
  reference: string;
  subject: string | null;
  resolutionMessage: string;
  fixedInVersion: string | null;
  fixReleased: boolean;
}): { subject: string; html: string } {
  const { reference, resolutionMessage, fixedInVersion, fixReleased } = args;

  const nextStep = fixReleased && fixedInVersion
    ? `<p style="margin:0 0 16px;color:#334155">This is included in StatfloBot v${escapeHtml(fixedInVersion)}. ` +
      `Open StatfloBot and choose <strong>Update Now</strong> when the notice appears, or use ` +
      `<strong>Account → App &amp; Updates → Check for updates</strong>.</p>`
    : `<p style="margin:0 0 16px;color:#334155">This will be included in an upcoming StatfloBot update. ` +
      `Your app updates itself, so there is nothing you need to install right now.</p>`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <p style="margin:0 0 4px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#6366f1;font-weight:600">StatfloBot Support</p>
  <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#0f172a">Your reported issue has been resolved</h1>

  <p style="margin:0 0 16px;color:#334155">Thank you for the report you sent us${
    args.subject ? ` about &ldquo;${escapeHtml(args.subject)}&rdquo;` : ''
  }. We have finished looking into it.</p>

  <div style="margin:0 0 20px;padding:16px 18px;background:#f8fafc;border-left:3px solid #6366f1;border-radius:6px">
    <p style="margin:0;color:#0f172a;line-height:1.6;white-space:pre-wrap">${escapeHtml(resolutionMessage)}</p>
  </div>

  ${nextStep}

  <p style="margin:0 0 24px;color:#64748b;font-size:13px">
    Reference <strong style="color:#334155">${escapeHtml(reference)}</strong> &middot;
    Reply to this email if the problem happens again and we will reopen it.
  </p>

  <p style="margin:0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
    StatfloBot &middot; You are receiving this because you sent us a support report from your StatfloBot account.
  </p>
</div>`.trim();

  return { subject: `Your StatfloBot report has been resolved (${reference})`, html };
}
