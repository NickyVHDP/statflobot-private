import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, ShieldCheck, Sparkles, UserPlus, X } from 'lucide-react';
import { markReleaseNotesSeen } from '../lib/releaseNotes.js';

const AUDIENCES = {
  everyone: { label: 'For everyone', Icon: Sparkles, color: '#818cf8' },
  paid:     { label: 'For paying users', Icon: ShieldCheck, color: '#86efac' },
  new:      { label: 'For new users', Icon: UserPlus, color: '#fbbf24' },
};

export default function WhatsNewModal({ release, onClose }) {
  if (!release) return null;

  function close() {
    markReleaseNotesSeen(release.version);
    onClose();
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 modal-backdrop"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          transition={{ type: 'spring', stiffness: 280, damping: 25 }}
          className="w-full max-w-lg rounded-2xl overflow-hidden"
          style={{ background: '#13131a', border: '1px solid #28283a', boxShadow: '0 30px 90px rgba(0,0,0,0.72)' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="whats-new-title"
        >
          <div className="px-6 pt-6 pb-5" style={{ background: 'linear-gradient(145deg, rgba(99,102,241,0.16), rgba(19,19,26,0))' }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold mb-3" style={{ color: '#c7d2fe', background: 'rgba(99,102,241,0.16)', border: '1px solid rgba(99,102,241,0.28)' }}>
                  <Sparkles size={11} /> WHAT’S NEW · v{release.version}
                </div>
                <h2 id="whats-new-title" className="text-xl font-bold text-white">{release.title}</h2>
                <p className="text-sm mt-2 leading-relaxed" style={{ color: '#94a3b8' }}>{release.intro}</p>
              </div>
              <button onClick={close} className="p-1.5 rounded-lg" style={{ color: '#64748b' }} aria-label="Close What’s New">
                <X size={17} />
              </button>
            </div>
          </div>

          <div className="px-6 pb-6 space-y-3">
            {release.changes.map((change, index) => {
              const audience = AUDIENCES[change.audience] ?? AUDIENCES.everyone;
              const Icon = audience.Icon;
              return (
                <div key={`${change.title}-${index}`} className="rounded-xl p-4" style={{ background: '#0d0d14', border: '1px solid #1e1e2e' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon size={14} style={{ color: audience.color }} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: audience.color }}>{audience.label}</span>
                  </div>
                  <h3 className="text-sm font-semibold text-white">{change.title}</h3>
                  <p className="text-xs mt-1.5 leading-relaxed" style={{ color: '#94a3b8' }}>{change.description}</p>
                </div>
              );
            })}

            {release.action && (
              <div className="flex items-start gap-2.5 rounded-xl px-4 py-3 text-xs" style={{ color: '#a7f3d0', background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.18)' }}>
                <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
                <span>{release.action}</span>
              </div>
            )}

            <button onClick={close} className="w-full py-2.5 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}>
              Got it
            </button>
            <p className="text-center text-[11px]" style={{ color: '#475569' }}>You can reopen this anytime from Account → App &amp; Updates.</p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
