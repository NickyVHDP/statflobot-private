import { useEffect, useReducer, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2,
  ArrowRight, Zap, Ban, SkipForward,
} from 'lucide-react';

// ── Log text → structured event ───────────────────────────────────────────────

function parseLog(text) {
  let m;
  if ((m = text.match(/^Opening client: (.+)$/)))
    return { ev: 'clientOpen', name: m[1] };
  if (text === '1st Attempt: top premade flow')
    return { ev: 'flow', step: 'Top Premade' };
  if (text === '1st Attempt: bottom Chat Starter flow')
    return { ev: 'flow', step: 'Chat Starter' };
  if (text === 'Top premade: Send enabled' || text === 'Bottom Chat Starter: Send enabled')
    return { ev: 'flowOk' };
  if (text.startsWith('Bottom Chat Starter: no in-container Next button'))
    return { ev: 'flowDead' };
  if ((m = text.match(/trying SMS line (\d+)\/(\d+)/)))
    return { ev: 'smsLine', n: +m[1], total: +m[2] };
  if ((m = text.match(/^(.+): Message SENT$/)))
    return { ev: 'outcome', name: m[1], res: 'sent' };
  if ((m = text.match(/^\[DRY RUN\] Would send to (.+?) —/)))
    return { ev: 'outcome', name: m[1], res: 'dryrun' };
  if ((m = text.match(/^\[DRY RUN\] Would send message/)))
    return { ev: 'dryOutcome' };
  if ((m = text.match(/^(.+): DNC activity logged/)))
    return { ev: 'outcome', name: m[1], res: 'dnc' };
  if ((m = text.match(/^(.+): No active SMS lines/)))
    return { ev: 'outcome', name: m[1], res: 'dnc' };
  if ((m = text.match(/^(.+): skipped$/i)))
    return { ev: 'outcome', name: m[1], res: 'skipped' };
  if (text.includes('SMS line(s) exhausted'))
    return { ev: 'allFailed' };
  // 2nd/3rd attempt (nextActionFilter)
  if ((m = text.match(/^Client (\d+): Message SENT/)))
    return { ev: 'numOutcome', num: +m[1], res: 'sent' };
  if ((m = text.match(/^Client (\d+): DNC/)))
    return { ev: 'numOutcome', num: +m[1], res: 'dnc' };
  return null;
}

// ── State reducer ─────────────────────────────────────────────────────────────

const INIT = { clients: [], active: null, seq: 0 };

function reducer(state, action) {
  const { ev } = action;
  const clients = [...state.clients];
  let active = state.active ? { ...state.active, path: [...state.active.path] } : null;

  const flush = () => { if (active) { clients.push(active); active = null; } };

  if (ev === 'reset') return { ...INIT };

  if (ev === 'clientOpen') {
    flush();
    active = { id: state.seq, name: action.name, path: [], outcome: null };
    return { clients, active, seq: state.seq + 1 };
  }

  if (ev === 'flow') {
    if (!active) active = { id: state.seq, name: null, path: [], outcome: null };
    active.currentStep = action.step;
    active.path.push({ label: action.step, status: 'running' });
    return { ...state, clients, active };
  }

  if (ev === 'flowOk') {
    if (active?.path.length) active.path[active.path.length - 1].status = 'ok';
    active && (active.currentStep = null);
    return { ...state, clients, active };
  }

  if (ev === 'flowDead') {
    if (active?.path.length) active.path[active.path.length - 1].status = 'dead';
    active && (active.currentStep = null);
    return { ...state, clients, active };
  }

  if (ev === 'smsLine') {
    if (!active) active = { id: state.seq, name: null, path: [], outcome: null };
    if (action.n > 1) {
      active.path.push({ label: `Retry Line ${action.n}`, status: 'retry' });
    }
    return { ...state, clients, active };
  }

  if (ev === 'outcome') {
    if (!active) active = { id: state.seq, name: action.name, path: [], outcome: null };
    active.outcome = action.res;
    clients.push(active);
    return { ...state, clients, active: null };
  }

  if (ev === 'allFailed') {
    if (active) { active.outcome = 'failed'; clients.push(active); }
    return { ...state, clients, active: null };
  }

  if (ev === 'numOutcome') {
    if (!active) active = { id: state.seq, name: `Client ${action.num}`, path: [], outcome: null };
    active.outcome = action.res;
    clients.push(active);
    return { ...state, clients, active: null };
  }

  if (ev === 'dryOutcome') {
    if (active) { active.outcome = 'dryrun'; clients.push(active); }
    return { ...state, clients, active: null };
  }

  return state;
}

// ── Visual helpers ────────────────────────────────────────────────────────────

const OUTCOME_CONFIG = {
  sent:    { icon: CheckCircle2, color: '#22c55e', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.25)',   label: 'Sent' },
  dryrun:  { icon: Zap,          color: '#6366f1', bg: 'rgba(99,102,241,0.10)',  border: 'rgba(99,102,241,0.25)',  label: 'Dry Run' },
  failed:  { icon: XCircle,      color: '#ef4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.25)',   label: 'Failed' },
  dnc:     { icon: Ban,          color: '#64748b', bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.25)', label: 'DNC' },
  skipped: { icon: SkipForward,  color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.25)',  label: 'Skipped' },
};

const STEP_STATUS_COLORS = {
  running: '#6366f1',
  ok:      '#22c55e',
  dead:    '#ef4444',
  retry:   '#f59e0b',
};

function StepPill({ label, status }) {
  const color = STEP_STATUS_COLORS[status] || '#475569';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
      style={{ background: `${color}18`, border: `1px solid ${color}40`, color }}
    >
      {status === 'running' && (
        <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
          <Loader2 size={9} />
        </motion.span>
      )}
      {label}
    </span>
  );
}

function ClientRow({ client, isActive }) {
  const oc = client.outcome ? OUTCOME_CONFIG[client.outcome] : null;
  const OutcomeIcon = oc?.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="rounded-xl px-4 py-3 flex flex-col gap-2"
      style={{
        background: isActive ? 'rgba(99,102,241,0.06)' : '#0d0d14',
        border: `1px solid ${isActive ? 'rgba(99,102,241,0.3)' : '#1a1a27'}`,
      }}
    >
      {/* Name row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {isActive ? (
            <motion.span
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ repeat: Infinity, duration: 1.4 }}
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: '#6366f1', boxShadow: '0 0 6px #6366f1' }}
            />
          ) : (
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: oc?.color ?? '#1e1e2e' }}
            />
          )}
          <span
            className="text-sm font-medium truncate"
            style={{ color: isActive ? '#c7d2fe' : '#94a3b8' }}
          >
            {client.name ?? '—'}
          </span>
        </div>

        {oc && (
          <span
            className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-md"
            style={{ background: oc.bg, border: `1px solid ${oc.border}`, color: oc.color }}
          >
            <OutcomeIcon size={11} />
            {oc.label}
          </span>
        )}
        {isActive && !oc && (
          <span className="flex-shrink-0 text-xs" style={{ color: '#6366f1' }}>
            <Loader2 size={12} className="animate-spin inline" />
          </span>
        )}
      </div>

      {/* Path row */}
      {client.path.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-4">
          {client.path.map((step, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ArrowRight size={10} style={{ color: '#2d2d3f' }} />}
              <StepPill label={step.label} status={step.status} />
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RunMap({ logs, runState }) {
  const [map, dispatch] = useReducer(reducer, INIT);
  const prevLogCount = useRef(0);
  const scrollRef = useRef(null);

  // Reset when a new run starts
  useEffect(() => {
    if (runState === 'running' && logs.length === 0) {
      dispatch({ ev: 'reset' });
      prevLogCount.current = 0;
    }
  }, [runState, logs.length]);

  // Parse new log entries incrementally
  useEffect(() => {
    const newEntries = logs.slice(prevLogCount.current);
    prevLogCount.current = logs.length;
    for (const entry of newEntries) {
      const event = parseLog(entry.text);
      if (event) dispatch(event);
    }
  }, [logs]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [map.clients.length, map.active]);

  const isRunning = runState === 'running';
  const isEmpty = map.clients.length === 0 && !map.active;

  return (
    <div
      className="rounded-xl flex flex-col h-full min-h-[500px]"
      style={{ background: '#13131a', border: '1px solid #1e1e2e' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
        style={{ borderColor: '#1e1e2e' }}
      >
        <div className="flex items-center gap-2">
          <Zap size={15} style={{ color: '#6366f1' }} />
          <h2 className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>Automation Path</h2>
          {isRunning && (
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
              className="inline-flex"
            >
              <Loader2 size={13} className="text-indigo-400" />
            </motion.span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {map.clients.length > 0 && (
            <span className="text-xs" style={{ color: '#475569' }}>
              {map.clients.filter(c => c.outcome === 'sent' || c.outcome === 'dryrun').length} sent
              {' · '}
              {map.clients.filter(c => c.outcome === 'failed').length > 0 && (
                <span style={{ color: '#ef4444' }}>
                  {map.clients.filter(c => c.outcome === 'failed').length} failed
                </span>
              )}
              {map.clients.filter(c => c.outcome === 'failed').length === 0 && (
                <span>{map.clients.length} processed</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2" style={{ minHeight: 0 }}>
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 py-16">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)' }}
            >
              <Zap size={24} style={{ color: '#4f46e5' }} />
            </div>
            <p className="text-sm" style={{ color: '#3d4152' }}>
              {runState === 'idle' ? 'Start a run to see the automation path' : 'Waiting for first client…'}
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {map.clients.map((client) => (
              <ClientRow key={client.id} client={client} isActive={false} />
            ))}
            {map.active && (
              <ClientRow key="active" client={map.active} isActive={true} />
            )}
          </AnimatePresence>
        )}
      </div>

      {/* Footer */}
      {isRunning && (
        <div
          className="flex items-center gap-2 px-5 py-2 border-t flex-shrink-0"
          style={{ borderColor: '#1e1e2e', background: 'rgba(99,102,241,0.03)' }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 pulse-running inline-block" />
          <span className="text-xs" style={{ color: '#6366f1' }}>Bot running — tracing path in real time</span>
        </div>
      )}
    </div>
  );
}
