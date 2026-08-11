import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Send } from 'lucide-react';
import { fetchAdminSupportReports, resolveAdminSupportReport } from '../lib/cloudApi.js';

function date(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

export default function AdminSupportReports() {
  const [reports, setReports] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminSupportReports();
      setReports(data.reports ?? []);
      setSelected(current => current ? (data.reports ?? []).find(r => r.id === current.id) ?? null : null);
    } catch (err) {
      setError(err.status === 403 ? 'Owner account required.' : 'Support reports are temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function resolve() {
    if (!selected || !message.trim() || !version.trim()) return;
    if (!window.confirm(`Send the resolution email for ${selected.reference}? This customer communication cannot be recalled.`)) return;
    setSending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await resolveAdminSupportReport(selected.reference, message.trim(), version.trim());
      if (!result.ok) throw new Error(result.error ?? 'Could not resolve this report.');
      setSuccess(result.duplicate ? 'The customer had already been notified.' : 'Resolution saved and customer notified.');
      setMessage('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-xl p-5" style={{ background: '#13131a', border: '1px solid #1e1e2e' }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2"><Send size={16} style={{ color: '#a78bfa' }} /><h3 className="text-sm font-semibold text-white">Customer Support Reports</h3></div>
          <p className="text-xs mt-1" style={{ color: '#64748b' }}>Owner-only queue. Resolving explicitly sends one email and creates one private in-app notice.</p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg disabled:opacity-50" style={{ color: '#94a3b8', background: '#1e1e2e' }}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {error && <div className="rounded-lg px-3 py-2 text-xs mb-3" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)' }}>{error}</div>}
      {success && <div className="rounded-lg px-3 py-2 text-xs mb-3 flex gap-2" style={{ color: '#86efac', background: 'rgba(34,197,94,0.08)' }}><CheckCircle2 size={14} />{success}</div>}
      {loading && reports.length === 0 ? (
        <div className="h-24 flex items-center justify-center gap-2 text-sm" style={{ color: '#64748b' }}><Loader2 size={15} className="animate-spin" /> Loading reports…</div>
      ) : (
        <div className="grid lg:grid-cols-[0.8fr_1.2fr] gap-3">
          <div className="rounded-lg border max-h-[420px] overflow-y-auto" style={{ borderColor: '#222233', background: '#0e0e14' }}>
            {reports.length === 0 && <div className="p-5 text-xs" style={{ color: '#64748b' }}>No support reports yet.</div>}
            {reports.map(report => (
              <button key={report.id} onClick={() => { setSelected(report); setMessage(report.resolution_message ?? ''); setVersion(report.fixed_in_version ?? version); setSuccess(null); }} className="w-full text-left p-3 border-b" style={{ borderColor: '#1e1e2e', background: selected?.id === report.id ? 'rgba(99,102,241,0.09)' : 'transparent' }}>
                <div className="flex justify-between gap-2"><span className="text-xs font-mono" style={{ color: '#818cf8' }}>{report.reference}</span><span className="text-[10px] uppercase" style={{ color: report.status === 'resolved' ? '#86efac' : '#fbbf24' }}>{report.status}</span></div>
                <div className="text-sm text-white mt-1 truncate">{report.subject || 'No subject'}</div>
                <div className="text-[11px] mt-1" style={{ color: '#475569' }}>{date(report.created_at)}</div>
              </button>
            ))}
          </div>
          <div className="rounded-lg border p-4" style={{ borderColor: '#222233', background: '#0e0e14' }}>
            {!selected ? <div className="h-full min-h-40 flex items-center justify-center text-xs" style={{ color: '#64748b' }}>Select a report to review.</div> : (
              <div className="space-y-3">
                <div><div className="text-[11px]" style={{ color: '#64748b' }}>Customer report</div><p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: '#cbd5e1' }}>{selected.description}</p></div>
                <div className="text-xs" style={{ color: '#64748b' }}>Log attached privately: {selected.log_attached ? 'Yes' : 'No'} · Support email: {selected.support_email_status}</div>
                <textarea value={message} onChange={e => setMessage(e.target.value)} disabled={selected.resolution_email_status === 'sent'} maxLength={1000} rows={4} placeholder="Customer-friendly explanation of what was fixed" className="w-full rounded-lg p-3 text-sm outline-none disabled:opacity-60" style={{ background: '#171722', color: '#e2e8f0', border: '1px solid #29293b' }} />
                <input value={version} onChange={e => setVersion(e.target.value)} disabled={selected.resolution_email_status === 'sent'} placeholder="Released version, e.g. 1.5.60" className="w-full rounded-lg px-3 py-2 text-sm outline-none disabled:opacity-60" style={{ background: '#171722', color: '#e2e8f0', border: '1px solid #29293b' }} />
                <button onClick={resolve} disabled={sending || selected.resolution_email_status === 'sent' || !message.trim() || !version.trim()} className="w-full rounded-lg py-2.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40" style={{ color: '#fff', background: '#4f46e5' }}>
                  {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}{selected.resolution_email_status === 'sent' ? 'Customer notified' : 'Resolve & notify customer'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
