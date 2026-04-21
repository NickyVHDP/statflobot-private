import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, MessageCircle, Ban, SkipForward, XCircle, RefreshCw } from 'lucide-react';

const MESSAGES = [
  'Mission complete. The list got cooked.',
  'Run finished. Statflo got put to work.',
  'Done. Another list cleared like a pro.',
  'Operation complete. Smooth as butter.',
  'Finished. The bot ate.',
];

function getRandomMessage() {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
}

const STAT_CONFIG = [
  { key: 'processed', label: 'Processed', icon: CheckCircle2, color: '#6366f1' },
  { key: 'messaged', label: 'Messaged', icon: MessageCircle, color: '#22c55e' },
  { key: 'skipped', label: 'Skipped', icon: SkipForward, color: '#f59e0b' },
  { key: 'dnc', label: 'DNC', icon: Ban, color: '#64748b' },
  { key: 'failed', label: 'Failed', icon: XCircle, color: '#ef4444' },
];

export default function CompletionModal({ stats, onClose }) {
  const message = getRandomMessage();

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.85, y: 24 }}
          transition={{ type: 'spring', stiffness: 260, damping: 22 }}
          className="w-full max-w-md rounded-2xl p-8 text-center"
          style={{
            background: '#13131a',
            border: '1px solid #1e1e2e',
            boxShadow: '0 30px 80px rgba(0,0,0,0.7)',
          }}
        >
          {/* Animated checkmark */}
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
            className="flex items-center justify-center mb-6"
          >
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(34,197,94,0.12)',
                border: '2px solid rgba(34,197,94,0.3)',
                boxShadow: '0 0 40px rgba(34,197,94,0.15)',
              }}
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.2 }}
              >
                <CheckCircle2 size={42} className="text-green-400" />
              </motion.div>
            </div>
          </motion.div>

          {/* Message */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <h2 className="text-xl font-bold mb-2" style={{ color: '#f1f5f9' }}>
              {message}
            </h2>
            <p className="text-sm mb-6" style={{ color: '#64748b' }}>
              Control center standing by.
            </p>
          </motion.div>

          {/* Stats grid */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="grid grid-cols-5 gap-2 mb-8"
          >
            {STAT_CONFIG.map(({ key, label, icon: Icon, color }) => (
              <div
                key={key}
                className="flex flex-col items-center gap-1.5 p-2 rounded-xl"
                style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}
              >
                <Icon size={16} style={{ color }} />
                <span className="text-lg font-bold leading-tight" style={{ color }}>
                  {stats?.[key] ?? 0}
                </span>
                <span className="text-[10px] leading-tight" style={{ color: '#64748b' }}>
                  {label}
                </span>
              </div>
            ))}
          </motion.div>

          {/* CTA button */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={onClose}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}
            >
              <RefreshCw size={15} />
              Start New Run
            </motion.button>
          </motion.div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
