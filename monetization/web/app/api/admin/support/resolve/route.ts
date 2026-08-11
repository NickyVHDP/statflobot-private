import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import {
  ADMIN_REPORT_COLUMNS,
  MAX_RESOLUTION_MESSAGE_CHARS,
  compareVersions,
  getPublicAppVersion,
  isValidReportReference,
  normalizeVersion,
} from '@/lib/supportReports';
import { buildResolutionEmail, customerEmailMode, sendResendEmail } from '@/lib/supportEmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEND_LEASE_MS = 5 * 60 * 1000;

/** Resolve one report and notify its verified account owner. */
export async function POST(req: NextRequest) {
  const admin = await getAuthUser(req);
  if (!admin) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(admin.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body was not valid JSON.' }, { status: 400 });
  }

  const reference = String(body?.reference ?? '').trim();
  const resolutionMessage = String(body?.resolutionMessage ?? '').trim();
  const fixedInVersion = normalizeVersion(body?.fixedInVersion);
  if (!isValidReportReference(reference)) {
    return NextResponse.json({ ok: false, error: 'A valid report reference is required.' }, { status: 400 });
  }
  if (!resolutionMessage || resolutionMessage.length > MAX_RESOLUTION_MESSAGE_CHARS) {
    return NextResponse.json(
      { ok: false, error: `Resolution message must be 1-${MAX_RESOLUTION_MESSAGE_CHARS} characters.` },
      { status: 400 },
    );
  }
  if (!fixedInVersion) {
    return NextResponse.json({ ok: false, error: 'A valid released app version is required.' }, { status: 400 });
  }

  const publicVersion = getPublicAppVersion();
  const releaseComparison = publicVersion ? compareVersions(publicVersion, fixedInVersion) : null;
  if (!publicVersion || releaseComparison === null || releaseComparison < 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Version ${fixedInVersion} is not confirmed public. Publish it and update PUBLIC_APP_VERSION before notifying the customer.`,
        reason: 'fix-not-public',
        publicAppVersion: publicVersion,
      },
      { status: 409 },
    );
  }
  if (customerEmailMode() !== 'live') {
    return NextResponse.json(
      { ok: false, error: 'Customer resolution email is in dry-run mode; no report was changed.', reason: 'email-dry-run' },
      { status: 503 },
    );
  }

  const svc = createServiceClient();
  const { data: existing, error: lookupError } = await svc
    .from('support_reports')
    .select(ADMIN_REPORT_COLUMNS)
    .eq('reference', reference)
    .maybeSingle();

  if (lookupError) {
    console.error(`[api/admin/support/resolve] lookup failed ref=${reference}: ${lookupError.message}`);
    return NextResponse.json({ ok: false, error: 'Could not load that support report.' }, { status: 500 });
  }
  if (!existing) return NextResponse.json({ ok: false, error: 'Support report not found.' }, { status: 404 });
  if (existing.status === 'closed') {
    return NextResponse.json({ ok: false, error: 'This support report is closed.' }, { status: 409 });
  }

  const sameResolution = existing.resolution_message === resolutionMessage
    && normalizeVersion(existing.fixed_in_version) === fixedInVersion;
  if (existing.status === 'resolved' && existing.resolution_email_status === 'sent') {
    if (!sameResolution) {
      return NextResponse.json({ ok: false, error: 'This report was already resolved with different details.' }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      duplicate: true,
      reference,
      emailSent: true,
      providerId: existing.resolution_email_provider_id ?? null,
    });
  }
  if (existing.status === 'resolved' && !sameResolution) {
    return NextResponse.json({ ok: false, error: 'This report was already resolved with different details.' }, { status: 409 });
  }

  const attemptedAt = existing.resolution_email_attempted_at
    ? new Date(existing.resolution_email_attempted_at).getTime()
    : 0;
  if (existing.resolution_email_status === 'sending' && Date.now() - attemptedAt < SEND_LEASE_MS) {
    return NextResponse.json({ ok: false, error: 'Resolution notification is already being sent.' }, { status: 409 });
  }

  const { data: authResult, error: authError } = await svc.auth.admin.getUserById(existing.user_id);
  const customerEmail = authResult?.user?.email?.trim();
  const emailConfirmedAt = authResult?.user?.email_confirmed_at;
  if (authError || !customerEmail || !emailConfirmedAt) {
    return NextResponse.json({ ok: false, error: 'The reporting account has no verified email address.' }, { status: 409 });
  }

  const now = new Date().toISOString();
  const claimPatch = {
    status: 'resolved',
    resolution_message: resolutionMessage,
    fixed_in_version: fixedInVersion,
    resolved_at: existing.resolved_at ?? now,
    resolved_by_user_id: admin.id,
    resolved_by_email: admin.email ?? null,
    resolution_email_status: 'sending',
    resolution_email_attempted_at: now,
    resolution_email_attempts: Number(existing.resolution_email_attempts ?? 0) + 1,
    resolution_email_error: null,
  };
  let claimQuery = svc
    .from('support_reports')
    .update(claimPatch)
    .eq('id', existing.id)
    .eq('resolution_email_status', existing.resolution_email_status);
  // A stale `sending` lease is reclaimed by matching its exact old timestamp.
  // Without this second compare-and-swap condition, two retries could both
  // update sending→sending and race the provider call.
  if (existing.resolution_email_status === 'sending' && existing.resolution_email_attempted_at) {
    claimQuery = claimQuery.eq('resolution_email_attempted_at', existing.resolution_email_attempted_at);
  }
  const { data: claimed, error: claimError } = await claimQuery
    .select('id, reference')
    .maybeSingle();

  if (claimError) {
    console.error(`[api/admin/support/resolve] claim failed ref=${reference}: ${claimError.message}`);
    return NextResponse.json({ ok: false, error: 'Could not save the resolution.' }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ ok: false, error: 'This report changed while it was being resolved. Refresh and try again.' }, { status: 409 });
  }

  const email = buildResolutionEmail({
    reference,
    subject: existing.subject,
    resolutionMessage,
    fixedInVersion,
    fixReleased: true,
  });
  const send = await sendResendEmail({
    to: customerEmail,
    replyTo: process.env.SUPPORT_EMAIL_TO,
    subject: email.subject,
    html: email.html,
    idempotencyKey: `support-resolution-${existing.id}`,
  });

  if (!send.ok) {
    await svc.from('support_reports').update({
      resolution_email_status: 'failed',
      resolution_email_error: send.error.slice(0, 500),
    }).eq('id', existing.id).eq('resolution_email_status', 'sending');
    return NextResponse.json(
      { ok: false, emailSent: false, error: 'The resolution was saved, but the customer email was not delivered. Retry is safe.' },
      { status: 502 },
    );
  }

  const { error: sentWriteError } = await svc.from('support_reports').update({
    resolution_email_status: 'sent',
    resolution_email_sent_at: new Date().toISOString(),
    resolution_email_provider_id: send.providerId,
    resolution_email_error: null,
  }).eq('id', existing.id).eq('resolution_email_status', 'sending');
  if (sentWriteError) {
    console.error(`[api/admin/support/resolve] sent status write failed ref=${reference}: ${sentWriteError.message}`);
  }

  console.log(`[SUPPORT_REPORT_RESOLVED] ref=${reference} admin=${admin.id} fixedIn=${fixedInVersion}`);
  return NextResponse.json({ ok: true, emailSent: true, reference, fixedInVersion, providerId: send.providerId });
}
