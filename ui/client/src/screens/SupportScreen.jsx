import { useState, useEffect } from 'react';
import { ArrowLeft, Send, FileText, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { getAccessToken } from '../lib/cloudApi';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read a fetch Response without assuming it is JSON.
 *
 * A 404/500/proxy error returns an HTML error page; calling res.json() on that
 * throws `Unexpected token '<'` and hides the real status. This surfaces the
 * status and endpoint instead.
 */
async function readJsonResponse(res, endpoint) {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const preview = (await res.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ').trim();
    console.warn(`[SUPPORT_REPORT_NON_JSON_RESPONSE] status=${res.status} endpoint=${endpoint} contentType="${contentType}"`);
    return {
      ok: false,
      emailSent: false,
      emailError:
        `Server returned ${res.status} ${res.statusText || ''} (not JSON) from ${endpoint}. ` +
        (preview ? `Response began: "${preview}…"` : 'The endpoint may be missing or the local server is not running.'),
    };
  }
  const data = await res.json().catch(() => null);
  if (!data) {
    return { ok: false, emailSent: false, emailError: `Server returned an unreadable JSON body (status ${res.status}) from ${endpoint}.` };
  }
  // Trust the transport status as well as the payload — never treat a non-2xx as success.
  if (!res.ok && data.ok !== false) {
    return { ...data, ok: false, emailError: data.error ?? data.emailError ?? `Server returned status ${res.status}.` };
  }
  return data;
}

function accountContact(user, account) {
  return {
    name: String(
      account?.profile?.full_name
      ?? user?.user_metadata?.full_name
      ?? user?.user_metadata?.name
      ?? ''
    ).trim(),
    email: String(account?.profile?.email ?? user?.email ?? '').trim(),
  };
}

export default function SupportScreen({ user, account }) {
  const params          = new URLSearchParams(window.location.search);
  const attachLatestLog = params.get('attachLatestLog') === '1';
  const attachHistoryRun = params.get('attachHistoryRun') === '1';
  const failedRunPrompt = params.get('failedRunPrompt') === '1';
  const promptedRunStatus = params.get('runStatus') ?? 'error';

  const initialContact = accountContact(user, account);
  const [name,        setName]        = useState(initialContact.name);
  const [email,       setEmail]       = useState(initialContact.email);
  const [subject,     setSubject]     = useState('');
  const [description, setDescription] = useState('');
  const [logContent,  setLogContent]  = useState(null);
  const [logFile,     setLogFile]     = useState(null);
  const [logStatus,   setLogStatus]   = useState(null);
  const [logUnavailableReason, setLogUnavailableReason] = useState(null);
  const [historyRunId, setHistoryRunId] = useState(null);
  const [loadingLog,  setLoadingLog]  = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [result,      setResult]      = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  // Account/profile data can resolve after this route renders. Fill any still
  // empty contact fields, but never overwrite something the customer typed.
  useEffect(() => {
    const contact = accountContact(user, account);
    if (contact.name && !name) setName(contact.name);
    if (contact.email && !email) setEmail(contact.email);
  }, [user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name, account?.profile?.full_name, account?.profile?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const runId = params.get('runId') ?? 'none';
    console.log(`[SUPPORT_REPORT_ROUTE_OPENED] runId=${runId} attachLatestLog=${attachLatestLog} attachHistoryRun=${attachHistoryRun}`);
    if (attachHistoryRun) {
      try {
        const raw = sessionStorage.getItem('statflobot_support_history_run');
        const run = raw ? JSON.parse(raw) : null;
        sessionStorage.removeItem('statflobot_support_history_run');
        if (!run?.id) throw new Error('selected history record is unavailable');
        setHistoryRunId(run.id);
        setLogContent(null);
        setLogFile(`cloud-run-${String(run.id).slice(0, 36)}.txt`);
        setLogStatus(run.status ?? null);
        setSubject(`StatfloBot run issue — ${run.list_name ?? 'Unknown list'}`);
        setDescription('Please review the attached run details and help me understand what went wrong.');
        setLogUnavailableReason(null);
        console.log('[SUPPORT_REPORT_HISTORY_RUN_ATTACHED] selected cloud history record pre-filled');
      } catch (err) {
        setLogUnavailableReason(err.message);
        console.warn(`[SUPPORT_REPORT_HISTORY_RUN_UNAVAILABLE] reason=${err.message}`);
      }
      return;
    }
    if (!attachLatestLog) return;
    // Do not load raw diagnostics into the renderer. The local server resolves
    // and attaches the latest run privately only after the report is submitted.
    setLogContent(null);
    setLogFile('latest-run.log');
    setLogStatus(failedRunPrompt ? promptedRunStatus : null);
    setLogUnavailableReason(null);
    if (failedRunPrompt) {
      const partialFailure = promptedRunStatus === 'completed_with_errors';
      setSubject(partialFailure ? 'StatfloBot run completed with errors' : 'StatfloBot failed run report');
      setDescription(
        partialFailure
          ? 'The latest run completed, but one or more clients failed. Please review the privately attached diagnostics.'
          : 'The latest run did not complete successfully. Please review the privately attached diagnostics and help resolve the issue.'
      );
    }
  }, [attachLatestLog, attachHistoryRun, failedRunPrompt, promptedRunStatus]);

  /** Validate each field independently so every error renders under its own input. */
  function validate() {
    const errors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail)                  errors.email = 'Please enter your email address.';
    else if (!EMAIL_RE.test(trimmedEmail)) errors.email = 'Please enter a valid email address.';
    if (!subject.trim())                errors.subject = 'Please enter a subject.';
    if (!description.trim())            errors.description = 'Please describe what happened.';
    return errors;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setResult(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      console.warn(`[SUPPORT_FORM_VALIDATION_FAILED] fields=${Object.keys(errors).join(',')}`);
      return;
    }

    setSubmitting(true);
    const endpoint = '/api/support/report';
    try {
      const version  = await window.electron?.getVersion?.().catch(() => null);
      const platform = window.electron?.getPlatform?.() ?? navigator.platform ?? 'unknown';
      const token    = await getAccessToken().catch(() => '');

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name:         name.trim(),
          email:        email.trim(),
          contactEmail: email.trim(),
          accountEmail: user?.email ?? null,
          subject:      subject.trim(),
          description:  description.trim(),
          logContent,
          logFile,
          logAvailable: Boolean(logContent || attachLatestLog || historyRunId),
          logUnavailableReason,
          attachLatestLog,
          historyRunId,
          runStatus: logStatus,
          version:   version ? `v${version}` : 'unknown',
          platform,
          timestamp: new Date().toISOString(),
        }),
      });

      const data = await readJsonResponse(res, endpoint);
      // Server-side field errors map back onto the same per-field UI.
      if (data.fieldErrors) setFieldErrors(data.fieldErrors);
      setResult(data);
    } catch (err) {
      console.warn(`[SUPPORT_REPORT_SUBMIT_FAILED] ${err.message}`);
      setResult({
        ok: false,
        emailSent: false,
        emailError: `Could not reach the local app server (${endpoint}): ${err.message}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  const errorTextStyle = { color: '#f87171', fontSize: 12, marginTop: 6 };

  function fieldBorder(field) {
    return fieldErrors[field] ? '1px solid rgba(248,113,113,0.55)' : '1px solid rgba(255,255,255,0.08)';
  }

  function handleBack() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  }

  const inputStyle = {
    background: '#1a1a2e',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#f1f5f9',
    borderRadius: 12,
    padding: '10px 16px',
    width: '100%',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  };

  // ── Success view ─────────────────────────────────────────────────────────
  if (result?.ok) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-6 max-w-2xl mx-auto w-full">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-xs mb-6 transition-colors hover:text-white"
          style={{ color: '#64748b' }}
        >
          <ArrowLeft size={13} /> Back
        </button>
        <div
          className="rounded-2xl p-8 border flex flex-col items-center gap-4 text-center"
          style={{ background: '#13131f', borderColor: 'rgba(134,239,172,0.2)' }}
        >
          <CheckCircle size={40} style={{ color: '#86efac' }} />
          <div>
            <h2 className="text-lg font-semibold text-white mb-1">Report sent</h2>
            <p className="text-sm" style={{ color: '#94a3b8', lineHeight: 1.6 }}>
              Your report was emailed to the support team. We will get back to you at the address you provided.
            </p>
            <p className="text-xs mt-2" style={{ color: '#64748b', lineHeight: 1.6 }}>
              {result.logIncluded
                ? `Your attached run log was included${result.logTruncated ? ' (trimmed to the most recent lines)' : ''}.`
                : `Run details were not included — ${result.logUnavailableReason ?? 'no run log was available'}.`}
            </p>
          </div>
          <button
            onClick={handleBack}
            className="mt-2 px-5 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: '#1e1e2e', color: '#818cf8', border: '1px solid #2e2e3e' }}
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  // ── Form view ────────────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen"
      style={{ background: '#0a0a0f' }}
    >
      <div className="px-6 py-6 max-w-2xl mx-auto w-full">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-xs mb-6 transition-colors hover:text-white"
          style={{ color: '#64748b' }}
        >
          <ArrowLeft size={13} /> Back to Account
        </button>

        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Send Support Report</h1>
          <p className="text-sm mt-0.5" style={{ color: '#64748b' }}>
            Describe the issue and we will follow up.
          </p>
        </div>

        {result && !result.ok && (
          <div
            className="mb-4 rounded-xl px-4 py-3 text-sm border flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.2)', color: '#f87171' }}
          >
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Your report was not sent.</div>
              <div className="mt-1" style={{ lineHeight: 1.5 }}>
                {result.emailError ?? result.error ?? 'Unknown error.'}
              </div>
              <div className="mt-1" style={{ color: '#fca5a5' }}>
                {result.saved
                  ? 'A copy was saved on this computer, so nothing was lost.'
                  : 'The report could not be saved locally either.'}
              </div>
            </div>
          </div>
        )}

        {/* noValidate: we render our own per-field errors so the browser never
            anchors a generic validation bubble to the wrong input. */}
        <form onSubmit={handleSubmit} noValidate className="space-y-5">

          {/* Name */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Your name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="First and last name"
              style={inputStyle}
            />
          </div>

          {/* Contact email */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Best email to reach you <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={e => {
                setEmail(e.target.value);
                if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: undefined }));
              }}
              placeholder="your@email.com"
              aria-invalid={Boolean(fieldErrors.email)}
              style={{ ...inputStyle, border: fieldBorder('email') }}
            />
            {user?.email && (
              <p className="text-xs mt-1.5" style={{ color: '#475569' }}>
                Signed in as {user.email} — change this if you would rather we replied elsewhere.
              </p>
            )}
            {fieldErrors.email && <p style={errorTextStyle}>{fieldErrors.email}</p>}
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Subject <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              type="text"
              value={subject}
              onChange={e => {
                setSubject(e.target.value);
                if (fieldErrors.subject) setFieldErrors(prev => ({ ...prev, subject: undefined }));
              }}
              placeholder="e.g. Bot stuck waiting for Send button"
              aria-invalid={Boolean(fieldErrors.subject)}
              style={{ ...inputStyle, border: fieldBorder('subject') }}
            />
            {fieldErrors.subject && <p style={errorTextStyle}>{fieldErrors.subject}</p>}
          </div>

          {/* What happened */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              What happened <span style={{ color: '#f87171' }}>*</span>
            </label>
            <textarea
              value={description}
              onChange={e => {
                setDescription(e.target.value);
                if (fieldErrors.description) setFieldErrors(prev => ({ ...prev, description: undefined }));
              }}
              placeholder="What were you doing? What did you expect? What actually happened?"
              rows={5}
              aria-invalid={Boolean(fieldErrors.description)}
              style={{ ...inputStyle, border: fieldBorder('description'), resize: 'vertical', minHeight: 100 }}
            />
            {fieldErrors.description && <p style={errorTextStyle}>{fieldErrors.description}</p>}
          </div>

          {/* Attached logs */}
          <div>
            <label
              className="flex items-center gap-1.5 text-xs font-medium mb-1.5"
              style={{ color: '#94a3b8' }}
            >
              <FileText size={11} />
              Attached logs
            </label>

            {loadingLog ? (
              <div
                className="flex items-center gap-2 rounded-xl px-4 py-3 text-xs"
                style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.06)', color: '#64748b' }}
              >
                <Loader2 size={11} className="animate-spin" />
                Loading latest log…
              </div>
            ) : (attachLatestLog || historyRunId) ? (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(99,102,241,0.2)' }}>
                <div
                  className="flex items-center justify-between px-3 py-2 border-b text-xs"
                  style={{ background: '#13131a', borderColor: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
                >
                  <span className="flex items-center gap-1.5 font-mono truncate">
                    <FileText size={11} />
                    {historyRunId ? 'Selected run diagnostics' : 'Latest run diagnostics'}
                  </span>
                  {logStatus && (
                    <span
                      className="flex-shrink-0 ml-2 px-2 py-0.5 rounded-full text-xs"
                      style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}
                    >
                      {logStatus}
                    </span>
                  )}
                </div>
                <div
                  className="px-3 py-3 text-xs"
                  style={{ background: '#13131a', borderColor: 'rgba(99,102,241,0.15)', color: '#475569' }}
                >
                  Technical details stay private. The server will attach them directly to your support report.
                </div>
              </div>
            ) : (
              <div
                className="rounded-xl px-4 py-3 text-xs"
                style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.06)', color: '#475569' }}
              >
                Latest failed logs unavailable
                {logUnavailableReason ? ` — ${logUnavailableReason}` : ''}. The report will still send,
                and will say the logs could not be attached.
              </div>
            )}
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-60"
            style={{
              background: submitting
                ? '#1e1e2e'
                : 'linear-gradient(135deg, #6366f1, #818cf8)',
              color: '#fff',
              border: 'none',
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? (
              <><Loader2 size={14} className="animate-spin" /> Sending report…</>
            ) : (
              <><Send size={14} /> Send Report</>
            )}
          </button>

        </form>
      </div>
    </div>
  );
}
