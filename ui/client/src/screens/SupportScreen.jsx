import { useState, useEffect } from 'react';
import { ArrowLeft, Send, FileText, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';

export default function SupportScreen({ user }) {
  const params          = new URLSearchParams(window.location.search);
  const attachLatestLog = params.get('attachLatestLog') === '1';

  const [email,       setEmail]       = useState(user?.email ?? '');
  const [subject,     setSubject]     = useState('');
  const [description, setDescription] = useState('');
  const [logContent,  setLogContent]  = useState(null);
  const [logFile,     setLogFile]     = useState(null);
  const [logStatus,   setLogStatus]   = useState(null);
  const [loadingLog,  setLoadingLog]  = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [result,      setResult]      = useState(null);
  const [formError,   setFormError]   = useState(null);

  useEffect(() => {
    if (!attachLatestLog) return;
    setLoadingLog(true);
    console.log('[SUPPORT_REPORT_ROUTE_OPENED] fetching latest log');
    fetch('/api/logs/latest')
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.content) {
          setLogContent(data.content);
          setLogFile(data.logFile ?? null);
          setLogStatus(data.status ?? null);
          console.log('[SUPPORT_REPORT_LOG_ATTACHED] latest log pre-filled');
        }
      })
      .catch(() => {})
      .finally(() => setLoadingLog(false));
  }, [attachLatestLog]);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    if (!email.trim() || !subject.trim() || !description.trim()) {
      setFormError('Please fill in Email, Subject, and Description before sending.');
      return;
    }
    setSubmitting(true);
    try {
      const version  = await window.electron?.getVersion?.().catch(() => null);
      const platform = window.electron?.getPlatform?.() ?? navigator.platform ?? 'unknown';
      const res = await fetch('/api/support/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:       email.trim(),
          subject:     subject.trim(),
          description: description.trim(),
          logContent,
          logFile,
          runStatus: logStatus,
          version:   version ? `v${version}` : 'unknown',
          platform,
        }),
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ ok: false, emailError: err.message });
    } finally {
      setSubmitting(false);
    }
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
            <h2 className="text-lg font-semibold text-white mb-1">Report submitted</h2>
            <p className="text-sm" style={{ color: '#94a3b8', lineHeight: 1.6 }}>
              {result.emailSent
                ? 'Your report has been saved and emailed to the support team. We will get back to you at the address you provided.'
                : 'Your report has been saved locally. Email delivery is not configured — to reach support, copy and paste the log from Account → Recent Run Logs.'}
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

        {formError && (
          <div
            className="mb-4 rounded-xl px-4 py-3 text-sm border flex items-center gap-2"
            style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.2)', color: '#f87171' }}
          >
            <AlertTriangle size={13} className="flex-shrink-0" />
            {formError}
          </div>
        )}

        {result && !result.ok && (
          <div
            className="mb-4 rounded-xl px-4 py-3 text-sm border flex items-center gap-2"
            style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.2)', color: '#f87171' }}
          >
            <AlertTriangle size={13} className="flex-shrink-0" />
            Submission failed: {result.emailError ?? 'unknown error'}. Your report was {result.saved ? 'saved locally.' : 'not saved.'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Email */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Email <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              style={inputStyle}
            />
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Subject <span style={{ color: '#f87171' }}>*</span>
            </label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="e.g. Bot stuck waiting for Send button"
              required
              style={inputStyle}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Describe your problem <span style={{ color: '#f87171' }}>*</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What were you doing? What did you expect? What actually happened?"
              required
              rows={5}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 100 }}
            />
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
            ) : logContent ? (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(99,102,241,0.2)' }}>
                <div
                  className="flex items-center justify-between px-3 py-2 border-b text-xs"
                  style={{ background: '#13131a', borderColor: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
                >
                  <span className="flex items-center gap-1.5 font-mono truncate">
                    <FileText size={11} />
                    {logFile ? logFile.split(/[/\\]/).slice(-1)[0] : 'latest-run.log'}
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
                  className="px-3 py-2 max-h-28 overflow-y-auto"
                  style={{ background: '#060610' }}
                >
                  <pre
                    className="text-xs"
                    style={{ color: '#475569', lineHeight: '15px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}
                  >
                    {logContent.split('\n').slice(-20).join('\n')}
                  </pre>
                </div>
                <div
                  className="px-3 py-1.5 border-t text-xs"
                  style={{ background: '#13131a', borderColor: 'rgba(99,102,241,0.15)', color: '#475569' }}
                >
                  {logContent.split('\n').length} lines will be included
                </div>
              </div>
            ) : (
              <div
                className="rounded-xl px-4 py-3 text-xs"
                style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.06)', color: '#475569' }}
              >
                No log attached — start a run first, then return here to send the report.
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
