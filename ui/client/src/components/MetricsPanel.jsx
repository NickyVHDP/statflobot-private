import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, MessageCircle, Ban, SkipForward, XCircle } from 'lucide-react';

const METRIC_CONFIG = [
  {
    key: 'processed',
    label: 'Processed',
    icon: CheckCircle2,
    color: '#6366f1',
    bg: 'rgba(99,102,241,0.08)',
    border: 'rgba(99,102,241,0.2)',
  },
  {
    key: 'messaged',
    label: 'Messaged',
    icon: MessageCircle,
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.2)',
  },
  {
    key: 'skipped',
    label: 'Skipped',
    icon: SkipForward,
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.2)',
  },
  {
    key: 'dnc',
    label: 'DNC',
    icon: Ban,
    color: '#64748b',
    bg: 'rgba(100,116,139,0.08)',
    border: 'rgba(100,116,139,0.2)',
  },
  {
    key: 'failed',
    label: 'Failed',
    icon: XCircle,
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)',
    border: 'rgba(239,68,68,0.2)',
  },
];

const STATE_LABELS = {
  idle: { text: 'Idle — ready to run', color: '#64748b' },
  running: { text: 'Running...', color: '#22c55e' },
  complete: { text: 'Run complete', color: '#6366f1' },
};

function StatCard({ metric, value }) {
  const Icon = metric.icon;
  return (
    <motion.div
      layout
      className="flex items-center gap-3 p-3 rounded-lg"
      style={{ background: metric.bg, border: `1px solid ${metric.border}` }}
    >
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
        style={{ background: metric.bg }}
      >
        <Icon size={16} style={{ color: metric.color }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium" style={{ color: '#64748b' }}>{metric.label}</p>
        <AnimatePresence mode="wait">
          <motion.p
            key={value}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.15 }}
            className="text-lg font-bold leading-tight"
            style={{ color: metric.color }}
          >
            {value}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

export default function MetricsPanel({ stats, runState }) {
  const stateLabel = STATE_LABELS[runState] || STATE_LABELS.idle;

  return (
    <div
      className="rounded-xl p-5 flex flex-col gap-4"
      style={{ background: '#13131a', border: '1px solid #1e1e2e' }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>Live Metrics</h2>
        <span className="text-xs font-medium" style={{ color: stateLabel.color }}>
          {stateLabel.text}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2">
        {METRIC_CONFIG.map((metric) => (
          <StatCard key={metric.key} metric={metric} value={stats[metric.key] ?? 0} />
        ))}
      </div>
    </div>
  );
}
