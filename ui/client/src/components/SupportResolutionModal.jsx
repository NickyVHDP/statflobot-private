import { useState } from 'react';
import { CheckCircle2, Download, Loader2 } from 'lucide-react';

export default function SupportResolutionModal({ notice, onAcknowledge, onUpdate }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const needsUpdate = notice?.fixDelivery === 'update-available';

  async function finish(update) {
    setWorking(true);
    setError(null);
    try {
      if (update) await onUpdate();
      await onAcknowledge(notice.reference);
    } catch (err) {
      setError(err?.message ?? 'Could not save this acknowledgement. Please try again.');
      setWorking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-lg rounded-2xl border overflow-hidden" style={{ background: '#13131f', borderColor: 'rgba(99,102,241,0.30)', boxShadow: '0 30px 90px rgba(0,0,0,0.55)' }}>
        <div className="p-7 pb-5" style={{ background: 'linear-gradient(135deg,rgba(34,197,94,0.10),rgba(99,102,241,0.10))' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'rgba(34,197,94,0.13)', border: '1px solid rgba(34,197,94,0.25)' }}>
            <CheckCircle2 size={25} style={{ color: '#4ade80' }} />
          </div>
          <p className="text-[11px] uppercase tracking-widest font-semibold mb-2" style={{ color: '#86efac' }}>Support update</p>
          <h2 className="text-xl font-semibold text-white">Your reported issue has been fixed</h2>
          <p className="text-sm mt-2" style={{ color: '#94a3b8', lineHeight: 1.6 }}>
            Thank you for helping us improve StatfloBot. This update is private to your account.
          </p>
        </div>

        <div className="px-7 py-5 space-y-4">
          {notice.subject && <p className="text-sm font-medium text-white">{notice.subject}</p>}
          <div className="rounded-xl p-4 text-sm" style={{ background: '#0d0d15', color: '#cbd5e1', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
            {notice.resolutionMessage}
          </div>
          <div className="flex items-center justify-between gap-3 text-xs" style={{ color: '#64748b' }}>
            <span className="font-mono">{notice.reference}</span>
            {notice.fixedInVersion && <span>Fixed in v{notice.fixedInVersion}</span>}
          </div>
          {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.09)' }}>{error}</div>}
          <button
            onClick={() => finish(needsUpdate)}
            disabled={working}
            className="w-full rounded-xl py-3 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
            style={{ color: '#fff', background: 'linear-gradient(135deg,#4f46e5,#6366f1)' }}
          >
            {working ? <Loader2 size={16} className="animate-spin" /> : needsUpdate ? <Download size={16} /> : <CheckCircle2 size={16} />}
            {working ? 'Saving…' : needsUpdate ? 'Update Now' : 'Got It'}
          </button>
          {needsUpdate && (
            <button onClick={() => finish(false)} disabled={working} className="w-full text-xs py-1 disabled:opacity-50" style={{ color: '#64748b' }}>
              I’ll update later
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
