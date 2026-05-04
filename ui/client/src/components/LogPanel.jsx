import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, Loader2, Copy, Check, Trash2, FileText, FolderOpen } from 'lucide-react';

const LEVEL_STYLES = {
  success: {
    badge: 'bg-green-900/60 text-green-400 border border-green-700/40',
    text: 'text-green-300',
    label: 'OK',
  },
  error: {
    badge: 'bg-red-900/60 text-red-400 border border-red-700/40',
    text: 'text-red-300',
    label: 'ERR',
  },
  warn: {
    badge: 'bg-yellow-900/60 text-yellow-400 border border-yellow-700/40',
    text: 'text-yellow-300',
    label: 'WRN',
  },
  info: {
    badge: 'bg-slate-800/60 text-slate-400 border border-slate-700/40',
    text: 'text-slate-300',
    label: 'INF',
  },
};

const STATUS_STYLES = {
  complete: { label: 'Complete', color: '#86efac', bg: 'rgba(134,239,172,0.1)' },
  stopped:  { label: 'Stopped',  color: '#fbbf24', bg: 'rgba(251,191,36,0.1)'  },
  error:    { label: 'Error',    color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
};

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '--:--:--';
  }
}

function LogEntry({ entry, index }) {
  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.12, delay: Math.min(index * 0.01, 0.1) }}
      className="flex items-start gap-3 py-1.5 px-3 rounded hover:bg-white/[0.02] transition-colors group"
    >
      <span
        className="font-mono text-xs flex-shrink-0 mt-0.5 select-none"
        style={{ color: '#3d4152', minWidth: '52px' }}
      >
        {formatTimestamp(entry.timestamp)}
      </span>
      <span
        className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 leading-none ${style.badge}`}
        style={{ minWidth: '32px', textAlign: 'center' }}
      >
        {style.label}
      </span>
      <span
        className={`font-mono text-xs leading-relaxed break-all ${style.text}`}
        style={{ wordBreak: 'break-word' }}
      >
        {entry.text}
      </span>
    </motion.div>
  );
}

export default function LogPanel({ logs, runState, lastRunStatus, lastRunLogFile, onClear }) {
  const scrollRef  = useRef(null);
  const isRunning  = runState === 'running';
  const isPostRun  = !isRunning && logs.length > 0;
  const [copied,   setCopied]   = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fullLog,  setFullLog]  = useState(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  async function handleCopy() {
    const text = logs.map(e => `${formatTimestamp(e.timestamp)} [${(e.level || 'info').toUpperCase()}] ${e.text}`).join('\n');
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleFetchFullLog() {
    if (fetching) return;
    setFetching(true);
    try {
      const res = await fetch('/api/logs/latest');
      const data = await res.json();
      if (data.ok && data.content) {
        setFullLog(data.content);
        await navigator.clipboard.writeText(data.content).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch { /* ignore */ }
    setFetching(false);
  }

  function handleRevealFolder() {
    if (!lastRunLogFile) return;
    // Electron exposes openExternal via preload; fall back to copying the path.
    const folder = lastRunLogFile.replace(/[/\\][^/\\]+$/, '');
    if (window.electron?.openExternal) {
      window.electron.openExternal(`file://${folder}`);
    } else {
      navigator.clipboard.writeText(folder).catch(() => {});
    }
  }

  const statusCfg = lastRunStatus ? STATUS_STYLES[lastRunStatus] : null;

  return (
    <div
      className="rounded-xl flex flex-col h-full min-h-[500px]"
      style={{ background: '#13131a', border: '1px solid #1e1e2e' }}
    >
      {/* Panel header */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
        style={{ borderColor: '#1e1e2e' }}
      >
        <div className="flex items-center gap-2">
          <Terminal size={15} style={{ color: '#6366f1' }} />
          <h2 className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>
            {isRunning ? 'Live Output' : (logs.length > 0 ? 'Last Run Output' : 'Live Output')}
          </h2>
          {isRunning && (
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
              className="inline-flex"
            >
              <Loader2 size={13} className="text-green-400" />
            </motion.span>
          )}
          {statusCfg && !isRunning && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: statusCfg.bg, color: statusCfg.color }}
            >
              {statusCfg.label}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: '#0a0a0f', color: '#64748b', border: '1px solid #1e1e2e' }}
          >
            {logs.length} line{logs.length !== 1 ? 's' : ''}
          </span>

          {/* Copy in-memory logs */}
          {logs.length > 0 && (
            <button
              onClick={handleCopy}
              title="Copy visible logs"
              className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors"
              style={{ color: '#64748b', background: '#0a0a0f', border: '1px solid #1e1e2e' }}
            >
              {copied ? <Check size={11} style={{ color: '#86efac' }} /> : <Copy size={11} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}

          {/* Copy full log file (post-run) */}
          {isPostRun && lastRunLogFile && (
            <button
              onClick={handleFetchFullLog}
              disabled={fetching}
              title="Copy full log file"
              className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors disabled:opacity-50"
              style={{ color: '#a78bfa', background: '#0a0a0f', border: '1px solid #2d2d4e' }}
            >
              <FileText size={11} />
              {fetching ? 'Loading…' : 'Full log'}
            </button>
          )}

          {/* Reveal logs folder */}
          {isPostRun && lastRunLogFile && (
            <button
              onClick={handleRevealFolder}
              title="Open logs folder"
              className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors"
              style={{ color: '#64748b', background: '#0a0a0f', border: '1px solid #1e1e2e' }}
            >
              <FolderOpen size={11} />
            </button>
          )}

          {/* Clear */}
          {logs.length > 0 && onClear && !isRunning && (
            <button
              onClick={onClear}
              title="Clear logs"
              className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors"
              style={{ color: '#f87171', background: '#0a0a0f', border: '1px solid #1e1e2e' }}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Log file path bar — post-run only */}
      {isPostRun && lastRunLogFile && (
        <div
          className="px-5 py-1.5 flex items-center gap-2 border-b text-xs"
          style={{ borderColor: '#1e1e2e', background: 'rgba(99,102,241,0.04)', color: '#475569' }}
        >
          <FileText size={11} style={{ color: '#6366f1', flexShrink: 0 }} />
          <span className="font-mono truncate" title={lastRunLogFile}>{lastRunLogFile}</span>
        </div>
      )}

      {/* Log content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-2 log-scroll"
        style={{ minHeight: 0 }}
      >
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 py-16">
            <Terminal size={32} style={{ color: '#1e1e2e' }} />
            <p className="text-sm" style={{ color: '#3d4152' }}>
              {runState === 'idle' ? 'Start a run to see output here' : 'Waiting for output...'}
            </p>
          </div>
        ) : (
          <div className="space-y-0">
            {logs.map((entry, i) => (
              <LogEntry key={i} entry={entry} index={i} />
            ))}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      {isRunning && (
        <div
          className="flex items-center gap-2 px-5 py-2 border-t flex-shrink-0"
          style={{ borderColor: '#1e1e2e', background: 'rgba(34,197,94,0.03)' }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 pulse-running inline-block" />
          <span className="text-xs" style={{ color: '#22c55e' }}>Bot is running — streaming live output</span>
        </div>
      )}

      {/* Post-run footer with stats hint */}
      {isPostRun && !isRunning && (
        <div
          className="flex items-center justify-between px-5 py-2 border-t flex-shrink-0 text-xs"
          style={{ borderColor: '#1e1e2e', color: '#475569' }}
        >
          <span>Logs preserved — start a new run to clear</span>
          {onClear && (
            <button onClick={onClear} className="hover:text-red-400 transition-colors flex items-center gap-1">
              <Trash2 size={10} /> Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
