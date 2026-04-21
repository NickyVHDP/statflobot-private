import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, MessageSquare, ShieldCheck, X, ChevronRight, Info } from 'lucide-react';

const STEPS = [
  {
    icon: Zap,
    iconColor: '#6366f1',
    title: 'Welcome to StatfloBot',
    body: (
      <div className="space-y-3 text-sm" style={{ color: '#94a3b8' }}>
        <p>
          StatfloBot automates your Statflo outreach — it opens clients, sends the right message
          for each attempt stage, and returns to the list, hands-free.
        </p>
        <p>
          It runs directly in a Chromium window on your machine. Your Statflo session stays
          local — nothing is stored on our servers.
        </p>
      </div>
    ),
  },
  {
    icon: MessageSquare,
    iconColor: '#22c55e',
    title: 'Three attempt stages',
    body: (
      <div className="space-y-3 text-sm" style={{ color: '#94a3b8' }}>
        <div className="rounded-xl p-3 space-y-2" style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
          <div className="flex gap-2">
            <span className="font-semibold" style={{ color: '#6366f1', minWidth: 28 }}>1st</span>
            <span>New customers — uses Statflo's Chat Starter premade flow. Bot clicks through the carousel to the second message.</span>
          </div>
          <div className="flex gap-2">
            <span className="font-semibold" style={{ color: '#f59e0b', minWidth: 28 }}>2nd</span>
            <span>Follow-up — types your saved custom message directly into the conversation thread.</span>
          </div>
          <div className="flex gap-2">
            <span className="font-semibold" style={{ color: '#ef4444', minWidth: 28 }}>3rd</span>
            <span>Final touch — same as 2nd Attempt with your third-attempt message.</span>
          </div>
        </div>
        <p>Write your 2nd and 3rd Attempt messages in the <strong style={{ color: '#e2e8f0' }}>Message Editor</strong> before starting those lists.</p>
      </div>
    ),
  },
  {
    icon: ShieldCheck,
    iconColor: '#f59e0b',
    title: 'First-run recommendations',
    body: (
      <div className="space-y-3 text-sm" style={{ color: '#94a3b8' }}>
        <div className="rounded-xl p-3 space-y-2.5" style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
          <div className="flex gap-2.5 items-start">
            <span style={{ color: '#22c55e', marginTop: 1 }}>✓</span>
            <span>Set <strong style={{ color: '#e2e8f0' }}>Max clients</strong> to a small number (5–10) for your first live run so you can verify the flow.</span>
          </div>
          <div className="flex gap-2.5 items-start">
            <span style={{ color: '#22c55e', marginTop: 1 }}>✓</span>
            <span>Use <strong style={{ color: '#e2e8f0' }}>Safe delay</strong> — it adds human-like pauses between actions to avoid detection.</span>
          </div>
          <div className="flex gap-2.5 items-start">
            <span style={{ color: '#22c55e', marginTop: 1 }}>✓</span>
            <span>Keep an eye on the log panel during the first run — it reports every action and any fallbacks used.</span>
          </div>
          <div className="flex gap-2.5 items-start">
            <span style={{ color: '#f59e0b', marginTop: 1 }}>!</span>
            <span>Log in to Statflo in the browser window that opens — the bot waits until login is detected before starting.</span>
          </div>
        </div>
      </div>
    ),
  },
];

const STORAGE_KEY = 'statflobot_welcomed';

export default function WelcomeModal({ onClose }) {
  const [step, setStep] = useState(0);
  const [dontShow, setDontShow] = useState(false);

  const isLast = step === STEPS.length - 1;
  const { icon: Icon, iconColor, title, body } = STEPS[step];

  function handleClose() {
    if (dontShow) localStorage.setItem(STORAGE_KEY, '1');
    onClose();
  }

  function handleNext() {
    if (isLast) {
      handleClose();
    } else {
      setStep(s => s + 1);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.88, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.88, y: 20 }}
          transition={{ type: 'spring', stiffness: 280, damping: 24 }}
          className="w-full max-w-md rounded-2xl"
          style={{
            background: '#13131a',
            border: '1px solid #1e1e2e',
            boxShadow: '0 30px 80px rgba(0,0,0,0.7)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-0">
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-1 rounded-full transition-all duration-300"
                  style={{
                    width: i === step ? 24 : 8,
                    background: i === step ? iconColor : '#1e1e2e',
                  }}
                />
              ))}
            </div>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: '#475569' }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-6">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                style={{ background: `${iconColor}18`, border: `1px solid ${iconColor}33` }}
              >
                <Icon size={22} style={{ color: iconColor }} />
              </div>
              <h2 className="text-lg font-bold mb-3" style={{ color: '#f1f5f9' }}>
                {title}
              </h2>
              {body}
            </motion.div>
          </div>

          {/* Footer */}
          <div className="px-6 pb-6 flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dontShow}
                onChange={e => setDontShow(e.target.checked)}
                className="rounded"
                style={{ accentColor: '#6366f1' }}
              />
              <span className="text-xs" style={{ color: '#475569' }}>Don't show again</span>
            </label>

            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}
            >
              {isLast ? 'Get started' : 'Next'}
              <ChevronRight size={15} />
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

export function shouldShowWelcome() {
  return !localStorage.getItem(STORAGE_KEY);
}
