'use client';

import { useState, useEffect } from 'react';
import { Send, CheckCircle } from 'lucide-react';

interface Props {
  supportEmail: string;
}

export default function SupportContactForm({ supportEmail }: Props) {
  const [name,    setName]    = useState('');
  const [email,   setEmail]   = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent,    setSent]    = useState(false);
  const [sending, setSending] = useState(false);
  const [error,   setError]   = useState('');
  const [historyRunId, setHistoryRunId] = useState('');

  // Prefill subject/message from a run log stored by the dashboard "Send to support" flow
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('statflobot_run_log');
      if (!raw) return;
      const log = JSON.parse(raw);
      if (log.id) setHistoryRunId(String(log.id));
      if (log.subject) setSubject(log.subject);
      if (log.listName) setMessage('Please review this run and help me understand what went wrong.');
    } catch {
      // ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !email || !subject || !message) return;
    setSending(true);
    setError('');
    try {
      const response = await fetch('/api/support/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          contactEmail: email,
          subject,
          description: message,
          historyRunId: historyRunId || null,
          logAvailable: historyRunId ? true : false,
          logUnavailableReason: historyRunId ? null : 'no run selected',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'The report could not be sent.');
      sessionStorage.removeItem('statflobot_run_log');
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be sent.');
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div
        className="p-6 rounded-2xl border flex flex-col items-center gap-3 text-center"
        style={{ background: 'var(--card)', borderColor: 'rgba(134,239,172,0.25)' }}
      >
        <CheckCircle size={28} style={{ color: '#86efac' }} />
        <p className="text-white font-semibold text-sm">Report sent securely.</p>
        <p className="text-slate-400 text-xs">
          Support received your report{historyRunId ? ' with the selected run diagnostics attached privately' : ''}. We will reply at {email}. If needed, email{' '}
          <a href={`mailto:${supportEmail}`} className="underline hover:text-white transition-colors">
            {supportEmail}
          </a>
        </p>
        <button
          onClick={() => setSent(false)}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors mt-1"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Name</label>
          <input
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Your name"
            className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-slate-600 outline-none focus:ring-1 focus:ring-violet-500/50 border transition-colors"
            style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-slate-600 outline-none focus:ring-1 focus:ring-violet-500/50 border transition-colors"
            style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-slate-400 mb-1.5">Subject</label>
        <input
          type="text"
          required
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="e.g. Billing question, bot issue, access problem"
          className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-slate-600 outline-none focus:ring-1 focus:ring-violet-500/50 border transition-colors"
          style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
        />
      </div>

      <div>
        <label className="block text-xs text-slate-400 mb-1.5">Message</label>
        <textarea
          required
          rows={5}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Describe your issue in detail. For bot issues, include your OS and any error messages."
          className="w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-slate-600 outline-none focus:ring-1 focus:ring-violet-500/50 border transition-colors resize-none"
          style={{ background: 'var(--raised)', borderColor: 'var(--border)' }}
        />
      </div>

      <button
        type="submit"
        disabled={sending}
        className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
        style={{ background: 'var(--accent)' }}
      >
        <Send size={14} />
        {sending ? 'Sending securely…' : 'Send report'}
      </button>

      {error && <p className="text-center text-xs text-red-400">{error}</p>}
      <p className="text-center text-xs text-slate-600">Sent directly to StatfloBot support. Technical logs are never displayed here.</p>
    </form>
  );
}
