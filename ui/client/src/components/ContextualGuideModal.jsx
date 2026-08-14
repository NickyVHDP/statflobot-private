import { useEffect, useRef } from 'react';
import { CheckCircle2, Info, X } from 'lucide-react';
import { markContextualGuideSeen } from '../lib/contextualGuides.js';

export default function ContextualGuideModal({
  guide,
  onClose,
  onConfirm,
  confirmLabel = 'Got it',
  cancelLabel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!guide) return null;

  function remember() {
    markContextualGuideSeen(guide.id);
  }

  function handleClose() {
    remember();
    onClose?.();
  }

  function handleConfirm() {
    remember();
    onConfirm?.();
  }

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center p-4 modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) handleClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: '#13131a', border: '1px solid #28283a', boxShadow: '0 30px 90px rgba(0,0,0,0.72)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${guide.id}-guide-title`}
        aria-describedby={`${guide.id}-guide-intro`}
      >
        <div className="px-6 pt-6 pb-5" style={{ background: 'linear-gradient(145deg, rgba(99,102,241,0.16), rgba(19,19,26,0))' }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold mb-3" style={{ color: '#c7d2fe', background: 'rgba(99,102,241,0.16)', border: '1px solid rgba(99,102,241,0.28)' }}>
                <Info size={11} /> {guide.eyebrow.toUpperCase()}
              </div>
              <h2 id={`${guide.id}-guide-title`} className="text-xl font-bold text-white">{guide.title}</h2>
              <p id={`${guide.id}-guide-intro`} className="text-sm mt-2 leading-relaxed" style={{ color: '#94a3b8' }}>{guide.intro}</p>
            </div>
            <button onClick={handleClose} className="p-1.5 rounded-lg" style={{ color: '#64748b' }} aria-label={`Close ${guide.title}`}>
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="px-6 pb-6 space-y-3">
          <div className="rounded-xl p-4 space-y-3" style={{ background: '#0d0d14', border: '1px solid #1e1e2e' }}>
            {guide.points.map((point) => (
              <div key={point} className="flex items-start gap-2.5">
                <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" style={{ color: '#86efac' }} />
                <p className="text-xs leading-relaxed" style={{ color: '#cbd5e1' }}>{point}</p>
              </div>
            ))}
          </div>

          {guide.note && (
            <p className="rounded-xl px-4 py-3 text-xs leading-relaxed" style={{ color: '#fcd34d', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)' }}>
              {guide.note}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            {cancelLabel && (
              <button onClick={handleClose} className="flex-1 py-2.5 rounded-xl text-sm font-medium" style={{ background: '#1e1e2e', color: '#94a3b8' }}>
                {cancelLabel}
              </button>
            )}
            <button ref={confirmRef} onClick={handleConfirm} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
