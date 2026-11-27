import { useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { matchesPayoutApproval } from '../lib/payoutApproval.js';

export default function PayoutApprovalModal({ approval, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('');
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const valid = matchesPayoutApproval(approval, typed);
  const deferred = approval.early && !approval.row.payoutsEnabled;

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  function handleKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key !== 'Tab') return;
    const items = dialogRef.current?.querySelectorAll('input, button:not([disabled])');
    if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)' }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={handleKey}
        className="w-full max-w-lg rounded-2xl border p-6 space-y-4" style={{ background: '#13131f', borderColor: '#35304f', boxShadow: '0 25px 70px rgba(0,0,0,0.5)' }}>
        <ShieldCheck size={26} style={{ color: '#a78bfa' }} />
        <h2 id={titleId} className="text-lg font-semibold text-white">{approval.early ? 'Release referral reward early' : 'Approve bank payout'}</h2>
        <div className="rounded-xl p-4 text-sm space-y-1" style={{ background: '#0e0e14', color: '#cbd5e1' }}>
          <p>Recipient: <strong>{approval.recipient}</strong></p>
          <p>Available balance: <strong>{approval.amount}</strong></p>
        </div>
        <p id={descriptionId} className="text-sm leading-relaxed" style={{ color: '#94a3b8' }}>
          {deferred
            ? 'This bypasses the remaining 30-day hold and notifies the member to complete bank setup. No deposit can be submitted until their bank is ready.'
            : `${approval.early ? 'This bypasses the remaining 30-day hold and ' : 'This '}submits the full eligible balance to Stripe now. Bank delivery timing is determined by Stripe and the recipient’s bank; it is not guaranteed to arrive instantly.`}
        </p>
        <label className="block text-xs" style={{ color: '#cbd5e1' }}>
          Type <strong className="font-mono">{approval.expected}</strong> to confirm
          <input ref={inputRef} value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false}
            className="mt-2 w-full rounded-lg border px-3 py-2.5 text-sm text-white" style={{ background: '#0e0e14', borderColor: '#35304f' }} />
        </label>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2.5 text-sm" style={{ color: '#cbd5e1', background: '#242433' }}>Cancel</button>
          <button type="button" disabled={!valid} onClick={() => { if (valid) onConfirm(typed); }}
            className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40" style={{ background: '#6d28d9' }}>
            {deferred ? 'Release reward' : 'Submit payout now'}
          </button>
        </div>
      </div>
    </div>
  );
}
