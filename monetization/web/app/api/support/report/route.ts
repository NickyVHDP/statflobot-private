import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

/**
 * POST /api/support/report
 *
 * Delivers a desktop support report to the support inbox.
 *
 * Email is sent from here — never from the desktop app — because the provider
 * key must not ship inside an Electron bundle that customers can unpack.
 * The desktop server (ui/server/index.js) forwards the report to this route
 * with the user's Bearer token.
 *
 * Always responds JSON, including on failure, and only reports emailSent:true
 * when the provider actually accepted the message.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPORT_EMAIL_TO_DEFAULT = 'nickymccracken159@gmail.com';
// Resend's shared sender works without a verified domain; override in prod env.
const SUPPORT_EMAIL_FROM_DEFAULT = 'StatfloBot Support <onboarding@resend.dev>';

// Resend caps request bodies. Keep the tail — that is where failures appear.
const MAX_LOG_CHARS = 250_000;

function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, emailSent: false, error: 'Request body was not valid JSON.' },
      { status: 400 },
    );
  }

  // Auth: reports are tied to an account so this cannot be used as an open relay.
  const user = await getAuthUser(req);
  if (!user) {
    console.warn('[REPORT_EMAIL_SEND_FAILED] reason=unauthenticated');
    return NextResponse.json(
      { ok: false, emailSent: false, error: 'Not authenticated — sign in before sending a support report.' },
      { status: 401 },
    );
  }

  const contactEmail = String(body.contactEmail ?? body.email ?? '').trim();
  const subject      = String(body.subject ?? '').trim();
  const description  = String(body.description ?? '').trim();

  const fieldErrors: Record<string, string> = {};
  if (!contactEmail) fieldErrors.email = 'Please enter your email address.';
  else if (!isValidEmail(contactEmail)) fieldErrors.email = 'Please enter a valid email address.';
  if (!subject) fieldErrors.subject = 'Please enter a subject.';
  if (!description) fieldErrors.description = 'Please describe what happened.';

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      { ok: false, emailSent: false, error: 'Please correct the highlighted fields.', fieldErrors },
      { status: 400 },
    );
  }

  const supportEmailTo = process.env.SUPPORT_EMAIL_TO || SUPPORT_EMAIL_TO_DEFAULT;
  const supportEmailFrom = process.env.SUPPORT_EMAIL_FROM || SUPPORT_EMAIL_FROM_DEFAULT;
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    // Misconfiguration must be loud and must NOT look like a success to the user.
    console.error('[REPORT_EMAIL_SEND_FAILED] reason=missing-provider-key env=RESEND_API_KEY');
    return NextResponse.json(
      {
        ok: false,
        emailSent: false,
        error: 'Support email is not configured on the server. Please email support directly.',
        reason: 'provider-not-configured',
      },
      { status: 500 },
    );
  }

  // ── Log inclusion — degrade to an explicit notice, never silently drop ─────
  // A customer can select a run by ID without ever receiving its diagnostic
  // log. Resolve the log here, scoped to the authenticated account, and attach
  // it directly to the private support email.
  let historyLog = '';
  let historyLogFile = '';
  const historyRunId = typeof body.historyRunId === 'string' ? body.historyRunId.trim() : '';
  if (historyRunId && /^[0-9a-f-]{36}$/i.test(historyRunId)) {
    const svc = createServiceClient();
    const { data: run, error: runError } = await svc
      .from('bot_runs')
      .select('id, raw_log_sanitized')
      .eq('id', historyRunId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (runError) console.warn(`[support/report] history lookup failed userId=${user.id}: ${runError.message}`);
    if (run?.raw_log_sanitized) {
      historyLog = String(run.raw_log_sanitized);
      historyLogFile = `cloud-run-${run.id}.txt`;
    }
  }

  const rawLog = historyLog || (typeof body.logContent === 'string' ? body.logContent : '');
  const logAvailable = rawLog.length > 0;
  const logUnavailableReason = body.logUnavailableReason ?? 'no log content supplied';

  let logText: string;
  let logTruncated = Boolean(body.logTruncated);
  if (logAvailable) {
    if (rawLog.length > MAX_LOG_CHARS) {
      logText = `…[truncated ${rawLog.length - MAX_LOG_CHARS} earlier characters]…\n` + rawLog.slice(-MAX_LOG_CHARS);
      logTruncated = true;
    } else {
      logText = rawLog;
    }
  } else {
    logText = `latest failed logs unavailable — ${logUnavailableReason}`;
  }

  const meta: Array<[string, string]> = [
    ['Name',           String(body.name ?? 'not provided')],
    ['Contact email',  contactEmail],
    ['Account email',  String(body.accountEmail ?? user.email ?? 'unknown')],
    ['Account ID',     user.id],
    ['Subject',        subject],
    ['App version',    String(body.version ?? 'unknown')],
    ['Platform / OS',  String(body.platform ?? 'unknown')],
    ['Run status',     String(body.runStatus ?? 'none')],
    ['Log file',       String(historyLogFile || body.logFile || 'none')],
    ['Logs included',  logAvailable ? (logTruncated ? 'yes (truncated)' : 'yes') : `no — ${logUnavailableReason}`],
    ['Timestamp',      String(body.timestamp ?? new Date().toISOString())],
  ];

  const html = [
    '<h2>StatfloBot Support Report</h2>',
    '<table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">',
    ...meta.map(([k, v]) => `<tr><td style="color:#666">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`),
    '</table>',
    '<hr/>',
    '<h3>What happened</h3>',
    `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;white-space:pre-wrap">${escapeHtml(description)}</pre>`,
    ...(body.botErrorSummary
      ? ['<h3>Recent bot error summary</h3>',
         `<pre style="background:#fff4f4;padding:12px;border-radius:4px;white-space:pre-wrap">${escapeHtml(body.botErrorSummary)}</pre>`]
      : []),
    `<h3>Latest failed run log${logTruncated ? ' (truncated)' : ''}</h3>`,
    `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:11px;white-space:pre-wrap">${escapeHtml(logText)}</pre>`,
  ].join('\n');

  console.log(`[REPORT_EMAIL_SEND_ATTEMPT] to=${supportEmailTo} from=${supportEmailFrom} user=${user.id} logIncluded=${logAvailable}`);

  try {
    const providerRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: supportEmailFrom,
        to: [supportEmailTo],
        reply_to: contactEmail,
        subject: `[StatfloBot Support] ${subject}`,
        html,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const providerBody = await providerRes.json().catch(() => ({} as any));

    if (!providerRes.ok) {
      // Full provider response server-side only — never returned to the client.
      console.error(
        `[REPORT_EMAIL_SEND_FAILED] status=${providerRes.status} provider=resend response=${JSON.stringify(providerBody)}`,
      );
      return NextResponse.json(
        {
          ok: false,
          emailSent: false,
          error: `Email provider rejected the report (HTTP ${providerRes.status}). Support has been notified.`,
          reason: 'provider-error',
        },
        { status: 502 },
      );
    }

    console.log(`[REPORT_EMAIL_SEND_SUCCESS] id=${providerBody?.id ?? 'unknown'} to=${supportEmailTo} user=${user.id}`);
    return NextResponse.json({
      ok: true,
      emailSent: true,
      providerId: providerBody?.id ?? null,
      logIncluded: logAvailable,
      logUnavailableReason: logAvailable ? null : logUnavailableReason,
      logTruncated,
    });
  } catch (err: any) {
    console.error(`[REPORT_EMAIL_SEND_FAILED] reason=transport error=${err?.message ?? 'unknown'}`);
    return NextResponse.json(
      {
        ok: false,
        emailSent: false,
        error: 'Could not reach the email provider. Please try again shortly.',
        reason: 'provider-unreachable',
      },
      { status: 502 },
    );
  }
}
