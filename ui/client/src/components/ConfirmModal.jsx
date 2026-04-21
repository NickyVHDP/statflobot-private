import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';

const LIST_LABELS = {
  '1st': '1st Attempt',
  '2nd': '2nd Attempt',
  '3rd': '3rd Attempt',
};

const MAX_LABELS = {
  '1': '1 client',
  '3': '3 clients',
  '5': '5 clients',
  '10': '10 clients',
  'all': 'All clients',
};

const DELAY_LABELS = {
  safe: 'Safe',
  normal: 'Normal',
  fast: 'Fast',
  turbo: 'Turbo',
};

function ConfigRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: '#1e1e2e' }}>
      <span className="text-xs" style={{ color: '#64748b' }}>{label}</span>
      <span className="text-xs font-semibold" style={{ color: '#f1f5f9' }}>{value}</span>
    </div>
  );
}

export default function ConfirmModal({ config, onConfirm, onCancel }) {
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
        onClick={(e) => e.target === e.currentTarget && onCancel()}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 16 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="w-full max-w-md rounded-2xl p-6 relative"
          style={{ background: '#13131a', border: '1px solid #1e1e2e', boxShadow: '0 25px 60px rgba(0,0,0,0.6)' }}
        >
          {/* Close button */}
          <button
            onClick={onCancel}
            className="absolute top-4 right-4 p-1.5 rounded-lg transition-colors hover:bg-white/5"
            style={{ color: '#64748b' }}
          >
            <X size={16} />
          </button>

          {/* Icon + title */}
          <div className="flex flex-col items-center text-center mb-6">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)' }}
            >
              <AlertTriangle size={28} className="text-red-400" />
            </div>
            <h2 className="text-lg font-bold mb-1" style={{ color: '#f1f5f9' }}>Live Mode Warning</h2>
            <p className="text-sm" style={{ color: '#64748b' }}>
              This will send real messages to real clients. Please confirm the configuration below.
            </p>
          </div>

          {/* Config summary */}
          <div
            className="rounded-xl px-4 py-1 mb-6"
            style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}
          >
            <ConfigRow label="Attempt List" value={LIST_LABELS[config.list] || config.list} />
            <ConfigRow label="Mode" value="LIVE" />
            <ConfigRow label="Max Clients" value={MAX_LABELS[config.max] || config.max} />
            <ConfigRow label="Speed" value={DELAY_LABELS[config.delay] || config.delay} />
          </div>

          {/* Warning box */}
          <div
            className="flex items-start gap-3 p-3 rounded-lg mb-6"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)' }}
          >
            <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-300">
              Real messages will be sent. This action cannot be undone once the bot starts processing.
            </p>
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors hover:bg-white/5"
              style={{ border: '1px solid #1e1e2e', color: '#64748b' }}
            >
              Cancel
            </button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={onConfirm}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white transition-all"
              style={{ background: 'linear-gradient(135deg, #b91c1c, #ef4444)' }}
            >
              Confirm — Go Live
            </motion.button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
